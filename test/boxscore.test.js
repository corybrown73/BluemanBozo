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
