'use strict';

/**
 * Line movement: every pull keeps the board it replaced, and each row says
 * which way its number went. The arrows on the board come from this alone.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-move-test-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough';
process.env.NODE_ENV = 'test';
process.env.ODDS_API_KEY = ''; // no key: the board is served from the cache

const { db } = require('../server/db');
const odds = require('../server/odds');

const KEY = 'props:e1:us:player_anytime_td,player_pass_yds';

const board = (rodgersLine, rodgersPrice, kelcePrice, extra = []) => ({
  id: 'e1', home_team: 'Kansas City Chiefs', away_team: 'Green Bay Packers', commence_time: '2026-09-20T17:00:00Z',
  bookmakers: [{
    key: 'dk', title: 'DraftKings',
    markets: [
      { key: 'player_pass_yds', outcomes: [
        { name: 'Over', description: 'Aaron Rodgers', price: rodgersPrice, point: rodgersLine },
        { name: 'Under', description: 'Aaron Rodgers', price: -110, point: rodgersLine },
        ...extra,
      ] },
      { key: 'player_anytime_td', outcomes: [{ name: 'Yes', description: 'Travis Kelce', price: kelcePrice }] },
    ],
  }],
});

const serve = () => odds.getEventProps('e1', { markets: ['player_anytime_td', 'player_pass_yds'] });
const row = (res, player, sel) => res.props.find((p) => p.player === player && p.selection === sel);

test.after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('the first pull has nothing to compare against', async () => {
  odds.cacheSet(KEY, board(212.5, -110, 160));
  const res = await serve();
  assert.strictEqual(row(res, 'Aaron Rodgers', 'Over').line_move, undefined, 'no earlier pull, no stamp');
});

test('a second pull stamps each row with where it stood', async () => {
  odds.cacheSet(KEY, board(215.5, -105, 140, [
    { name: 'Over', description: 'New Guy', price: -110, point: 40.5 },
  ]));
  const res = await serve();

  const over = row(res, 'Aaron Rodgers', 'Over');
  assert.strictEqual(over.line, 215.5);
  assert.strictEqual(over.prev_line, 212.5);
  assert.strictEqual(over.line_move, 1, 'the line went up');
  assert.strictEqual(row(res, 'Aaron Rodgers', 'Under').line_move, 1, 'up is up whichever side you are on');

  const kelce = row(res, 'Travis Kelce', 'Yes');
  assert.strictEqual(kelce.prev_line, null, 'a Yes/No market has no line to move');
  assert.strictEqual(kelce.prev_price, 160);
  assert.strictEqual(kelce.price_move, 1, '+160 to +140 is shorter — more likely, so up');

  assert.strictEqual(row(res, 'New Guy', 'Over').line_move, null, 'a player who was not on the last board has no history');
});

test('a pull that changes nothing shows nothing', async () => {
  odds.cacheSet(KEY, board(215.5, -105, 140));
  const res = await serve();
  assert.strictEqual(row(res, 'Aaron Rodgers', 'Over').line_move, 0);
  assert.strictEqual(row(res, 'Aaron Rodgers', 'Over').prev_line, 215.5, 'and "previous" now means the pull just before');
  assert.strictEqual(row(res, 'Travis Kelce', 'Yes').price_move, 0);
});

test('a line coming back down reads as down', async () => {
  odds.cacheSet(KEY, board(209.5, -115, 150));
  const res = await serve();
  assert.strictEqual(row(res, 'Aaron Rodgers', 'Over').line_move, -1);
  assert.strictEqual(row(res, 'Travis Kelce', 'Yes').price_move, -1, '+140 to +150 drifted out');
});
