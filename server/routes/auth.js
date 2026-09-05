'use strict';

const express = require('express');
const { db } = require('../db');
const auth = require('../auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

  const key = `${req.ip}|${username.toLowerCase()}`;
  const throttle = auth.loginThrottle(key);
  if (throttle.blocked) {
    return res.status(429).json({ error: 'Too many attempts. Take a lap and try again in 10 minutes.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password.', attempts_left: throttle.remaining });
  }

  auth.clearThrottle(key);
  auth.setSessionCookie(res, user.id);
  res.json({
    ok: true,
    user: { id: user.id, username: user.username, display_name: user.display_name, avatar: user.avatar, is_admin: !!user.is_admin },
  });
});

router.post('/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ user: req.user || null });
});

router.post('/change-password', auth.requireAuth, (req, res) => {
  const current = String(req.body?.current_password || '');
  const next = String(req.body?.new_password || '');
  if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!auth.verifyPassword(current, row.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(next), req.user.id);
  res.json({ ok: true });
});

const PROFILE_LIMITS = { display_name: 40, email: 120, phone: 24, avatar: 8, venmo: 40 };

router.patch('/profile', auth.requireAuth, (req, res) => {
  const fields = {};
  for (const key of Object.keys(PROFILE_LIMITS)) {
    if (!(key in (req.body || {}))) continue;
    const value = req.body[key] === '' || req.body[key] === null ? null : String(req.body[key]);
    // Output is escaped everywhere; this just keeps a "name" from being a novel.
    fields[key] = value === null ? null : value.replace(/[\u0000-\u001f]/g, '').slice(0, PROFILE_LIMITS[key]);
  }
  if (fields.display_name === null || fields.display_name === '') {
    return res.status(400).json({ error: 'Display name cannot be empty.' });
  }
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nothing to update.' });

  const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE users SET ${sets} WHERE id = @id`).run({ ...fields, id: req.user.id });
  const user = db.prepare(`SELECT ${auth.publicUserCols} FROM users WHERE id = ?`).get(req.user.id);
  res.json({ ok: true, user: { ...user, is_admin: !!user.is_admin } });
});

module.exports = router;
