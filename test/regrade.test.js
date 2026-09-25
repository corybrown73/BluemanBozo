'use strict';

/**
 * Three ways the record could quietly go wrong after a week is settled.
 *
 *   - a vote for someone who WON, which the crown would then land on
 *   - a corrected stat line that turns the crowned bozo's loss into a win,
 *     leaving a Hall of Shame entry that no longer adds up
 *   - a player who never took the field, typed in as 0 and graded a loss
 *
 * Each of these was possible through the API. None is now.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-regrade-test-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough';
process.env.NODE_ENV = 'test';
process.env.ODDS_API_KEY = '';

const { db } = require('../server/db');
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
let weekId;
let picks;

test.before(async () => {
  db.prepare('INSERT INTO seasons (year, label, is_active) VALUES (2026, ?, 1)').run('2026 Season');
  const mk = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, avatar, is_admin) VALUES (?, ?, ?, ?, ?)'
  );
  mk.run('boss', 'Boss', hashPassword('password123'), '👑', 1);
  mk.run('winner', 'Winner', hashPassword('password123'), '🏆', 0);
  mk.run('loser', 'Loser', hashPassword('password123'), '🤡', 0);
  mk.run('benched', 'Benched', hashPassword('password123'), '🪑', 0);
  ids = Object.fromEntries(db.prepare('SELECT id, username FROM users').all().map((r) => [r.username, r.id]));

  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const u of Object.keys(ids)) {
    await as(u, 'POST', '/api/auth/login', { username: u, password: 'password123' });
  }

  weekId = (await as('boss', 'POST', '/api/weeks', {})).data.week.id;
  await as('winner', 'POST', `/api/weeks/${weekId}/picks`, pick('Runs A Lot', 50.5));
  await as('loser', 'POST', `/api/weeks/${weekId}/picks`, pick('Runs A Little', 80.5));
  await as('benched', 'POST', `/api/weeks/${weekId}/picks`, pick('Never Played', 60.5));
  picks = Object.fromEntries(
    (await as('boss', 'GET', `/api/weeks/${weekId}`)).data.picks.map((p) => [p.username, p.id])
  );
});

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('a player who never took the field is voided, not scored', async () => {
  const r = await as('boss', 'POST', `/api/weeks/${weekId}/grade`, {
    results: [
      { pick_id: picks.winner, actual_value: 90 },
      { pick_id: picks.loser, actual_value: 20 },
      { pick_id: picks.benched, result: 'void' },
    ],
  });
  assert.strictEqual(r.status, 200);
  const by = Object.fromEntries(r.data.picks.map((p) => [p.username, p]));
  assert.strictEqual(by.benched.result, 'void');
  assert.strictEqual(by.benched.actual_value, null);
  assert.strictEqual(r.data.week.status, 'graded', 'a void counts as settled, so the week can grade');
  assert.deepStrictEqual(
    r.data.candidates.map((c) => c.display_name),
    ['Loser'],
    'a void is not a loss, so the benched player is not up for the crown'
  );
  assert.strictEqual(r.data.parlay.leg_count, 2, 'and the void drops out of the parlay');
});

test('a vote only lands on someone who actually lost', async () => {
  const r = await as('loser', 'POST', `/api/weeks/${weekId}/vote`, { nominee_id: ids.winner });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /didn't lose/);

  const v = await as('loser', 'POST', `/api/weeks/${weekId}/vote`, { nominee_id: ids.benched });
  assert.strictEqual(v.status, 400, 'a void is not a loss either');

  const okVote = await as('winner', 'POST', `/api/weeks/${weekId}/vote`, { nominee_id: ids.loser });
  assert.strictEqual(okVote.status, 200);
});

test('once graded, a settled pick cannot be blanked back to pending', async () => {
  const r = await as('boss', 'POST', `/api/weeks/${weekId}/grade`, {
    results: [{ pick_id: picks.winner, actual_value: '' }],
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /already graded/);
  const after = (await as('boss', 'GET', `/api/weeks/${weekId}`)).data;
  assert.strictEqual(after.picks.find((p) => p.username === 'winner').result, 'win', 'nothing moved');
});

test('correcting the bozo into a winner takes the crown off and says so', async () => {
  const crowned = await as('boss', 'POST', `/api/weeks/${weekId}/bozo`, {});
  assert.strictEqual(crowned.data.bozo.display_name, 'Loser');
  assert.strictEqual(crowned.data.week.status, 'final');

  // Next week is on Loser's tab.
  const next = (await as('boss', 'POST', '/api/weeks', {})).data;
  assert.strictEqual(next.payer.display_name, 'Loser');

  // The stat line was wrong: 20 was really 120.
  const fixed = await as('boss', 'POST', `/api/weeks/${weekId}/grade`, {
    results: [{ pick_id: picks.loser, actual_value: 120 }],
  });
  assert.strictEqual(fixed.status, 200);
  assert.strictEqual(fixed.data.picks.find((p) => p.username === 'loser').result, 'win');
  assert.strictEqual(fixed.data.bozo, null, 'the crown cannot stand on a bet that did not lose');
  assert.strictEqual(fixed.data.week.status, 'graded', 'the week goes back to voting');
  assert.ok((fixed.data.warnings || []).some((w) => /crown is off/i.test(w)), 'the commissioner is told');

  const nextAfter = (await as('boss', 'GET', `/api/weeks/${next.week.id}`)).data;
  assert.strictEqual(nextAfter.payer, null, 'and nobody is on the hook for next week any more');

  // Nobody lost now, so the week can close as a perfect week.
  const closed = await as('boss', 'PATCH', `/api/weeks/${weekId}`, { status: 'final' });
  assert.strictEqual(closed.status, 200);
  assert.ok(closed.data.perfect_week, 'and it reads as one');
});

test('correcting a stat that leaves the bozo a loser keeps the crown', async () => {
  db.prepare("UPDATE weeks SET status = 'locked' WHERE status = 'open'").run(); // one open week at a time
  const w = (await as('boss', 'POST', '/api/weeks', { week_number: 9 })).data.week;
  await as('winner', 'POST', `/api/weeks/${w.id}/picks`, pick('Fine', 10.5));
  await as('loser', 'POST', `/api/weeks/${w.id}/picks`, pick('Bad', 99.5));
  const ps = Object.fromEntries((await as('boss', 'GET', `/api/weeks/${w.id}`)).data.picks.map((p) => [p.username, p.id]));
  await as('boss', 'POST', `/api/weeks/${w.id}/grade`, {
    results: [{ pick_id: ps.winner, actual_value: 50 }, { pick_id: ps.loser, actual_value: 5 }],
  });
  await as('boss', 'POST', `/api/weeks/${w.id}/bozo`, {});

  // 5 was really 7. Still a loss by a mile.
  const r = await as('boss', 'POST', `/api/weeks/${w.id}/grade`, { results: [{ pick_id: ps.loser, actual_value: 7 }] });
  assert.strictEqual(r.data.bozo.display_name, 'Loser', 'still the bozo');
  assert.strictEqual(r.data.week.status, 'final', 'week stays closed');
  assert.ok(!(r.data.warnings || []).length, 'nothing to warn about');
});
