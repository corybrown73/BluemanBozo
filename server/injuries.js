'use strict';

/**
 * NFL injury designations.
 *
 * The Odds API does not carry injury data at all, so this reads ESPN's public
 * feed — no key, no cost, no quota. It is an undocumented endpoint, so every
 * call is treated as best-effort: any failure degrades to "no injury data"
 * rather than breaking the digest that calls it.
 *
 * Verify it from your own machine with:  node scripts/check-injuries.js
 */

const { db } = require('./db');

const FEED = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries';
const CACHE_KEY = 'injuries:nfl';
const CACHE_MINUTES = 180;

/** Designations worth interrupting someone's week over. */
const SERIOUS = new Set(['out', 'injured reserve', 'doubtful', 'suspension']);
const NOTABLE = new Set([...SERIOUS, 'questionable']);

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

/** Normalize ESPN's nested shape into a flat list. Tolerant of layout drift. */
function flatten(raw) {
  const out = [];
  const teams = Array.isArray(raw?.injuries) ? raw.injuries : [];
  for (const team of teams) {
    const teamName = team.displayName || team.name || '';
    for (const item of team.injuries || []) {
      const athlete = item.athlete || {};
      const name = athlete.displayName || athlete.fullName || item.displayName;
      if (!name) continue;
      out.push({
        player: name,
        team: teamName,
        position: athlete.position?.abbreviation || athlete.position?.name || '',
        status: item.status || item.type?.description || 'Unknown',
        detail: item.shortComment || item.longComment || item.details?.type || '',
        date: item.date || null,
      });
    }
  }
  return out;
}

/** @returns {Promise<{injuries: array, cached: boolean, error?: string}>} */
async function getInjuries({ force = false } = {}) {
  if (!force) {
    const hit = cacheGet(CACHE_MINUTES);
    if (hit) return { injuries: hit.data, cached: true, fetched_at: hit.fetched_at };
  }
  try {
    const res = await fetch(FEED, {
      headers: { Accept: 'application/json', 'User-Agent': 'BlueManBozo/1.0' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
    const raw = await res.json();
    const injuries = flatten(raw);
    if (!injuries.length) throw new Error('Feed parsed but contained no injury rows.');
    cacheSet(injuries);
    return { injuries, cached: false, fetched_at: new Date().toISOString() };
  } catch (err) {
    // Fall back to whatever we last saw before giving up entirely.
    const stale = cacheGet(null);
    if (stale) {
      return { injuries: stale.data, cached: true, stale: true, fetched_at: stale.fetched_at, error: err.message };
    }
    return { injuries: [], cached: false, error: err.message };
  }
}

/** Loose name match — feeds differ on suffixes, punctuation and middle names. */
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find injury notes for the players in a set of picks.
 * @param {array} picks   objects with a `player` field
 * @returns {Promise<{flags: array, checked: boolean, error?: string}>}
 */
async function flagPicks(picks) {
  const { injuries, error } = await getInjuries();
  if (!injuries.length) return { flags: [], checked: false, error };

  const index = new Map();
  for (const inj of injuries) index.set(normalizeName(inj.player), inj);

  const flags = [];
  for (const pick of picks) {
    const hit = index.get(normalizeName(pick.player));
    if (!hit) continue;
    const status = String(hit.status || '').toLowerCase();
    if (!NOTABLE.has(status)) continue;
    flags.push({
      pick_id: pick.id,
      user_id: pick.user_id,
      display_name: pick.display_name,
      player: pick.player,
      status: hit.status,
      serious: SERIOUS.has(status),
      team: hit.team,
      position: hit.position,
      detail: hit.detail,
    });
  }
  // Worst news first.
  flags.sort((a, b) => Number(b.serious) - Number(a.serious));
  return { flags, checked: true };
}

module.exports = { getInjuries, flagPicks, normalizeName, flatten, SERIOUS, NOTABLE, FEED };
