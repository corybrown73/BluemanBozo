'use strict';
const test = require('node:test');
const assert = require('node:assert');
const s = require('../server/scoring');

test('american <-> decimal conversion', () => {
  assert.strictEqual(s.americanToDecimal(100), 2);
  assert.strictEqual(s.americanToDecimal(-110), 1 + 100 / 110);
  assert.strictEqual(s.americanToDecimal(150), 2.5);
  assert.strictEqual(s.decimalToAmerican(2), 100);
  assert.strictEqual(s.decimalToAmerican(2.5), 150);
  assert.strictEqual(s.decimalToAmerican(1.5), -200);
});

test('implied probability', () => {
  assert.strictEqual(s.impliedProbability(100), 0.5);
  assert.ok(Math.abs(s.impliedProbability(-300) - 0.75) < 1e-9);
});

test('formatAmerican adds a plus for underdogs', () => {
  assert.strictEqual(s.formatAmerican(150), '+150');
  assert.strictEqual(s.formatAmerican(-110), '-110');
});

test('parlay multiplies decimal odds and computes payout', () => {
  const p = s.parlay(
    [
      { price: 100, result: 'pending' },
      { price: 100, result: 'pending' },
    ],
    2000
  );
  assert.strictEqual(p.decimal_odds, 4);
  assert.strictEqual(p.american_odds, 300);
  assert.strictEqual(p.payout_cents, 8000);
  assert.strictEqual(p.profit_cents, 6000);
  assert.strictEqual(p.leg_count, 2);
  assert.strictEqual(p.status, 'live');
});

test('parlay drops pushes and voids from the multiplier', () => {
  const p = s.parlay(
    [
      { price: 100, result: 'win' },
      { price: -110, result: 'push' },
      { price: 100, result: 'win' },
    ],
    1000
  );
  assert.strictEqual(p.leg_count, 2);
  assert.strictEqual(p.dropped_legs, 1);
  assert.strictEqual(p.decimal_odds, 4);
  assert.strictEqual(p.status, 'cashed');
});

test('parlay is dead if any leg loses', () => {
  const p = s.parlay([{ price: 100, result: 'win' }, { price: 100, result: 'loss' }], 2000);
  assert.strictEqual(p.status, 'dead');
});

test('empty parlay is handled', () => {
  const p = s.parlay([], 2000);
  assert.strictEqual(p.status, 'empty');
  assert.strictEqual(p.decimal_odds, 1);
});

test('grades over/under against the line', () => {
  const over = { selection: 'Over', line: 60.5 };
  assert.strictEqual(s.gradePick(over, 75), 'win');
  assert.strictEqual(s.gradePick(over, 12), 'loss');
  const under = { selection: 'Under', line: 60.5 };
  assert.strictEqual(s.gradePick(under, 12), 'win');
  assert.strictEqual(s.gradePick(under, 75), 'loss');
});

test('exact number on a whole line is a push', () => {
  assert.strictEqual(s.gradePick({ selection: 'Over', line: 50 }, 50), 'push');
  assert.strictEqual(s.gradePick({ selection: 'Under', line: 50 }, 50), 'push');
});

test('grades anytime-TD yes/no markets', () => {
  assert.strictEqual(s.gradePick({ selection: 'Yes', line: null }, 1), 'win');
  assert.strictEqual(s.gradePick({ selection: 'Yes', line: null }, 0), 'loss');
  assert.strictEqual(s.gradePick({ selection: 'No', line: null }, 2), 'loss');
});

test('grading is pending when the stat line is missing', () => {
  assert.strictEqual(s.gradePick({ selection: 'Over', line: 60.5 }, null), 'pending');
  assert.strictEqual(s.gradePick({ selection: 'Over', line: 60.5 }, ''), 'pending');
});

test('a catastrophic miss outscores a narrow miss', () => {
  const blowout = { result: 'loss', selection: 'Over', line: 60.5, actual_value: 6, price: -110 };
  const nearMiss = { result: 'loss', selection: 'Over', line: 60.5, actual_value: 58, price: -110 };
  assert.ok(s.bozoScore(blowout) > s.bozoScore(nearMiss));
});

test('blowing a heavy chalk favorite outscores losing a longshot', () => {
  const chalk = { result: 'loss', selection: 'Over', line: 10, actual_value: 9, price: -400 };
  const dog = { result: 'loss', selection: 'Over', line: 10, actual_value: 9, price: 400 };
  assert.ok(s.bozoScore(chalk) > s.bozoScore(dog));
});

test('only losses get a bozo score', () => {
  assert.strictEqual(s.bozoScore({ result: 'win', price: -110 }), null);
  assert.strictEqual(s.bozoScore({ result: 'push', price: -110 }), null);
  assert.strictEqual(s.bozoScore({ result: 'pending', price: -110 }), null);
});

test('bozo score stays inside 0-100', () => {
  const worst = { result: 'loss', selection: 'Over', line: 100, actual_value: -50, price: -100000 };
  const score = s.bozoScore(worst);
  assert.ok(score <= 100 && score >= 0, `score was ${score}`);
});

test('vote winner beats the algorithm', () => {
  const picks = [
    { user_id: 1, result: 'loss', selection: 'Over', line: 60.5, actual_value: 3, price: -110 },
    { user_id: 2, result: 'loss', selection: 'Over', line: 60.5, actual_value: 59, price: -110 },
  ];
  const votes = [{ nominee_id: 2 }, { nominee_id: 2 }, { nominee_id: 1 }];
  const res = s.resolveBozo(votes, picks);
  assert.strictEqual(res.user_id, 2);
  assert.strictEqual(res.method, 'vote');
  assert.strictEqual(res.votes_received, 2);
});

test('a tied vote breaks toward the higher bozo index', () => {
  const picks = [
    { user_id: 1, result: 'loss', selection: 'Over', line: 60.5, actual_value: 3, price: -110 },
    { user_id: 2, result: 'loss', selection: 'Over', line: 60.5, actual_value: 59, price: -110 },
  ];
  const votes = [{ nominee_id: 1 }, { nominee_id: 2 }];
  const res = s.resolveBozo(votes, picks);
  assert.strictEqual(res.user_id, 1);
  assert.strictEqual(res.method, 'vote-tiebreak');
  assert.strictEqual(res.tied, true);
});

test('no votes falls back to the algorithm', () => {
  const picks = [
    { user_id: 1, result: 'loss', selection: 'Over', line: 60.5, actual_value: 3, price: -110 },
    { user_id: 2, result: 'win', selection: 'Over', line: 20.5, actual_value: 40, price: -110 },
  ];
  const res = s.resolveBozo([], picks);
  assert.strictEqual(res.user_id, 1);
  assert.strictEqual(res.method, 'auto');
});

test('a perfect week has no bozo', () => {
  const picks = [{ user_id: 1, result: 'win', price: -110 }];
  assert.strictEqual(s.resolveBozo([], picks), null);
});

test('blank-ish stat lines never grade as a loss', () => {
  const pick = { selection: 'Over', line: 60.5 };
  for (const blank of [null, undefined, '', '   ']) {
    assert.strictEqual(s.gradePick(pick, blank), 'pending', `blank value ${JSON.stringify(blank)}`);
  }
  assert.strictEqual(s.gradePick(pick, 0), 'loss', 'an actual zero is still a real loss');
});

test('a genuine zero stat line is the worst possible miss', () => {
  const goose = { result: 'loss', selection: 'Over', line: 60.5, actual_value: 0, price: -110 };
  assert.strictEqual(s.missFraction(goose, 0), 1);
  assert.ok(s.bozoScore(goose) > 80);
});

test('spectacular blowups outrank merely bad misses', () => {
  // QB throws for 18 against a 228.5 line (92% miss) vs 2 catches against 4.5 (56% miss).
  const catastrophe = { result: 'loss', selection: 'Over', line: 228.5, actual_value: 18, price: -110 };
  const merelyBad = { result: 'loss', selection: 'Over', line: 4.5, actual_value: 2, price: -125 };
  assert.ok(
    s.bozoScore(catastrophe) > s.bozoScore(merelyBad),
    `catastrophe ${s.bozoScore(catastrophe)} should beat ${s.bozoScore(merelyBad)}`
  );
});

test('a missed longshot anytime-TD is not treated as a total whiff', () => {
  const longshot = { result: 'loss', selection: 'Yes', line: null, actual_value: 0, price: 160 };
  const lock = { result: 'loss', selection: 'Yes', line: null, actual_value: 0, price: -300 };
  assert.ok(s.bozoScore(lock) > s.bozoScore(longshot), 'blowing a TD lock beats missing a dart');
  // A dart that misses should not outrank a genuine statistical disaster.
  const disaster = { result: 'loss', selection: 'Over', line: 228.5, actual_value: 18, price: -110 };
  assert.ok(s.bozoScore(disaster) > s.bozoScore(longshot));
});

test('the slate estimator charges only for uncached games', () => {
  const odds = require('../server/odds');
  const events = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const est = odds.estimateSlate(events, ['player_pass_yds', 'player_rush_yds']);
  assert.strictEqual(est.games_total, 3);
  assert.strictEqual(est.cost_per_game, 2, '2 markets x 1 region');
  // Nothing is cached in a fresh process, so every game is billable.
  assert.strictEqual(est.games_to_fetch, 3);
  assert.strictEqual(est.estimated_cost, 6);
});

test('every market declares the sides it actually supports', () => {
  const odds = require('../server/odds');
  for (const m of odds.MARKETS) {
    assert.ok(Array.isArray(m.sides) && m.sides.length === 2, `${m.key} has two sides`);
    const expected = m.type === 'yesno' ? ['Yes', 'No'] : ['Over', 'Under'];
    assert.deepStrictEqual(m.sides, expected, `${m.key} sides match its type`);
    if (m.type === 'ou') {
      assert.ok(m.plausible && m.plausible[0] < m.plausible[1], `${m.key} has a sane line range`);
    } else {
      assert.strictEqual(m.plausible, null, `${m.key} is a yes/no bet and has no line`);
    }
  }
});

test('real NFL lines pass the plausibility check', () => {
  const odds = require('../server/odds');
  const real = [
    ['player_pass_yds', 249.5], ['player_pass_tds', 1.5], ['player_pass_completions', 22.5],
    ['player_rush_yds', 88.5], ['player_receptions', 5.5], ['player_reception_yds', 74.5],
    ['player_kicking_points', 7.5], ['player_sacks', 0.5],
  ];
  for (const [market, line] of real) {
    assert.strictEqual(odds.lineWarning(market, line), null, `${market} ${line} should be accepted`);
  }
});

test('magnitude typos are caught', () => {
  const odds = require('../server/odds');
  assert.match(odds.lineWarning('player_reception_yds', 745), /high/);
  assert.match(odds.lineWarning('player_receptions', 55), /high/);
  assert.match(odds.lineWarning('player_pass_yds', 24.9), /low/);
});
