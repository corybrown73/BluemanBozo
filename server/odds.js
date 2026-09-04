'use strict';

/**
 * The Odds API (v4) client.
 *
 * Credit math that drives every decision in here:
 *   - /events                        -> 0 credits (free). Browse the slate all day.
 *   - /events/{id}/odds              -> 1 credit PER MARKET PER REGION.
 *   - /scores                        -> 1 credit (2 if daysFrom is used).
 *
 * So a 6-market player-prop pull for one game costs 6 credits. On the 500/month
 * free tier that is the whole ballgame, which is why:
 *   1. every paid response is cached in SQLite and shared by the entire group,
 *   2. props are fetched lazily for ONE game at a time, never the full slate,
 *   3. a monthly cap is enforced locally before we ever hit the wire.
 */

const { db, getSetting } = require('./db');

const API_BASE = 'https://api.the-odds-api.com/v4';
const SPORT = 'americanfootball_nfl';

/** Player prop markets we support, with human labels and how results are graded. */
const MARKETS = [
  { key: 'player_pass_yds',        label: 'Passing Yards',      unit: 'yds',    type: 'ou',  group: 'Passing' },
  { key: 'player_pass_tds',        label: 'Passing TDs',        unit: 'TDs',    type: 'ou',  group: 'Passing' },
  { key: 'player_pass_attempts',   label: 'Pass Attempts',      unit: 'att',    type: 'ou',  group: 'Passing' },
  { key: 'player_pass_completions',label: 'Completions',        unit: 'comp',   type: 'ou',  group: 'Passing' },
  { key: 'player_pass_interceptions', label: 'Interceptions',   unit: 'INTs',   type: 'ou',  group: 'Passing' },
  { key: 'player_rush_yds',        label: 'Rushing Yards',      unit: 'yds',    type: 'ou',  group: 'Rushing' },
  { key: 'player_rush_attempts',   label: 'Rush Attempts',      unit: 'att',    type: 'ou',  group: 'Rushing' },
  { key: 'player_reception_yds',   label: 'Receiving Yards',    unit: 'yds',    type: 'ou',  group: 'Receiving' },
  { key: 'player_receptions',      label: 'Receptions',         unit: 'rec',    type: 'ou',  group: 'Receiving' },
  { key: 'player_rush_reception_yds', label: 'Rush + Rec Yards', unit: 'yds',   type: 'ou',  group: 'Combo' },
  { key: 'player_kicking_points',  label: 'Kicking Points',     unit: 'pts',    type: 'ou',  group: 'Kicking' },
  { key: 'player_tackles_assists', label: 'Tackles + Assists',  unit: 'tkl',    type: 'ou',  group: 'Defense' },
  { key: 'player_sacks',           label: 'Sacks',              unit: 'sacks',  type: 'ou',  group: 'Defense' },
  { key: 'player_anytime_td',      label: 'Anytime TD',         unit: 'TDs',    type: 'yesno', group: 'Touchdowns' },
  { key: 'player_1st_td',          label: 'First TD Scorer',    unit: 'TDs',    type: 'yesno', group: 'Touchdowns' },
];

const MARKET_BY_KEY = new Map(MARKETS.map((m) => [m.key, m]));

function marketMeta(key) {
  return MARKET_BY_KEY.get(key) || { key, label: key, unit: '', type: 'ou', group: 'Other' };
}

function apiKey() {
  return (getSetting('odds_api_key') || process.env.ODDS_API_KEY || '').trim();
}

function hasApiKey() {
  return apiKey().length > 0;
}

/* ------------------------------------------------------------------ */
/* Credit accounting                                                   */
/* ------------------------------------------------------------------ */

function currentMonth() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

function creditsUsedThisMonth() {
  const row = db
    .prepare('SELECT COALESCE(SUM(credits), 0) AS n FROM api_usage WHERE month = ?')
    .get(currentMonth());
  return row.n || 0;
}

function quotaStatus() {
  const cap = parseInt(getSetting('monthly_credit_cap'), 10) || 0;
  const used = creditsUsedThisMonth();
  const last = db.prepare('SELECT remaining, created_at FROM api_usage WHERE remaining IS NOT NULL ORDER BY id DESC LIMIT 1').get();
  return {
    month: currentMonth(),
    used_this_month: used,
    local_cap: cap,
    local_remaining: Math.max(0, cap - used),
    over_cap: cap > 0 && used >= cap,
    provider_remaining: last ? last.remaining : null,
    provider_checked_at: last ? last.created_at : null,
    configured: hasApiKey(),
  };
}

function recordUsage(endpoint, credits, headers) {
  const remaining = headers ? parseInt(headers.get('x-requests-remaining'), 10) : NaN;
  const usedTotal = headers ? parseInt(headers.get('x-requests-used'), 10) : NaN;
  const last = headers ? parseInt(headers.get('x-requests-last'), 10) : NaN;
  db.prepare(
    `INSERT INTO api_usage (endpoint, credits, remaining, used_total, month)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    endpoint,
    Number.isFinite(last) ? last : credits,
    Number.isFinite(remaining) ? remaining : null,
    Number.isFinite(usedTotal) ? usedTotal : null,
    currentMonth()
  );
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

function cacheGet(key, maxAgeMinutes) {
  const row = db
    .prepare(
      `SELECT payload, fetched_at,
              CAST((julianday('now') - julianday(fetched_at)) * 1440 AS REAL) AS age_minutes
       FROM odds_cache WHERE cache_key = ?`
    )
    .get(key);
  if (!row) return null;
  if (maxAgeMinutes !== null && row.age_minutes > maxAgeMinutes) return null;
  try {
    return { data: JSON.parse(row.payload), fetched_at: row.fetched_at, age_minutes: row.age_minutes };
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

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

class OddsApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OddsApiError';
    this.status = status;
  }
}

async function request(pathname, params, { endpoint, credits }) {
  const key = apiKey();
  if (!key) throw new OddsApiError('No Odds API key configured. Add ODDS_API_KEY to your environment.', 503);

  const quota = quotaStatus();
  if (credits > 0 && quota.over_cap) {
    throw new OddsApiError(
      `Monthly credit cap reached (${quota.used_this_month}/${quota.local_cap}). ` +
        `Raise the cap in Admin, or wait for the ${quota.month} cycle to reset.`,
      429
    );
  }

  const url = new URL(API_BASE + pathname);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  url.searchParams.set('apiKey', key);

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  recordUsage(endpoint, credits, res.headers);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = `Odds API ${res.status}`;
    try {
      const parsed = JSON.parse(body);
      if (parsed.message) msg = parsed.message;
    } catch {
      if (body) msg = body.slice(0, 300);
    }
    if (res.status === 401) msg = 'Odds API rejected the key (401). Check ODDS_API_KEY.';
    if (res.status === 429) msg = 'Odds API quota exhausted (429). ' + msg;
    throw new OddsApiError(msg, res.status);
  }

  return res.json();
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Upcoming NFL games. FREE — costs zero credits. */
async function getEvents({ force = false } = {}) {
  const ttl = parseInt(getSetting('events_cache_minutes'), 10) || 60;
  const cacheKey = 'events:nfl';
  if (!force) {
    const hit = cacheGet(cacheKey, ttl);
    if (hit) return { events: hit.data, cached: true, fetched_at: hit.fetched_at };
  }
  if (!hasApiKey()) {
    const stale = cacheGet(cacheKey, null);
    if (stale) return { events: stale.data, cached: true, stale: true, fetched_at: stale.fetched_at };
    return { events: [], cached: false, fetched_at: null, error: 'No Odds API key configured.' };
  }
  try {
    const data = await request(`/sports/${SPORT}/events`, { dateFormat: 'iso' }, { endpoint: 'events', credits: 0 });
    cacheSet(cacheKey, data);
    return { events: data, cached: false, fetched_at: new Date().toISOString() };
  } catch (err) {
    const stale = cacheGet(cacheKey, null);
    if (stale) return { events: stale.data, cached: true, stale: true, fetched_at: stale.fetched_at, error: err.message };
    throw err;
  }
}

/**
 * Player props for ONE game. Costs (markets x regions) credits on a cache miss.
 * Returns a flattened, de-duplicated board: one row per player+market+side with
 * the best price across books.
 */
async function getEventProps(eventId, { markets, force = false } = {}) {
  const regions = (getSetting('odds_regions') || 'us').split(',').map((s) => s.trim()).filter(Boolean);
  const marketList = (markets && markets.length
    ? markets
    : (getSetting('odds_markets') || '').split(',')
  )
    .map((s) => s.trim())
    .filter((s) => MARKET_BY_KEY.has(s));

  if (!marketList.length) throw new OddsApiError('No valid player prop markets selected.', 400);

  const ttl = parseInt(getSetting('props_cache_minutes'), 10) || 360;
  const cacheKey = `props:${eventId}:${regions.join(',')}:${[...marketList].sort().join(',')}`;

  if (!force) {
    const hit = cacheGet(cacheKey, ttl);
    if (hit) {
      return { ...normalizeProps(hit.data), cached: true, fetched_at: hit.fetched_at, cost: 0 };
    }
  }

  if (!hasApiKey()) {
    const stale = cacheGet(cacheKey, null);
    if (stale) return { ...normalizeProps(stale.data), cached: true, stale: true, fetched_at: stale.fetched_at, cost: 0 };
    throw new OddsApiError('No Odds API key configured.', 503);
  }

  const cost = marketList.length * regions.length;
  try {
    const data = await request(
      `/sports/${SPORT}/events/${encodeURIComponent(eventId)}/odds`,
      {
        regions: regions.join(','),
        markets: marketList.join(','),
        oddsFormat: 'american',
        dateFormat: 'iso',
      },
      { endpoint: 'event-odds', credits: cost }
    );
    cacheSet(cacheKey, data);
    return { ...normalizeProps(data), cached: false, fetched_at: new Date().toISOString(), cost };
  } catch (err) {
    const stale = cacheGet(cacheKey, null);
    if (stale) {
      return { ...normalizeProps(stale.data), cached: true, stale: true, fetched_at: stale.fetched_at, cost: 0, error: err.message };
    }
    throw err;
  }
}

/** Flatten the bookmaker/market/outcome tree into pickable rows, best price wins. */
function normalizeProps(raw) {
  const game = {
    id: raw.id,
    home_team: raw.home_team,
    away_team: raw.away_team,
    commence_time: raw.commence_time,
  };
  const byKey = new Map();

  for (const book of raw.bookmakers || []) {
    for (const market of book.markets || []) {
      const meta = marketMeta(market.key);
      for (const outcome of market.outcomes || []) {
        // For player props the player name lives in `description`; `name` is the side.
        const player = outcome.description || outcome.name;
        const side = outcome.description ? outcome.name : 'Yes';
        if (!player) continue;
        const line = outcome.point === undefined ? null : outcome.point;
        const key = `${market.key}|${player}|${side}|${line}`;
        const existing = byKey.get(key);
        const row = {
          market: market.key,
          market_label: meta.label,
          market_group: meta.group,
          market_type: meta.type,
          unit: meta.unit,
          player,
          selection: side,
          line,
          price: outcome.price,
          bookmaker: book.title || book.key,
          book_count: 1,
        };
        if (!existing) {
          byKey.set(key, row);
        } else {
          existing.book_count += 1;
          if (outcome.price > existing.price) {
            existing.price = outcome.price;
            existing.bookmaker = row.bookmaker;
          }
        }
      }
    }
  }

  const props = [...byKey.values()].sort(
    (a, b) =>
      a.market_group.localeCompare(b.market_group) ||
      a.market_label.localeCompare(b.market_label) ||
      a.player.localeCompare(b.player) ||
      String(a.selection).localeCompare(String(b.selection))
  );

  return { game, props, bookmakers: (raw.bookmakers || []).map((b) => b.title || b.key) };
}

/** Final scores, used to nudge admins that games are done. Costs 1-2 credits. */
async function getScores({ daysFrom = 3, force = false } = {}) {
  const cacheKey = `scores:${daysFrom}`;
  if (!force) {
    const hit = cacheGet(cacheKey, 30);
    if (hit) return { scores: hit.data, cached: true, fetched_at: hit.fetched_at };
  }
  if (!hasApiKey()) {
    const stale = cacheGet(cacheKey, null);
    if (stale) return { scores: stale.data, cached: true, stale: true, fetched_at: stale.fetched_at };
    throw new OddsApiError('No Odds API key configured.', 503);
  }
  const data = await request(
    `/sports/${SPORT}/scores`,
    { daysFrom, dateFormat: 'iso' },
    { endpoint: 'scores', credits: daysFrom ? 2 : 1 }
  );
  cacheSet(cacheKey, data);
  return { scores: data, cached: false, fetched_at: new Date().toISOString() };
}

module.exports = {
  MARKETS,
  marketMeta,
  getEvents,
  getEventProps,
  getScores,
  quotaStatus,
  hasApiKey,
  OddsApiError,
  normalizeProps,
  SPORT,
};
