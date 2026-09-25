'use strict';

/**
 * Season-ready: the things that used to need the commissioner on a Tuesday.
 *
 *   - two open weeks can no longer happen through the API
 *   - the vote closes itself Tuesday morning and the crown lands
 *   - the clock stops opening weeks after the season's last one
 *   - the whole record can be downloaded as a spreadsheet
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-season-test-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough';
process.env.NODE_ENV = 'test';
process.env.ODDS_API_KEY = '';

const { db, setSetting, currentWeek } = require('../server/db');
const { hashPassword } = require('../server/auth');
const scheduler = require('../server/scheduler');
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
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  return { status: res.status, data, type: res.headers.get('content-type') || '' };
}

const at = (iso) => new Date(iso);
const pick = (player, line) => ({
  player, market: 'player_rush_yds', market_label: 'Rushing Yards', selection: 'Over', line, price: -110,
});

let ids;
let w2;

test.before(async () => {
  db.prepare('INSERT INTO seasons (year, label, is_active) VALUES (2026, ?, 1)').run('2026 Season');
  const mk = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, avatar, is_admin) VALUES (?, ?, ?, ?, ?)'
  );
  mk.run('boss', 'Boss', hashPassword('password123'), '👑', 1);
  mk.run('a', 'Alpha', hashPassword('password123'), '🅰️', 0);
  mk.run('b', 'Bravo', hashPassword('password123'), '🅱️', 0);
  ids = Object.fromEntries(db.prepare('SELECT id, username FROM users').all().map((r) => [r.username, r.id]));

  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const u of Object.keys(ids)) await as(u, 'POST', '/api/auth/login', { username: u, password: 'password123' });

  // Week 2: everyone in, locked, graded — Bravo lost — and one vote cast.
  w2 = (await as('boss', 'POST', '/api/weeks', { week_number: 2 })).data.week;
  await as('a', 'POST', `/api/weeks/${w2.id}/picks`, pick('Alpha Guy', 50.5));
  await as('b', 'POST', `/api/weeks/${w2.id}/picks`, pick('Bravo Guy', 80.5));
  await as('boss', 'PATCH', `/api/weeks/${w2.id}`, { status: 'locked' });
  const picks = (await as('boss', 'GET', `/api/weeks/${w2.id}`)).data.picks;
  await as('boss', 'POST', `/api/weeks/${w2.id}/grade`, {
    results: picks.map((p) => ({ pick_id: p.id, actual_value: p.username === 'b' ? 10 : 90 })),
  });
  await as('a', 'POST', `/api/weeks/${w2.id}/vote`, { nominee_id: ids.b });
});

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('a week graded on Sunday is crowned when Tuesday comes, and the next week bills the bozo', async () => {
  assert.strictEqual(currentWeek().status, 'graded');
  db.prepare("UPDATE picks SET graded_at = '2026-09-20 21:00:00' WHERE week_id = ?").run(w2.id);

  // Monday night: too early, the vote is still open.
  const monday = await scheduler.clockTick(at('2026-09-22T03:00:00Z'));
  assert.deepStrictEqual(monday.crowned, []);

  // Tuesday 6:30am ET: the crown lands and week 3 opens on Bravo's tab.
  const tuesday = await scheduler.clockTick(at('2026-09-22T10:30:00Z'));
  assert.strictEqual(tuesday.crowned.length, 1);
  assert.strictEqual(tuesday.crowned[0].display_name, 'Bravo');
  assert.strictEqual(tuesday.crowned[0].method, 'vote');
  assert.strictEqual(tuesday.opened, 3);

  const done = (await as('a', 'GET', `/api/weeks/${w2.id}`)).data;
  assert.strictEqual(done.week.status, 'final');
  assert.strictEqual(done.bozo.display_name, 'Bravo');
  assert.ok(done.bozo.roast.length > 10, 'roasted all the same');

  const next = (await as('a', 'GET', '/api/state')).data.current_week;
  assert.strictEqual(next.week.week_number, 3);
  assert.strictEqual(next.payer.display_name, 'Bravo');
});

test('a week graded late still gets half a day of voting before the crown lands', async () => {
  const seasonId = db.prepare('SELECT id FROM seasons').get().id;
  const info = db.prepare(`INSERT INTO weeks (season_id, week_number, status, stake_cents) VALUES (?, 1, 'graded', 2000)`).run(seasonId);
  const late = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO picks (week_id, user_id, player, market, market_label, selection, line, price, result, actual_value, graded_at)
     VALUES (?, ?, 'Late Loser', 'player_rush_yds', 'Rushing Yards', 'Over', 60.5, -110, 'loss', 12, '2026-09-23 14:00:00')`
  ).run(late, ids.a);

  // Wednesday 11am ET, an hour after the no-show was voided: wait.
  const soon = await scheduler.clockTick(at('2026-09-23T15:00:00Z'));
  assert.deepStrictEqual(soon.crowned, [], 'an hour is not a vote');
  // Thursday morning: twelve hours have passed, nobody voted, the index decides.
  const later = await scheduler.clockTick(at('2026-09-24T12:00:00Z'));
  assert.strictEqual(later.crowned.length, 1);
  assert.strictEqual(later.crowned[0].method, 'auto');
  assert.strictEqual(later.crowned[0].display_name, 'Alpha');
});

test('the switch turns it off', async () => {
  setSetting('auto_crown', '0');
  const seasonId = db.prepare('SELECT id FROM seasons').get().id;
  const info = db.prepare(`INSERT INTO weeks (season_id, week_number, status, stake_cents) VALUES (?, 4, 'graded', 2000)`).run(seasonId);
  db.prepare(
    `INSERT INTO picks (week_id, user_id, player, market, market_label, selection, line, price, result, actual_value, graded_at)
     VALUES (?, ?, 'Manual', 'player_rush_yds', 'Rushing Yards', 'Over', 60.5, -110, 'loss', 12, '2026-10-04 21:00:00')`
  ).run(Number(info.lastInsertRowid), ids.a);
  const r = await scheduler.clockTick(at('2026-10-13T12:00:00Z'));
  assert.deepStrictEqual(r.crowned, []);
  setSetting('auto_crown', '1');
  db.prepare('DELETE FROM weeks WHERE week_number = 4').run();
});

test('only one week takes picks at a time', async () => {
  assert.strictEqual(currentWeek().status, 'open', 'week 3 is taking picks');
  const r = await as('boss', 'POST', '/api/weeks', {});
  assert.strictEqual(r.status, 409);
  assert.match(r.data.error, /still open/);
  assert.match(r.data.error, /Tuesday/);
});

test('the clock opens nothing past the last week of the season', async () => {
  setSetting('season_last_week', '3');
  db.prepare("UPDATE weeks SET status = 'locked' WHERE status = 'open'").run();
  // Week 4's Tuesday, with nothing open: normally week 4 would open here.
  const r = await scheduler.clockTick(at('2026-09-29T10:30:00Z'));
  assert.strictEqual(r.opened, null);
  assert.strictEqual(scheduler.clockStatus(at('2026-09-29T10:30:00Z')).next_open_week, null, 'and the screens do not promise one');

  setSetting('season_last_week', '18');
  const again = await scheduler.clockTick(at('2026-09-29T10:30:00Z'));
  assert.strictEqual(again.opened, 4, 'raise the ceiling and it opens');

  const bad = await as('boss', 'PATCH', '/api/admin/settings', { season_last_week: '40' });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.data.error, /1 to 22/);
});

test('the whole record downloads as a spreadsheet', async () => {
  const r = await as('boss', 'GET', '/api/admin/export.csv');
  assert.strictEqual(r.status, 200);
  assert.match(r.type, /text\/csv/);
  const lines = r.data._raw.trim().split('\n');
  assert.strictEqual(lines[0], 'season,week,week_status,member,player,market,side,line,price,result,actual,bozo,roast,trash_talk');
  const bravo = lines.find((l) => l.startsWith('2026,2,final,Bravo,'));
  assert.ok(bravo, 'every pick is a row');
  assert.match(bravo, /^2026,2,final,Bravo,Bravo Guy,Rushing Yards,Over,80.5,-110,loss,10,Bravo,/);

  const member = await as('a', 'GET', '/api/admin/export.csv');
  assert.strictEqual(member.status, 403, 'commissioner only');
});
