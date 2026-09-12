'use strict';

/**
 * Who gets to pull fresh lines, and how often.
 *
 * The board is one shared cache: whoever refreshes it updates it for the whole
 * group. So rather than pulling on a blanket schedule whether anyone is
 * looking or not, everyone gets a small personal allowance and spends it when
 * they actually want new numbers. Scheduled pulls still happen, and do not
 * come out of anybody's allowance.
 *
 * Two guards keep the bill predictable:
 *   - a per-member weekly count (refreshes_per_member)
 *   - a minimum gap, so two people tapping seconds apart cost one pull, not
 *     two, and neither of them loses an allowance for it
 */

const { db, getSetting } = require('./db');

const num = (key, fallback) => {
  const v = parseInt(getSetting(key), 10);
  return Number.isFinite(v) ? v : fallback;
};

/** The most recent refresh of this week's board, whoever caused it. */
function lastRefresh(weekId) {
  return (
    db
      .prepare(
        `SELECT r.created_at, r.source, r.credits, u.display_name, u.avatar,
                CAST((julianday('now') - julianday(r.created_at)) * 1440 AS REAL) AS age_minutes
         FROM board_refreshes r
         LEFT JOIN users u ON u.id = r.user_id
         WHERE r.week_id = ?
         ORDER BY r.id DESC LIMIT 1`
      )
      .get(weekId) || null
  );
}

function usedThisWeek(weekId, userId) {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM board_refreshes WHERE week_id = ? AND user_id = ? AND source = 'member'`)
    .get(weekId, userId).n;
}

/**
 * What the board should tell this person about refreshing.
 * @returns {{allowance:number, used:number, left:number, unlimited:boolean,
 *            last:object|null, can:boolean, reason:string|null}}
 */
function status(weekId, user) {
  const allowance = num('refreshes_per_member', 2);
  const gap = num('refresh_min_gap_minutes', 10);
  const last = weekId ? lastRefresh(weekId) : null;
  const unlimited = Boolean(user?.is_admin);
  const used = weekId && user ? usedThisWeek(weekId, user.id) : 0;
  const left = unlimited ? Infinity : Math.max(0, allowance - used);

  let can = true;
  let reason = null;
  if (!weekId) {
    can = false;
    reason = 'No week is open.';
  } else if (last && last.age_minutes < gap) {
    // Not a refusal so much as "you already have that" — the board in front
    // of them is younger than the gap, so there is nothing to fetch.
    can = false;
    reason = `These numbers are ${Math.max(1, Math.round(last.age_minutes))} minute${
      Math.round(last.age_minutes) === 1 ? '' : 's'
    } old. Fresh enough.`;
  } else if (!unlimited && left <= 0) {
    can = false;
    reason = `You have used both refreshes this week. The next scheduled pull will update it for everyone.`;
  }

  return {
    allowance,
    used,
    left: unlimited ? null : left,
    unlimited,
    gap_minutes: gap,
    can,
    reason,
    last: last
      ? {
          at: last.created_at,
          age_minutes: Math.round(last.age_minutes),
          by: last.source === 'scheduled' ? null : last.display_name,
          avatar: last.source === 'scheduled' ? null : last.avatar,
          scheduled: last.source === 'scheduled',
        }
      : null,
  };
}

/** Write down that the board was pulled. */
function record(weekId, userId, { source = 'member', credits = 0 } = {}) {
  db.prepare(
    `INSERT INTO board_refreshes (week_id, user_id, source, credits) VALUES (?, ?, ?, ?)`
  ).run(weekId || null, userId || null, source, credits || 0);
}

module.exports = { status, record, lastRefresh, usedThisWeek };
