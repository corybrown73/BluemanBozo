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
  -- 'book' = taken straight off the board, 'adjusted' = line slid and priced by
  -- our model, 'manual' = typed in from whatever book the picker actually uses.
  line_source    TEXT NOT NULL DEFAULT 'book',
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

-- Where each pick's number sat every time we checked. The bozo places the bet
-- days after everyone picked, so the line they get is not the line that was
-- chosen; this is what makes the Saturday placement sheet accurate.
CREATE TABLE IF NOT EXISTS line_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pick_id     INTEGER NOT NULL REFERENCES picks(id) ON DELETE CASCADE,
  line        REAL,
  price       INTEGER,
  bookmaker   TEXT,
  source      TEXT NOT NULL DEFAULT 'scheduled',
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_pick ON line_snapshots(pick_id);

-- Last run of each scheduled digest, so a restart or a sleeping host can catch
-- up rather than silently skipping a week.
CREATE TABLE IF NOT EXISTS job_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job         TEXT NOT NULL,
  week_id     INTEGER REFERENCES weeks(id) ON DELETE SET NULL,
  status      TEXT NOT NULL,
  detail      TEXT,
  credits     INTEGER NOT NULL DEFAULT 0,
  recipients  INTEGER NOT NULL DEFAULT 0,
  late        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job, created_at);

-- Who pulled fresh lines, and when. One person's refresh updates the board for
-- everyone, so this is both a per-member quota and the attribution the board
-- shows: "refreshed 12 minutes ago by Derek".
CREATE TABLE IF NOT EXISTS board_refreshes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id     INTEGER REFERENCES weeks(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source      TEXT NOT NULL DEFAULT 'member',   -- 'member' | 'scheduled'
  credits     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_refresh_week ON board_refreshes (week_id, user_id);

-- Picks people are weighing but have not committed to.
--
-- Nobody makes their mind up in one go: they find three they like, sit on
-- them, and pick one on Sunday morning. The sheet had nowhere to put that, so
-- it happened in the group chat. This is that shortlist, and the COUNT is
-- public on purpose — "Ricky is weighing 3" is half the fun. The contents stay
-- with whoever put them there, so nobody can shop off someone else's homework.
CREATE TABLE IF NOT EXISTS shortlist (
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
  line_source    TEXT NOT NULL DEFAULT 'book',
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shortlist_week ON shortlist (week_id, user_id);
-- The same bet twice is a mis-tap, not a second opinion.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shortlist_unique
  ON shortlist (week_id, user_id, player, market, selection, IFNULL(line, -999999));

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

/**
 * Columns added after the first release. CREATE TABLE IF NOT EXISTS does not
 * touch a table that already exists, so anything new has to be added to a
 * live database by hand — idempotently, so every boot can run it.
 */
function ensureColumn(table, column, ddl) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
// Where a pick stands while its game is on: filled every few minutes from the
// box score, never graded from — grading is a separate, deliberate step.
ensureColumn('picks', 'live_value', 'REAL');
ensureColumn('picks', 'live_note', 'TEXT');
ensureColumn('picks', 'live_at', 'TEXT');

const DEFAULT_SETTINGS = {
  group_name: 'Blue Man Group',
  picks_per_user: '1',
  allow_self_vote: '1',
  hide_picks_until_lock: '1',
  default_stake_cents: '2000',
  odds_regions: 'us',
  // Each market costs one credit per game, so the count here multiplies the
  // whole bill: on a ~15-game Sunday slate, 6 markets is 90 a pull. The
  // defaults below assume the 20,000-credit plan. On the free 500 tier, drop
  // to five markets and set monthly_credit_cap to 450 — the app reads the
  // real plan size from the provider's headers and warns when the cap and the
  // plan disagree, and the usage card reports what a real week cost.
  //
  // These are DEFAULTS for a fresh database. An existing deployment keeps
  // whatever is in its settings table; change those in Commissioner -> Odds API.
  // What this group actually bets: touchdowns (anytime and first), rushing or
  // receiving yards, the two combined, and passing TDs. Carries, completions
  // and attempts are deliberately absent — nobody has ever picked one, and
  // each market loaded is a credit per game whether it gets used or not.
  odds_markets:
    'player_anytime_td,player_1st_td,player_rush_yds,player_reception_yds,player_rush_reception_yds,player_pass_tds',
  // Which games the pick board offers. 'week' = through the end of the
  // current football week (Thu-Mon). A number = that many days. 0 = all.
  slate_days: 'week',
  // Which kickoff days the board offers, in Eastern time. The group plays the
  // Sunday slate and Monday night; Thursday games are not used.
  slate_weekdays: 'sun,mon',
  props_cache_minutes: '120',
  events_cache_minutes: '60',
  monthly_credit_cap: '18000',
  // Everyone gets a couple of pulls a week of their own. One person's refresh
  // updates the board for the whole group, so these are cheap in practice and
  // they happen when somebody actually wants new numbers.
  // How many candidates one person may weigh at once. Enough to deliberate,
  // not enough to shortlist the whole board.
  shortlist_max: '8',
  refreshes_per_member: '2',
  // A refresh this soon after the last one is served from cache and does not
  // count — two people tapping within a minute of each other should not cost
  // two pulls.
  refresh_min_gap_minutes: '10',

  // Weekly rhythm. Times are in schedule_timezone, cron format: min hour * * dow
  // (0=Sun ... 2=Tue, 4=Thu, 6=Sat).
  // The clock: the app locks, opens and updates on its own. Each can be
  // switched off, and every one of them can still be done by hand.
  clock_enabled: '1',           // the master switch: off, and nothing below runs
  auto_lock: '1',
  lock_time_et: '12:55',        // Sunday, Eastern — the early window's kickoff minus five
  auto_open_hour_et: '6',       // Tuesday morning, Eastern
  live_stats: '1',
  live_interval_minutes: '1',
  schedule_enabled: '0',
  schedule_timezone: 'America/New_York',
  cron_open:  '0 12 * * 6',   // Saturday noon - get your bets in, board is live
  cron_mid:   '',             // off - the group does not play Thursday games
  cron_final: '0 10 * * 0',   // Sunday 10am - final numbers for whoever is paying
  schedule_channels: 'email',
  auto_open_week: '1',
  injury_feed: '1',
  // Thursday costs nothing by default: injuries come free from ESPN and the
  // "who hasn't picked" nag needs no API at all. Turn this on only if you have
  // credits to spare — it re-prices every picked game.
  mid_refresh_lines: '0',
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

/**
 * The week the app is about right now.
 *
 * A week that still needs settling comes first: one waiting on a vote, then
 * one waiting on stat lines. Only once those are done does the next open week
 * take over. The old order put an open week ahead of everything, so the
 * moment Tuesday's week was opened — by hand or by the scheduler — last
 * week's vote screen vanished from the app with the bozo still uncrowned.
 * The bill has to be settled before anyone moves on; the sheet worked the
 * same way, it just had two rows.
 *
 * A locked week nobody picked in is skipped: there is nothing in it to
 * settle, and it must not hold the season hostage.
 */
function currentWeek() {
  const season = activeSeason();
  return (
    db
      .prepare(
        `SELECT w.* FROM weeks w WHERE w.season_id = ?
         ORDER BY CASE w.status
                    WHEN 'graded' THEN 0
                    WHEN 'locked' THEN
                      CASE WHEN EXISTS (SELECT 1 FROM picks p WHERE p.week_id = w.id) THEN 1 ELSE 3 END
                    WHEN 'open'   THEN 2
                    ELSE 4
                  END,
                  w.week_number DESC
         LIMIT 1`
      )
      .get(season.id) || null
  );
}

/**
 * The week people are picking in — the latest open one, or nothing. Not the
 * same question as currentWeek(): the Saturday lock and the Tuesday summons
 * are about picks, and must not land on the week still being graded.
 */
function pickWeek() {
  const season = activeSeason();
  return (
    db
      .prepare(
        `SELECT * FROM weeks WHERE season_id = ? AND status = 'open' ORDER BY week_number DESC LIMIT 1`
      )
      .get(season.id) || null
  );
}

/** A later week already open for picks, waiting behind one still being settled. */
function upcomingWeek(current) {
  if (!current) return null;
  return (
    db
      .prepare(
        `SELECT id, week_number FROM weeks
         WHERE season_id = ? AND status = 'open' AND week_number > ?
         ORDER BY week_number ASC LIMIT 1`
      )
      .get(current.season_id, current.week_number) || null
  );
}

module.exports = {
  upcomingWeek,
  pickWeek,
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
