'use strict';

const express = require('express');
const { db, allSettings, setSetting, activeSeason, nflSeasonYear } = require('../db');
const { requireAdmin, hashPassword, publicUserCols } = require('../auth');
const history = require('../history');
const odds = require('../odds');
const notify = require('../notify');
const game = require('../game');
const scheduler = require('../scheduler');
const injuries = require('../injuries');
const rosterFeed = require('../roster');

const router = express.Router();
router.use(requireAdmin);

/* ---------------- members ---------------- */

router.get('/users', (req, res) => {
  res.json({ users: game.listUsers({ includeInactive: true }) });
});

router.post('/users', (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const displayName = String(req.body?.display_name || '').trim() || username;
  const password = String(req.body?.password || '');

  if (!/^[a-z0-9_.-]{2,32}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 2-32 characters: letters, numbers, dot, dash, underscore.' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'That username is taken.' });
  }

  const info = db
    .prepare(
      `INSERT INTO users (username, display_name, password_hash, email, phone, avatar, is_admin)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      username,
      displayName,
      hashPassword(password),
      req.body?.email || null,
      req.body?.phone || null,
      req.body?.avatar || '🤡',
      req.body?.is_admin ? 1 : 0
    );

  res.status(201).json({ user: db.prepare(`SELECT ${publicUserCols} FROM users WHERE id = ?`).get(info.lastInsertRowid) });
});

router.patch('/users/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Member not found.' });

  const LIMITS = { display_name: 40, email: 120, phone: 24, avatar: 8 };
  const updates = {};
  for (const key of Object.keys(LIMITS)) {
    if (req.body?.[key] === undefined) continue;
    const value = req.body[key] === '' || req.body[key] === null ? null : String(req.body[key]);
    updates[key] = value === null ? null : value.replace(/[\u0000-\u001f]/g, '').slice(0, LIMITS[key]);
  }
  if (req.body?.is_admin !== undefined) {
    // Don't let the last commissioner demote themselves out of the building.
    if (!req.body.is_admin && user.is_admin) {
      const admins = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND is_active = 1').get().n;
      if (admins <= 1) return res.status(400).json({ error: 'The group needs at least one commissioner.' });
    }
    updates.is_admin = req.body.is_admin ? 1 : 0;
  }
  if (req.body?.is_active !== undefined) {
    if (!req.body.is_active && user.is_admin) {
      const admins = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND is_active = 1').get().n;
      if (admins <= 1) return res.status(400).json({ error: 'The group needs at least one active commissioner.' });
    }
    updates.is_active = req.body.is_active ? 1 : 0;
  }
  if (req.body?.password) {
    if (String(req.body.password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    updates.password_hash = hashPassword(String(req.body.password));
  }

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update.' });
  const sets = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE users SET ${sets} WHERE id = @id`).run({ ...updates, id });

  res.json({ user: db.prepare(`SELECT ${publicUserCols} FROM users WHERE id = ?`).get(id) });
});

/* ---------------- seasons ---------------- */

router.get('/seasons', (req, res) => {
  res.json({ seasons: db.prepare('SELECT * FROM seasons ORDER BY year DESC').all(), active: activeSeason() });
});

router.post('/seasons', (req, res) => {
  const year = parseInt(req.body?.year, 10) || nflSeasonYear(new Date());
  if (db.prepare('SELECT 1 FROM seasons WHERE year = ?').get(year)) {
    return res.status(409).json({ error: `The ${year} season already exists.` });
  }
  const info = db
    .prepare('INSERT INTO seasons (year, label, is_active) VALUES (?, ?, 0)')
    .run(year, req.body?.label || `${year} Season`);
  res.status(201).json({ season: db.prepare('SELECT * FROM seasons WHERE id = ?').get(info.lastInsertRowid) });
});

router.post('/seasons/:id/activate', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!db.prepare('SELECT 1 FROM seasons WHERE id = ?').get(id)) return res.status(404).json({ error: 'Season not found.' });
  db.transaction(() => {
    db.prepare('UPDATE seasons SET is_active = 0').run();
    db.prepare('UPDATE seasons SET is_active = 1 WHERE id = ?').run(id);
  })();
  res.json({ season: db.prepare('SELECT * FROM seasons WHERE id = ?').get(id) });
});

/* ---------------- settings ---------------- */

const EDITABLE_SETTINGS = new Set([
  'group_name',
  'picks_per_user',
  'allow_self_vote',
  'hide_picks_until_lock',
  'default_stake_cents',
  'odds_regions',
  'odds_markets',
  'props_cache_minutes',
  'events_cache_minutes',
  'monthly_credit_cap',
  'site_url',
  'odds_api_key',
  'clock_enabled',
  'lock_time_et',
  'live_interval_minutes',
]);

router.get('/settings', (req, res) => {
  const settings = allSettings();
  // Never ship the key back to the browser — just whether one is set, and where from.
  const dbKey = (settings.odds_api_key || '').trim();
  const envKey = (process.env.ODDS_API_KEY || '').trim();
  delete settings.odds_api_key;
  res.json({
    settings,
    odds_api_key_set: Boolean(dbKey || envKey),
    odds_api_key_source: dbKey ? 'database' : envKey ? 'environment' : 'none',
    quota: odds.quotaStatus(),
    channels: notify.channelStatus(),
    available_markets: odds.MARKETS,
  });
});

router.patch('/settings', (req, res) => {
  const changed = [];
  for (const [key, value] of Object.entries(req.body || {})) {
    if (!EDITABLE_SETTINGS.has(key)) continue;
    if (key === 'lock_time_et') {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
      if (!m || +m[1] > 23 || +m[2] > 59) {
        return res.status(400).json({ error: `"${value}" is not a time. Use HH:MM, Eastern — 12:55 for the early kickoff.` });
      }
      setSetting(key, `${String(+m[1]).padStart(2, '0')}:${m[2]}`);
      changed.push(key);
      continue;
    }
    if (key === 'live_interval_minutes') {
      const n = parseInt(value, 10);
      if (!Number.isInteger(n) || n < 1 || n > 60) {
        return res.status(400).json({ error: 'Live stats interval must be a whole number of minutes from 1 to 60.' });
      }
      setSetting(key, String(n));
      changed.push(key);
      continue;
    }
    if (key === 'clock_enabled') {
      setSetting(key, value === '0' || value === false || value === 0 ? '0' : '1');
      changed.push(key);
      continue;
    }
    setSetting(key, value);
    changed.push(key);
  }
  if (!changed.length) return res.status(400).json({ error: 'No recognized settings in that request.' });
  const settings = allSettings();
  delete settings.odds_api_key;
  res.json({ ok: true, changed, settings, quota: odds.quotaStatus() });
});

/* ---------------- diagnostics ---------------- */

router.get('/usage', (req, res) => {
  const rows = db
    .prepare(
      `SELECT endpoint, COUNT(*) AS calls, SUM(credits) AS credits, month
       FROM api_usage GROUP BY month, endpoint ORDER BY month DESC, credits DESC LIMIT 60`
    )
    .all();
  const recent = db.prepare('SELECT * FROM api_usage ORDER BY id DESC LIMIT 25').all();

  // Credits per football week, so one real week can be measured and the month
  // projected from it — rather than guessing what a slate costs.
  const byWeek = db
    .prepare(
      `SELECT strftime('%Y-W%W', created_at) AS week,
              MIN(date(created_at)) AS starting,
              SUM(credits) AS credits,
              COUNT(*) AS calls
       FROM api_usage
       WHERE credits > 0
       GROUP BY week
       ORDER BY week DESC
       LIMIT 8`
    )
    .all();

  // Project from the most recent COMPLETE week, not a half-finished one.
  const quota = odds.quotaStatus();
  const basis = byWeek.find((w) => w.credits > 0) || null;
  const projection = basis
    ? {
        basis_week: basis.starting,
        credits_that_week: basis.credits,
        projected_month: Math.round(basis.credits * 4.33),
        plan_size: quota.plan_size,
        fits: quota.plan_size ? Math.round(basis.credits * 4.33) <= quota.plan_size : null,
      }
    : null;

  res.json({ quota, by_endpoint: rows, by_week: byWeek, projection, recent });
});

router.get('/notifications', (req, res) => {
  res.json({
    notifications: db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 50').all(),
    channels: notify.channelStatus(),
  });
});

router.post('/notifications/test', async (req, res) => {
  const channel = req.body?.channel === 'sms' ? 'sms' : 'email';
  const target = String(req.body?.target || '').trim();
  if (!target) return res.status(400).json({ error: 'Enter an address or phone number to test.' });

  const body = `🤡 Blue Man Bozo test message. If you're reading this, the ${channel} pipe works.`;
  const result =
    channel === 'sms'
      ? await notify.sendSms({ to: target, body, user_id: req.user.id })
      : await notify.sendEmail({ to: target, subject: '🤡 Blue Man Bozo test', text: body, user_id: req.user.id });

  res.status(result.ok ? 200 : 400).json(result);
});

/* ---------------- weekly schedule ---------------- */

router.get('/schedule', (req, res) => {
  res.json(scheduler.status());
});

/** Build a digest without sending it — costs whatever its line refresh costs. */
router.post('/schedule/preview/:job', async (req, res) => {
  try {
    const result = await scheduler.runJob(req.params.job, { dryRun: true });
    if (!result.ok) return res.status(400).json({ error: result.reason || 'Nothing to preview.' });
    res.json({
      subject: result.digest.subject,
      text: result.digest.text,
      credits: result.digest.credits || 0,
      injury_flags: result.digest.injury_flags || [],
      moves: result.digest.moves || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Fire a job now, for real. */
router.post('/schedule/run/:job', async (req, res) => {
  try {
    const result = await scheduler.runJob(req.params.job, { force: true });
    if (!result.ok) return res.status(400).json({ error: result.reason || 'Nothing to send.' });
    res.json({
      ok: true,
      subject: result.digest.subject,
      delivered: result.delivered,
      credits: result.digest.credits || 0,
      results: result.results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Cron settings live here so the scheduler can be rebuilt on save. */
router.patch('/schedule', (req, res) => {
  const allowed = [
    'schedule_enabled', 'schedule_timezone', 'cron_open', 'cron_mid', 'cron_final',
    'schedule_channels', 'auto_open_week', 'injury_feed', 'mid_refresh_lines',
  ];
  const cron = require('node-cron');
  const changed = [];

  for (const [key, value] of Object.entries(req.body || {})) {
    if (!allowed.includes(key)) continue;
    if (key.startsWith('cron_') && value && !cron.validate(String(value))) {
      return res.status(400).json({ error: `"${value}" is not a valid cron expression for ${key}.` });
    }
    if (key === 'schedule_timezone' && value) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: String(value) });
      } catch {
        return res.status(400).json({ error: `"${value}" is not a recognized timezone.` });
      }
    }
    setSetting(key, value);
    changed.push(key);
  }
  if (!changed.length) return res.status(400).json({ error: 'No schedule settings in that request.' });

  scheduler.start(); // rebuild with the new settings
  res.json({ ok: true, changed, status: scheduler.status() });
});

/** Verify the free ESPN injury feed. */
router.get('/injuries', async (req, res) => {
  const result = await injuries.getInjuries({ force: req.query.force === '1' });
  res.json({
    count: result.injuries.length,
    cached: result.cached,
    stale: result.stale || false,
    error: result.error || null,
    sample: result.injuries.slice(0, 8),
  });
});

/** Verify the free ESPN roster feed that powers grouping by team. */
router.get('/roster', async (req, res) => {
  const result = await rosterFeed.getRoster({ force: req.query.force === '1' });
  res.json({
    available: Boolean(result.roster),
    players: result.roster ? Object.keys(result.roster.players).length : 0,
    teams: result.roster ? result.roster.teams.length : 0,
    rosters_loaded: result.roster?.rosters_loaded ?? 0,
    cached: result.cached,
    stale: result.stale || false,
    error: result.error || null,
  });
});

/* ---------------- importing the old spreadsheet ---------------- */

/**
 * What importing the sheet would do. Reads only — nothing is written until
 * the commissioner has seen this and confirmed the column mapping.
 */
router.post('/history/preview', (req, res) => {
  const year = parseInt(req.body?.season_year, 10);
  const result = history.preview({
    csv: typeof req.body?.csv === 'string' ? req.body.csv : undefined,
    seasonYear: Number.isFinite(year) ? year : undefined,
  });
  res.status(result.ok ? 200 : 400).json(result);
});

/**
 * Write it in. `mapping` is column name -> user id, or the string 'create'
 * for a new account, or 'skip'. Mapping to an ID rather than a name is the
 * point: someone who has since renamed keeps one career record instead of
 * gaining a second, empty account.
 */
router.post('/history/import', (req, res) => {
  const year = parseInt(req.body?.season_year, 10);
  const mapping = req.body?.mapping && typeof req.body.mapping === 'object' ? req.body.mapping : {};
  const result = history.importGrid({
    csv: typeof req.body?.csv === 'string' ? req.body.csv : undefined,
    seasonYear: Number.isFinite(year) ? year : undefined,
    mapping,
  });
  res.status(result.ok ? 200 : 400).json(result);
});

/** Clear cached odds so the next request refetches. Costs credits next call. */
router.post('/cache/clear', (req, res) => {
  const info = db.prepare('DELETE FROM odds_cache').run();
  res.json({ ok: true, cleared: info.changes });
});

module.exports = router;
