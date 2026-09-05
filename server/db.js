'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'bluemanbozo.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  avatar        TEXT NOT NULL DEFAULT '🤡',
  venmo         TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seasons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  year       INTEGER NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- status: open -> locked -> graded -> final
CREATE TABLE IF NOT EXISTS weeks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id     INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  week_number   INTEGER NOT NULL,
  label         TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  lock_at       TEXT,
  stake_cents   INTEGER NOT NULL DEFAULT 2000,
  payer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (season_id, week_number)
);

-- result: pending | win | loss | push | void
CREATE TABLE IF NOT EXISTS picks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id        INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id       TEXT,
  home_team      TEXT,
  away_team      TEXT,
  commence_time  TEXT,
  player         TEXT NOT NULL,
  market         TEXT NOT NULL,
  market_label   TEXT NOT NULL,
  selection      TEXT NOT NULL,
  line           REAL,
  price          INTEGER NOT NULL DEFAULT -110,
  bookmaker      TEXT,
  trash_talk     TEXT,
  result         TEXT NOT NULL DEFAULT 'pending',
  actual_value   REAL,
  graded_at      TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_picks_week ON picks(week_id);
CREATE INDEX IF NOT EXISTS idx_picks_user ON picks(user_id);

CREATE TABLE IF NOT EXISTS votes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id    INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  voter_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nominee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (week_id, voter_id)
);

CREATE TABLE IF NOT EXISTS bozos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id        INTEGER NOT NULL UNIQUE REFERENCES weeks(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method         TEXT NOT NULL DEFAULT 'vote',
  votes_received INTEGER NOT NULL DEFAULT 0,
  roast          TEXT,
  paid           INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS odds_cache (
  cache_key  TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id    INTEGER REFERENCES weeks(id) ON DELETE SET NULL,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  channel    TEXT NOT NULL,
  target     TEXT,
  subject    TEXT,
  body       TEXT,
  status     TEXT NOT NULL,
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint    TEXT NOT NULL,
  credits     INTEGER NOT NULL DEFAULT 0,
  remaining   INTEGER,
  used_total  INTEGER,
  month       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_usage_month ON api_usage(month);
`);

/* ---------- settings helpers ---------- */

const DEFAULT_SETTINGS = {
  group_name: 'Blue Man Group',
  picks_per_user: '1',
  allow_self_vote: '1',
  hide_picks_until_lock: '1',
  default_stake_cents: '2000',
  odds_regions: 'us',
  // Tuned for the 20k/month tier. On the 500 free tier, trim this to ~4 markets
  // and drop monthly_credit_cap to 400 (Commissioner -> Odds API).
  odds_markets:
    'player_pass_yds,player_pass_tds,player_pass_completions,player_rush_yds,player_rush_attempts,' +
    'player_reception_yds,player_receptions,player_rush_reception_yds,player_anytime_td,player_kicking_points',
  props_cache_minutes: '180',
  events_cache_minutes: '60',
  monthly_credit_cap: '16000',
};

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row && row.value !== null) return row.value;
  if (key in DEFAULT_SETTINGS) return DEFAULT_SETTINGS[key];
  return fallback;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value === null || value === undefined ? null : String(value));
}

function allSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

/* ---------- season/week helpers ---------- */

function activeSeason() {
  let season = db.prepare('SELECT * FROM seasons WHERE is_active = 1 ORDER BY year DESC').get();
  if (!season) season = db.prepare('SELECT * FROM seasons ORDER BY year DESC').get();
  if (!season) {
    const year = nflSeasonYear(new Date());
    db.prepare('INSERT INTO seasons (year, label, is_active) VALUES (?, ?, 1)').run(year, `${year} Season`);
    season = db.prepare('SELECT * FROM seasons WHERE year = ?').get(year);
  }
  return season;
}

// The NFL season that "owns" a date: Jan–Jul belongs to the previous year's season.
function nflSeasonYear(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.getUTCMonth() <= 6 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}

function currentWeek() {
  const season = activeSeason();
  return (
    db
      .prepare(
        `SELECT * FROM weeks WHERE season_id = ?
         ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'locked' THEN 1 WHEN 'graded' THEN 2 ELSE 3 END,
                  week_number DESC
         LIMIT 1`
      )
      .get(season.id) || null
  );
}

module.exports = {
  db,
  DB_PATH,
  DATA_DIR,
  getSetting,
  setSetting,
  allSettings,
  activeSeason,
  currentWeek,
  nflSeasonYear,
  DEFAULT_SETTINGS,
};
