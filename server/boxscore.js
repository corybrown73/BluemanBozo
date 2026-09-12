'use strict';

/**
 * Grade a week from ESPN's box scores, for free.
 *
 * The Odds API has no player stats at any tier, so grading cannot come from
 * there. ESPN's public JSON does, at the same undocumented endpoints already
 * used here for injuries and rosters — no key, no quota.
 *
 * The market -> stat mapping below was read off a real finished game rather
 * than assumed. Verify it yourself any time with:  npm run check-boxscore
 *
 *   passing     C/ATT  YDS  AVG  TD  INT  SACKS  QBR  RTG
 *   rushing     CAR    YDS  AVG  TD  LONG
 *   receiving   REC    YDS  AVG  TD  LONG  TGTS
 *
 * This fills in the numbers. It never decides a week — the commissioner sees
 * every value and presses Grade. An undocumented feed should not be trusted
 * to settle a bet unwatched.
 */

const { db } = require('./db');
const { normalizeName } = require('./injuries');

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const CACHE_MINUTES = 60;

/**
 * market -> which category and column to read, from the labels ESPN actually
 * returns (confirmed via `npm run check-boxscore`):
 *
 *   passing        C/ATT  YDS  AVG  TD  INT  SACKS  QBR  RTG
 *   rushing        CAR    YDS  AVG  TD  LONG
 *   receiving      REC    YDS  AVG  TD  LONG  TGTS
 *   defensive      TOT    SOLO SACKS TFL PD  QB HTS  TD
 *   kicking        FG     PCT  LONG XP  PTS
 *
 * Entries with several specs are summed — a touchdown counts whether it was
 * run in or caught.
 */
const STAT_MAP = {
  player_pass_yds: [{ category: 'passing', label: 'YDS' }],
  player_pass_tds: [{ category: 'passing', label: 'TD' }],
  player_pass_interceptions: [{ category: 'passing', label: 'INT' }],
  // ESPN reports completions and attempts as one "23/33" cell.
  player_pass_completions: [{ category: 'passing', label: 'C/ATT', part: 0 }],
  player_pass_attempts: [{ category: 'passing', label: 'C/ATT', part: 1 }],

  player_rush_yds: [{ category: 'rushing', label: 'YDS' }],
  player_rush_attempts: [{ category: 'rushing', label: 'CAR' }],

  player_reception_yds: [{ category: 'receiving', label: 'YDS' }],
  player_receptions: [{ category: 'receiving', label: 'REC' }],

  player_rush_reception_yds: [
    { category: 'rushing', label: 'YDS' },
    { category: 'receiving', label: 'YDS' },
  ],
  // Scoring a touchdown is rushing OR receiving, so the two are summed.
  player_anytime_td: [
    { category: 'rushing', label: 'TD' },
    { category: 'receiving', label: 'TD' },
  ],

  player_kicking_points: [{ category: 'kicking', label: 'PTS' }],
  player_tackles_assists: [{ category: 'defensive', label: 'TOT' }],
  player_sacks: [{ category: 'defensive', label: 'SACKS' }],
};

/**
 * Markets a box score cannot settle. First TD scorer needs the order goals
 * were scored in, which is play-by-play, not a box score. Saying so is better
 * than reading "1 rushing TD" and calling it first.
 */
const UNGRADEABLE = {
  player_1st_td: 'First TD needs the scoring order, which a box score does not carry.',
};

/* ---------------- fetching, with the same cache the other feeds use ---------------- */

function cacheGet(key, maxAgeMinutes) {
  const row = db
    .prepare(
      `SELECT payload, CAST((julianday('now') - julianday(fetched_at)) * 1440 AS REAL) AS age_minutes
       FROM odds_cache WHERE cache_key = ?`
    )
    .get(key);
  if (!row) return null;
  if (maxAgeMinutes !== null && row.age_minutes > maxAgeMinutes) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

function cacheSet(key, data) {
  db.prepare(
    `INSERT INTO odds_cache (cache_key, payload, fetched_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`
  ).run(key, JSON.stringify(data));
}

async function getJson(url, timeoutMs = 15000) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'BlueManBozo/1.0' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
  return res.json();
}

/** YYYYMMDD in US Eastern — the day the league schedules by. */
function espnDate(date) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  return p.replace(/-/g, '');
}

async function scoreboard(dates, { force = false } = {}) {
  const key = `espn:scoreboard:${dates}`;
  if (!force) {
    const hit = cacheGet(key, CACHE_MINUTES);
    if (hit) return hit;
  }
  const data = await getJson(`${BASE}/scoreboard?dates=${dates}`);
  cacheSet(key, data);
  return data;
}

async function summary(eventId, { force = false } = {}) {
  const key = `espn:summary:${eventId}`;
  if (!force) {
    const hit = cacheGet(key, CACHE_MINUTES);
    if (hit) return hit;
  }
  const data = await getJson(`${BASE}/summary?event=${eventId}`);
  cacheSet(key, data);
  return data;
}

/* ---------------- reading a box score ---------------- */

const num = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Every player's line in one game, keyed by normalised name.
 * @returns {Map<string, {name: string, stats: object}>}
 *   stats is { 'passing.YDS': 178, 'receiving.REC': 8, ... }
 */
function playersFromSummary(sum) {
  const out = new Map();
  for (const team of sum?.boxscore?.players || []) {
    for (const cat of team.statistics || []) {
      const labels = cat.labels || [];
      for (const a of cat.athletes || []) {
        const name = a.athlete?.displayName || a.athlete?.fullName;
        if (!name) continue;
        const key = normalizeName(name);
        if (!out.has(key)) out.set(key, { name, stats: {}, raw: {} });
        const entry = out.get(key);
        labels.forEach((label, i) => {
          const raw = a.stats?.[i];
          entry.raw[`${cat.name}.${label}`] = raw;
          const v = num(raw);
          if (v !== null) entry.stats[`${cat.name}.${label}`] = v;
        });
      }
    }
  }
  return out;
}

/** What a market reads for one player. null when the feed has nothing for them. */
function readStat(market, playerEntry) {
  const spec = STAT_MAP[market];
  if (!spec || !playerEntry) return null;
  let total = null;
  for (const { category, label, part } of spec) {
    const key = `${category}.${label}`;
    let v;
    if (part === undefined) {
      v = playerEntry.stats[key];
    } else {
      // A combined cell like "23/33" — completions then attempts.
      const piece = String(playerEntry.raw?.[key] ?? '').split('/')[part];
      v = num(piece);
      if (v === null) v = undefined;
    }
    if (v === undefined) continue;
    total = (total ?? 0) + v;
  }
  return total;
}

/* ---------------- matching a pick to a game ---------------- */

const normTeam = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z]/g, '');

/** Find the ESPN event for a pick, by its two teams. */
function matchEvent(events, pick) {
  const home = normTeam(pick.home_team);
  const away = normTeam(pick.away_team);
  if (!home && !away) return null;
  return (
    events.find((e) => {
      const comps = e.competitions?.[0]?.competitors || [];
      const names = comps.map((c) => normTeam(c.team?.displayName));
      return (!home || names.includes(home)) && (!away || names.includes(away));
    }) || null
  );
}

/**
 * Look up the real number for each pick in a week.
 *
 * @returns {Promise<{results: Array, checked: number, unresolved: Array, error?: string}>}
 *   results: [{ pick_id, player, market, actual_value, source }]
 *   unresolved: [{ pick_id, player, reason }] — always reported, never guessed
 */
async function statsForPicks(picks, { force = false } = {}) {
  const results = [];
  const unresolved = [];
  if (!picks.length) return { results, unresolved, checked: 0 };

  // One scoreboard per distinct game day, so a Sunday slate is a single call.
  const days = [...new Set(
    picks.map((p) => (p.commence_time ? espnDate(new Date(p.commence_time)) : null)).filter(Boolean)
  )];
  if (!days.length) {
    return { results, unresolved: picks.map((p) => ({ pick_id: p.id, player: p.player, reason: 'No kickoff time on the pick.' })), checked: 0 };
  }

  const events = [];
  for (const d of days) {
    try {
      const board = await scoreboard(d, { force });
      events.push(...(board.events || []));
    } catch (err) {
      return { results, unresolved, checked: 0, error: `Could not reach ESPN: ${err.message}` };
    }
  }

  const summaries = new Map();
  for (const pick of picks) {
    const event = matchEvent(events, pick);
    if (!event) {
      unresolved.push({ pick_id: pick.id, player: pick.player, reason: 'That game is not on ESPN\'s board.' });
      continue;
    }
    if (!event.status?.type?.completed) {
      unresolved.push({ pick_id: pick.id, player: pick.player, reason: 'That game has not finished.' });
      continue;
    }

    if (!summaries.has(event.id)) {
      try {
        summaries.set(event.id, playersFromSummary(await summary(event.id, { force })));
      } catch (err) {
        unresolved.push({ pick_id: pick.id, player: pick.player, reason: `Box score unavailable: ${err.message}` });
        continue;
      }
    }
    const players = summaries.get(event.id);
    const entry = players.get(normalizeName(pick.player));

    if (!entry) {
      // Nowhere in the box score. Usually inactive or hurt — and a sportsbook
      // would void that, not settle it at zero. Say so instead of deciding.
      unresolved.push({
        pick_id: pick.id,
        player: pick.player,
        reason: 'Did not appear in the box score — inactive, or the name did not match.',
      });
      continue;
    }

    if (UNGRADEABLE[pick.market]) {
      unresolved.push({ pick_id: pick.id, player: pick.player, reason: UNGRADEABLE[pick.market] });
      continue;
    }

    const value = readStat(pick.market, entry);
    if (value === null) {
      unresolved.push({
        pick_id: pick.id,
        player: pick.player,
        reason: `${entry.name} played, but the feed has no ${pick.market_label} for them.`,
      });
      continue;
    }

    results.push({
      pick_id: pick.id,
      player: pick.player,
      matched_as: entry.name,
      market: pick.market,
      market_label: pick.market_label,
      actual_value: value,
      source: 'espn',
    });
  }

  return { results, unresolved, checked: picks.length };
}

module.exports = {
  statsForPicks,
  UNGRADEABLE,
  playersFromSummary,
  readStat,
  matchEvent,
  espnDate,
  STAT_MAP,
  BASE,
};
