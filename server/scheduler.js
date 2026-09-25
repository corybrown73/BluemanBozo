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
const { db, getSetting, activeSeason, currentWeek, pickWeek } = require('./db');
const game = require('./game');
const digest = require('./digest');
const odds = require('./odds');
const calendar = require('./calendar');
const boxscore = require('./boxscore');

const JOBS = [
  { key: 'open',  setting: 'cron_open',  label: 'Saturday — get your bets in',  audience: 'group' },
  { key: 'mid',   setting: 'cron_mid',   label: 'Midweek nudge (off)',          audience: 'group' },
  { key: 'final', setting: 'cron_final', label: 'Sunday — final numbers',       audience: 'group' },
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
function ensureWeekForOpen(now = new Date()) {
  // The week people pick in, not the one still being graded — those can be
  // different weeks on a Tuesday, and the summons must go out for the right one.
  const week = pickWeek();
  if (week) return week;
  if (getSetting('auto_open_week') !== '1') return null;
  return createWeek(calendar.nflWeekFor(now) || nextWeekNumber(), now);
}

function nextWeekNumber() {
  const season = activeSeason();
  return db.prepare('SELECT COALESCE(MAX(week_number), 0) + 1 AS n FROM weeks WHERE season_id = ?').get(season.id).n;
}

/** Open a week: last week's bozo pays, and the clock supplies its lock time. */
function createWeek(weekNumber, now = new Date()) {
  const season = activeSeason();
  if (!season) return null;
  if (db.prepare('SELECT 1 FROM weeks WHERE season_id = ? AND week_number = ?').get(season.id, weekNumber)) return null;
  const prevBozo = db
    .prepare(
      `SELECT b.user_id FROM bozos b JOIN weeks w ON w.id = b.week_id
       WHERE w.season_id = ? AND w.week_number < ? ORDER BY w.week_number DESC LIMIT 1`
    )
    .get(season.id, weekNumber);
  const stake = parseInt(getSetting('default_stake_cents'), 10) || 2000;
  let lockAt = null;
  if (getSetting('auto_lock') === '1') {
    const at = calendar.lockAtFor(weekNumber, season.year, getSetting('lock_time_et') || '12:55');
    if (at.getTime() > now.getTime()) lockAt = at.toISOString();
  }
  const id = db
    .prepare(
      `INSERT INTO weeks (season_id, week_number, status, stake_cents, payer_user_id, lock_at)
       VALUES (?, ?, 'open', ?, ?, ?)`
    )
    .run(season.id, weekNumber, stake, prevBozo?.user_id || null, lockAt).lastInsertRowid;
  return game.getWeek(id);
}

/* ---------------- the clock ---------------- */

/**
 * The commissioner is not the clock. Once a minute:
 *
 *   - an open week whose lock time has passed is locked
 *   - an open week with no lock time gets Sunday 12:55 ET
 *   - on Tuesday morning the coming Sunday's week opens, numbered off the
 *     NFL calendar, whether or not last week has been settled (it waits its
 *     turn on screen)
 *   - while games are on, every few minutes the box scores come in and each
 *     pick shows where it stands; once every game is final the week grades
 *     itself and voting opens. A player missing from a final box score is
 *     left for a human — that is a void decision, not a zero.
 *
 * Everything here can still be done by hand, and each part can be switched
 * off in settings. `now` is a parameter so the tests can set the clock.
 */
let clockTimer = null;
let lastLiveAt = 0;
/** After ESPN fails, no live pull before this instant — a hiccup must not become a minute-by-minute hammering. */
let liveHoldUntil = 0;

function lockDueWeeks(now) {
  if (getSetting('auto_lock') !== '1') return 0;
  return db
    .prepare(`UPDATE weeks SET status = 'locked' WHERE status = 'open' AND lock_at IS NOT NULL AND lock_at <= ?`)
    .run(now.toISOString()).changes;
}

function setDefaultLocks(now) {
  if (getSetting('auto_lock') !== '1') return 0;
  const season = activeSeason();
  if (!season) return 0;
  const time = getSetting('lock_time_et') || '12:55';
  let n = 0;
  for (const w of db.prepare(`SELECT * FROM weeks WHERE season_id = ? AND status = 'open' AND lock_at IS NULL`).all(season.id)) {
    let at = calendar.lockAtFor(w.week_number, season.year, time);
    if (at.getTime() <= now.getTime()) {
      const created = Date.parse(String(w.created_at).replace(' ', 'T') + 'Z');
      if (Number.isFinite(created) && created < at.getTime()) {
        // Opened before its Sunday, never given a lock time, and the games
        // have since been played: it locks now. Nobody edits a pick after
        // kickoff because a setting did not exist yet.
        db.prepare(`UPDATE weeks SET lock_at = ?, status = 'locked' WHERE id = ? AND status = 'open'`).run(at.toISOString(), w.id);
        n += 1;
        continue;
      }
      // Opened after its own Sunday: a stand-in for the coming one, so lock then.
      const s = calendar.sundayOf(now);
      at = calendar.etToUtc(s.y, s.m, s.d, ...time.split(':').map((x) => parseInt(x, 10)));
      if (at.getTime() <= now.getTime()) at = new Date(at.getTime() + 7 * 86400000);
    }
    db.prepare('UPDATE weeks SET lock_at = ? WHERE id = ?').run(at.toISOString(), w.id);
    n += 1;
  }
  return n;
}

/** The clock opens nothing past this week: 18 unless the group plays on. */
function lastWeek() {
  const n = parseInt(getSetting('season_last_week'), 10);
  return Number.isInteger(n) && n >= 1 && n <= 22 ? n : 18;
}

/** SQLite's datetime('now') text, as an instant. */
function sqlInstant(text) {
  if (!text) return NaN;
  const s = String(text);
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
}

/**
 * A week left in "voting" gets its crown on Tuesday morning, when the next
 * one opens: the votes that are in decide, the Bozo Index breaks ties and
 * silence, and the commissioner can still overrule. A week graded late — a
 * no-show voided on Wednesday, say — gets half a day of voting first.
 */
function crownDueWeeks(now) {
  if (getSetting('auto_crown') !== '1') return [];
  const season = activeSeason();
  if (!season) return [];
  const hour = parseInt(getSetting('auto_open_hour_et'), 10);
  const openHour = Number.isFinite(hour) ? hour : 6;
  const out = [];
  for (const w of db.prepare(`SELECT * FROM weeks WHERE season_id = ? AND status = 'graded'`).all(season.id)) {
    if (now.getTime() < calendar.openAtFor(w.week_number + 1, season.year, openHour).getTime()) continue;
    const settled = sqlInstant(
      db.prepare('SELECT MAX(COALESCE(graded_at, updated_at)) AS at FROM picks WHERE week_id = ?').get(w.id).at
    );
    if (Number.isFinite(settled) && now.getTime() - settled < 12 * 3600000) continue;
    const crowned = game.crownBozo(w);
    if (crowned) {
      out.push({ week_id: w.id, week_number: w.week_number, user_id: crowned.user.id, display_name: crowned.user.display_name, method: crowned.method });
    } else {
      // Nobody lost: a perfect week closes itself.
      db.prepare("UPDATE weeks SET status = 'final' WHERE id = ? AND status = 'graded'").run(w.id);
      out.push({ week_id: w.id, week_number: w.week_number, perfect: true });
    }
  }
  return out;
}

function openDueWeek(now) {
  if (getSetting('auto_open_week') !== '1') return null;
  const season = activeSeason();
  if (!season) return null;
  if (pickWeek()) return null; // something is already open for picks
  const target = calendar.nflWeekFor(now);
  if (!target) return null;
  if (target > lastWeek()) return null; // the season is over for this group
  if (db.prepare('SELECT 1 FROM weeks WHERE season_id = ? AND week_number = ?').get(season.id, target)) return null;
  const hour = parseInt(getSetting('auto_open_hour_et'), 10);
  if (now.getTime() < calendar.openAtFor(target, season.year, Number.isFinite(hour) ? hour : 6).getTime()) return null;
  // Its Sunday already kicked off (a Monday night, say): nothing left to pick.
  if (calendar.lockAtFor(target, season.year, getSetting('lock_time_et') || '12:55').getTime() <= now.getTime()) return null;
  return createWeek(target, now);
}

/** Picks whose game is on, or just was: fifteen minutes before kickoff to four and a half hours after. */
function gamesLive(picks, now) {
  const t = now.getTime();
  return picks.some((p) => {
    const k = Date.parse(p.commence_time);
    return Number.isFinite(k) && t >= k - 15 * 60000 && t <= k + 4.5 * 3600000;
  });
}

/**
 * Games that finished while nobody was looking — a deploy or a restart after
 * Sunday — still deserve one pass, so a pick whose kickoff is within the last
 * day and a half and that has never been checked gets it.
 */
function owedAPass(picks, now) {
  const t = now.getTime();
  return picks.some((p) => {
    const k = Date.parse(p.commence_time);
    return Number.isFinite(k) && !p.live_at && p.result === 'pending' && k < t && t - k <= 36 * 3600000;
  });
}

async function liveTick(now, { fetchStats = boxscore.statsForPicks, force = false } = {}) {
  if (getSetting('live_stats') !== '1') return { skipped: 'off' };
  const season = activeSeason();
  if (!season) return { skipped: 'no season' };
  const week = db
    .prepare(
      `SELECT w.* FROM weeks w WHERE w.season_id = ? AND w.status = 'locked'
         AND EXISTS (SELECT 1 FROM picks p WHERE p.week_id = w.id)
       ORDER BY w.week_number DESC LIMIT 1`
    )
    .get(season.id);
  if (!week) return { skipped: 'nothing locked' };

  // Only what is still in play. A settled pick's box score cannot change, so
  // its game is never asked for again — at a minute's cadence that is most of
  // the calls saved.
  const picks = game.rawPicks(week.id).filter((p) => p.result === 'pending');
  const catchUpPass = owedAPass(picks, now);
  if (!force && !catchUpPass && !gamesLive(picks, now)) return { skipped: 'no games on' };
  if (!force && now.getTime() < liveHoldUntil) return { skipped: 'backing off' };
  const interval = (parseInt(getSetting('live_interval_minutes'), 10) || 1) * 60000;
  // The clock ticks once a minute and lands a few milliseconds late each time;
  // a minute's interval has to fire on every tick, so drift is forgiven.
  if (!force && !catchUpPass && now.getTime() - lastLiveAt < interval - 5000) return { skipped: 'too soon' };
  lastLiveAt = now.getTime();

  let stats;
  try {
    stats = await fetchStats(picks, { force: true });
  } catch (err) {
    stats = { error: `Could not reach ESPN: ${err.message}` };
  }
  if (stats.error) {
    liveHoldUntil = now.getTime() + 5 * 60000;
    return { week_id: week.id, error: stats.error };
  }
  liveHoldUntil = 0;
  game.applyLive(week.id, stats);

  // Final results settle themselves. The week flips to voting only once every
  // pick is settled, so a DNP still waits for the commissioner's decision.
  const finals = stats.results.filter((r) => r.final).map((r) => ({ pick_id: r.pick_id, actual_value: r.actual_value }));
  let graded = null;
  if (finals.length) graded = game.gradePicks(week, finals);
  return {
    week_id: week.id,
    live: stats.results.filter((r) => !r.final).length,
    settled: finals.length,
    unresolved: stats.unresolved.length,
    status: graded ? graded.status : week.status,
  };
}

async function clockTick(now = new Date(), deps = {}) {
  // The one switch: paused, and the commissioner is the clock again.
  if (getSetting('clock_enabled') === '0') return { paused: true, locks_set: 0, locked: 0, opened: null, live: { skipped: 'paused' } };
  const out = { locks_set: setDefaultLocks(now), locked: lockDueWeeks(now), crowned: crownDueWeeks(now), opened: null, live: null };
  const opened = openDueWeek(now);
  if (opened) out.opened = opened.week_number;
  try {
    out.live = await liveTick(now, deps);
  } catch (err) {
    out.live = { error: err.message };
  }
  return out;
}

function startClock() {
  if (clockTimer) clearInterval(clockTimer);
  const run = () =>
    clockTick().then((r) => {
      if (r.locked) console.log(`[clock] locked ${r.locked} week(s)`);
      if (r.opened) console.log(`[clock] opened week ${r.opened}`);
      for (const c of r.crowned || []) console.log(`[clock] crowned week ${c.week_number}: ${c.perfect ? 'perfect week' : c.display_name}`);
      if (r.live && !r.live.skipped) console.log(`[clock] live: ${JSON.stringify(r.live)}`);
    }).catch((err) => console.error('[clock] tick failed:', err.message));
  setTimeout(run, 5000).unref?.();
  clockTimer = setInterval(run, 60 * 1000);
  if (clockTimer.unref) clockTimer.unref();
}

/** What the clock will do next — for the screens. */
function clockStatus(now = new Date()) {
  const season = activeSeason();
  const open = pickWeek();
  const target = calendar.nflWeekFor(now);
  const hour = parseInt(getSetting('auto_open_hour_et'), 10);
  const openHour = Number.isFinite(hour) ? hour : 6;
  // The next opening is always ahead of us: after the open week's, or the
  // first calendar week whose Tuesday has not come yet.
  const last = lastWeek();
  let nextNumber = open ? open.week_number + 1 : target;
  while (season && nextNumber && nextNumber <= last && calendar.openAtFor(nextNumber, season.year, openHour).getTime() <= now.getTime()) {
    nextNumber += 1;
  }
  if (nextNumber > last) nextNumber = null;
  const liveWeek = season
    ? db.prepare(`SELECT MAX(p.live_at) AS at FROM picks p JOIN weeks w ON w.id = p.week_id WHERE w.season_id = ? AND w.status = 'locked'`).get(season.id)
    : null;
  return {
    enabled: getSetting('clock_enabled') !== '0',
    auto_lock: getSetting('auto_lock') === '1',
    lock_time_et: getSetting('lock_time_et') || '12:55',
    auto_open: getSetting('auto_open_week') === '1',
    auto_crown: getSetting('auto_crown') === '1',
    last_week: last,
    live_stats: getSetting('live_stats') === '1',
    live_interval_minutes: parseInt(getSetting('live_interval_minutes'), 10) || 1,
    nfl_week: target,
    next_lock_at: open ? open.lock_at : null,
    next_open_at: season && nextNumber && getSetting('auto_open_week') === '1'
      ? calendar.openAtFor(nextNumber, season.year, openHour).toISOString()
      : null,
    next_open_week: nextNumber,
    live_last_at: liveWeek?.at || null,
  };
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
      const wk = pickWeek();
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

  // Every job here is about the week people are picking in. Last week may
  // still be waiting on stat lines or a vote; that is the app's business, not
  // the mailer's. Emailing "Week 3 is open!" about a finished week, or
  // re-pricing a dead ticket for the payer, is worse than sending nothing.
  let week = jobKey === 'open' ? ensureWeekForOpen() : pickWeek();
  if (!week) {
    const latest = currentWeek();
    const reason = latest
      ? `Week ${latest.week_number} is ${latest.status} — nothing is open for picks.`
      : 'No week to report on.';
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
  // Both weekend sends re-price against live numbers: Saturday so the board is
  // current when people pick, Sunday so the payer places the real thing.
  const refresh =
    jobKey === 'final' || jobKey === 'open' || (jobKey === 'mid' && getSetting('mid_refresh_lines') === '1');
  const built = await digest.build(refresh ? jobKey : jobKey === 'mid' ? 'mid' : jobKey, week.id, {
    force: jobKey === 'final',
  });

  if (dryRun) return { ok: true, dry_run: true, digest: built, week };

  const results = await digest.send(built, { audience: job.audience });
  const delivered = results.filter((r) => r.ok).length;

  // A scheduled pull is a refresh too — the board should say so rather than
  // still crediting whoever last tapped the button.
  if (refresh && built.credits) {
    require('./refresh').record(week.id, null, { source: 'scheduled', credits: built.credits });
  }

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
  // Catch-up is for the picks week, same as the jobs it re-fires.
  const week = pickWeek();
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
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
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
  // The clock runs whether or not the digests are switched on.
  startClock();
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
  // The panel talks about the week the sends are for; when nothing is open
  // for picks it still needs a week to name, so it falls back to the app's.
  const week = pickWeek() || currentWeek();

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

module.exports = {
  clockTick,
  clockStatus,
  createWeek,
  liveTick, start, stop, status, runJob, catchUp, lastScheduledTime, parseDays, JOBS };
