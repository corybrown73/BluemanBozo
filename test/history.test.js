'use strict';

/**
 * Importing the old spreadsheet.
 *
 * The case that matters most here is the rename. A career record is worth
 * nothing if changing your name in Settings quietly starts you a second one,
 * so the import binds columns to user ids and these tests hold it to that.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-history-test-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough';
process.env.NODE_ENV = 'test';

const { db } = require('../server/db');
const { hashPassword } = require('../server/auth');
const history = require('../server/history');
const game = require('../server/game');

const SHEET = [
  'Week,Cory,Derek,Michael',
  '1,Hit,Miss,Hit',
  '2,Miss,Miss,Hit',
  '3,Hit,Hit,Miss',
  '4,,Hit,Hit', // Cory sat this one out
].join('\n');

test.before(() => {
  db.prepare('INSERT INTO seasons (year, label, is_active) VALUES (2026, ?, 1)').run('2026 Season');
  const mk = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, avatar, is_admin) VALUES (?, ?, ?, ?, ?)'
  );
  mk.run('cory', 'Cory', hashPassword('password123'), '👑', 1);
  // The rename: the sheet says Michael, the app says Mike, same person.
  mk.run('michael', 'Mike', hashPassword('password123'), '🍕', 0);
});

test.after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('preview reads the grid without writing anything', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM picks').get().n;
  const p = history.preview({ csv: SHEET, seasonYear: 2025 });

  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.weeks, 4);
  assert.strictEqual(p.season_year, 2025);
  assert.strictEqual(p.has_bozo_column, false);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM picks').get().n, before, 'preview writes nothing');

  const cory = p.columns.find((c) => c.name === 'Cory');
  assert.deepStrictEqual([cory.hit, cory.miss], [2, 1], 'a blank cell is a week not played, not a loss');
});

test('a renamed member is suggested, never silently matched', () => {
  const p = history.preview({ csv: SHEET, seasonYear: 2025 });
  const mich = p.columns.find((c) => c.name === 'Michael');
  const mike = p.members.find((m) => m.display_name === 'Mike');

  assert.strictEqual(mich.suggested_user_id, mike.id, 'Michael is offered as Mike');
  assert.strictEqual(mich.exact, false, 'and flagged as a guess rather than a certainty');

  const cory = p.columns.find((c) => c.name === 'Cory');
  assert.strictEqual(cory.exact, true, 'an unchanged name matches outright');
});

test('importing binds columns to accounts, so a rename keeps one record', () => {
  const mike = db.prepare("SELECT * FROM users WHERE username = 'michael'").get();
  const r = history.importGrid({
    csv: SHEET,
    seasonYear: 2025,
    mapping: { Cory: 1, Michael: mike.id, Derek: 'create' },
  });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.weeks_created, 4);
  assert.strictEqual(r.results, 11, 'every filled cell became a result');
  assert.deepStrictEqual(r.created.map((c) => c.name), ['Derek'], 'only the genuinely new member was created');

  const michaels = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE display_name IN ('Mike', 'Michael')")
    .get().n;
  assert.strictEqual(michaels, 1, 'no second account for the renamed member');

  const mikeRow = r.per_person.find((t) => t.user_id === mike.id);
  assert.deepStrictEqual([mikeRow.hit, mikeRow.miss], [3, 1], "the sheet's Michael column landed on Mike");
});

test('renaming again afterwards does not disturb the record', () => {
  const mike = db.prepare("SELECT * FROM users WHERE username = 'michael'").get();
  const before = game.leaderboard({}).accuracy.find((a) => a.user.id === mike.id).all_time;

  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('Michael J', mike.id);
  const after = game.leaderboard({}).accuracy.find((a) => a.user.id === mike.id).all_time;

  assert.deepStrictEqual(
    [before.wins, before.losses],
    [after.wins, after.losses],
    'the record follows the account, not the name'
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS n FROM picks p LEFT JOIN users u ON u.id = p.user_id WHERE u.id IS NULL').get().n,
    0,
    'nothing was orphaned'
  );
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('Mike', mike.id);
});

test('importing the same sheet twice does not double anyone', () => {
  const mike = db.prepare("SELECT * FROM users WHERE username = 'michael'").get();
  const derek = db.prepare("SELECT * FROM users WHERE display_name = 'Derek'").get();
  const usersBefore = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  const again = history.importGrid({
    csv: SHEET,
    seasonYear: 2025,
    mapping: { Cory: 1, Michael: mike.id, Derek: derek.id },
  });

  assert.strictEqual(again.results, 0, 'nothing new was written');
  assert.strictEqual(again.duplicates, 11, 'every row was recognised as already there');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, usersBefore, 'and no new accounts');
});

test('"create" will not spawn a twin when that name already exists', () => {
  const usersBefore = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  // Someone presses the button a second time with the mapping left on create.
  const r = history.importGrid({ csv: SHEET, seasonYear: 2025, mapping: { Derek: 'create', Cory: 'skip', Michael: 'skip' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, usersBefore, 'Derek was reused, not duplicated');
  assert.deepStrictEqual(r.skipped.sort(), ['Cory', 'Michael']);
});

test('a skipped column is left out entirely', () => {
  const r = history.importGrid({
    csv: 'Week,Ghost\n1,Hit\n2,Hit',
    seasonYear: 2019,
    mapping: { Ghost: 'skip' },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.results, 0);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM users WHERE display_name = 'Ghost'").get().n, 0);
});

test('a sheet that is not a hit/miss grid is refused, not guessed at', () => {
  const notAGrid = 'week,date,bozo,player,market\n1,2024-09-08,Dave,Josh Allen,Passing Yards';
  const p = history.preview({ csv: notAGrid, seasonYear: 2024 });
  assert.strictEqual(p.ok, false);
  assert.match(p.error, /Hit\/Miss grid/);

  const r = history.importGrid({ csv: notAGrid, seasonYear: 2024, mapping: {} });
  assert.strictEqual(r.ok, false, 'and the import refuses it too');
});

test('non-numeric week labels are kept without colliding with real weeks', () => {
  const r = history.importGrid({
    csv: 'Week,Solo\n1,Hit\nTGD,Miss\nWC,Hit',
    seasonYear: 2018,
    mapping: { Solo: 'create' },
  });
  assert.strictEqual(r.ok, true);
  const season = db.prepare('SELECT * FROM seasons WHERE year = 2018').get();
  const weeks = db.prepare('SELECT week_number, label FROM weeks WHERE season_id = ? ORDER BY week_number').all(season.id);
  assert.deepStrictEqual(weeks.map((w) => w.label), [null, 'TGD', 'WC']);
  assert.strictEqual(weeks[0].week_number, 1);
  assert.ok(weeks[1].week_number >= 1000, 'labelled weeks are numbered clear of real ones');
});

test('the bundled sheet still parses as a grid', () => {
  if (!fs.existsSync(history.BUNDLED)) return; // fine if it was removed
  const p = history.preview({ seasonYear: 2025 });
  assert.strictEqual(p.ok, true, 'the sheet that ships with the app is importable');
  assert.ok(p.weeks > 0);
  assert.ok(p.columns.length >= 2);
});

test('a sheet that records who paid is still recognised as a grid', () => {
  // The Bozo column holds names, which are neither hit nor miss. Counting it
  // in the detection ratio used to get a perfectly good sheet refused.
  const withBozo = ['Week,Cory,Derek,Bozo', '1,Hit,Miss,Derek', '2,Miss,Hit,Cory', '3,Hit,Miss,Derek'].join('\n');
  const p = history.preview({ csv: withBozo, seasonYear: 2017 });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.has_bozo_column, true);
  assert.deepStrictEqual(p.columns.map((c) => c.name), ['Cory', 'Derek'], 'Bozo is not treated as a player');

  const r = history.importGrid({ csv: withBozo, seasonYear: 2017, mapping: { Cory: 1, Derek: 'create' } });
  assert.strictEqual(r.ok, true);
  const season = db.prepare('SELECT * FROM seasons WHERE year = 2017').get();
  const crowned = db
    .prepare('SELECT COUNT(*) AS n FROM bozos b JOIN weeks w ON w.id = b.week_id WHERE w.season_id = ?')
    .get(season.id).n;
  assert.strictEqual(crowned, 3, 'each week got its bozo');
});
