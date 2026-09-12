'use strict';

/**
 * Which week the app is about.
 *
 * Tuesday's week gets opened — by hand or by the scheduler — while Sunday's
 * is still waiting on a vote. The app has one "current" week, and it used to
 * be the open one, so the vote screen simply vanished with the bozo
 * uncrowned. A week that still needs settling has to come first.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-current-test-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough';
process.env.NODE_ENV = 'test';
process.env.ODDS_API_KEY = '';

const { db, currentWeek } = require('../server/db');
const { hashPassword } = require('../server/auth');
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
let w1;
let w2;

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

  w1 = (await as('boss', 'POST', '/api/weeks', {})).data.week;
  await as('boss', 'POST', `/api/weeks/${w1.id}/picks`, pick('Boss Guy', 50.5));
  await as('m', 'POST', `/api/weeks/${w1.id}/picks`, pick('Member Guy', 80.5));
  await as('boss', 'PATCH', `/api/weeks/${w1.id}`, { status: 'locked' });
});

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('a locked week waiting on stat lines stays current when the next one opens', async () => {
  w2 = (await as('boss', 'POST', '/api/weeks', {})).data.week;
  assert.strictEqual(w2.status, 'open');

  assert.strictEqual(currentWeek().id, w1.id, 'the week that needs settling comes first');
  const state = (await as('m', 'GET', '/api/state')).data;
  assert.strictEqual(state.current_week.week.id, w1.id);
  assert.deepStrictEqual(
    { id: state.upcoming_week.id, week_number: state.upcoming_week.week_number },
    { id: w2.id, week_number: w2.week_number },
    'and the app is told which week is waiting behind it'
  );
});

test('once graded, the vote is still the current thing', async () => {
  const picks = (await as('boss', 'GET', `/api/weeks/${w1.id}`)).data.picks;
  await as('boss', 'POST', `/api/weeks/${w1.id}/grade`, {
    results: picks.map((p) => ({ pick_id: p.id, actual_value: p.username === 'm' ? 10 : 90 })),
  });
  assert.strictEqual(currentWeek().id, w1.id);
  assert.strictEqual(currentWeek().status, 'graded');

  const state = (await as('m', 'GET', '/api/state')).data;
  assert.strictEqual(state.current_week.week.voting_open, true, 'a member landing on the app can vote');
});

test('crowning the bozo hands the app to the open week', async () => {
  await as('boss', 'POST', `/api/weeks/${w1.id}/bozo`, {});
  assert.strictEqual(currentWeek().id, w2.id, 'now the open week is current');

  const state = (await as('m', 'GET', '/api/state')).data;
  assert.strictEqual(state.current_week.week.status, 'open');
  assert.strictEqual(state.upcoming_week, null, 'nothing is waiting behind an open week');
  assert.strictEqual(state.current_week.payer.display_name, 'Member', 'and the bill carried over');
});

test('a locked week nobody picked in does not hold the season hostage', async () => {
  const ghost = (await as('boss', 'POST', '/api/weeks', { week_number: 50 })).data.week;
  await as('boss', 'PATCH', `/api/weeks/${ghost.id}`, { status: 'locked' });
  assert.strictEqual(currentWeek().id, w2.id, 'an empty locked week is skipped');
});

test('an accidentally opened week can be deleted while it is empty, and only then', async () => {
  const oops = (await as('boss', 'POST', '/api/weeks', { week_number: 60 })).data.week;
  const gone = await as('boss', 'DELETE', `/api/weeks/${oops.id}`);
  assert.strictEqual(gone.status, 200);
  assert.strictEqual(gone.data.deleted, 60);
  assert.strictEqual((await as('boss', 'GET', `/api/weeks/${oops.id}`)).status, 404);

  // One with a pick in it stays, however fresh.
  const withPick = (await as('boss', 'POST', '/api/weeks', { week_number: 61 })).data.week;
  await as('boss', 'POST', `/api/weeks/${withPick.id}/picks`, pick('Somebody', 30.5));
  const keep = await as('boss', 'DELETE', `/api/weeks/${withPick.id}`);
  assert.strictEqual(keep.status, 409);
  assert.match(keep.data.error, /pick/);

  // And a settled week is never a delete, whatever is in it.
  const settled = await as('boss', 'DELETE', `/api/weeks/${w1.id}`);
  assert.strictEqual(settled.status, 409);

  const member = await as('m', 'DELETE', `/api/weeks/${withPick.id}`);
  assert.strictEqual(member.status, 403, 'members cannot delete weeks at all');
});
