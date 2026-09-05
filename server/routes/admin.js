'use strict';

const express = require('express');
const { db, allSettings, setSetting, activeSeason, nflSeasonYear } = require('../db');
const { requireAdmin, hashPassword, publicUserCols } = require('../auth');
const odds = require('../odds');
const notify = require('../notify');
const game = require('../game');
const scheduler = require('../scheduler');
const injuries = require('../injuries');

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
      `INSERT INTO users (username, display_name, password_hash, email, phone, avatar, venmo, is_admin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      username,
      displayName,
      hashPassword(password),
      req.body?.email || null,
      req.body?.phone || null,
      req.body?.avatar || '🤡',
      req.body?.venmo || null,
      req.body?.is_admin ? 1 : 0
    );

  res.status(201).json({ user: db.prepare(`SELECT ${publicUserCols} FROM users WHERE id = ?`).get(info.lastInsertRowid) });
});

router.patch('/users/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Member not found.' });

  const updates = {};
  for (const key of ['display_name', 'email', 'phone', 'avatar', 'venmo']) {
    if (req.body?.[key] !== undefined) updates[key] = req.body[key] === '' ? null : String(req.body[key]).slice(0, 200);
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
]);

router.get('/settings', (req, res) => {
  const settings = allSettings();
  // Never ship the key back to the browser — just whether one is set.
  const hasKey = Boolean((settings.odds_api_key || process.env.ODDS_API_KEY || '').trim());
  delete settings.odds_api_key;
  res.json({
    settings,
    odds_api_key_set: hasKey,
    odds_api_key_source: settings.odds_api_key ? 'database' : process.env.ODDS_API_KEY ? 'environment' : 'none',
    quota: odds.quotaStatus(),
    channels: notify.channelStatus(),
    available_markets: odds.MARKETS,
  });
});

router.patch('/settings', (req, res) => {
  const changed = [];
  for (const [key, value] of Object.entries(req.body || {})) {
    if (!EDITABLE_SETTINGS.has(key)) continue;
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
  res.json({ quota: odds.quotaStatus(), by_endpoint: rows, recent });
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
    const result = await scheduler.runJob(req.params.job);
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

/** Clear cached odds so the next request refetches. Costs credits next call. */
router.post('/cache/clear', (req, res) => {
  const info = db.prepare('DELETE FROM odds_cache').run();
  res.json({ ok: true, cleared: info.changes });
});

module.exports = router;
