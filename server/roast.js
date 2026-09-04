'use strict';

/**
 * The roast engine. Picks a line that actually fits what happened — a
 * blowout miss gets mocked differently than a heartbreaker or a choked lock.
 * Seeded by week + user so the roast is stable on refresh (nobody gets to
 * reload until they find a nicer one).
 */

const GENERIC = [
  '{name} has been formally designated the Week {week} Bozo. The nose is in the mail.',
  'By order of the {group}, {name} is the Bozo of Week {week}. Venmo is now a spectator sport.',
  '{name} looked at every player in the National Football League and chose violence against their own wallet.',
  'Somewhere a bookmaker is having a very nice week, and it is entirely because of {name}.',
  '{name} did not just lose a bet. {name} filed a formal complaint against competence.',
  'Scientists have confirmed the coldest place in the universe is {name}’s betting slip.',
];

const BLOWOUT = [
  '{name} took {player} {selection} {line} {unit}. {player} finished with {actual}. That is not a miss, that is a crime scene.',
  '{name} needed {line} from {player} and got {actual}. Off by {missPct}%. A coin flip would be insulted by the comparison.',
  '{player} was asked for {line} {unit} and delivered {actual}. {name} watched it happen live and had opinions beforehand.',
  '{name} bet {player} {selection} {line}. Final: {actual}. At some point that stops being bad luck and starts being a personality.',
  'The gap between {name}’s pick ({line}) and reality ({actual}) is wide enough to park the entire {group} in.',
];

const CHOKED_CHALK = [
  '{name} found a {price} lock and lost it. That takes real ambition.',
  'Everyone said {player} {selection} {line} was the safest leg on the board. {name} proved everyone wrong in the worst possible way.',
  '{name} paid {price} for the privilege of being wrong. Premium bozo. Top shelf.',
  'A {price} favorite failed, and {name} was holding the ticket. The house always wins, but rarely this comfortably.',
];

const HEARTBREAK = [
  '{name} missed {player} {selection} {line} by a hair — final was {actual}. Painful, but the ledger does not accept sympathy.',
  '{actual} against a line of {line}. {name} was one play away from being insufferable about it all week. Instead: bozo.',
  'So close. {name} still has to pay. Those two facts are unrelated and always will be.',
];

const REPEAT = [
  'This is bozo #{count} for {name}. At this point it is less a losing streak and more a career.',
  '{name} collects bozos the way other people collect frequent flyer miles. Bozo #{count} secured.',
  'Bozo #{count}. {name} is no longer losing bets, {name} is curating an exhibition.',
  'The {group} would like to remind everyone that {name} has now been the bozo {count} times. Sample size achieved.',
];

const PERFECT_WEEK = [
  'Nobody lost. Nobody is the bozo. Everyone is quietly furious about it.',
  'A perfect week. The parlay lives, the group chat is peaceful, and it feels deeply wrong.',
  'All legs cashed. No bozo this week. Enjoy it, it will not happen again.',
];

const TITLES = [
  { min: 0, title: 'Clean Record', blurb: 'Never been the bozo. Suspicious.' },
  { min: 1, title: 'Rookie Bozo', blurb: 'Everyone gets one.' },
  { min: 2, title: 'Repeat Offender', blurb: 'A pattern is forming.' },
  { min: 3, title: 'Certified Bozo', blurb: 'Papers filed. Fully accredited.' },
  { min: 5, title: 'Bozo Laureate', blurb: 'Distinguished service to the sportsbook.' },
  { min: 8, title: 'Bozo Emeritus', blurb: 'They should retire your nose.' },
  { min: 12, title: 'The Big Shoe', blurb: 'A living legend. A cautionary tale.' },
];

function titleFor(count) {
  let best = TITLES[0];
  for (const t of TITLES) if (count >= t.min) best = t;
  return { ...best, count };
}

/** Deterministic 32-bit hash so a given (week, user) always gets the same roast. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, key) => (vars[key] === undefined || vars[key] === null ? m : String(vars[key])));
}

/**
 * @param {object} opts
 * @param {string} opts.name        display name of the bozo
 * @param {number} opts.week        week number
 * @param {string} opts.group       group name
 * @param {number} opts.count       total career bozo count (including this one)
 * @param {object} [opts.pick]      the losing pick, with breakdown fields
 */
function roast({ name, week, group = 'Blue Man Group', count = 1, pick = null, seed = '' }) {
  const vars = {
    name,
    week,
    group,
    count,
    player: pick?.player || 'their guy',
    selection: pick?.selection || '',
    line: pick?.line ?? '',
    actual: pick?.actual_value ?? '',
    unit: pick?.unit || '',
    price: pick?.price !== undefined && pick?.price !== null ? (pick.price > 0 ? `+${pick.price}` : String(pick.price)) : '',
    missPct: pick?.miss_percent ?? '',
  };

  let pool = GENERIC;
  const hasStat = pick && pick.actual_value !== null && pick.actual_value !== undefined;
  const missPct = pick?.miss_percent ?? 0;
  const implied = pick?.implied_probability ?? 0;

  if (count >= 3 && hash(seed + 'repeat') % 3 === 0) {
    pool = REPEAT;
  } else if (hasStat && missPct >= 45) {
    pool = BLOWOUT;
  } else if (implied >= 0.7) {
    pool = CHOKED_CHALK;
  } else if (hasStat && missPct > 0 && missPct <= 10) {
    pool = HEARTBREAK;
  }

  const idx = hash(`${seed}|${name}|${week}`) % pool.length;
  return fill(pool[idx], vars);
}

function perfectWeek(seed = '') {
  return PERFECT_WEEK[hash(String(seed)) % PERFECT_WEEK.length];
}

/** Little award badges computed over a week's picks. */
function weeklyAwards(picks) {
  const awards = [];
  const graded = picks.filter((p) => p.result === 'win' || p.result === 'loss');
  if (!graded.length) return awards;

  const wins = graded.filter((p) => p.result === 'win');
  if (wins.length) {
    const longest = wins.reduce((a, b) => (Number(b.price) > Number(a.price) ? b : a));
    if (Number(longest.price) > 0) {
      awards.push({ key: 'dart', emoji: '🎯', title: 'Dart Throw of the Week', user_id: longest.user_id, detail: `${longest.player} at ${longest.price > 0 ? '+' : ''}${longest.price} cashed` });
    }
  }

  const losses = picks.filter((p) => p.result === 'loss');
  if (losses.length) {
    const worst = losses.reduce((a, b) => ((b.miss_percent || 0) > (a.miss_percent || 0) ? b : a));
    if ((worst.miss_percent || 0) > 0) {
      awards.push({ key: 'airball', emoji: '🧊', title: 'Ice Cold', user_id: worst.user_id, detail: `${worst.player} missed by ${worst.miss_percent}%` });
    }
  }

  const pushes = picks.filter((p) => p.result === 'push');
  for (const p of pushes) {
    awards.push({ key: 'push', emoji: '😐', title: 'Landed on the Number', user_id: p.user_id, detail: `${p.player} hit exactly ${p.line}` });
  }

  return awards;
}

module.exports = { roast, perfectWeek, titleFor, weeklyAwards, TITLES };
