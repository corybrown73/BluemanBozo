'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const { db, getSetting } = require('./db');
const auth = require('./auth');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// Behind a reverse proxy (Render/Fly/Railway/nginx) so req.ip and secure
// cookies resolve correctly.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// Minimal cookie helpers (avoids pulling in cookie-parser for two methods).
app.use((req, res, next) => {
  res.cookie = (name, value, opts = {}) => {
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path || '/'}`];
    if (opts.maxAge) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
    if (opts.httpOnly) parts.push('HttpOnly');
    if (opts.secure) parts.push('Secure');
    parts.push(`SameSite=${opts.sameSite ? opts.sameSite[0].toUpperCase() + opts.sameSite.slice(1) : 'Lax'}`);
    const prev = res.getHeader('Set-Cookie');
    const header = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
    header.push(parts.join('; '));
    res.setHeader('Set-Cookie', header);
    return res;
  };
  res.clearCookie = (name, opts = {}) => res.cookie(name, '', { ...opts, maxAge: 0 });
  next();
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use(auth.attachUser);

app.get('/healthz', (req, res) => {
  res.json({ ok: true, users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/odds', require('./routes/odds'));
app.use('/api', require('./routes/game'));
app.use('/api/admin', require('./routes/admin'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint.' }));

/* ---------------- static + pages ---------------- */

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0, index: false }));

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('*', auth.requireAuth, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

/* ---------------- errors ---------------- */

app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something broke on our end.' });
});

function start() {
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const server = app.listen(PORT, () => {
    console.log(`\n  🤡  Blue Man Bozo running on http://localhost:${PORT}`);
    console.log(`      group:   ${getSetting('group_name')}`);
    console.log(`      members: ${userCount}`);
    if (userCount === 0) console.log('      ⚠  No members yet — run: npm run seed\n');
    else console.log('');
  });
  return server;
}

if (require.main === module) start();

module.exports = { app, start };
