'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Point at a throwaway database BEFORE anything requires server/db. Several
// tests here read and write settings; without this they would use — and
// mutate — the developer's real data/bluemanbozo.db, so a local demo seed
// could fail the suite.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-scoring-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'scoring.db');
process.env.SESSION_SECRET = 'scoring-secret-that-is-long-enough';
process.env.NODE_ENV = 'test';
process.env.ODDS_API_KEY = '';
test.after(() => {
  require('../server/scheduler').stop();
  fs.rmSync(TMP, { recursive: true, force: true });
});

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

test('a credit cap larger than the real plan is detected and flagged', () => {
  const { db, setSetting } = require('../server/db');
  const odds = require('../server/odds');
  const month = new Date().toISOString().slice(0, 7);

  db.prepare('DELETE FROM api_usage').run();
  // The provider reports remaining + used on every response; their sum is the plan.
  db.prepare(
    "INSERT INTO api_usage (endpoint, credits, remaining, used_total, month) VALUES ('event-odds', 5, 480, 20, ?)"
  ).run(month);

  setSetting('monthly_credit_cap', '16000');
  const bad = odds.quotaStatus();
  assert.strictEqual(bad.plan_size, 500, 'plan size inferred from the headers');
  assert.strictEqual(bad.cap_exceeds_plan, true);
  assert.match(bad.cap_warning, /higher than your actual plan/);

  setSetting('monthly_credit_cap', '450');
  const good = odds.quotaStatus();
  assert.strictEqual(good.cap_exceeds_plan, false);
  assert.strictEqual(good.cap_warning, null);

  db.prepare('DELETE FROM api_usage').run();
  setSetting('monthly_credit_cap', '450');
});

test('free-tier defaults keep a full slate affordable', () => {
  // The shipped default is the claim being made; a local database may have
  // been widened by whoever runs this, and that is their business.
  const { DEFAULT_SETTINGS } = require('../server/db');
  const markets = DEFAULT_SETTINGS.odds_markets.split(',').filter(Boolean);
  const fullSlate = markets.length * 16;
  assert.ok(fullSlate * 4 < 500, `four weekly slate loads (${fullSlate * 4}) must fit in the free 500`);
});

test('books posting different lines collapse to one consensus row', () => {
  const odds = require('../server/odds');
  // Shape taken from a real Patriots @ Seahawks response: five books, three
  // different passing-yard lines for the same quarterback.
  const raw = {
    id: 'g1', home_team: 'Seattle Seahawks', away_team: 'New England Patriots',
    bookmakers: [
      { key: 'dk', title: 'DraftKings', markets: [{ key: 'player_pass_yds', outcomes: [
        { name: 'Over', description: 'Drake Maye', price: -113, point: 227.5 },
        { name: 'Under', description: 'Drake Maye', price: -111, point: 227.5 }] }] },
      { key: 'fd', title: 'FanDuel', markets: [{ key: 'player_pass_yds', outcomes: [
        { name: 'Over', description: 'Drake Maye', price: -114, point: 232.5 },
        { name: 'Under', description: 'Drake Maye', price: -114, point: 232.5 }] }] },
      { key: 'br', title: 'BetRivers', markets: [{ key: 'player_pass_yds', outcomes: [
        { name: 'Over', description: 'Drake Maye', price: -115, point: 224.5 },
        { name: 'Under', description: 'Drake Maye', price: -115, point: 224.5 }] }] },
      { key: 'eb', title: 'ESPN BET', markets: [{ key: 'player_pass_yds', outcomes: [
        { name: 'Over', description: 'Drake Maye', price: -108, point: 227.5 },
        { name: 'Under', description: 'Drake Maye', price: -112, point: 227.5 }] }] },
    ],
  };

  const { props } = odds.normalizeProps(raw);
  assert.strictEqual(props.length, 2, 'eight raw outcomes become one Over and one Under');

  const over = props.find((p) => p.selection === 'Over');
  assert.strictEqual(over.line, 227.5, 'the line two of four books agree on wins');
  assert.strictEqual(over.price, -108, 'best price available AT the consensus line');
  assert.strictEqual(over.bookmaker, 'ESPN BET');
  assert.strictEqual(over.books_at_line, 2);
  assert.strictEqual(over.book_count, 4);
  assert.strictEqual(over.line_varies, true);
  assert.strictEqual(over.line_min, 224.5);
  assert.strictEqual(over.line_max, 232.5);
});

test('a single agreed line is not reported as varying', () => {
  const odds = require('../server/odds');
  const raw = { id: 'g2', bookmakers: [
    { key: 'dk', title: 'DraftKings', markets: [{ key: 'player_receptions', outcomes: [
      { name: 'Over', description: 'Travis Kelce', price: -135, point: 5.5 }] }] },
    { key: 'fd', title: 'FanDuel', markets: [{ key: 'player_receptions', outcomes: [
      { name: 'Over', description: 'Travis Kelce', price: -125, point: 5.5 }] }] },
  ] };
  const { props } = odds.normalizeProps(raw);
  assert.strictEqual(props.length, 1);
  assert.strictEqual(props[0].line_varies, false);
  assert.strictEqual(props[0].price, -125, 'better of the two prices');
});

test('anytime-TD props have no line and still collapse per player', () => {
  const odds = require('../server/odds');
  const raw = { id: 'g3', bookmakers: [
    { key: 'dk', title: 'DraftKings', markets: [{ key: 'player_anytime_td', outcomes: [
      { name: 'Yes', description: 'Rashee Rice', price: 135 }] }] },
    { key: 'fd', title: 'FanDuel', markets: [{ key: 'player_anytime_td', outcomes: [
      { name: 'Yes', description: 'Rashee Rice', price: 150 }] }] },
  ] };
  const { props } = odds.normalizeProps(raw);
  assert.strictEqual(props.length, 1);
  assert.strictEqual(props[0].line, null);
  assert.strictEqual(props[0].price, 150, 'longest price wins on a yes/no bet');
  assert.strictEqual(props[0].line_varies, false);
});

test('with no agreement between books the median line wins, not the lowest', () => {
  const odds = require('../server/odds');
  // Five books, five different numbers — the classic no-consensus case.
  const lines = [223, 225.5, 228, 230.5, 233];
  const raw = {
    id: 'g4',
    bookmakers: lines.map((point, i) => ({
      key: `b${i}`, title: `Book ${i}`,
      markets: [{ key: 'player_pass_yds', outcomes: [
        { name: 'Over', description: 'Drake Maye', price: -110, point },
        { name: 'Under', description: 'Drake Maye', price: -110, point },
      ] }],
    })),
  };
  const { props } = odds.normalizeProps(raw);
  const over = props.find((p) => p.selection === 'Over');
  assert.strictEqual(over.line, 228, 'median of 223/225.5/228/230.5/233');
  assert.notStrictEqual(over.line, 223, 'must not default to the lowest line');

  // The Under must land on the same number, or the two sides disagree.
  const under = props.find((p) => p.selection === 'Under');
  assert.strictEqual(under.line, over.line, 'both sides quote the same consensus line');
});

test('an agreed line still beats the median', () => {
  const odds = require('../server/odds');
  const raw = { id: 'g5', bookmakers: [
    { key: 'a', title: 'A', markets: [{ key: 'player_pass_yds', outcomes: [{ name: 'Over', description: 'QB', price: -110, point: 220 }] }] },
    { key: 'b', title: 'B', markets: [{ key: 'player_pass_yds', outcomes: [{ name: 'Over', description: 'QB', price: -110, point: 220 }] }] },
    { key: 'c', title: 'C', markets: [{ key: 'player_pass_yds', outcomes: [{ name: 'Over', description: 'QB', price: -110, point: 235 }] }] },
  ] };
  const { props } = odds.normalizeProps(raw);
  assert.strictEqual(props[0].line, 220, 'two books at 220 outrank the median of 220/220/235');
  assert.strictEqual(props[0].books_at_line, 2);
});

/* ---------------- alternate line curve ---------------- */

test('the curve reprices the posted line back to roughly the posted price', () => {
  const alt = require('../server/altlines');
  const c = alt.buildCurve({ market: 'player_pass_yds', line: 227.5, selection: 'Over', price: -113, opposite_price: -111 });
  const back = c.priceAt(227.5);
  // Within a few cents: the vig is split evenly back, the book's was not exactly even.
  assert.ok(Math.abs(back.price - -113) < 15, `repriced to ${back.price}, expected near -113`);
});

test('sliding an Over up makes it longer, down makes it shorter', () => {
  const alt = require('../server/altlines');
  const c = alt.buildCurve({ market: 'player_pass_yds', line: 227.5, selection: 'Over', price: -113, opposite_price: -111 });
  const probs = [200, 220, 240, 260].map((l) => c.priceAt(l).true_probability);
  for (let i = 1; i < probs.length; i++) {
    assert.ok(probs[i] < probs[i - 1], 'a higher Over line must be less likely');
  }
  assert.ok(c.priceAt(260).price > c.priceAt(200).price, 'longer line pays more');
});

test('Under mirrors Over at the same line', () => {
  const alt = require('../server/altlines');
  const c = alt.buildCurve({ market: 'player_rush_yds', line: 62.5, selection: 'Over', price: -115, opposite_price: -105 });
  const over = c.priceAt(80, 'Over');
  const under = c.priceAt(80, 'Under');
  assert.ok(Math.abs(over.true_probability + under.true_probability - 1) < 1e-9, 'the two sides sum to 1 before vig');
});

test('the curve declines to quote lines no book would offer', () => {
  const alt = require('../server/altlines');
  const c = alt.buildCurve({ market: 'player_receptions', line: 5.5, selection: 'Over', price: -135, opposite_price: 105 });

  const sane = c.priceAt(5.5);
  assert.ok(sane.price !== null, 'the posted line is quotable');

  const absurd = c.priceAt(20.5);
  assert.strictEqual(absurd.price, null, 'a 0% line gets no price at all');
  assert.strictEqual(absurd.unquotable, 'too_unlikely');

  const gimme = c.priceAt(0.5);
  assert.strictEqual(gimme.price, null, 'a near-certainty gets no price either');
  assert.strictEqual(gimme.unquotable, 'too_likely');
});

test('distinct lines never collapse to the same price', () => {
  const alt = require('../server/altlines');
  const c = alt.buildCurve({ market: 'player_receptions', line: 5.5, selection: 'Over', price: -135, opposite_price: 105 });
  const priced = c.ladder ? null : null;
  const quotes = [3.5, 4.5, 5.5, 6.5, 7.5].map((l) => c.priceAt(l)).filter((q) => q.price !== null);
  const seen = new Set();
  for (const q of quotes) {
    assert.ok(!seen.has(q.price), `price ${q.price} appeared twice — the curve is saturating`);
    seen.add(q.price);
  }
  assert.ok(quotes.length >= 4, 'the usable range is still wide enough to be useful');
});

test('a yes/no market has no line to slide', () => {
  const alt = require('../server/altlines');
  assert.strictEqual(alt.buildCurve({ market: 'player_anytime_td', line: null, selection: 'Yes', price: 135 }), null);
});

test('the ladder brackets the posted line and marks it', () => {
  const alt = require('../server/altlines');
  const c = alt.curveFor({ market: 'player_reception_yds', line: 58.5, selection: 'Over', price: -110, opposite_price: -110 });
  const posted = c.ladder.filter((r) => r.is_posted);
  assert.strictEqual(posted.length, 1, 'exactly one rung is the posted line');
  assert.strictEqual(posted[0].line, 58.5);
  assert.ok(c.ladder[0].line < 58.5 && c.ladder[c.ladder.length - 1].line > 58.5, 'ladder spans both sides');
  assert.ok(c.ladder.every((r) => r.estimated === true), 'every rung is flagged as an estimate');
});

test('spread scales with the line rather than being fixed', () => {
  const alt = require('../server/altlines');
  assert.ok(alt.sigmaFor('player_rush_yds', 120) > alt.sigmaFor('player_rush_yds', 40), 'a bigger line scatters more');
  assert.ok(alt.sigmaFor('player_rush_yds', 2) >= 15, 'tiny lines still get a sane floor');
});

test('normal helpers round-trip', () => {
  const alt = require('../server/altlines');
  for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    assert.ok(Math.abs(alt.normalCdf(alt.normalInv(p)) - p) < 1e-4, `round-trip at p=${p}`);
  }
});
