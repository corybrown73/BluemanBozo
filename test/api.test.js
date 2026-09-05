'use strict';

/**
 * End-to-end API test against a throwaway database. Covers the week lifecycle
 * the group actually uses: sign in, pick, lock, grade, vote, crown.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-test-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough';
process.env.NODE_ENV = 'test';
// Set it empty rather than deleting: server/index.js calls dotenv.config(), which
// would re-populate a deleted key from a developer's local .env and make this
// suite depend on whether someone has real credentials sitting on disk. dotenv
// skips keys already present in process.env, so an empty string wins.
process.env.ODDS_API_KEY = '';

const { db } = require('../server/db');
const { hashPassword } = require('../server/auth');
const { app } = require('../server/index');

let server;
let base;

const jar = {};
function setJar(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar[pair.slice(0, i)] = pair.slice(i + 1);
  }
}
function cookieHeader() {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookieHeader() ? { Cookie: cookieHeader() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  setJar(res);
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  return { status: res.status, data };
}

test.before(async () => {
  db.prepare('INSERT INTO seasons (year, label, is_active) VALUES (2025, ?, 1)').run('2025 Season');
  const mk = db.prepare('INSERT INTO users (username, display_name, password_hash, avatar, is_admin) VALUES (?, ?, ?, ?, ?)');
  mk.run('boss', 'Boss', hashPassword('password123'), '👑', 1);
  mk.run('rube', 'Rube', hashPassword('password123'), '🎺', 0);

  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('API calls without a session get 401 JSON, not an HTML redirect', async () => {
  const res = await call('GET', '/api/state');
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.data.error, 'Not signed in.');
});

test('a page request without a session redirects to the login page', async () => {
  const res = await fetch(base + '/', { redirect: 'manual' });
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location'), /\/login$/);
});

test('bad credentials are rejected', async () => {
  const res = await call('POST', '/api/auth/login', { username: 'boss', password: 'wrong' });
  assert.strictEqual(res.status, 401);
});

test('the commissioner can sign in', async () => {
  const res = await call('POST', '/api/auth/login', { username: 'boss', password: 'password123' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.user.is_admin, true);
});

let weekId;

test('opening a week', async () => {
  const res = await call('POST', '/api/weeks', {});
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.data.week.week_number, 1);
  assert.strictEqual(res.data.week.status, 'open');
  weekId = res.data.week.id;
});

test('a pick needs a line on an over/under market', async () => {
  const res = await call('POST', `/api/weeks/${weekId}/picks`, {
    player: 'Nobody', market: 'player_rush_yds', selection: 'Over', price: -110,
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /needs a line/);
});

test('a pick needs valid American odds', async () => {
  const res = await call('POST', `/api/weeks/${weekId}/picks`, {
    player: 'Nobody', market: 'player_rush_yds', selection: 'Over', line: 50.5, price: 0,
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /American price/);
});

test('both members submit a pick', async () => {
  let res = await call('POST', `/api/weeks/${weekId}/picks`, {
    player: 'Bijan Robinson', market: 'player_rush_yds', market_label: 'Rushing Yards',
    selection: 'Over', line: 71.5, price: -110,
  });
  assert.strictEqual(res.status, 200);

  res = await call('POST', `/api/weeks/${weekId}/picks`, {
    user_id: 2, player: 'Zay Flowers', market: 'player_reception_yds', market_label: 'Receiving Yards',
    selection: 'Over', line: 60.5, price: -115,
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.picks.length, 2);
});

test("picks stay hidden from other members until the week locks", async () => {
  await call('POST', '/api/auth/login', { username: 'rube', password: 'password123' });
  const res = await call('GET', '/api/state');
  const picks = res.data.current_week.picks;
  const mine = picks.find((p) => p.user_id === 2);
  const theirs = picks.find((p) => p.user_id === 1);
  assert.strictEqual(mine.hidden, false, 'you always see your own pick');
  assert.strictEqual(theirs.hidden, true, "you cannot see someone else's pick before lock");
  assert.strictEqual(theirs.player, undefined, 'the hidden pick leaks no details');
});

test('a non-admin cannot lock the week', async () => {
  const res = await call('PATCH', `/api/weeks/${weekId}`, { status: 'locked' });
  assert.strictEqual(res.status, 403);
});

test('a non-admin cannot grade picks', async () => {
  const res = await call('POST', `/api/weeks/${weekId}/grade`, { results: [] });
  assert.strictEqual(res.status, 403);
});

test('locking reveals every pick and prices the parlay', async () => {
  await call('POST', '/api/auth/login', { username: 'boss', password: 'password123' });
  const res = await call('PATCH', `/api/weeks/${weekId}`, { status: 'locked' });
  assert.strictEqual(res.data.week.status, 'locked');
  assert.ok(res.data.picks.every((p) => !p.hidden));
  assert.strictEqual(res.data.parlay.leg_count, 2);
  assert.strictEqual(res.data.parlay.status, 'live');
});

test('picks are refused once the week is locked', async () => {
  await call('POST', '/api/auth/login', { username: 'rube', password: 'password123' });
  const res = await call('POST', `/api/weeks/${weekId}/picks`, {
    player: 'Too Late', market: 'player_rush_yds', selection: 'Over', line: 10.5, price: -110,
  });
  assert.strictEqual(res.status, 409);
  await call('POST', '/api/auth/login', { username: 'boss', password: 'password123' });
});

test('voting is refused before results are in', async () => {
  const res = await call('POST', `/api/weeks/${weekId}/vote`, { nominee_id: 2 });
  assert.strictEqual(res.status, 409);
});

test('grading computes results and opens voting', async () => {
  const detail = await call('GET', `/api/weeks/${weekId}`);
  const [a, b] = detail.data.picks;
  const res = await call('POST', `/api/weeks/${weekId}/grade`, {
    results: [
      { pick_id: a.id, actual_value: 95 },  // Bijan over 71.5 -> win
      { pick_id: b.id, actual_value: 8 },   // Zay over 60.5 -> big loss
    ],
  });
  assert.strictEqual(res.data.week.status, 'graded');
  assert.strictEqual(res.data.picks.find((p) => p.id === a.id).result, 'win');
  assert.strictEqual(res.data.picks.find((p) => p.id === b.id).result, 'loss');
  assert.strictEqual(res.data.parlay.status, 'dead');
  assert.strictEqual(res.data.candidates.length, 1);
  assert.strictEqual(res.data.candidates[0].user_id, 2);
});

test('a blank stat line leaves the pick pending rather than grading it a loss', async () => {
  const detail = await call('GET', `/api/weeks/${weekId}`);
  const pick = detail.data.picks[0];
  await call('POST', `/api/weeks/${weekId}/grade`, { results: [{ pick_id: pick.id, actual_value: '' }] });
  const after = await call('GET', `/api/weeks/${weekId}`);
  const updated = after.data.picks.find((p) => p.id === pick.id);
  assert.strictEqual(updated.result, 'pending');
  assert.strictEqual(updated.actual_value, null);
  // put it back so the rest of the flow has a settled week
  await call('POST', `/api/weeks/${weekId}/grade`, { results: [{ pick_id: pick.id, actual_value: 95 }] });
});

test('members vote and the tally is visible', async () => {
  const res = await call('POST', `/api/weeks/${weekId}/vote`, { nominee_id: 2, reason: 'eight yards' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.my_vote.nominee_id, 2);
  assert.strictEqual(res.data.vote_tally.find((t) => t.user_id === 2).count, 1);
});

test('a second vote from the same person replaces the first', async () => {
  await call('POST', `/api/weeks/${weekId}/vote`, { nominee_id: 1 });
  const res = await call('POST', `/api/weeks/${weekId}/vote`, { nominee_id: 2 });
  assert.strictEqual(res.data.votes.length, 1);
  assert.strictEqual(res.data.vote_tally.length, 1);
});

test('crowning the bozo closes the week and assigns the roast', async () => {
  const res = await call('POST', `/api/weeks/${weekId}/bozo`, {});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.week.status, 'final');
  assert.strictEqual(res.data.bozo.user_id, 2);
  assert.strictEqual(res.data.bozo.method, 'vote');
  assert.ok(res.data.bozo.roast.length > 10, 'a roast was generated');
  assert.strictEqual(res.data.bozo.counts.all_time, 1);
});

test("the next week bills last week's bozo", async () => {
  const res = await call('POST', '/api/weeks', {});
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.data.week.week_number, 2);
  assert.strictEqual(res.data.payer.id, 2, 'the bozo inherits the bill');
});

test('the leaderboard counts bozos for the season and all time', async () => {
  const res = await call('GET', '/api/leaderboard');
  const rube = res.data.rows.find((r) => r.user.id === 2);
  assert.strictEqual(rube.bozos_season, 1);
  assert.strictEqual(rube.bozos_all_time, 1);
  assert.strictEqual(rube.title.title, 'Rookie Bozo');
  const boss = res.data.rows.find((r) => r.user.id === 1);
  assert.strictEqual(boss.bozos_all_time, 0);
  assert.strictEqual(res.data.rows[0].user.id, 2, 'the bozo tops the shame list');
});

test('the summons text names the bozo and the ticket', async () => {
  const res = await call('GET', `/api/weeks/${weekId}/summons`);
  assert.match(res.data.text, /BOZO ALERT/);
  assert.match(res.data.text, /Rube/);
  assert.match(res.data.text, /Zay Flowers/);
});

test('the odds API reports itself unconfigured instead of crashing', async () => {
  const res = await call('GET', '/api/odds/events');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.data.events, []);
  assert.match(res.data.error, /No Odds API key/);
});

test('the last commissioner cannot demote themselves', async () => {
  const res = await call('PATCH', '/api/admin/users/1', { is_admin: false });
  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /at least one commissioner/);
});

test('signing out clears the session', async () => {
  await call('POST', '/api/auth/logout');
  const res = await call('GET', '/api/state');
  assert.strictEqual(res.status, 401);
});

test('the slate estimate prices the job without calling the API', async () => {
  await call('POST', '/api/auth/login', { username: 'boss', password: 'password123' });
  const res = await call('GET', '/api/odds/slate/estimate');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.games_total, 0, 'no cached slate in a fresh test db');
  assert.strictEqual(res.data.estimated_cost, 0);
  assert.ok(res.data.cost_per_game > 0, 'cost per game reflects the enabled markets');
});

test('an impossible side for the market is rejected', async () => {
  await call('POST', '/api/auth/login', { username: 'boss', password: 'password123' });
  const wk = await call('POST', '/api/weeks', {});
  const id = wk.data.week.id;

  // "Anytime TD Over 27.5" is not a bet that exists.
  let res = await call('POST', `/api/weeks/${id}/picks`, {
    player: 'Travis Kelce', market: 'player_anytime_td', selection: 'Over', line: 27.5, price: 125,
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /Yes\/No/);

  // …and neither is "Passing Yards Yes".
  res = await call('POST', `/api/weeks/${id}/picks`, {
    player: 'Josh Allen', market: 'player_pass_yds', selection: 'Yes', price: -110,
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /Over\/Under/);
});

test('a yes/no market rejects a line instead of silently keeping it', async () => {
  const weeks = await call('GET', '/api/weeks');
  const id = weeks.data.weeks[0].id;
  const res = await call('POST', `/api/weeks/${id}/picks`, {
    player: 'Travis Kelce', market: 'player_anytime_td', selection: 'Yes', line: 27.5, price: 125,
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /no line/);
});

test('an order-of-magnitude line typo is flagged but still saved', async () => {
  const weeks = await call('GET', '/api/weeks');
  const id = weeks.data.weeks[0].id;
  const res = await call('POST', `/api/weeks/${id}/picks`, {
    player: 'Fat Finger', market: 'player_reception_yds', selection: 'Over', line: 745, price: -110,
  });
  assert.strictEqual(res.status, 200, 'a warning must not block the pick');
  assert.match(res.data.warning, /high for Receiving Yards/);
  assert.ok(res.data.picks.some((p) => p.player === 'Fat Finger'), 'the pick was still recorded');
});

test('a plausible line produces no warning', async () => {
  const weeks = await call('GET', '/api/weeks');
  const id = weeks.data.weeks[0].id;
  const res = await call('POST', `/api/weeks/${id}/picks`, {
    user_id: 2, player: 'Normal Guy', market: 'player_reception_yds', selection: 'Over', line: 74.5, price: -110,
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.warning, undefined);
});

test('an impossible stat line is flagged at grading', async () => {
  const weeks = await call('GET', '/api/weeks');
  const id = weeks.data.weeks[0].id;
  const detail = await call('GET', `/api/weeks/${id}`);
  const pick = detail.data.picks.find((p) => p.player === 'Normal Guy');
  const res = await call('POST', `/api/weeks/${id}/grade`, {
    results: [{ pick_id: pick.id, actual_value: 9999 }],
  });
  assert.strictEqual(res.status, 200);
  assert.match(res.data.warnings.join(' '), /record/);
});
