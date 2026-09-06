'use strict';

/**
 * First-boot setup for a hosted deploy.
 *
 * On a host there is no terminal to run `npm run seed` in, so a fresh deploy
 * used to come up with zero users and zero seasons — a login page nobody on
 * earth could get past. This creates the season and the first commissioner
 * from environment variables the host already knows how to set.
 *
 * It only ever fires on a COMPLETELY EMPTY user table. Once anybody exists it
 * does nothing, so leaving the variables set is harmless and a redeploy can
 * never reset a password or resurrect a removed account.
 *
 * Everyone else is added through Commissioner → Members in the app.
 */

const { db, setSetting, nflSeasonYear } = require('./db');
const { hashPassword } = require('./auth');

const MIN_PASSWORD = 8;

/** The active season for the current NFL year, created if it is missing. */
function ensureSeason() {
  const year = nflSeasonYear(new Date());
  let season = db.prepare('SELECT * FROM seasons WHERE year = ?').get(year);
  if (season) {
    if (!season.is_active) {
      db.prepare('UPDATE seasons SET is_active = 0').run();
      db.prepare('UPDATE seasons SET is_active = 1 WHERE id = ?').run(season.id);
    }
    return { season, created: false };
  }
  db.prepare('UPDATE seasons SET is_active = 0').run();
  db.prepare('INSERT INTO seasons (year, label, is_active) VALUES (?, ?, 1)').run(year, `${year} Season`);
  season = db.prepare('SELECT * FROM seasons WHERE year = ?').get(year);
  return { season, created: true };
}

/**
 * @returns {{status: string, detail?: string, username?: string}}
 *   'skipped'   nothing to do — members already exist
 *   'created'   the season and the commissioner are in
 *   'no-admin'  the table is empty and no credentials were supplied
 *   'refused'   credentials were supplied but are not usable
 */
function bootstrap(env = process.env) {
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount > 0) return { status: 'skipped' };

  const username = String(env.ADMIN_USERNAME || '').trim().toLowerCase();
  const password = String(env.ADMIN_PASSWORD || '');

  if (!username && !password) return { status: 'no-admin' };

  if (!/^[a-z0-9_.-]{2,32}$/.test(username)) {
    return { status: 'refused', detail: 'ADMIN_USERNAME must be 2-32 characters: letters, numbers, dot, dash, underscore.' };
  }
  if (password.length < MIN_PASSWORD) {
    return { status: 'refused', detail: `ADMIN_PASSWORD must be at least ${MIN_PASSWORD} characters.` };
  }

  const displayName = String(env.ADMIN_DISPLAY_NAME || '').trim() || username.replace(/^./, (c) => c.toUpperCase());

  const run = db.transaction(() => {
    ensureSeason();
    db.prepare(
      `INSERT INTO users (username, display_name, password_hash, email, avatar, is_admin)
       VALUES (?, ?, ?, ?, ?, 1)`
    ).run(username, displayName, hashPassword(password), String(env.ADMIN_EMAIL || '').trim() || null, '👑');
    // Safe to set unconditionally: this whole transaction only runs on an
    // empty user table, so there is no chosen name to clobber.
    if (env.GROUP_NAME) setSetting('group_name', String(env.GROUP_NAME).trim());
  });
  run();

  return { status: 'created', username };
}

module.exports = { bootstrap, ensureSeason };
