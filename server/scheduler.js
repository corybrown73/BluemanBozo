'use strict';

/**
 * The weekly rhythm.
 *
 *   Tuesday 9am   open   Week opens, everyone gets nagged for a pick.  0 credits
 *   Thursday 9am  mid    Injuries + who is still missing.              0 credits
 *   Saturday 8pm  final  Placement sheet with re-priced lines.        ~25 credits
 *
 * Why in-process rather than host cron: this app is already a long-running
 * server, the jobs need the same database and settings, and a single scheduler
 * behaves identically on Render, Fly and plain Docker instead of needing a
 * different cron story on each. The cost is that a restart at exactly the wrong
 * minute would miss a run — so every job records itself and a catch-up sweep
 * runs late jobs on boot and every 15 minutes after.
 */

const cron = require('node-cron');
const { db, getSetting, activeSeason, currentWeek } = require('./db');
const game = require('./game');
const digest = require('./digest');
const odds = require('./odds');

const JOBS = [
  { key: 'open',  setting: 'cron_open',  label: 'Tuesday — open the week',   audience: 'group' },
  { key: 'mid',   setting: 'cron_mid',   label: 'Thursday — midweek update', audience: 'group' },
  { key: 'final', setting: 'cron_final', label: 'Saturday — placement sheet', audience: 'group' },
];

// How long after its slot a missed job is still worth running.
const CATCHUP_HOURS = { open: 36, mid: 30, final: 14 };

let tasks = [];
let sweeper = null;
/** Jobs currently executing — a sweep tick landing mid-send must not double it. */
const inFlight = new Set();

/* ---------------- run bookkeeping ---------------- */

function lastRun(jobKey) {
  return db
    .prepare(`SELECT * FROM job_runs WHERE job = ? AND status = 'sent' ORDER BY id DESC LIMIT 1`)
    .get(jobKey) || null;
}

function recordRun(jobKey, fields) {
  db.prepare(
    `INSERT INTO job_runs (job, week_id, status, detail, credits, recipients, late)
     VALUES (@job, @week_id, @status, @detail, @credits, @recipients, @late)`
  ).run({
    job: jobKey,
    week_id: fields.week_id ?? null,
    status: fields.status,
    detail: fields.detail ?? null,
    credits: fields.credits ?? 0,
    recipients: fields.recipients ?? 0,
    late: fields.late ? 1 : 0,
  });
}

/** Did this job already run for the week it would target? */
function alreadyRanForWeek(jobKey, weekId) {
  if (!weekId) return false;
  const row = db
    .prepare(`SELECT 1 FROM job_runs WHERE job = ? AND week_id = ? AND status = 'sent' LIMIT 1`)
    .get(jobKey, weekId);
  return Boolean(row);
}

/* ---------------- the work ---------------- */

/** Tuesday may need to create the week before it can announce it. */
function ensureWeekForOpen() {
  let week = currentWeek();
  if (week && week.status === 'open') return week;
  if (getSetting('auto_open_week') !== '1') return week;

  const season = activeSeason();
  const next = db
    .prepare('SELECT COALESCE(MAX(week_number), 0) + 1 AS n FROM weeks WHERE season_id = ?')
    .get(season.id).n;
  const prevBozo = db
    .prepare(
      `SELECT b.user_id FROM bozos b JOIN weeks w ON w.id = b.week_id
       WHERE w.season_id = ? ORDER BY w.week_number DESC LIMIT 1`
    )
    .get(season.id);
  const stake = parseInt(getSetting('default_stake_cents'), 10) || 2000;

  const id = db
    .prepare(
      `INSERT INTO weeks (season_id, week_number, status, stake_cents, payer_user_id)
       VALUES (?, ?, 'open', ?, ?)`
    )
    .run(season.id, next, stake, prevBozo?.user_id || null).lastInsertRowid;

  return game.getWeek(id);
}

/**
 * Run one job.
 * @param {'open'|'mid'|'final'} jobKey
 * @param {object} opts  { dryRun } — dryRun builds and returns without sending
 */
async function runJob(jobKey, { dryRun = false, late = false, force = false } = {}) {
  const job = JOBS.find((j) => j.key === jobKey);
  if (!job) throw new Error(`Unknown job: ${jobKey}`);

  if (dryRun) return runJobInner(job, { dryRun, late });

  if (inFlight.has(jobKey)) return { ok: false, skipped: true, reason: `${jobKey} is already running.` };
  inFlight.add(jobKey);
  try {
    // Scheduled and catch-up sends are once per week; a manual "Send now" may repeat.
    if (!force) {
      const wk = currentWeek();
      if (wk && alreadyRanForWeek(jobKey, wk.id)) {
        return { ok: false, skipped: true, reason: `${jobKey} already went out for week ${wk.week_number}.` };
      }
    }
    return await runJobInner(job, { dryRun, late });
  } finally {
    inFlight.delete(jobKey);
  }
}

async function runJobInner(job, { dryRun, late }) {
  const jobKey = job.key;

  let week = jobKey === 'open' ? ensureWeekForOpen() : currentWeek();

  // currentWeek() falls back to the latest FINAL week when nothing is live.
  // Emailing "Week 3 is open!" about a finished week, or re-pricing a dead
  // ticket for the payer, is worse than sending nothing.
  if (!week || week.status === 'final' || (jobKey === 'open' && week.status !== 'open')) {
    const reason = !week ? 'No week to report on.' : `Week ${week.week_number} is ${week.status}.`;
    if (!dryRun) recordRun(jobKey, { status: 'skipped', detail: reason });
    return { ok: false, skipped: true, reason };
  }

  // The placement sheet names every leg. That is the moment picks stop being
  // secret, so Saturday locks the week before it says a word — which is also
  // what "final" means.
  if (jobKey === 'final' && week.status === 'open' && !dryRun) {
    db.prepare("UPDATE weeks SET status = 'locked' WHERE id = ? AND status = 'open'").run(week.id);
    week = game.getWeek(week.id);
  }

  // Thursday only spends credits if explicitly told to.
  const refresh = jobKey === 'final' || (jobKey === 'mid' && getSetting('mid_refresh_lines') === '1');
  const built = await digest.build(refresh ? jobKey : jobKey === 'mid' ? 'mid' : jobKey, week.id, {
    force: jobKey === 'final',
  });

  if (dryRun) return { ok: true, dry_run: true, digest: built, week };

  const results = await digest.send(built, { audience: job.audience });
  const delivered = results.filter((r) => r.ok).length;

  recordRun(jobKey, {
    week_id: week.id,
    status: 'sent',
    detail: `${built.subject} · ${delivered}/${results.length} delivered`,
    credits: built.credits || 0,
    recipients: delivered,
    late,
  });

  return { ok: true, digest: built, results, week, delivered };
}

/* ---------------- catch-up ---------------- */

/**
 * Run anything whose slot has passed but that never fired — a restart during
 * the scheduled minute, or a host that was asleep.
 */
async function catchUp() {
  if (getSetting('schedule_enabled') !== '1') return [];
  const week = currentWeek();
  if (!week) return [];

  const ran = [];
  for (const job of JOBS) {
    if (alreadyRanForWeek(job.key, week.id)) continue;

    const expr = getSetting(job.setting);
    if (!expr || !cron.validate(expr)) continue;

    const due = lastScheduledTime(expr);
    if (!due) continue;

    const hoursLate = (Date.now() - due.getTime()) / 3600000;
    if (hoursLate < 0 || hoursLate > (CATCHUP_HOURS[job.key] || 24)) continue;

    try {
      const res = await runJob(job.key, { late: true });
      if (res.ok) ran.push({ job: job.key, hours_late: Number(hoursLate.toFixed(1)) });
    } catch (err) {
      recordRun(job.key, { week_id: week.id, status: 'failed', detail: err.message, late: 1 });
    }
  }
  return ran;
}

/**
 * When a 5-field cron expression last came due, in the configured timezone.
 * Only the shapes this app uses (fixed minute, fixed hour, day-of-week) need to
 * be understood, so this walks back a day at a time rather than pulling in a
 * full cron parser.
 */
function lastScheduledTime(expr, now = new Date()) {
  const [min, hour, , , dow] = expr.trim().split(/\s+/);
  const minute = parseInt(min, 10);
  const hours = parseInt(hour, 10);
  const days = parseDays(dow);
  // Step forms (*/2) are valid cron but not something this app schedules;
  // catch-up simply doesn't apply to them. The cron task itself still fires.
  if (!Number.isFinite(minute) || !Number.isFinite(hours) || days === false) return null;

  const tz = getSetting('schedule_timezone') || 'America/New_York';

  for (let back = 0; back <= 8; back++) {
    const day = new Date(now.getTime() - back * 86400000);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(day);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    if (days && !days.includes(wd)) continue;

    // Build the instant for that local date+time. The offset depends on the
    // instant (DST), so probe once at a naive guess, then again at the result —
    // the second pass is what keeps a 3am job honest on a transition Sunday.
    const iso = `${get('year')}-${get('month')}-${get('day')}T${String(hours).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
    const naive = new Date(`${iso}Z`);
    let actual = new Date(naive.getTime() + tzOffsetMinutes(tz, naive) * 60000);
    actual = new Date(naive.getTime() + tzOffsetMinutes(tz, actual) * 60000);
    if (actual.getTime() <= now.getTime()) return actual;
  }
  return null;
}

/** "2", "2,4", "1-5", "*" → array of weekday numbers; null for *; false for unsupported. */
function parseDays(field) {
  if (field === '*' || field === undefined) return null;
  const out = [];
  for (const token of field.split(',')) {
    const range = token.match(/^(\d)-(\d)$/);
    if (range) {
      for (let d = Number(range[1]); d <= Number(range[2]); d++) out.push(d);
      continue;
    }
    if (/^\d$/.test(token)) {
      out.push(Number(token));
      continue;
    }
    return false;
  }
  return out;
}

/** Minutes to add to a UTC-interpreted local time to get the real instant. */
function tzOffsetMinutes(timeZone, at) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(at);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return (at.getTime() - asUTC) / 60000;
}

/* ---------------- lifecycle ---------------- */

function stop() {
  for (const t of tasks) t.stop();
  tasks = [];
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

/** (Re)build every cron task from current settings. Safe to call repeatedly. */
function start() {
  stop();
  if (getSetting('schedule_enabled') !== '1') {
    return { enabled: false, jobs: [] };
  }

  const tz = getSetting('schedule_timezone') || 'America/New_York';
  const started = [];

  for (const job of JOBS) {
    const expr = getSetting(job.setting);
    if (!expr || !cron.validate(expr)) {
      console.warn(`[scheduler] skipping ${job.key}: invalid cron "${expr}"`);
      continue;
    }
    const task = cron.schedule(
      expr,
      () => {
        runJob(job.key, { force: false }).catch((err) => {
          console.error(`[scheduler] ${job.key} failed:`, err.message);
          recordRun(job.key, { status: 'failed', detail: err.message });
        });
      },
      { timezone: tz }
    );
    tasks.push(task);
    started.push({ job: job.key, cron: expr, label: job.label });
  }

  // Boot sweep, then every 15 minutes.
  catchUp().catch((err) => console.error('[scheduler] catch-up failed:', err.message));
  sweeper = setInterval(() => {
    catchUp().catch((err) => console.error('[scheduler] catch-up failed:', err.message));
  }, 15 * 60 * 1000);
  if (sweeper.unref) sweeper.unref();

  console.log(`[scheduler] ${started.length} jobs armed (${tz})`);
  return { enabled: true, timezone: tz, jobs: started };
}

/** What the admin panel shows. */
function status() {
  const enabled = getSetting('schedule_enabled') === '1';
  const tz = getSetting('schedule_timezone') || 'America/New_York';
  const week = currentWeek();

  return {
    enabled,
    timezone: tz,
    running: tasks.length,
    channels: (getSetting('schedule_channels') || 'email').split(',').filter(Boolean),
    mid_refresh_lines: getSetting('mid_refresh_lines') === '1',
    auto_open_week: getSetting('auto_open_week') === '1',
    injury_feed: getSetting('injury_feed') === '1',
    jobs: JOBS.map((j) => {
      const expr = getSetting(j.setting);
      const last = lastRun(j.key);
      return {
        key: j.key,
        label: j.label,
        setting: j.setting,
        cron: expr,
        valid: Boolean(expr && cron.validate(expr)),
        last_run: last?.created_at || null,
        last_detail: last?.detail || null,
        last_credits: last?.credits ?? null,
        ran_this_week: alreadyRanForWeek(j.key, week?.id),
      };
    }),
    recent: db.prepare('SELECT * FROM job_runs ORDER BY id DESC LIMIT 15').all(),
    quota: odds.quotaStatus(),
  };
}

module.exports = { start, stop, status, runJob, catchUp, lastScheduledTime, parseDays, JOBS };
