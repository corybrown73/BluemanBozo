'use strict';

/**
 * Two weeks opened in the wrong order.
 *
 * Week 1 was opened, then week 2 by accident. The Pick tab fills the latest
 * open week, so the first Sunday's picks all landed in "week 2", got graded
 * there, and the bozo was crowned there. Then everyone picked the second
 * Sunday into the leftover "week 1". The record reads backwards and nothing
 * else about it is wrong — so the fix moves nothing but the numbers.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-renumber-test-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough';
process.env.NODE_ENV = 'test';
process.env.ODDS_API_KEY = '';

const { db, currentWeek } = require('../server/db');
const { hashPassword } = require('../server/auth');
const calendar = require('../server/calendar');
const { app } = require('../server/index');

let server;
let base;
const jars = {};

async function as(user, method, url, body) {
  const jar = (jars[user] = jars[user] || {});
  const res = await fetch(base + url, {
    method,
    redirect: 'manual',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(Object.keys(jar).length ? { Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar[pair.slice(0, i)] = pair.slice(i + 1);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}

const pick = (player, line) => ({
  player, market: 'player_rush_yds', market_label: 'Rushing Yards', selection: 'Over', line, price: -110,
});

let ids;
let leftover; // opened first, numbered 1, holds the SECOND Sunday's picks
let accident; // opened by accident, numbered 2, holds the FIRST Sunday's results

test.before(async () => {
  db.prepare('INSERT INTO seasons (year, label, is_active) VALUES (2026, ?, 1)').run('2026 Season');
  const mk = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, avatar, is_admin) VALUES (?, ?, ?, ?, ?)'
  );
  mk.run('boss', 'Boss', hashPassword('password123'), '👑', 1);
  mk.run('m', 'Member', hashPassword('password123'), '🤡', 0);
  ids = Object.fromEntries(db.prepare('SELECT id, username FROM users').all().map((r) => [r.username, r.id]));

  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const u of Object.keys(ids)) await as(u, 'POST', '/api/auth/login', { username: u, password: 'password123' });

  leftover = (await as('boss', 'POST', '/api/weeks', {})).data.week;
  // The API refuses a second open week now; this is how the accident used to happen.
  const seasonId = db.prepare('SELECT id FROM seasons').get().id;
  const planted = db.prepare(`INSERT INTO weeks (season_id, week_number, status, stake_cents) VALUES (?, 2, 'open', 2000)`).run(seasonId);
  accident = { id: Number(planted.lastInsertRowid), week_number: 2 };
  assert.deepStrictEqual([leftover.week_number, accident.week_number], [1, 2]);

  // First Sunday: everyone's picks went into the latest open week — the accident.
  await as('boss', 'POST', `/api/weeks/${accident.id}/picks`, pick('Boss Guy', 50.5));
  await as('m', 'POST', `/api/weeks/${accident.id}/picks`, pick('Member Guy', 80.5));
  await as('boss', 'PATCH', `/api/weeks/${accident.id}`, { status: 'locked' });
  const picks = (await as('boss', 'GET', `/api/weeks/${accident.id}`)).data.picks;
  await as('boss', 'POST', `/api/weeks/${accident.id}/grade`, {
    results: picks.map((p) => ({ pick_id: p.id, actual_value: p.username === 'm' ? 10 : 90 })),
  });
  await as('boss', 'POST', `/api/weeks/${accident.id}/bozo`, {});

  // Second Sunday: picks went into the week that was left, still calling itself 1.
  await as('boss', 'POST', `/api/weeks/${leftover.id}/picks`, pick('Boss Again', 40.5));
  await as('m', 'POST', `/api/weeks/${leftover.id}/picks`, pick('Member Again', 70.5));
});

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('the record reads backwards before the fix', async () => {
  const done = (await as('m', 'GET', `/api/weeks/${accident.id}`)).data;
  assert.strictEqual(done.week.week_number, 2);
  assert.strictEqual(done.week.status, 'final');
  assert.strictEqual(done.bozo.display_name, 'Member');
  const now = (await as('m', 'GET', `/api/weeks/${leftover.id}`)).data;
  assert.strictEqual(now.week.week_number, 1);
  assert.strictEqual(now.payer, null, 'nobody is on the hook, because "week 1" has no week before it');
});

test('only the commissioner can renumber, and only to a sensible number', async () => {
  assert.strictEqual((await as('m', 'POST', `/api/weeks/${leftover.id}/renumber`, { week_number: 2 })).status, 403);
  const same = await as('boss', 'POST', `/api/weeks/${leftover.id}/renumber`, { week_number: 1 });
  assert.strictEqual(same.status, 400);
  assert.match(same.data.error, /already week 1/);
  assert.strictEqual((await as('boss', 'POST', `/api/weeks/${leftover.id}/renumber`, { week_number: 0 })).status, 400);
  assert.strictEqual((await as('boss', 'POST', `/api/weeks/${leftover.id}/renumber`, { week_number: 'x' })).status, 400);
  assert.strictEqual((await as('boss', 'POST', `/api/weeks/${leftover.id}/renumber`, { week_number: 23 })).status, 400);
});

test('renumbering into a taken number trades places and moves nothing else', async () => {
  const r = await as('boss', 'POST', `/api/weeks/${leftover.id}/renumber`, { week_number: 2 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.deepStrictEqual({ from: r.data.from, to: r.data.to }, { from: 1, to: 2 });
  assert.deepStrictEqual(r.data.swapped_with, { id: accident.id, week_number: 1 });
  assert.ok(r.data.notes.some((n) => /week 1 is now week 2/i.test(n)), r.data.notes.join(' | '));

  // The finished week is week 1 now, with its results, votes and crown intact.
  const done = (await as('m', 'GET', `/api/weeks/${accident.id}`)).data;
  assert.strictEqual(done.week.week_number, 1);
  assert.strictEqual(done.week.status, 'final');
  assert.strictEqual(done.bozo.display_name, 'Member');
  assert.deepStrictEqual(
    done.picks.map((p) => [p.username, p.result, p.actual_value]).sort(),
    [['boss', 'win', 90], ['m', 'loss', 10]]
  );

  // This week is week 2, picks untouched, and the bill now follows the crown.
  const now = (await as('m', 'GET', `/api/weeks/${leftover.id}`)).data;
  assert.strictEqual(now.week.week_number, 2);
  assert.deepStrictEqual(now.picks.map((p) => p.player).sort(), ['Boss Again', 'Member Again']);
  assert.strictEqual(now.payer.display_name, 'Member', "week 1's bozo pays for week 2");
  assert.ok(r.data.notes.some((n) => /Member is on the hook for week 2/.test(n)), r.data.notes.join(' | '));

  // And it locks on week 2's Sunday, not week 1's.
  const at = calendar.lockAtFor(2, 2026, '12:55');
  assert.strictEqual(now.week.lock_at, at.toISOString());
  assert.strictEqual(now.week.status, at.getTime() <= Date.now() ? 'locked' : 'open');

  // The app is about the right week.
  assert.strictEqual(currentWeek().id, leftover.id);
  const state = (await as('m', 'GET', '/api/state')).data;
  assert.strictEqual(state.current_week.week.week_number, 2);
  assert.strictEqual(state.current_week.payer.display_name, 'Member');
});

test('renumbering into a free number is a plain move', async () => {
  const r = await as('boss', 'POST', `/api/weeks/${leftover.id}/renumber`, { week_number: 5 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.swapped_with, null);
  const moved = (await as('m', 'GET', `/api/weeks/${leftover.id}`)).data;
  assert.strictEqual(moved.week.week_number, 5);
  assert.strictEqual(moved.payer, null, 'week 4 has no bozo, so nobody is on the hook for week 5');
  assert.ok(!db.prepare('SELECT 1 FROM weeks WHERE week_number = 2').get(), 'and nothing is left calling itself week 2');

  // Back where it belongs.
  await as('boss', 'POST', `/api/weeks/${leftover.id}/renumber`, { week_number: 2 });
  assert.strictEqual((await as('m', 'GET', `/api/weeks/${leftover.id}`)).data.payer.display_name, 'Member');
});
