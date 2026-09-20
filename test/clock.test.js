'use strict';

/**
 * The clock — locks, opens, live stats and self-grading — driven by a fake
 * `now`, so a whole week runs in a second. The 2026 calendar: Week 2 Sunday is
 * September 20; it opens Tuesday the 15th at 6am ET and locks Sunday 12:55 ET.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-clock-test-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough';
process.env.NODE_ENV = 'test';
process.env.ODDS_API_KEY = '';

const { db, setSetting, currentWeek } = require('../server/db');
const { hashPassword } = require('../server/auth');
const game = require('../server/game');
const scheduler = require('../server/scheduler');

const at = (iso) => new Date(iso);
const weekRow = (n) => db.prepare('SELECT * FROM weeks WHERE week_number = ?').get(n);
let ids;

test.before(() => {
  db.prepare('INSERT INTO seasons (year, label, is_active) VALUES (2026, ?, 1)').run('2026 Season');
  const mk = db.prepare('INSERT INTO users (username, display_name, password_hash, avatar, is_admin) VALUES (?, ?, ?, ?, ?)');
  mk.run('boss', 'Boss', hashPassword('password123'), '👑', 1);
  mk.run('a', 'A', hashPassword('password123'), '🅰️', 0);
  mk.run('b', 'B', hashPassword('password123'), '🅱️', 0);
  ids = Object.fromEntries(db.prepare('SELECT id, username FROM users').all().map((r) => [r.username, r.id]));
});

test.after(() => {
  scheduler.stop();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('Monday night: nothing opens yet', async () => {
  const r = await scheduler.clockTick(at('2026-09-15T02:00:00Z')); // Mon Sep 14, 10pm ET
  assert.strictEqual(r.opened, null);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM weeks').get().n, 0);
});

test('Tuesday 6am ET: the coming Sunday\'s week opens itself, with its lock time set', async () => {
  const r = await scheduler.clockTick(at('2026-09-15T10:30:00Z'));
  assert.strictEqual(r.opened, 2, 'numbered off the NFL calendar, not "last week plus one"');
  const w = weekRow(2);
  assert.strictEqual(w.status, 'open');
  assert.strictEqual(w.lock_at, '2026-09-20T16:55:00.000Z', 'Sunday 12:55 ET');

  const again = await scheduler.clockTick(at('2026-09-15T11:30:00Z'));
  assert.strictEqual(again.opened, null, 'and only once');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM weeks').get().n, 1);
});

test('the week locks itself at 12:55 Sunday, not a minute before', async () => {
  const w = weekRow(2);
  const ins = db.prepare(
    `INSERT INTO picks (week_id, user_id, player, market, market_label, selection, line, price, commence_time, home_team, away_team)
     VALUES (?, ?, ?, 'player_reception_yds', 'Receiving Yards', 'Over', ?, -110, '2026-09-20T17:00:00Z', 'Kansas City Chiefs', 'Buffalo Bills')`
  );
  ins.run(w.id, ids.a, 'Travis Kelce', 58.5);
  ins.run(w.id, ids.b, 'Khalil Shakir', 44.5);
  ins.run(w.id, ids.boss, 'Benched Guy', 30.5);

  let r = await scheduler.clockTick(at('2026-09-20T16:54:00Z'));
  assert.strictEqual(r.locked, 0);
  assert.strictEqual(weekRow(2).status, 'open');

  r = await scheduler.clockTick(at('2026-09-20T16:55:00Z'));
  assert.strictEqual(r.locked, 1);
  assert.strictEqual(weekRow(2).status, 'locked');
});

test('during the games, box scores land on each pick without grading anything', async () => {
  const w = weekRow(2);
  const picks = game.rawPicks(w.id);
  const byName = Object.fromEntries(picks.map((p) => [p.player, p]));
  const fetchStats = async () => ({
    checked: 3,
    results: [
      { pick_id: byName['Travis Kelce'].id, actual_value: 41, final: false, live: true, period: 3, clock: '8:12', detail: '8:12 - 3rd' },
      { pick_id: byName['Khalil Shakir'].id, actual_value: 12, final: false, live: true, period: 3, clock: '8:12', detail: '8:12 - 3rd' },
    ],
    unresolved: [{ pick_id: byName['Benched Guy'].id, player: 'Benched Guy', reason: 'No stats yet.', live: true }],
  });

  const r = await scheduler.clockTick(at('2026-09-20T18:30:00Z'), { fetchStats });
  assert.strictEqual(r.live.live, 2);
  assert.strictEqual(r.live.settled, 0);
  const after = Object.fromEntries(game.rawPicks(w.id).map((p) => [p.player, p]));
  assert.strictEqual(after['Travis Kelce'].live_value, 41);
  assert.strictEqual(after['Travis Kelce'].live_note, '8:12 - 3rd');
  assert.strictEqual(after['Travis Kelce'].result, 'pending', 'live is not graded');
  assert.strictEqual(after['Benched Guy'].live_value, null);
  assert.strictEqual(after['Benched Guy'].live_note, 'No stats yet.');
  assert.strictEqual(weekRow(2).status, 'locked');
});

test('a second look inside the interval is skipped; outside the game window nothing is fetched', async () => {
  let calls = 0;
  const fetchStats = async () => { calls += 1; return { results: [], unresolved: [] }; };
  const soon = await scheduler.clockTick(at('2026-09-20T18:30:30Z'), { fetchStats });
  assert.strictEqual(soon.live.skipped, 'too soon');
  // Sunday 11pm ET: the games are long over, and it is still week 2's window.
  const lateNight = await scheduler.clockTick(at('2026-09-21T03:00:00Z'), { fetchStats });
  assert.strictEqual(lateNight.live.skipped, 'no games on');
  assert.strictEqual(calls, 0, 'ESPN was never called');
});

test("at a minute's interval every tick pulls, and a failed pull waits five minutes before the next", async () => {
  let calls = 0;
  let fail = false;
  const fetchStats = async () => {
    calls += 1;
    return fail ? { results: [], unresolved: [], error: 'Could not reach ESPN: ESPN returned 429' } : { results: [], unresolved: [] };
  };
  // The clock's ticks land a few milliseconds late; a minute's interval still fires on every one.
  const next = await scheduler.clockTick(at('2026-09-20T18:31:00.020Z'), { fetchStats });
  assert.ok(!next.live.skipped, JSON.stringify(next.live));
  assert.strictEqual(calls, 1);

  fail = true;
  const failed = await scheduler.clockTick(at('2026-09-20T18:32:00Z'), { fetchStats });
  assert.match(failed.live.error, /429/);
  assert.strictEqual(calls, 2);
  fail = false;
  assert.strictEqual((await scheduler.clockTick(at('2026-09-20T18:33:00Z'), { fetchStats })).live.skipped, 'backing off');
  assert.strictEqual((await scheduler.clockTick(at('2026-09-20T18:36:30Z'), { fetchStats })).live.skipped, 'backing off');
  assert.strictEqual(calls, 2, 'nothing asked while backing off');
  const resumed = await scheduler.clockTick(at('2026-09-20T18:37:00Z'), { fetchStats });
  assert.ok(!resumed.live.skipped, JSON.stringify(resumed.live));
  assert.strictEqual(calls, 3);
});

test('when the games go final the week grades itself — except a player who never showed', async () => {
  const w = weekRow(2);
  const byName = Object.fromEntries(game.rawPicks(w.id).map((p) => [p.player, p]));
  const fetchStats = async () => ({
    results: [
      { pick_id: byName['Travis Kelce'].id, actual_value: 77, final: true, detail: 'Final' },
      { pick_id: byName['Khalil Shakir'].id, actual_value: 31, final: true, detail: 'Final' },
    ],
    unresolved: [{ pick_id: byName['Benched Guy'].id, player: 'Benched Guy', final: true,
      reason: 'Did not appear in the box score — inactive, or the name did not match.' }],
  });
  const r = await scheduler.clockTick(at('2026-09-20T21:00:00Z'), { fetchStats });
  assert.strictEqual(r.live.settled, 2);
  const after = Object.fromEntries(game.rawPicks(w.id).map((p) => [p.player, p]));
  assert.strictEqual(after['Travis Kelce'].result, 'win');
  assert.strictEqual(after['Travis Kelce'].actual_value, 77);
  assert.strictEqual(after['Khalil Shakir'].result, 'loss');
  assert.strictEqual(after['Benched Guy'].result, 'pending', 'a DNP is a human decision, never a zero');
  assert.strictEqual(weekRow(2).status, 'locked', 'so voting does not open on its own yet');

  // Kelce and Shakir are settled and their box scores cannot change, so the
  // next pull asks ESPN about the one pick still in play and nothing else.
  const asked = [];
  await scheduler.clockTick(at('2026-09-20T21:02:00Z'), {
    fetchStats: async (picks) => { asked.push(...picks.map((p) => p.player)); return { results: [], unresolved: [] }; },
  });
  assert.deepStrictEqual(asked, ['Benched Guy']);

  // The commissioner voids the no-show; the week is settled and voting opens.
  game.gradePicks(weekRow(2), [{ pick_id: byName['Benched Guy'].id, result: 'void' }]);
  assert.strictEqual(weekRow(2).status, 'graded');
});

test('next Tuesday the following week opens even though this one is still voting', async () => {
  const r = await scheduler.clockTick(at('2026-09-22T10:30:00Z'));
  assert.strictEqual(r.opened, 3);
  assert.strictEqual(weekRow(3).lock_at, '2026-09-27T16:55:00.000Z');
  assert.strictEqual(currentWeek().week_number, 2, 'but the app stays on the week that needs a crown');
});

test('a week opened by hand after its own Sunday is not locked on arrival', async () => {
  setSetting('auto_open_week', '0');
  const late = scheduler.createWeek(1, at('2026-09-16T12:00:00Z')); // week 1's Sunday was the 13th
  assert.strictEqual(late.lock_at, null);
  const r = await scheduler.clockTick(at('2026-09-16T12:01:00Z'));
  assert.ok(r.locks_set >= 1, 'the clock gives it the next Sunday instead');
  assert.strictEqual(weekRow(1).lock_at, '2026-09-20T16:55:00.000Z');
  assert.strictEqual(weekRow(1).status, 'open');
  db.prepare('DELETE FROM weeks WHERE week_number = 1').run();
  setSetting('auto_open_week', '1');
});

test('every part of the clock can be switched off', async () => {
  setSetting('auto_lock', '0');
  setSetting('live_stats', '0');
  const w = scheduler.createWeek(9, at('2026-11-03T12:00:00Z'));
  assert.strictEqual(w.lock_at, null, 'no lock time when auto-lock is off');
  const r = await scheduler.clockTick(at('2026-11-08T20:00:00Z'), { fetchStats: async () => { throw new Error('should not run'); } });
  assert.strictEqual(r.locked, 0);
  assert.strictEqual(r.live.skipped, 'off');
  setSetting('auto_lock', '1');
  setSetting('live_stats', '1');
  db.prepare('DELETE FROM weeks WHERE week_number = 9').run();
});

test('a week opened before its Sunday with no lock time locks the moment the clock sees the Sunday has passed', async () => {
  // The live app's week 1: opened Saturday the 12th, before auto-lock existed.
  const season = db.prepare('SELECT id FROM seasons').get();
  db.prepare(`INSERT INTO weeks (season_id, week_number, status, stake_cents, created_at) VALUES (?, 1, 'open', 2000, '2026-09-12 18:16:58')`).run(season.id);
  const r = await scheduler.clockTick(at('2026-09-14T14:00:00Z')); // Monday Sep 14
  assert.ok(r.locks_set >= 1);
  const w = weekRow(1);
  assert.strictEqual(w.status, 'locked', 'the games were yesterday — nobody edits a pick now');
  assert.strictEqual(w.lock_at, '2026-09-13T16:55:00.000Z');
});

test('games that finished before anyone was looking still get one stats pass', async () => {
  const w = weekRow(1);
  db.prepare(
    `INSERT INTO picks (week_id, user_id, player, market, market_label, selection, line, price, commence_time, home_team, away_team)
     VALUES (?, ?, 'Late Look', 'player_rush_yds', 'Rushing Yards', 'Over', 40.5, -110, '2026-09-13T17:00:00Z', 'Dallas Cowboys', 'Philadelphia Eagles')`
  ).run(w.id, ids.a);
  let calls = 0;
  const fetchStats = async (picks) => {
    calls += 1;
    return { results: picks.map((p) => ({ pick_id: p.id, actual_value: 88, final: true, detail: 'Final' })), unresolved: [] };
  };
  // Monday afternoon: the game window closed hours ago, but the pick has never been checked.
  const r = await scheduler.clockTick(at('2026-09-14T18:00:00Z'), { fetchStats });
  assert.strictEqual(calls, 1, 'one catch-up pass');
  assert.strictEqual(r.live.settled, 1);
  assert.strictEqual(game.rawPicks(w.id)[0].result, 'win');
  const again = await scheduler.clockTick(at('2026-09-14T18:05:00Z'), { fetchStats });
  assert.strictEqual(calls, 1, 'and then it is quiet');
  assert.ok(again.live.skipped, 'nothing owed any more');
  db.prepare('DELETE FROM weeks WHERE week_number = 1').run();
});

test('the master switch stops everything at once', async () => {
  setSetting('clock_enabled', '0');
  const r = await scheduler.clockTick(at('2026-09-29T10:30:00Z')); // a Tuesday that would open week 4
  assert.strictEqual(r.paused, true);
  assert.strictEqual(r.opened, null);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM weeks WHERE week_number = 4').get().n, 0);
  assert.strictEqual(scheduler.clockStatus().enabled, false);
  setSetting('clock_enabled', '1');
  assert.strictEqual(scheduler.clockStatus().enabled, true);
});

test('the "next opens" line always looks forward', async () => {
  // Week 3 is open (from the Tuesday test); the next opening is week 4's Tuesday.
  const st = scheduler.clockStatus(at('2026-09-23T12:00:00Z'));
  assert.strictEqual(st.next_open_week, 4);
  assert.strictEqual(st.next_open_at, '2026-09-29T10:00:00.000Z');

  // Nothing open at all, mid-week: still the coming Tuesday, never a date gone by.
  db.prepare("UPDATE weeks SET status = 'locked' WHERE week_number = 3").run();
  const none = scheduler.clockStatus(at('2026-09-23T12:00:00Z'));
  assert.ok(Date.parse(none.next_open_at) > Date.parse('2026-09-23T12:00:00Z'), `next open ${none.next_open_at} is ahead`);
  assert.strictEqual(none.next_open_week, 4);
  db.prepare("UPDATE weeks SET status = 'open' WHERE week_number = 3").run();
});
