'use strict';

/**
 * The shortlist — bets you are weighing, not bets you have made.
 *
 * The rule that matters here is the asymmetry: the COUNT is public, the
 * CONTENTS are not. "Ricky is weighing 3" is the fun part; letting everyone
 * read the three would walk through the group's hide-picks setting and turn
 * the game into copying.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-shortlist-test-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough';
process.env.NODE_ENV = 'test';
process.env.ODDS_API_KEY = '';

const { db, setSetting } = require('../server/db');
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

const BET = {
  player: 'Travis Kelce',
  market: 'player_reception_yds',
  market_label: 'Receiving Yards',
  selection: 'Over',
  line: 58.5,
  price: -110,
  home_team: 'Kansas City Chiefs',
  away_team: 'Buffalo Bills',
};

let weekId;

test.before(async () => {
  db.prepare('INSERT INTO seasons (year, label, is_active) VALUES (2026, ?, 1)').run('2026 Season');
  const mk = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, avatar, is_admin) VALUES (?, ?, ?, ?, ?)'
  );
  mk.run('boss', 'Boss', hashPassword('password123'), '👑', 1);
  mk.run('ricky', 'Ricky', hashPassword('password123'), '🚀', 0);

  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  for (const u of ['boss', 'ricky']) {
    await as(u, 'POST', '/api/auth/login', { username: u, password: 'password123' });
  }
  const wk = await as('boss', 'POST', '/api/weeks', {});
  weekId = wk.data.week.id;
});

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('a bet can be put on the list without committing to it', async () => {
  const r = await as('ricky', 'POST', `/api/weeks/${weekId}/shortlist`, BET);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.my_shortlist.length, 1);
  assert.strictEqual(r.data.my_shortlist[0].player, 'Travis Kelce');
  assert.strictEqual(r.data.picks.length, 0, 'weighing a bet is not making one');

  const me = r.data.roster.find((x) => x.display_name === 'Ricky');
  assert.strictEqual(me.picked, false, 'and it does not count as having picked');
  assert.strictEqual(me.weighing, 1);
});

test('the count is public but the contents are not', async () => {
  const seen = await as('boss', 'GET', `/api/weeks/${weekId}`);
  const ricky = seen.data.roster.find((x) => x.display_name === 'Ricky');

  assert.strictEqual(ricky.weighing, 1, 'everyone can see how many he is weighing');
  assert.strictEqual(seen.data.my_shortlist.length, 0, "and nothing of anyone else's list");

  // Belt and braces: Kelce must not appear anywhere in what Boss is handed.
  assert.ok(!JSON.stringify(seen.data).includes('Kelce'), 'the bet itself never leaves its owner');
});

test('the same bet twice is a mis-tap, not a second entry', async () => {
  const r = await as('ricky', 'POST', `/api/weeks/${weekId}/shortlist`, BET);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.already, true);
  assert.strictEqual(r.data.my_shortlist.length, 1);
});

test('a different line on the same player is a different bet', async () => {
  const r = await as('ricky', 'POST', `/api/weeks/${weekId}/shortlist`, { ...BET, line: 64.5, price: 105 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.my_shortlist.length, 2);
});

test('a side the market does not have is refused', async () => {
  const r = await as('ricky', 'POST', `/api/weeks/${weekId}/shortlist`, {
    player: 'Isiah Pacheco', market: 'player_anytime_td', selection: 'Over', line: 27.5, price: 120,
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.data.error, /Yes\/No/);
});

test('you can only take your own entries off', async () => {
  const mine = (await as('ricky', 'GET', `/api/weeks/${weekId}`)).data.my_shortlist;
  const theft = await as('boss', 'DELETE', `/api/weeks/${weekId}/shortlist/${mine[0].id}`);
  assert.strictEqual(theft.status, 404, "someone else's entry is not even visible to delete");

  const after = (await as('ricky', 'GET', `/api/weeks/${weekId}`)).data.my_shortlist;
  assert.strictEqual(after.length, 2, 'and it is still there');

  const own = await as('ricky', 'DELETE', `/api/weeks/${weekId}/shortlist/${mine[0].id}`);
  assert.strictEqual(own.status, 200);
  assert.strictEqual(own.data.my_shortlist.length, 1);
});

test('the list has a ceiling — it is for weighing, not hoarding', async () => {
  setSetting('shortlist_max', '3');
  const add = (n) =>
    as('ricky', 'POST', `/api/weeks/${weekId}/shortlist`, { ...BET, player: `Filler ${n}`, line: 10 + n });

  assert.strictEqual((await add(1)).status, 200);
  assert.strictEqual((await add(2)).status, 200, 'three is fine');

  const over = await add(3);
  assert.strictEqual(over.status, 409);
  assert.match(over.data.error, /only bet one/);
  setSetting('shortlist_max', '8');
});

test('betting one clears the rest', async () => {
  const before = (await as('ricky', 'GET', `/api/weeks/${weekId}`)).data.my_shortlist;
  assert.ok(before.length > 1, 'there is a list to clear');

  const bet = before[0];
  const r = await as('ricky', 'POST', `/api/weeks/${weekId}/picks`, {
    player: bet.player, market: bet.market, market_label: bet.market_label,
    selection: bet.selection, line: bet.line, price: bet.price,
  });

  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.my_shortlist.length, 0, 'the options are gone once one is taken');
  assert.strictEqual(r.data.shortlist_cleared, before.length);
  assert.strictEqual(r.data.picks.length, 1, 'and the bet is real now');

  const me = r.data.roster.find((x) => x.display_name === 'Ricky');
  assert.strictEqual(me.picked, true);
  assert.strictEqual(me.weighing, 0);
});

test('a locked week takes no more candidates', async () => {
  const locked = await as('boss', 'PATCH', `/api/weeks/${weekId}`, { status: 'locked' });
  assert.strictEqual(locked.status, 200, 'the week really did lock');
  const r = await as('ricky', 'POST', `/api/weeks/${weekId}/shortlist`, { ...BET, player: 'Too Late' });
  assert.strictEqual(r.status, 409);
  assert.match(r.data.error, /locked/i);
});
