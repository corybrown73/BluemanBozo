'use strict';

/**
 * Alternate lines — "give me Drake Maye at 230 instead of 227.5, what's the price?"
 *
 * The Odds API sells alternate lines as separate markets (player_pass_yds_alternate
 * and friends), one extra credit per market per game. On a 500-credit plan that
 * roughly doubles the cost of every board, so instead we DERIVE the price from
 * the main line, which costs nothing:
 *
 *   1. Take the Over and Under prices at the posted line and remove the vig —
 *      the two sides together tell us the book's true probability.
 *   2. That probability plus the line pins a normal distribution for the stat:
 *      if the book thinks Over 227.5 is a 50.2% shot, the mean sits at ~227.8.
 *   3. Read the probability of any other line off that same distribution and
 *      convert back to American odds, re-applying the book's hold.
 *
 * This is the standard way to interpolate a prop curve and lands within a few
 * cents of what books actually post — but it is an ESTIMATE, always labelled as
 * one, and every quote can be overridden with the real number off your own book.
 */

const { marketMeta } = require('./odds');

/* ---------------- distribution helpers ---------------- */

/** Normal CDF via Abramowitz & Stegun 7.1.26. Max error ~1.5e-7. */
function normalCdf(z) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/** Inverse normal CDF (Acklam's rational approximation). */
function normalInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/* ---------------- spread of each stat ---------------- */

/**
 * How much a stat scatters around its line, as a coefficient of variation with
 * a floor. A 30-yard rushing line and a 120-yard one do not have the same
 * absolute spread, so this scales; the floor stops tiny lines collapsing to a
 * near-certainty.
 */
const SPREAD = {
  player_pass_yds:           { cv: 0.28, min: 40 },
  player_pass_tds:           { cv: 0.75, min: 0.85 },
  player_pass_attempts:      { cv: 0.22, min: 4.5 },
  player_pass_completions:   { cv: 0.25, min: 3.5 },
  player_pass_interceptions: { cv: 0.95, min: 0.8 },
  player_rush_yds:           { cv: 0.55, min: 15 },
  player_rush_attempts:      { cv: 0.33, min: 3 },
  player_reception_yds:      { cv: 0.60, min: 15 },
  player_receptions:         { cv: 0.42, min: 1.2 },
  player_rush_reception_yds: { cv: 0.50, min: 18 },
  player_kicking_points:     { cv: 0.45, min: 2.5 },
  player_tackles_assists:    { cv: 0.40, min: 1.8 },
  player_sacks:              { cv: 0.90, min: 0.7 },
};

function sigmaFor(marketKey, line) {
  const spec = SPREAD[marketKey] || { cv: 0.45, min: 1 };
  return Math.max(spec.min, Math.abs(Number(line)) * spec.cv);
}

/**
 * Books stop quoting somewhere around a 2% / 98% shot. Beyond that a derived
 * price is meaningless, so the curve declines to answer rather than inventing
 * one.
 */
const QUOTABLE_MIN = 0.02;
const QUOTABLE_MAX = 0.98;

/* ---------------- odds conversion ---------------- */

function americanToProb(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n === 0) return 0.5;
  return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
}

function probToAmerican(p) {
  if (!(p > 0) || !(p < 1)) return null;
  return p >= 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);
}

/* ---------------- the curve ---------------- */

/**
 * Build a priced curve around a posted line.
 *
 * @param {object} anchor  { market, line, selection, price, opposite_price? }
 * @returns {object|null}  null when the market has no line to slide (anytime TD)
 */
function buildCurve(anchor) {
  const meta = marketMeta(anchor.market);
  if (meta.type !== 'ou') return null;

  const line = Number(anchor.line);
  if (!Number.isFinite(line)) return null;

  const side = String(anchor.selection).toLowerCase() === 'under' ? 'Under' : 'Over';
  const pSide = americanToProb(anchor.price);

  // Remove the vig using both sides when we have them; otherwise assume a
  // typical 4.5% hold so a one-sided quote still lands close.
  let hold;
  let pTrue;
  if (Number.isFinite(Number(anchor.opposite_price))) {
    const pOther = americanToProb(anchor.opposite_price);
    const total = pSide + pOther;
    hold = total;
    pTrue = pSide / total;
  } else {
    hold = 1.045;
    pTrue = pSide / hold;
  }

  const sigma = sigmaFor(anchor.market, line);

  // P(X > line) = pOver  =>  mean = line - sigma * z(1 - pOver)
  const pOverTrue = side === 'Over' ? pTrue : 1 - pTrue;
  const mean = line - sigma * normalInv(1 - pOverTrue);

  /**
   * Price any alternate line off the same distribution.
   *
   * Outside QUOTABLE the answer is null, not a number. Clamping the probability
   * instead produced identical prices for 0.5 and 1.5 receptions and offered
   * +6567 on a line with a 0.00% chance — a quote no book would ever post and
   * that would poison the parlay math if anyone took it.
   */
  function priceAt(newLine, newSide = side) {
    const l = Number(newLine);
    if (!Number.isFinite(l)) return null;
    const pOver = 1 - normalCdf((l - mean) / sigma);
    const pTrueAt = newSide === 'Under' ? 1 - pOver : pOver;

    if (pTrueAt < QUOTABLE_MIN || pTrueAt > QUOTABLE_MAX) {
      return {
        line: l,
        selection: newSide,
        price: null,
        true_probability: Number(pTrueAt.toFixed(4)),
        estimated: true,
        unquotable: pTrueAt > QUOTABLE_MAX ? 'too_likely' : 'too_unlikely',
      };
    }

    // Split the book's hold evenly back across the two sides.
    const withVig = Math.min(QUOTABLE_MAX, Math.max(QUOTABLE_MIN, pTrueAt * (hold / 2 + 0.5)));
    return {
      line: l,
      selection: newSide,
      price: probToAmerican(withVig),
      true_probability: Number(pTrueAt.toFixed(4)),
      estimated: true,
    };
  }

  // A ladder of alternates around the posted number, at the market's own step.
  // Rungs no book would price are simply left off, which also gives the slider
  // its honest travel limits.
  const step = meta.unit === 'yds' ? 5 : line <= 3 ? 0.5 : 1;
  const span = meta.unit === 'yds' ? 10 : 6;
  const ladder = [];
  for (let i = -span; i <= span; i++) {
    const l = Number((line + i * step).toFixed(1));
    if (l <= 0) continue;
    const quote = priceAt(l);
    if (quote && quote.price !== null) ladder.push({ ...quote, is_posted: Math.abs(l - line) < 1e-9 });
  }

  return {
    market: anchor.market,
    market_label: meta.label,
    unit: meta.unit,
    posted_line: line,
    posted_price: Number(anchor.price),
    selection: side,
    mean: Number(mean.toFixed(2)),
    sigma: Number(sigma.toFixed(2)),
    hold: Number(hold.toFixed(4)),
    step,
    min_line: ladder.length ? ladder[0].line : line,
    max_line: ladder.length ? ladder[ladder.length - 1].line : line,
    ladder,
    priceAt,
  };
}

/** Serializable form for the API (drops the function). */
function curveFor(anchor) {
  const c = buildCurve(anchor);
  if (!c) return null;
  const { priceAt, ...rest } = c;
  return rest;
}

module.exports = {
  buildCurve,
  curveFor,
  sigmaFor,
  normalCdf,
  normalInv,
  americanToProb,
  probToAmerican,
  SPREAD,
  QUOTABLE_MIN,
  QUOTABLE_MAX,
};
