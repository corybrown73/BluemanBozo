'use strict';

/**
 * Game state assembly and the rules around it. Routes stay thin; the
 * interesting decisions (who can see whose pick, when voting opens, how a
 * week's bozo gets resolved) live here.
 *
 * Week lifecycle:
 *   open   -> everyone submits a player prop. Picks are hidden from each
 *             other so nobody can fade the group.
 *   locked -> picks revealed, games underway, no more edits.
 *   graded -> actual stat lines entered, results computed, VOTING OPEN.
 *   final  -> bozo declared, ledger updated, summons sent.
 */

const { db, getSetting, activeSeason } = require('./db');
const scoring = require('./scoring');
const roast = require('./roast');
const { marketMeta } = require('./odds');

const STATUSES = ['open', 'locked', 'graded', 'final'];

function statusRank(status) {
  const i = STATUSES.indexOf(status);
  return i === -1 ? 0 : i;
}

function listUsers({ includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'WHERE is_active = 1';
  return db
    .prepare(`SELECT id, username, display_name, email, phone, avatar, venmo, is_admin, is_active FROM users ${where} ORDER BY display_name COLLATE NOCASE`)
    .all()
    .map((u) => ({ ...u, is_admin: !!u.is_admin, is_active: !!u.is_active }));
}

function getWeek(weekId) {
  return db.prepare('SELECT * FROM weeks WHERE id = ?').get(weekId) || null;
}

function rawPicks(weekId) {
  return db
    .prepare(
      `SELECT p.*, u.display_name, u.avatar, u.username
       FROM picks p JOIN users u ON u.id = p.user_id
       WHERE p.week_id = ?
       ORDER BY p.created_at`
    )
    .all(weekId);
}

/** Enrich a pick with derived scoring fields the UI needs. */
function decoratePick(pick) {
  const meta = marketMeta(pick.market);
  const breakdown = scoring.bozoBreakdown(pick);
  return {
    ...pick,
    unit: meta.unit,
    market_group: meta.group,
    market_type: meta.type,
    price_display: scoring.formatAmerican(pick.price),
    decimal_odds: Number(scoring.americanToDecimal(pick.price).toFixed(4)),
    ...breakdown,
  };
}

/**
 * Hide the details of other people's picks while the week is still open, so
 * the last person to submit can't just fade everyone. Your own pick is always
 * fully visible to you; admins always see everything.
 */
function serializePick(pick, viewer, week) {
  const decorated = decoratePick(pick);
  const hideUntilLock = getSetting('hide_picks_until_lock') === '1';
  const revealed =
    !hideUntilLock ||
    statusRank(week.status) >= statusRank('locked') ||
    viewer?.id === pick.user_id ||
    viewer?.is_admin;

  if (revealed) return { ...decorated, hidden: false };

  return {
    id: pick.id,
    week_id: pick.week_id,
    user_id: pick.user_id,
    display_name: pick.display_name,
    avatar: pick.avatar,
    username: pick.username,
    hidden: true,
    result: 'pending',
    created_at: pick.created_at,
  };
}

function getVotes(weekId) {
  return db
    .prepare(
      `SELECT v.*, voter.display_name AS voter_name, voter.avatar AS voter_avatar,
              nominee.display_name AS nominee_name, nominee.avatar AS nominee_avatar
       FROM votes v
       JOIN users voter ON voter.id = v.voter_id
       JOIN users nominee ON nominee.id = v.nominee_id
       WHERE v.week_id = ?
       ORDER BY v.created_at`
    )
    .all(weekId);
}

function getBozo(weekId) {
  return (
    db
      .prepare(
        `SELECT b.*, u.display_name, u.avatar, u.venmo, u.username
         FROM bozos b JOIN users u ON u.id = b.user_id WHERE b.week_id = ?`
      )
      .get(weekId) || null
  );
}

/** Career + season bozo counts for one user. */
function bozoCounts(userId, seasonId) {
  const all = db
    .prepare('SELECT COUNT(*) AS n FROM bozos WHERE user_id = ?')
    .get(userId).n;
  const season = db
    .prepare(
      `SELECT COUNT(*) AS n FROM bozos b JOIN weeks w ON w.id = b.week_id WHERE b.user_id = ? AND w.season_id = ?`
    )
    .get(userId, seasonId).n;
  return { all_time: all, season };
}

/** Everything the UI needs to render one week. */
function weekDetail(weekId, viewer) {
  const week = getWeek(weekId);
  if (!week) return null;

  const picksRaw = rawPicks(weekId);
  const picks = picksRaw.map((p) => serializePick(p, viewer, week));
  const decorated = picksRaw.map(decoratePick);

  const votes = getVotes(weekId);
  const bozo = getBozo(weekId);
  const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(week.season_id);

  const canSeeParlay = statusRank(week.status) >= statusRank('locked');
  const parlayInfo = canSeeParlay ? scoring.parlay(decorated, week.stake_cents) : null;

  const votingOpen = week.status === 'graded';
  const myVote = viewer ? votes.find((v) => v.voter_id === viewer.id) || null : null;

  // Tally is public once voting opens — half the fun is watching it happen.
  const tally = new Map();
  for (const v of votes) tally.set(v.nominee_id, (tally.get(v.nominee_id) || 0) + 1);

  const candidates = scoring.rankBozoCandidates(decorated).map((c) => ({
    user_id: c.user_id,
    display_name: c.display_name,
    avatar: c.avatar,
    pick_id: c.id,
    player: c.player,
    market_label: c.market_label,
    selection: c.selection,
    line: c.line,
    actual_value: c.actual_value,
    unit: c.unit,
    price: c.price,
    price_display: c.price_display,
    bozo_score: c.bozo_score,
    miss_percent: c.miss_percent,
    miss_score: c.miss_score,
    chalk_score: c.chalk_score,
    implied_probability: c.implied_probability,
    votes: tally.get(c.user_id) || 0,
  }));

  const payer = week.payer_user_id
    ? db.prepare('SELECT id, display_name, avatar, venmo FROM users WHERE id = ?').get(week.payer_user_id)
    : null;

  const awards = statusRank(week.status) >= statusRank('graded') ? roast.weeklyAwards(decorated) : [];

  // Nobody lost: there is no bozo to crown, so the vote screen needs its own
  // ending. Without this the week has no way to reach 'final' and the three
  // hand-written perfect-week lines are unreachable.
  const perfectWeek =
    statusRank(week.status) >= statusRank('graded') && !candidates.length && decorated.length
      ? roast.perfectWeek(`w${week.id}`)
      : null;

  return {
    week: {
      ...week,
      season_year: season?.year,
      season_label: season?.label,
      voting_open: votingOpen,
      picks_locked: statusRank(week.status) >= statusRank('locked'),
      graded: statusRank(week.status) >= statusRank('graded'),
    },
    payer,
    picks,
    parlay: parlayInfo,
    votes: votingOpen || statusRank(week.status) >= statusRank('final') ? votes : [],
    vote_tally: [...tally.entries()].map(([user_id, count]) => ({ user_id, count })),
    my_vote: myVote,
    candidates,
    perfect_week: perfectWeek,
    bozo: bozo
      ? {
          ...bozo,
          counts: bozoCounts(bozo.user_id, week.season_id),
        }
      : null,
    awards,
    missing_picks: listUsers()
      .filter((u) => !picksRaw.some((p) => p.user_id === u.id))
      .map((u) => ({ id: u.id, display_name: u.display_name, avatar: u.avatar })),
    // One row per member with their pick state — the "did you pick yet?"
    // question, answered without anyone having to ask it.
    roster: listUsers().map((u) => {
      const mine = picksRaw.find((p) => p.user_id === u.id);
      const shown = mine ? picks.find((p) => p.id === mine.id) : null;
      return {
        id: u.id,
        display_name: u.display_name,
        avatar: u.avatar,
        picked: Boolean(mine),
        picked_at: mine ? mine.created_at : null,
        // Same masking the pick itself gets: hidden picks read as pending.
        result: shown ? shown.result : null,
        is_payer: week.payer_user_id === u.id,
      };
    }),
  };
}

/** Season + all-time standings, with streaks and pick records. */
function leaderboard({ seasonId = null } = {}) {
  const users = listUsers({ includeInactive: true });
  const season = seasonId ? db.prepare('SELECT * FROM seasons WHERE id = ?').get(seasonId) : activeSeason();
  if (!season) return null;

  const rows = users.map((u) => {
    const counts = bozoCounts(u.id, season.id);
    const rec = db
      .prepare(
        `SELECT
           COUNT(*) AS picks,
           SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses,
           SUM(CASE WHEN result = 'push' THEN 1 ELSE 0 END) AS pushes
         FROM picks WHERE user_id = ?`
      )
      .get(u.id);
    const seasonRec = db
      .prepare(
        `SELECT
           COUNT(*) AS picks,
           SUM(CASE WHEN p.result = 'win' THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN p.result = 'loss' THEN 1 ELSE 0 END) AS losses,
           SUM(CASE WHEN p.result = 'push' THEN 1 ELSE 0 END) AS pushes
         FROM picks p JOIN weeks w ON w.id = p.week_id
         WHERE p.user_id = ? AND w.season_id = ?`
      )
      .get(u.id, season.id);

    const weeksPlayed = db
      .prepare(`SELECT COUNT(DISTINCT week_id) AS n FROM picks WHERE user_id = ?`)
      .get(u.id).n;

    const worst = db
      .prepare(
        `SELECT p.*, w.week_number, s.year FROM picks p
         JOIN weeks w ON w.id = p.week_id JOIN seasons s ON s.id = w.season_id
         WHERE p.user_id = ? AND p.result = 'loss' AND p.actual_value IS NOT NULL`
      )
      .all(u.id)
      .map((p) => ({ ...p, ...scoring.bozoBreakdown(p) }))
      .sort((a, b) => (b.bozo_score || 0) - (a.bozo_score || 0))[0] || null;

    return {
      user: { id: u.id, display_name: u.display_name, avatar: u.avatar, username: u.username, is_active: u.is_active, venmo: u.venmo },
      bozos_all_time: counts.all_time,
      bozos_season: counts.season,
      title: roast.titleFor(counts.all_time),
      weeks_played: weeksPlayed,
      bozo_rate: weeksPlayed ? Number((counts.all_time / weeksPlayed).toFixed(3)) : 0,
      record: {
        picks: rec.picks || 0,
        wins: rec.wins || 0,
        losses: rec.losses || 0,
        pushes: rec.pushes || 0,
        win_pct: rec.wins + rec.losses ? Number((rec.wins / (rec.wins + rec.losses)).toFixed(3)) : 0,
      },
      season_record: {
        picks: seasonRec.picks || 0,
        wins: seasonRec.wins || 0,
        losses: seasonRec.losses || 0,
        pushes: seasonRec.pushes || 0,
        win_pct: seasonRec.wins + seasonRec.losses ? Number((seasonRec.wins / (seasonRec.wins + seasonRec.losses)).toFixed(3)) : 0,
      },
      streak: bozoStreak(u.id),
      worst_pick: worst
        ? {
            week_number: worst.week_number,
            year: worst.year,
            player: worst.player,
            market_label: worst.market_label,
            selection: worst.selection,
            line: worst.line,
            actual_value: worst.actual_value,
            bozo_score: worst.bozo_score,
            miss_percent: worst.miss_percent,
          }
        : null,
    };
  });

  rows.sort(
    (a, b) =>
      b.bozos_season - a.bozos_season ||
      b.bozos_all_time - a.bozos_all_time ||
      a.user.display_name.localeCompare(b.user.display_name)
  );

  // A second ordering for the same people: who is actually good at this.
  // Requires a few picks before a 1-0 start counts as "100%".
  const MIN_PICKS = 3;
  const accuracy = [...rows]
    .map((r) => ({
      user: r.user,
      season: r.season_record,
      all_time: r.record,
      qualified: r.record.wins + r.record.losses >= MIN_PICKS,
    }))
    .sort(
      (a, b) =>
        Number(b.qualified) - Number(a.qualified) ||
        b.all_time.win_pct - a.all_time.win_pct ||
        b.all_time.wins - a.all_time.wins ||
        a.user.display_name.localeCompare(b.user.display_name)
    );

  return { season, rows, accuracy, group: groupStats(season.id), min_picks_to_qualify: MIN_PICKS };
}

/**
 * How the group as a whole is doing — the number the chat actually argues
 * about. A "ticket" counts once every leg in that week is settled; it cashed
 * only if every leg won (pushes drop out, as they do at the book).
 */
function groupStats(seasonId) {
  const record = (where, params) =>
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN p.result = 'win'  THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN p.result = 'loss' THEN 1 ELSE 0 END) AS losses,
           SUM(CASE WHEN p.result = 'push' THEN 1 ELSE 0 END) AS pushes
         FROM picks p JOIN weeks w ON w.id = p.week_id ${where}`
      )
      .get(...params);

  const tickets = (where, params) => {
    const weeks = db
      .prepare(
        `SELECT w.id,
           COUNT(p.id) AS legs,
           SUM(CASE WHEN p.result = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN p.result = 'loss' THEN 1 ELSE 0 END) AS losses,
           SUM(CASE WHEN p.result = 'win' THEN 1 ELSE 0 END) AS wins
         FROM weeks w JOIN picks p ON p.week_id = w.id ${where}
         GROUP BY w.id`
      )
      .all(...params);
    const settled = weeks.filter((w) => w.legs > 0 && w.pending === 0);
    const cashed = settled.filter((w) => w.losses === 0 && w.wins > 0);
    return { total: settled.length, cashed: cashed.length };
  };

  const shape = (r, t) => {
    const wins = r.wins || 0;
    const losses = r.losses || 0;
    const pushes = r.pushes || 0;
    return {
      wins,
      losses,
      pushes,
      picks: wins + losses + pushes,
      win_pct: wins + losses ? Number((wins / (wins + losses)).toFixed(3)) : 0,
      tickets_total: t.total,
      tickets_cashed: t.cashed,
      cash_rate: t.total ? Number((t.cashed / t.total).toFixed(3)) : 0,
    };
  };

  return {
    season: shape(record('WHERE w.season_id = ?', [seasonId]), tickets('WHERE w.season_id = ?', [seasonId])),
    all_time: shape(record('', []), tickets('', [])),
  };
}

/** Current and longest consecutive-bozo streaks, in week order. */
function bozoStreak(userId) {
  const weeks = db
    .prepare(
      `SELECT w.id, b.user_id FROM weeks w
       LEFT JOIN bozos b ON b.week_id = w.id
       JOIN seasons s ON s.id = w.season_id
       WHERE w.status = 'final'
       ORDER BY s.year, w.week_number`
    )
    .all();

  let current = 0;
  let longest = 0;
  for (const w of weeks) {
    if (w.user_id === userId) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return { current, longest };
}

/** Compact week-by-week history for the timeline view. */
function history({ limit = 50 } = {}) {
  return db
    .prepare(
      `SELECT w.id, w.week_number, w.status, w.stake_cents, s.year, s.label AS season_label,
              b.user_id AS bozo_user_id, u.display_name AS bozo_name, u.avatar AS bozo_avatar,
              b.roast, b.method, b.paid,
              (SELECT COUNT(*) FROM picks p WHERE p.week_id = w.id) AS pick_count,
              (SELECT COUNT(*) FROM picks p WHERE p.week_id = w.id AND p.result = 'win') AS win_count,
              (SELECT COUNT(*) FROM picks p WHERE p.week_id = w.id AND p.result = 'loss') AS loss_count
       FROM weeks w
       JOIN seasons s ON s.id = w.season_id
       LEFT JOIN bozos b ON b.week_id = w.id
       LEFT JOIN users u ON u.id = b.user_id
       ORDER BY s.year DESC, w.week_number DESC
       LIMIT ?`
    )
    .all(limit);
}

module.exports = {
  STATUSES,
  statusRank,
  listUsers,
  getWeek,
  rawPicks,
  decoratePick,
  serializePick,
  getVotes,
  getBozo,
  bozoCounts,
  weekDetail,
  leaderboard,
  groupStats,
  bozoStreak,
  history,
};
