'use strict';

/**
 * Everyone gets a couple of pulls a week of their own, and one person's pull
 * updates the board for the whole group.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-refresh-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'refresh.db');
process.env.SESSION_SECRET = 'refresh-secret-long-enough';
process.env.NODE_ENV = 'test';

const { db, setSetting } = require('../server/db');
const { hashPassword } = require('../server/auth');
const refresh = require('../server/refresh');

let weekId;
let rube;
let boss;

test.before(() => {
  db.prepare('INSERT INTO seasons (year, label, is_active) VALUES (2026, ?, 1)').run('2026');
  const mk = db.prepare('INSERT INTO users (username, display_name, password_hash, avatar, is_admin) VALUES (?, ?, ?, ?, ?)');
  boss = mk.run('boss', 'Boss', hashPassword('password123'), '👑', 1).lastInsertRowid;
  rube = mk.run('rube', 'Rube', hashPassword('password123'), '🎺', 0).lastInsertRowid;
  const season = db.prepare('SELECT id FROM seasons WHERE year = 2026').get().id;
  weekId = db.prepare("INSERT INTO weeks (season_id, week_number, status) VALUES (?, 1, 'open')").run(season).lastInsertRowid;
  setSetting('refreshes_per_member', '2');
  setSetting('refresh_min_gap_minutes', '10');
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const asRube = { id: rube, is_admin: 0 };

test('a member gets exactly their allowance, then is told what happens next', () => {
  const me = { id: rube, is_admin: 0 };
  let st = refresh.status(weekId, me);
  assert.strictEqual(st.left, 2, 'two to start');
  assert.strictEqual(st.can, true);

  // Spend both, backdating so the minimum-gap rule is not what stops us.
  for (let i = 0; i < 2; i += 1) {
    refresh.record(weekId, rube, { source: 'member', credits: 90 });
    db.prepare("UPDATE board_refreshes SET created_at = datetime('now','-60 minutes') WHERE id = last_insert_rowid()").run();
  }

  st = refresh.status(weekId, me);
  assert.strictEqual(st.used, 2);
  assert.strictEqual(st.left, 0);
  assert.strictEqual(st.can, false);
  assert.match(st.reason, /scheduled pull/, 'and says the board will still update: ' + st.reason);
});

test('one person spending a refresh does not spend anyone else\'s', () => {
  const other = db
    .prepare('INSERT INTO users (username, display_name, password_hash, avatar, is_admin) VALUES (?, ?, ?, ?, 0)')
    .run('eric', 'Eric', hashPassword('password123'), '🥁').lastInsertRowid;
  const st = refresh.status(weekId, { id: other, is_admin: 0 });
  assert.strictEqual(st.used, 0, 'allowances are per person');
  assert.strictEqual(st.left, 2);
});

test('two taps seconds apart cost one pull, and only one allowance', () => {
  const fresh = db
    .prepare('INSERT INTO users (username, display_name, password_hash, avatar, is_admin) VALUES (?, ?, ?, ?, 0)')
    .run('derek', 'Derek', hashPassword('password123'), '🎷').lastInsertRowid;

  refresh.record(weekId, fresh, { source: 'member', credits: 90 });
  const st = refresh.status(weekId, { id: fresh, is_admin: 0 });
  assert.strictEqual(st.can, false, 'the board is younger than the gap');
  assert.match(st.reason, /Fresh enough/, st.reason);
  assert.strictEqual(st.left, 1, 'and they keep the allowance they did not need');
});

test('the board says who refreshed it, and when it was the schedule', () => {
  refresh.record(weekId, rube, { source: 'member', credits: 90 });
  let st = refresh.status(weekId, { id: boss, is_admin: 1 });
  assert.strictEqual(st.last.by, 'Rube', 'a person gets named');
  assert.strictEqual(st.last.scheduled, false);

  refresh.record(weekId, null, { source: 'scheduled', credits: 90 });
  st = refresh.status(weekId, { id: boss, is_admin: 1 });
  assert.strictEqual(st.last.scheduled, true, 'a scheduled pull is not attributed to a person');
  assert.strictEqual(st.last.by, null);
});

test('the commissioner is not metered — they are the one watching the bill', () => {
  const st = refresh.status(weekId, { id: boss, is_admin: 1 });
  assert.strictEqual(st.unlimited, true);
  assert.strictEqual(st.left, null, 'no number to count down');
});

test('scheduled pulls do not eat anybody\'s allowance', () => {
  const before = refresh.status(weekId, asRube).used;
  refresh.record(weekId, null, { source: 'scheduled', credits: 90 });
  refresh.record(weekId, null, { source: 'scheduled', credits: 90 });
  assert.strictEqual(refresh.status(weekId, asRube).used, before, 'still theirs to spend');
});

test('a pull that fell back to old numbers is reported, not called a success', () => {
  // getSlateProps returns cost 0 both when the cache was fresh and when the
  // provider was unreachable and every game quietly reused its old payload.
  // Those look identical to a caller, so the slate flags the second one.
  const odds = require('../server/odds');
  const shape = odds.getSlateProps.toString();
  assert.match(shape, /staleGames/, 'stale games are tracked');
  assert.match(shape, /res\.stale && res\.error/, 'and only when the provider actually errored');

  // And the allowance is only spent on a pull that cost something, so a
  // failed refresh leaves the member exactly where they were.
  const routes = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'server', 'routes', 'odds.js'), 'utf8'
  );
  assert.match(routes, /if \(result\.cost > 0\) \{\s*\n\s*refresh\.record/,
    'the allowance is billed on cost, not on the attempt');
});
