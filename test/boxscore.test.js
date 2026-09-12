'use strict';

/**
 * Grading off ESPN's box score.
 *
 * The fixture below mirrors a real response — New England at Seattle, the game
 * `npm run check-boxscore` was run against — including the details that make
 * this fiddly: a quarterback who appears in both passing and rushing, a player
 * who did not appear at all, and stats arriving as strings.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-box-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'box.db');
process.env.SESSION_SECRET = 'boxscore-secret-long-enough';
process.env.NODE_ENV = 'test';

const box = require('../server/boxscore');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SUMMARY = {
  boxscore: {
    players: [
      {
        team: { abbreviation: 'NE', displayName: 'New England Patriots' },
        statistics: [
          { name: 'passing', labels: ['C/ATT', 'YDS', 'AVG', 'TD', 'INT', 'SACKS', 'QBR', 'RTG'],
            athletes: [{ athlete: { displayName: 'Drake Maye' }, stats: ['23/33', '178', '5.4', '1', '0', '2', '61.2', '95.4'] }] },
          { name: 'rushing', labels: ['CAR', 'YDS', 'AVG', 'TD', 'LONG'],
            athletes: [
              { athlete: { displayName: 'Rhamondre Stevenson' }, stats: ['18', '51', '2.8', '0', '9'] },
              { athlete: { displayName: 'Drake Maye' }, stats: ['7', '47', '6.7', '1', '18'] },
            ] },
          { name: 'receiving', labels: ['REC', 'YDS', 'AVG', 'TD', 'LONG', 'TGTS'],
            athletes: [
              { athlete: { displayName: 'Mack Hollins' }, stats: ['4', '51', '12.8', '0', '22', '6'] },
              { athlete: { displayName: 'Rhamondre Stevenson' }, stats: ['5', '44', '8.8', '1', '15', '6'] },
            ] },
        ],
      },
      {
        team: { abbreviation: 'SEA', displayName: 'Seattle Seahawks' },
        statistics: [
          { name: 'receiving', labels: ['REC', 'YDS', 'AVG', 'TD', 'LONG', 'TGTS'],
            athletes: [{ athlete: { displayName: 'Jaxon Smith-Njigba' }, stats: ['8', '122', '15.3', '1', '41', '11'] }] },
        ],
      },
    ],
  },
};

test('every market we offer reads the right column', () => {
  const players = box.playersFromSummary(SUMMARY);
  const maye = players.get('drake maye');
  const jsn = players.get('jaxon smithnjigba');
  const rhamondre = players.get('rhamondre stevenson');

  assert.strictEqual(box.readStat('player_pass_yds', maye), 178);
  assert.strictEqual(box.readStat('player_rush_yds', maye), 47, 'the same player in a second category');
  assert.strictEqual(box.readStat('player_reception_yds', jsn), 122);
  assert.strictEqual(box.readStat('player_receptions', jsn), 8);
  assert.strictEqual(box.readStat('player_rush_yds', rhamondre), 51);
});

test('anytime TD sums rushing and receiving, and is never a false zero', () => {
  const players = box.playersFromSummary(SUMMARY);
  // 1 rushing + 1 receiving. Reading only one category would grade this a loss.
  assert.strictEqual(box.readStat('player_anytime_td', players.get('rhamondre stevenson')), 1);
  assert.strictEqual(box.readStat('player_anytime_td', players.get('drake maye')), 1, 'a QB rushing TD counts');
  assert.strictEqual(box.readStat('player_anytime_td', players.get('jaxon smithnjigba')), 1);
  assert.strictEqual(box.readStat('player_anytime_td', players.get('mack hollins')), 0, 'played, did not score');
});

test('a player who never appears is reported, not settled at zero', async () => {
  // A sportsbook voids a bet on someone inactive. Grading it 0 would hand
  // somebody a loss for a game they were never in.
  const players = box.playersFromSummary(SUMMARY);
  assert.strictEqual(players.get('stefon diggs'), undefined);
  assert.strictEqual(box.readStat('player_receptions', players.get('stefon diggs')), null);
});

test('a pick is matched to its game by team name, in either order', () => {
  const events = [{
    id: '401872656',
    status: { type: { completed: true } },
    competitions: [{ competitors: [
      { team: { displayName: 'Seattle Seahawks' } },
      { team: { displayName: 'New England Patriots' } },
    ] }],
  }];
  assert.ok(box.matchEvent(events, { home_team: 'Seattle Seahawks', away_team: 'New England Patriots' }));
  assert.ok(box.matchEvent(events, { home_team: 'New England Patriots', away_team: 'Seattle Seahawks' }));
  assert.strictEqual(box.matchEvent(events, { home_team: 'Dallas Cowboys', away_team: 'Philadelphia Eagles' }), null);
  assert.strictEqual(box.matchEvent(events, {}), null);
});

test('the scoreboard date is the Eastern one, not UTC', () => {
  // Sunday Night Football, 8:20pm ET — which is Monday in UTC. Asking ESPN
  // for the UTC day returns the wrong slate and grades nothing.
  assert.strictEqual(box.espnDate(new Date('2026-09-14T00:20:00Z')), '20260913');
  assert.strictEqual(box.espnDate(new Date('2026-09-13T17:00:00Z')), '20260913');
  assert.strictEqual(box.espnDate(new Date('2026-09-15T00:15:00Z')), '20260914', 'Monday night');
});

test('stats arrive as strings and come back as numbers', () => {
  const players = box.playersFromSummary(SUMMARY);
  const v = box.readStat('player_pass_yds', players.get('drake maye'));
  assert.strictEqual(typeof v, 'number');
  assert.ok(!Number.isNaN(v));
});

test('a malformed or empty feed yields nothing rather than throwing', () => {
  assert.strictEqual(box.playersFromSummary(undefined).size, 0);
  assert.strictEqual(box.playersFromSummary({}).size, 0);
  assert.strictEqual(box.playersFromSummary({ boxscore: { players: [] } }).size, 0);
  assert.strictEqual(box.readStat('player_pass_yds', null), null);
  assert.strictEqual(box.readStat('nonsense_market', { stats: {} }), null);
});

/* ---------------- the wider market list ---------------- */

const WIDE = {
  boxscore: { players: [{
    team: { abbreviation: 'KC' },
    statistics: [
      { name: 'passing', labels: ['C/ATT', 'YDS', 'AVG', 'TD', 'INT', 'SACKS', 'QBR', 'RTG'],
        athletes: [{ athlete: { displayName: 'Patrick Mahomes' }, stats: ['23/33', '262', '7.9', '3', '1', '2', '78.1', '104.2'] }] },
      { name: 'rushing', labels: ['CAR', 'YDS', 'AVG', 'TD', 'LONG'],
        athletes: [{ athlete: { displayName: 'Isiah Pacheco' }, stats: ['17', '84', '4.9', '1', '21'] }] },
      { name: 'receiving', labels: ['REC', 'YDS', 'AVG', 'TD', 'LONG', 'TGTS'],
        athletes: [{ athlete: { displayName: 'Isiah Pacheco' }, stats: ['3', '26', '8.7', '0', '12', '4'] }] },
      { name: 'kicking', labels: ['FG', 'PCT', 'LONG', 'XP', 'PTS'],
        athletes: [{ athlete: { displayName: 'Harrison Butker' }, stats: ['2/2', '100.0', '48', '3/3', '9'] }] },
      { name: 'defensive', labels: ['TOT', 'SOLO', 'SACKS', 'TFL', 'PD', 'QB HTS', 'TD'],
        athletes: [{ athlete: { displayName: 'Nick Bolton' }, stats: ['11', '7', '1.5', '2', '1', '3', '0'] }] },
    ],
  }] },
};

test('every market the group can pick is gradeable, or says why not', () => {
  const p = box.playersFromSummary(WIDE);
  const mahomes = p.get('patrick mahomes');
  const pacheco = p.get('isiah pacheco');

  assert.strictEqual(box.readStat('player_pass_yds', mahomes), 262);
  assert.strictEqual(box.readStat('player_pass_tds', mahomes), 3);
  assert.strictEqual(box.readStat('player_pass_interceptions', mahomes), 1);
  assert.strictEqual(box.readStat('player_rush_attempts', pacheco), 17);
  assert.strictEqual(box.readStat('player_kicking_points', p.get('harrison butker')), 9);
  assert.strictEqual(box.readStat('player_tackles_assists', p.get('nick bolton')), 11);
  assert.strictEqual(box.readStat('player_sacks', p.get('nick bolton')), 1.5, 'half sacks are real');

  // Rush + Rec yards sums two categories for the same player.
  assert.strictEqual(box.readStat('player_rush_reception_yds', pacheco), 110, '84 rushing + 26 receiving');

  // First TD cannot come from a box score, and is declared rather than faked.
  assert.ok(box.UNGRADEABLE.player_1st_td, 'first TD is flagged ungradeable');
  assert.strictEqual(box.STAT_MAP.player_1st_td, undefined, 'and has no mapping to accidentally use');
});

test('completions and attempts are split out of the single C/ATT cell', () => {
  // ESPN reports "23/33". Reading it whole gives 23 for both, or NaN.
  const mahomes = box.playersFromSummary(WIDE).get('patrick mahomes');
  assert.strictEqual(box.readStat('player_pass_completions', mahomes), 23);
  assert.strictEqual(box.readStat('player_pass_attempts', mahomes), 33);
});

test('no market we offer is silently unmapped', () => {
  const odds = require('../server/odds');
  const missing = odds.MARKETS
    .map((m) => m.key)
    .filter((k) => !box.STAT_MAP[k] && !box.UNGRADEABLE[k]);
  assert.deepStrictEqual(missing, [],
    `these markets can be picked but not graded: ${missing.join(', ')}`);
});
