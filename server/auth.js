'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const COOKIE_NAME = 'bmb_session';
const SESSION_DAYS = 30;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SESSION_SECRET must be set to a random string of 16+ characters in production.');
    }
    return 'insecure-dev-secret-do-not-use-in-production';
  }
  return s;
}

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function verifyPassword(plain, hash) {
  try {
    return bcrypt.compareSync(plain, hash);
  } catch {
    return false;
  }
}

/* ---------- stateless signed-cookie sessions ---------- */

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function issueToken(userId) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const body = b64url(JSON.stringify({ uid: userId, exp }));
  return `${body}.${sign(body)}`;
}

function readToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = sign(body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, userId) {
  const secure = process.env.NODE_ENV === 'production' && process.env.INSECURE_COOKIES !== '1';
  res.cookie(COOKIE_NAME, issueToken(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: SESSION_DAYS * 86400000,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/* ---------- middleware ---------- */

const publicUserCols =
  'id, username, display_name, email, phone, avatar, venmo, is_admin, is_active, created_at';

function attachUser(req, res, next) {
  req.user = null;
  const cookies = parseCookies(req.headers.cookie);
  const data = readToken(cookies[COOKIE_NAME]);
  if (data) {
    const user = db.prepare(`SELECT ${publicUserCols} FROM users WHERE id = ? AND is_active = 1`).get(data.uid);
    if (user) req.user = { ...user, is_admin: !!user.is_admin };
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    // req.path is router-relative once mounted, so the full URL is what tells
    // an API call apart from a page load. API callers get JSON, not a redirect.
    if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in.' });
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  if (!req.user.is_admin) return res.status(403).json({ error: 'Commissioner access only.' });
  next();
}

/* ---------- brute-force throttle (in-memory, per process) ---------- */

const attempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

function loginThrottle(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.first > WINDOW_MS) {
    attempts.set(key, { count: 1, first: now });
    return { blocked: false, remaining: MAX_ATTEMPTS - 1 };
  }
  rec.count += 1;
  return { blocked: rec.count > MAX_ATTEMPTS, remaining: Math.max(0, MAX_ATTEMPTS - rec.count) };
}

function clearThrottle(key) {
  attempts.delete(key);
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  setSessionCookie,
  clearSessionCookie,
  attachUser,
  requireAuth,
  requireAdmin,
  loginThrottle,
  clearThrottle,
  publicUserCols,
  issueToken,
  readToken,
};
