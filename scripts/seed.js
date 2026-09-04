#!/usr/bin/env node
'use strict';

/**
 * First-run setup: creates the season, the commissioner account, and the rest
 * of the crew. Safe to re-run — it never overwrites an existing member.
 *
 *   npm run seed
 *   npm run seed -- --demo     also loads three fake finished weeks
 */

require('dotenv').config();

const crypto = require('crypto');
const { db, setSetting, nflSeasonYear } = require('../server/db');
const { hashPassword } = require('../server/auth');

const args = process.argv.slice(2);
const withDemo = args.includes('--demo');

function randomPassword() {
  const words = ['parlay', 'bozo', 'chalk', 'hammer', 'sweat', 'cover', 'juice', 'fade', 'lock', 'boot'];
  const w = words[crypto.randomInt(words.length)];
  return `${w}-${crypto.randomInt(1000, 9999)}`;
}

const CREW = [
  { username: 'cory', display_name: 'Cory', avatar: '👑', is_admin: 1 },
  { username: 'member2', display_name: 'Member Two', avatar: '🎺' },
  { username: 'member3', display_name: 'Member Three', avatar: '🥁' },
  { username: 'member4', display_name: 'Member Four', avatar: '🎷' },
  { username: 'member5', display_name: 'Member Five', avatar: '🪘' },
  { username: 'member6', display_name: 'Member Six', avatar: '🎸' },
];

const created = [];

function ensureUser(spec) {
  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(spec.username);
  if (existing) {
    console.log(`  · ${spec.username.padEnd(10)} already exists, left alone`);
    return existing;
  }
  const password = process.env.SEED_PASSWORD || randomPassword();
  const info = db
    .prepare(
      `INSERT INTO users (username, display_name, password_hash, avatar, is_admin)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(spec.username, spec.display_name, hashPassword(password), spec.avatar || '🤡', spec.is_admin || 0);
  created.push({ ...spec, password });
  console.log(`  ✓ ${spec.username.padEnd(10)} created`);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function ensureSeason() {
  const year = nflSeasonYear(new Date());
  let season = db.prepare('SELECT * FROM seasons WHERE year = ?').get(year);
  if (!season) {
    db.prepare('INSERT INTO seasons (year, label, is_active) VALUES (?, ?, 1)').run(year, `${year} Season`);
    season = db.prepare('SELECT * FROM seasons WHERE year = ?').get(year);
    console.log(`  ✓ ${year} season created and set active`);
  } else {
    db.prepare('UPDATE seasons SET is_active = 0').run();
    db.prepare('UPDATE seasons SET is_active = 1 WHERE id = ?').run(season.id);
    console.log(`  · ${year} season already exists, set active`);
  }
  return season;
}

/* ---------------- demo data ---------------- */

const DEMO_PICKS = [
  [
    { player: 'Josh Allen', market: 'player_pass_yds', market_label: 'Passing Yards', selection: 'Over', line: 249.5, price: -115, actual: 288 },
    { player: 'Puka Nacua', market: 'player_reception_yds', market_label: 'Receiving Yards', selection: 'Over', line: 74.5, price: -110, actual: 11 },
    { player: 'Saquon Barkley', market: 'player_rush_yds', market_label: 'Rushing Yards', selection: 'Over', line: 88.5, price: -120, actual: 109 },
    { player: 'Travis Kelce', market: 'player_receptions', market_label: 'Receptions', selection: 'Over', line: 5.5, price: -135, actual: 7 },
    { player: 'Ja\'Marr Chase', market: 'player_anytime_td', market_label: 'Anytime TD', selection: 'Yes', line: null, price: 125, actual: 1 },
    { player: 'Derrick Henry', market: 'player_rush_yds', market_label: 'Rushing Yards', selection: 'Over', line: 92.5, price: -110, actual: 90 },
  ],
  [
    { player: 'Lamar Jackson', market: 'player_rush_yds', market_label: 'Rushing Yards', selection: 'Over', line: 51.5, price: -115, actual: 62 },
    { player: 'CeeDee Lamb', market: 'player_reception_yds', market_label: 'Receiving Yards', selection: 'Over', line: 82.5, price: -110, actual: 94 },
    { player: 'Patrick Mahomes', market: 'player_pass_tds', market_label: 'Passing TDs', selection: 'Over', line: 1.5, price: -180, actual: 1 },
    { player: 'Bijan Robinson', market: 'player_rush_yds', market_label: 'Rushing Yards', selection: 'Over', line: 71.5, price: -110, actual: 88 },
    { player: 'Mike Evans', market: 'player_anytime_td', market_label: 'Anytime TD', selection: 'Yes', line: null, price: 140, actual: 1 },
    { player: 'Tyreek Hill', market: 'player_receptions', market_label: 'Receptions', selection: 'Over', line: 6.5, price: -125, actual: 4 },
  ],
  [
    { player: 'Jalen Hurts', market: 'player_pass_yds', market_label: 'Passing Yards', selection: 'Over', line: 224.5, price: -110, actual: 244 },
    { player: 'Amon-Ra St. Brown', market: 'player_receptions', market_label: 'Receptions', selection: 'Over', line: 6.5, price: -140, actual: 9 },
    { player: 'Jonathan Taylor', market: 'player_rush_yds', market_label: 'Rushing Yards', selection: 'Over', line: 79.5, price: -115, actual: 21 },
    { player: 'Brock Purdy', market: 'player_pass_tds', market_label: 'Passing TDs', selection: 'Over', line: 1.5, price: -160, actual: 3 },
    { player: 'Davante Adams', market: 'player_reception_yds', market_label: 'Receiving Yards', selection: 'Over', line: 66.5, price: -110, actual: 71 },
    { player: 'Kyren Williams', market: 'player_anytime_td', market_label: 'Anytime TD', selection: 'Yes', line: null, price: -105, actual: 0 },
  ],
];

function loadDemo(season, users) {
  const scoring = require('../server/scoring');
  const roastEngine = require('../server/roast');
  console.log('\n  Loading demo weeks…');

  DEMO_PICKS.forEach((weekPicks, idx) => {
    const weekNumber = idx + 1;
    if (db.prepare('SELECT 1 FROM weeks WHERE season_id = ? AND week_number = ?').get(season.id, weekNumber)) {
      console.log(`  · week ${weekNumber} already exists, skipped`);
      return;
    }
    const weekId = db
      .prepare(`INSERT INTO weeks (season_id, week_number, status, stake_cents) VALUES (?, ?, 'graded', 2000)`)
      .run(season.id, weekNumber).lastInsertRowid;

    weekPicks.slice(0, users.length).forEach((p, i) => {
      const user = users[i];
      const result = scoring.gradePick(p, p.actual);
      db.prepare(
        `INSERT INTO picks (week_id, user_id, player, market, market_label, selection, line, price,
          bookmaker, result, actual_value, graded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DraftKings', ?, ?, datetime('now'))`
      ).run(weekId, user.id, p.player, p.market, p.market_label, p.selection, p.line, p.price, result, p.actual);
    });

    const picks = db
      .prepare('SELECT p.*, u.display_name FROM picks p JOIN users u ON u.id = p.user_id WHERE p.week_id = ?')
      .all(weekId);
    const resolution = scoring.resolveBozo([], picks);

    if (resolution) {
      const user = users.find((u) => u.id === resolution.user_id);
      const careerCount =
        db.prepare('SELECT COUNT(*) AS n FROM bozos WHERE user_id = ?').get(user.id).n + 1;
      const losing = picks
        .filter((p) => p.user_id === user.id && p.result === 'loss')
        .map((p) => ({ ...p, ...scoring.bozoBreakdown(p) }))[0];
      const line = roastEngine.roast({
        name: user.display_name,
        week: weekNumber,
        count: careerCount,
        pick: losing,
        seed: `w${weekId}u${user.id}`,
      });
      db.prepare(
        `INSERT INTO bozos (week_id, user_id, method, votes_received, roast) VALUES (?, ?, 'auto', 0, ?)`
      ).run(weekId, user.id, line);
      db.prepare("UPDATE weeks SET status = 'final' WHERE id = ?").run(weekId);
      db.prepare('UPDATE weeks SET payer_user_id = ? WHERE season_id = ? AND week_number = ?').run(
        user.id,
        season.id,
        weekNumber + 1
      );
      console.log(`  ✓ week ${weekNumber}: bozo is ${user.display_name}`);
    }
  });

  // An open week so there's something to actually do after logging in.
  const nextNumber = DEMO_PICKS.length + 1;
  if (!db.prepare('SELECT 1 FROM weeks WHERE season_id = ? AND week_number = ?').get(season.id, nextNumber)) {
    const prevBozo = db
      .prepare(
        `SELECT b.user_id FROM bozos b JOIN weeks w ON w.id = b.week_id
         WHERE w.season_id = ? ORDER BY w.week_number DESC LIMIT 1`
      )
      .get(season.id);
    db.prepare(
      `INSERT INTO weeks (season_id, week_number, status, stake_cents, payer_user_id) VALUES (?, ?, 'open', 2000, ?)`
    ).run(season.id, nextNumber, prevBozo?.user_id || null);
    console.log(`  ✓ week ${nextNumber} opened for picks`);
  }
}

/* ---------------- run ---------------- */

console.log('\n🤡 Blue Man Bozo — seeding\n');

const season = ensureSeason();
console.log('\n  Members:');
const users = CREW.map(ensureUser);

setSetting('group_name', process.env.GROUP_NAME || 'Blue Man Group');
if (process.env.SITE_URL) setSetting('site_url', process.env.SITE_URL);

if (withDemo) loadDemo(season, users);

console.log('\n─────────────────────────────────────────────');
if (created.length) {
  console.log('  SAVE THESE PASSWORDS — they are not shown again:\n');
  for (const u of created) {
    console.log(`    ${u.display_name.padEnd(14)} ${u.username.padEnd(10)} ${u.password}`);
  }
  console.log('\n  Each member can change their own password after signing in.');
} else {
  console.log('  No new members created.');
}
console.log('─────────────────────────────────────────────');
console.log('\n  Start the site:  npm start\n');
