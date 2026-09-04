'use strict';

/**
 * Parlay math + the Bozo Index.
 *
 * The Bozo Index answers "whose pick was the most embarrassing?" on a 0-100
 * scale. Two things make a pick embarrassing, and they are weighted:
 *
 *   MISS (65%)  - how badly the player missed the number. Missing a 60.5 yard
 *                 line with 12 yards (80% short) is far worse than missing it
 *                 with 58 (4% short). A miss of half the line or more is
 *                 pegged at maximum badness.
 *   CHALK (35%) - how safe the bet was supposed to be. Blowing a -350 lock
 *                 (78% implied) is worse than losing a +250 dart throw.
 *
 * Only losses are eligible. Wins and pushes are never bozo candidates, and if
 * nobody loses, nobody is the bozo — that's a Perfect Week.
 */

/**
 * Strict numeric parse. Number('') and Number(null) are 0, which would silently
 * grade a blank stat-line box as a loss — so empty input must come back NaN.
 */
function toNum(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'string' && value.trim() === '') return NaN;
  return Number(value);
}

/* ---------------- odds conversion ---------------- */

function americanToDecimal(american) {
  const n = Number(american);
  if (!Number.isFinite(n) || n === 0) return 1;
  return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
}

function decimalToAmerican(decimal) {
  const d = Number(decimal);
  if (!Number.isFinite(d) || d <= 1) return 0;
  return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1));
}

function impliedProbability(american) {
  const d = americanToDecimal(american);
  return d > 1 ? 1 / d : 0;
}

function formatAmerican(american) {
  const n = Math.round(Number(american) || 0);
  return n > 0 ? `+${n}` : String(n);
}

/**
 * Combine every live leg into one parlay.
 * Losses void the ticket; pushes/voids drop out of the multiplier (standard
 * sportsbook behavior) rather than killing it.
 */
function parlay(picks, stakeCents = 2000) {
  const legs = picks.filter((p) => p.result !== 'push' && p.result !== 'void');
  const decimal = legs.reduce((acc, p) => acc * americanToDecimal(p.price), 1);
  const anyLoss = legs.some((p) => p.result === 'loss');
  const allWin = legs.length > 0 && legs.every((p) => p.result === 'win');
  const stake = Number(stakeCents) || 0;
  const payoutCents = Math.round(stake * decimal);

  return {
    leg_count: legs.length,
    dropped_legs: picks.length - legs.length,
    decimal_odds: Number(decimal.toFixed(4)),
    american_odds: decimalToAmerican(decimal),
    american_display: formatAmerican(decimalToAmerican(decimal)),
    implied_probability: decimal > 1 ? Number((1 / decimal).toFixed(6)) : 0,
    stake_cents: stake,
    payout_cents: payoutCents,
    profit_cents: payoutCents - stake,
    status: legs.length === 0 ? 'empty' : anyLoss ? 'dead' : allWin ? 'cashed' : 'live',
  };
}

/* ---------------- grading ---------------- */

/**
 * Decide win/loss/push from the actual stat line.
 * Over/Under markets compare against the line; Yes/No markets (anytime TD)
 * treat any actual value >= 1 as the event happening.
 */
function gradePick(pick, actualValue) {
  const actual = toNum(actualValue);
  if (!Number.isFinite(actual)) return 'pending';

  const side = String(pick.selection || '').trim().toLowerCase();
  const isYesNo = side === 'yes' || side === 'no';

  if (isYesNo) {
    const happened = actual >= 1;
    if (side === 'yes') return happened ? 'win' : 'loss';
    return happened ? 'loss' : 'win';
  }

  const line = toNum(pick.line);
  if (!Number.isFinite(line)) return 'pending';
  if (actual === line) return 'push';
  if (side === 'over') return actual > line ? 'win' : 'loss';
  if (side === 'under') return actual < line ? 'win' : 'loss';
  return 'pending';
}

/**
 * How far short the pick fell, as a fraction of the line. 0 if it didn't lose.
 *
 * Yes/No markets (Anytime TD) have no distance to measure — the guy either
 * scored or he didn't. Scoring every miss as a total whiff would make a +160
 * anytime-TD dart the equal of a QB throwing for 18 yards, which is absurd:
 * most anytime-TD bets lose. So for these, the "miss" is how likely the book
 * thought it was — whiffing on a -300 lock is embarrassing, whiffing on a
 * longshot is Tuesday.
 */
function missFraction(pick, actualValue) {
  const actual = toNum(actualValue);
  const side = String(pick.selection || '').trim().toLowerCase();

  if (side === 'yes' || side === 'no') {
    return gradePick(pick, actual) === 'loss' ? impliedProbability(pick.price) : 0;
  }

  const line = toNum(pick.line);
  if (!Number.isFinite(actual) || !Number.isFinite(line)) return 0;
  const denom = Math.max(Math.abs(line), 1);
  if (side === 'over' && actual < line) return (line - actual) / denom;
  if (side === 'under' && actual > line) return (actual - line) / denom;
  return 0;
}

/**
 * A miss of the full line (a goose egg against Over 74.5) is maximum badness.
 * Capping lower than this flattens every spectacular blowup into the same
 * score, which loses exactly the detail the group most wants to argue about.
 */
const MAX_MISS = 1.0;
const MISS_WEIGHT = 0.65;
const CHALK_WEIGHT = 0.35;

/**
 * 0-100. Higher = bigger bozo. Returns null for anything that isn't a loss.
 */
function bozoScore(pick) {
  if (pick.result !== 'loss') return null;
  const miss = missFraction(pick, pick.actual_value);
  const missScore = Math.min(miss / MAX_MISS, 1) * 100;
  const chalkScore = impliedProbability(pick.price) * 100;
  const score = MISS_WEIGHT * missScore + CHALK_WEIGHT * chalkScore;
  return Number(score.toFixed(1));
}

/** Full breakdown for the UI, so the group can argue with the math. */
function bozoBreakdown(pick) {
  const miss = missFraction(pick, pick.actual_value);
  const missScore = Math.min(miss / MAX_MISS, 1) * 100;
  const chalkScore = impliedProbability(pick.price) * 100;
  return {
    eligible: pick.result === 'loss',
    miss_fraction: Number(miss.toFixed(4)),
    miss_percent: Math.round(miss * 100),
    miss_score: Number(missScore.toFixed(1)),
    chalk_score: Number(chalkScore.toFixed(1)),
    implied_probability: Number(impliedProbability(pick.price).toFixed(4)),
    bozo_score: bozoScore(pick),
  };
}

/**
 * Rank the losers worst-first. The top of this list is the algorithm's
 * nomination; the group vote still has the final say.
 */
function rankBozoCandidates(picks) {
  return picks
    .filter((p) => p.result === 'loss')
    .map((p) => ({ ...p, ...bozoBreakdown(p) }))
    .sort((a, b) => (b.bozo_score || 0) - (a.bozo_score || 0));
}

/**
 * Resolve the week's bozo from votes, falling back to the Bozo Index.
 * Returns { user_id, method, votes_received, tied } or null.
 */
function resolveBozo(votes, picks) {
  const tally = new Map();
  for (const v of votes) tally.set(v.nominee_id, (tally.get(v.nominee_id) || 0) + 1);

  const ranked = rankBozoCandidates(picks);
  const indexByUser = new Map(ranked.map((p) => [p.user_id, p.bozo_score || 0]));

  if (tally.size > 0) {
    const max = Math.max(...tally.values());
    const leaders = [...tally.entries()].filter(([, n]) => n === max).map(([uid]) => uid);
    leaders.sort((a, b) => (indexByUser.get(b) || 0) - (indexByUser.get(a) || 0));
    return {
      user_id: leaders[0],
      method: leaders.length > 1 ? 'vote-tiebreak' : 'vote',
      votes_received: max,
      tied: leaders.length > 1,
      tied_with: leaders.slice(1),
    };
  }

  if (ranked.length) {
    return { user_id: ranked[0].user_id, method: 'auto', votes_received: 0, tied: false, tied_with: [] };
  }
  return null;
}

module.exports = {
  toNum,
  americanToDecimal,
  decimalToAmerican,
  impliedProbability,
  formatAmerican,
  parlay,
  gradePick,
  missFraction,
  bozoScore,
  bozoBreakdown,
  rankBozoCandidates,
  resolveBozo,
  MAX_MISS,
};
