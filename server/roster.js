'use strict';

/**
 * Player → team, so the prop board can be grouped by team.
 *
 * The Odds API gives a player's NAME on a prop and nothing else — no team, no
 * position. Grouping by team is impossible without a second source, so this
 * reads ESPN's public roster endpoints: one call for the 32 teams, then one per
 * team. No key, no quota, and none of it touches the Odds API budget.
 *
 * It is an undocumented public endpoint, so every failure degrades to "no team
 * data" and the board simply hides the By-team option rather than breaking.
 * Cached for a day; rosters do not move fast enough to matter.
 *
 * Verify from your own machine with:  npm run check-roster
 */

const { db } = require('./db');
const { normalizeName } = require('./injuries');

const TEAMS_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams';
const ROSTER_URL = (id) => `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${id}/roster`;
const CACHE_KEY = 'roster:nfl';
const CACHE_MINUTES = 24 * 60;
const CONCURRENCY = 5;

function cacheGet(maxAgeMinutes) {
  const row = db
    .prepare(
      `SELECT payload, fetched_at,
              CAST((julianday('now') - julianday(fetched_at)) * 1440 AS REAL) AS age_minutes
       FROM odds_cache WHERE cache_key = ?`
    )
    .get(CACHE_KEY);
  if (!row) return null;
  if (maxAgeMinutes !== null && row.age_minutes > maxAgeMinutes) return null;
  try {
    return { data: JSON.parse(row.payload), fetched_at: row.fetched_at };
  } catch {
    return null;
  }
}

function cacheSet(data) {
  db.prepare(
    `INSERT INTO odds_cache (cache_key, payload, fetched_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`
  ).run(CACHE_KEY, JSON.stringify(data));
}

async function getJson(url, timeoutMs = 12000) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'BlueManBozo/1.0' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
  return res.json();
}

/** Pull the 32 teams, then every roster, a few at a time. */
async function fetchRoster() {
  const teamsRaw = await getJson(TEAMS_URL);
  const teams = (teamsRaw?.sports?.[0]?.leagues?.[0]?.teams || [])
    .map((t) => t.team)
    .filter((t) => t && t.id)
    .map((t) => ({ id: t.id, name: t.displayName, abbreviation: t.abbreviation }));

  if (!teams.length) throw new Error('Team list parsed but was empty.');

  const players = {};
  let rostersLoaded = 0;

  for (let i = 0; i < teams.length; i += CONCURRENCY) {
    const batch = teams.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((t) => getJson(ROSTER_URL(t.id))));
    results.forEach((res, idx) => {
      if (res.status !== 'fulfilled') return;
      const team = batch[idx];
      // athletes[] is grouped by position category, each with items[].
      const groups = Array.isArray(res.value?.athletes) ? res.value.athletes : [];
      let added = 0;
      for (const group of groups) {
        for (const a of group.items || []) {
          const name = a.fullName || a.displayName;
          if (!name) continue;
          players[normalizeName(name)] = {
            team: team.name,
            abbreviation: team.abbreviation,
            position: a.position?.abbreviation || group.position || '',
            jersey: a.jersey || '',
          };
          added += 1;
        }
      }
      if (added) rostersLoaded += 1;
    });
  }

  if (!Object.keys(players).length) throw new Error('Rosters parsed but contained no players.');

  return {
    players,
    teams: teams.map((t) => t.name).sort(),
    rosters_loaded: rostersLoaded,
    team_count: teams.length,
  };
}

/** @returns {Promise<{roster: object|null, cached: boolean, error?: string}>} */
async function getRoster({ force = false } = {}) {
  if (!force) {
    const hit = cacheGet(CACHE_MINUTES);
    if (hit) return { roster: hit.data, cached: true, fetched_at: hit.fetched_at };
  }
  try {
    const roster = await fetchRoster();
    cacheSet(roster);
    return { roster, cached: false, fetched_at: new Date().toISOString() };
  } catch (err) {
    const stale = cacheGet(null);
    if (stale) return { roster: stale.data, cached: true, stale: true, fetched_at: stale.fetched_at, error: err.message };
    return { roster: null, cached: false, error: err.message };
  }
}

/**
 * Tag each prop with the player's team and position when we know them.
 * Silently leaves them undefined when the roster is unavailable — the board
 * checks for that and hides grouping by team.
 */
async function tagProps(props) {
  if (!Array.isArray(props) || !props.length) return { props, roster_available: false };
  const { roster } = await getRoster();
  if (!roster) return { props, roster_available: false };

  let matched = 0;
  for (const p of props) {
    const hit = roster.players[normalizeName(p.player)];
    if (!hit) continue;
    p.team = hit.team;
    p.team_abbr = hit.abbreviation;
    p.position = hit.position;
    matched += 1;
  }
  return { props, roster_available: matched > 0, matched };
}

module.exports = { getRoster, tagProps, fetchRoster, TEAMS_URL };
