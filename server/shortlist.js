'use strict';

/**
 * The shortlist — bets you are weighing, not bets you have made.
 *
 * Nobody decides in one sitting. You find three you like on Saturday, sleep
 * on it, and commit on Sunday morning. Until now that happened in the group
 * chat, where it got lost. This holds it.
 *
 * Two deliberate asymmetries:
 *
 *   - the COUNT is public, the CONTENTS are not. "Ricky is weighing 3" is the
 *     fun part, and it needles people into deciding. Showing what is on the
 *     list would let everyone shop off each other's homework, and would walk
 *     straight through the group's hide-picks-until-lock setting.
 *
 *   - nothing here is a commitment. A shortlist entry costs nothing, expires
 *     with the week, and is not scored. Only a real pick counts, and choosing
 *     one off the list clears the rest.
 */

const { db, getSetting } = require('./db');
const odds = require('./odds');

/** How many a person may have open at once — enough to weigh, not to hoard. */
function limit() {
  const n = parseInt(getSetting('shortlist_max'), 10);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

const COLS = `id, week_id, user_id, event_id, home_team, away_team, commence_time,
              player, market, market_label, selection, line, price, bookmaker,
              line_source, note, created_at`;

/** One person's shortlist for a week, newest first. */
function forUser(weekId, userId) {
  if (!weekId || !userId) return [];
  return db
    .prepare(`SELECT ${COLS} FROM shortlist WHERE week_id = ? AND user_id = ? ORDER BY id DESC`)
    .all(weekId, userId)
    .map(decorate);
}

/**
 * How many everyone is weighing. Public — this is the bit that goes on the
 * week page next to each name.
 * @returns {Array<{user_id:number, count:number}>}
 */
function counts(weekId) {
  if (!weekId) return [];
  return db
    .prepare('SELECT user_id, COUNT(*) AS count FROM shortlist WHERE week_id = ? GROUP BY user_id')
    .all(weekId);
}

/** Add the scoring fields the UI needs, same as a real pick gets. */
function decorate(row) {
  const meta = odds.marketMeta(row.market);
  return {
    ...row,
    unit: meta.unit,
    market_group: meta.group,
    market_type: meta.type,
    market_order: meta.order,
  };
}

/**
 * Put one on the list.
 * @returns {{ok:boolean, error?:string, status?:number, entry?:object}}
 */
function add(weekId, userId, body = {}) {
  const player = String(body.player || '').trim();
  const market = String(body.market || '').trim();
  const selection = String(body.selection || '').trim();

  if (!player) return { ok: false, status: 400, error: 'Pick a player.' };
  if (!market) return { ok: false, status: 400, error: 'Pick a market.' };
  if (!selection) return { ok: false, status: 400, error: 'Pick a side.' };

  const meta = odds.marketMeta(market);
  if (!odds.sideIsValid(market, selection)) {
    return {
      ok: false,
      status: 400,
      error: `${meta.label} is a ${meta.sides.join('/')} bet — "${selection}" isn't an option for it.`,
    };
  }

  const line =
    body.line === '' || body.line === null || body.line === undefined ? null : Number(body.line);
  if (meta.type === 'ou' && !Number.isFinite(line)) {
    return { ok: false, status: 400, error: `${meta.label} needs a line.` };
  }
  if (meta.type === 'yesno' && line !== null) {
    return { ok: false, status: 400, error: `${meta.label} has no line.` };
  }

  const price = parseInt(body.price, 10);
  if (!Number.isFinite(price) || price === 0) {
    return { ok: false, status: 400, error: 'Odds must be an American price like -110 or +225.' };
  }

  const have = db
    .prepare('SELECT COUNT(*) AS n FROM shortlist WHERE week_id = ? AND user_id = ?')
    .get(weekId, userId).n;
  if (have >= limit()) {
    return {
      ok: false,
      status: 409,
      error: `That is ${limit()} on your list already. Drop one before adding another — you can only bet one.`,
    };
  }

  try {
    const info = db
      .prepare(
        `INSERT INTO shortlist (week_id, user_id, event_id, home_team, away_team, commence_time,
                                player, market, market_label, selection, line, price, bookmaker,
                                line_source, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        weekId,
        userId,
        body.event_id || null,
        body.home_team || null,
        body.away_team || null,
        body.commence_time || null,
        player,
        market,
        String(body.market_label || meta.label),
        selection,
        line,
        price,
        body.bookmaker || null,
        String(body.line_source || 'book'),
        body.note ? String(body.note).slice(0, 200) : null
      );
    const entry = db.prepare(`SELECT ${COLS} FROM shortlist WHERE id = ?`).get(info.lastInsertRowid);
    return { ok: true, entry: decorate(entry) };
  } catch (err) {
    // The unique index. Tapping the same star twice is a mis-tap, so treat it
    // as already done rather than as an error.
    if (/UNIQUE/i.test(err.message)) {
      const entry = db
        .prepare(
          `SELECT ${COLS} FROM shortlist
           WHERE week_id = ? AND user_id = ? AND player = ? AND market = ? AND selection = ?
             AND IFNULL(line, -999999) = IFNULL(?, -999999)`
        )
        .get(weekId, userId, player, market, selection, line);
      return { ok: true, entry: entry ? decorate(entry) : null, already: true };
    }
    return { ok: false, status: 500, error: err.message };
  }
}

/** Take one off. Only ever your own. */
function remove(weekId, userId, id) {
  const info = db
    .prepare('DELETE FROM shortlist WHERE id = ? AND week_id = ? AND user_id = ?')
    .run(id, weekId, userId);
  return info.changes > 0;
}

/** Clear the list — what happens once a pick is actually made. */
function clear(weekId, userId) {
  return db.prepare('DELETE FROM shortlist WHERE week_id = ? AND user_id = ?').run(weekId, userId).changes;
}

module.exports = { forUser, counts, add, remove, clear, limit };
