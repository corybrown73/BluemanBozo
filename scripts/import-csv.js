#!/usr/bin/env node
'use strict';

/**
 * Import your existing Google Sheet history.
 *
 * In the sheet: File → Download → Comma-separated values (.csv)
 *
 * TWO SHAPES ARE SUPPORTED.
 *
 * 1. One row per week (preferred — preserves the actual picks):
 *
 *      week,date,bozo,player,market,side,line,odds,actual,stake
 *      1,2024-09-08,Dave,Josh Allen,Passing Yards,Over,249.5,-115,180,20
 *      2,2024-09-15,Mike,Puka Nacua,Receiving Yards,Over,74.5,-110,11,20
 *
 *    Only `week` and `bozo` are required. Column names are matched loosely, so
 *    "Week #", "Bozo of the Week", "Prop", "O/U", "Line", "Result" all work.
 *
 * 2. Just the running tally (--tally):
 *
 *      name,bozos
 *      Dave,4
 *      Mike,2
 *
 *    Creates that many closed "legacy" weeks so the all-time counts are right.
 *
 * Usage:
 *   node scripts/import-csv.js history.csv --season 2024
 *   node scripts/import-csv.js history.csv --season 2024 --dry-run
 *   node scripts/import-csv.js tally.csv --tally --season 2023
 *
 * 3. The grid most groups actually keep (--grid, auto-detected):
 *
 *      Week,Cory,Derek,Eric,Julian,Michael,Ricky
 *      1,Hit,Hit,Miss,Miss,Hit,Miss
 *      2,Hit,Miss,Hit,Miss,Miss,Hit
 *      TGD,,Miss,Miss,Miss,Hit,
 *
 *    One row per week, one column per person, Hit/Miss in the cells. Blank
 *    means they sat that week out. Column headers become members, created if
 *    they do not exist yet. Non-numeric week labels (TGD, WC, DR) are kept as
 *    labels. An optional Bozo column names who paid that week.
 *
 *    The sheet does not record what anyone actually picked, so the imported
 *    picks carry the result and nothing else — enough for an honest all-time
 *    record, and honest about what it does not know.
 *
 * Usage:
 *   node scripts/import-csv.js history.csv --season 2024
 *   node scripts/import-csv.js history.csv --season 2024 --dry-run
 *   node scripts/import-csv.js tally.csv --tally --season 2023
 *   node scripts/import-csv.js grid.csv --grid --season 2025
 */

require('dotenv').config();

const fs = require('fs');
const { db, nflSeasonYear } = require('../server/db');
const { hashPassword } = require('../server/auth');
const scoring = require('../server/scoring');
const { MARKETS } = require('../server/odds');

/* ---------------- args ---------------- */

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const tallyMode = args.includes('--tally');
const gridMode = args.includes('--grid');
const seasonArg = args[args.indexOf('--season') + 1];
const seasonYear = args.includes('--season') ? parseInt(seasonArg, 10) : nflSeasonYear(new Date());

if (!file) {
  console.error('Usage: node scripts/import-csv.js <file.csv> [--season 2024] [--tally|--grid] [--dry-run]');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(1);
}
if (!Number.isFinite(seasonYear)) {
  console.error('--season needs a year, e.g. --season 2024');
  process.exit(1);
}

/* ---------------- csv ---------------- */

/** Minimal RFC-4180 parser: handles quoted fields, embedded commas and newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Find a column by any of several loose aliases. */
function columnFinder(headers) {
  const map = new Map(headers.map((h, i) => [norm(h), i]));
  return (...aliases) => {
    for (const alias of aliases) {
      const key = norm(alias);
      if (map.has(key)) return map.get(key);
    }
    // fall back to a substring match
    for (const alias of aliases) {
      const key = norm(alias);
      for (const [h, i] of map) if (h.includes(key)) return i;
    }
    return -1;
  };
}

/* ---------------- lookups ---------------- */

function findOrCreateUser(displayName) {
  const name = String(displayName || '').trim();
  if (!name) return null;

  let user = db
    .prepare('SELECT * FROM users WHERE display_name = ? COLLATE NOCASE OR username = ? COLLATE NOCASE')
    .get(name, name);
  if (user) return user;

  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'member';
  let username = base;
  let n = 2;
  while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) username = `${base}${n++}`;

  if (dryRun) {
    console.log(`    would create member: ${name} (@${username})`);
    return { id: -1, display_name: name, username };
  }
  const info = db
    .prepare('INSERT INTO users (username, display_name, password_hash, avatar, is_active) VALUES (?, ?, ?, ?, 1)')
    .run(username, name, hashPassword(require('crypto').randomBytes(12).toString('hex')), '🤡');
  console.log(`    + created member ${name} (@${username}) — set their password in Commissioner → Members`);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function findOrCreateSeason(year) {
  let season = db.prepare('SELECT * FROM seasons WHERE year = ?').get(year);
  if (season) return season;
  if (dryRun) return { id: -1, year, label: `${year} Season` };
  db.prepare('INSERT INTO seasons (year, label, is_active) VALUES (?, ?, 0)').run(year, `${year} Season`);
  return db.prepare('SELECT * FROM seasons WHERE year = ?').get(year);
}

/** Map a free-text market name from the sheet onto one of our market keys. */
function guessMarket(text) {
  const t = norm(text);
  if (!t) return MARKETS[0];
  const exact = MARKETS.find((m) => norm(m.key) === t || norm(m.label) === t);
  if (exact) return exact;
  const aliases = [
    [['passyd', 'passingyard', 'payds', 'qbyard'], 'player_pass_yds'],
    [['passtd', 'passingtd', 'patd'], 'player_pass_tds'],
    [['rushyd', 'rushingyard', 'ruyds'], 'player_rush_yds'],
    [['recyd', 'receivingyard', 'reyds'], 'player_reception_yds'],
    [['reception', 'catches', 'rec'], 'player_receptions'],
    [['anytimetd', 'atd', 'touchdown', 'td'], 'player_anytime_td'],
    [['kick', 'fieldgoal', 'fg'], 'player_kicking_points'],
    [['tackle'], 'player_tackles_assists'],
    [['sack'], 'player_sacks'],
  ];
  for (const [keys, marketKey] of aliases) {
    if (keys.some((k) => t.includes(k))) return MARKETS.find((m) => m.key === marketKey);
  }
  return MARKETS[0];
}

function parseOdds(text) {
  const raw = String(text || '').trim().replace(/[+\s]/g, '');
  if (!raw) return -110;
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return -110;
  // A bare "110" in a sheet almost always means -110.
  if (n > 0 && n < 100) return -110;
  if (String(text).trim().startsWith('+')) return Math.round(n);
  return Math.round(Number(String(text).trim()));
}

/* ---------------- import modes ---------------- */

function importTally(rows) {
  const headers = rows[0];
  const col = columnFinder(headers);
  const nameCol = col('name', 'member', 'player', 'who', 'person');
  const countCol = col('bozos', 'bozo', 'count', 'total', 'times');

  if (nameCol === -1 || countCol === -1) {
    console.error(`\n❌ Could not find name and count columns. Headers seen: ${headers.join(', ')}`);
    process.exit(1);
  }

  const season = findOrCreateSeason(seasonYear);
  let weekNumber = db.prepare('SELECT COALESCE(MAX(week_number), 0) AS n FROM weeks WHERE season_id = ?').get(season.id).n;
  let created = 0;

  for (const row of rows.slice(1)) {
    const user = findOrCreateUser(row[nameCol]);
    const count = parseInt(row[countCol], 10) || 0;
    if (!user || count <= 0) continue;
    console.log(`  ${user.display_name}: ${count} bozo${count === 1 ? '' : 's'}`);
    for (let i = 0; i < count; i++) {
      weekNumber += 1;
      created += 1;
      if (dryRun) continue;
      const weekId = db
        .prepare(
          `INSERT INTO weeks (season_id, week_number, label, status, stake_cents)
           VALUES (?, ?, 'Imported from the sheet', 'final', 2000)`
        )
        .run(season.id, weekNumber).lastInsertRowid;
      db.prepare(
        `INSERT INTO bozos (week_id, user_id, method, roast) VALUES (?, ?, 'imported', ?)`
      ).run(weekId, user.id, `${user.display_name} was the bozo. The details are lost to history, the shame is not.`);
    }
  }
  console.log(`\n${dryRun ? 'Would create' : 'Created'} ${created} legacy weeks in ${season.label}.`);
}

function importWeeks(rows) {
  const headers = rows[0];
  const col = columnFinder(headers);

  const c = {
    week: col('week', 'week#', 'weeknumber', 'wk'),
    bozo: col('bozo', 'bozoofweek', 'loser', 'worstpick', 'paid'),
    member: col('member', 'name', 'who', 'person'),
    player: col('player', 'prop', 'pick', 'bet'),
    market: col('market', 'type', 'stat', 'proptype'),
    side: col('side', 'ou', 'overunder', 'direction'),
    line: col('line', 'number', 'total'),
    odds: col('odds', 'price', 'juice', 'americanodds'),
    actual: col('actual', 'result', 'final', 'stat', 'hit'),
    stake: col('stake', 'amount', 'wager', 'cost'),
    date: col('date', 'day'),
  };

  if (c.week === -1 || c.bozo === -1) {
    console.error(`\n❌ Need at least a "week" and a "bozo" column.`);
    console.error(`   Headers seen: ${headers.join(', ')}`);
    console.error(`   If your sheet is just a running tally, re-run with --tally`);
    process.exit(1);
  }

  const season = findOrCreateSeason(seasonYear);
  let weeks = 0;
  let picks = 0;

  for (const row of rows.slice(1)) {
    const weekNumber = parseInt(row[c.week], 10);
    if (!Number.isFinite(weekNumber)) continue;

    const bozoUser = findOrCreateUser(row[c.bozo]);
    if (!bozoUser) continue;

    const stakeCents = c.stake !== -1 ? Math.round((parseFloat(String(row[c.stake]).replace(/[^0-9.]/g, '')) || 20) * 100) : 2000;

    let weekId = db.prepare('SELECT id FROM weeks WHERE season_id = ? AND week_number = ?').get(season.id, weekNumber)?.id;
    if (!weekId) {
      weeks += 1;
      if (!dryRun) {
        weekId = db
          .prepare(
            `INSERT INTO weeks (season_id, week_number, label, status, stake_cents)
             VALUES (?, ?, ?, 'final', ?)`
          )
          .run(season.id, weekNumber, c.date !== -1 ? String(row[c.date]).trim() || null : null, stakeCents).lastInsertRowid;
      }
    }

    // Optional: the bozo's actual losing pick, if the sheet recorded it.
    const playerName = c.player !== -1 ? String(row[c.player] || '').trim() : '';
    const pickOwner = c.member !== -1 ? findOrCreateUser(row[c.member]) || bozoUser : bozoUser;

    if (playerName && !dryRun) {
      const market = guessMarket(c.market !== -1 ? row[c.market] : playerName);
      const rawSide = c.side !== -1 ? String(row[c.side]).trim() : '';
      const selection =
        /^u/i.test(rawSide) ? 'Under' : /^y/i.test(rawSide) ? 'Yes' : /^n/i.test(rawSide) ? 'No' : 'Over';
      const line = c.line !== -1 ? scoring.toNum(String(row[c.line]).replace(/[^0-9.\-]/g, '')) : NaN;
      const actual = c.actual !== -1 ? scoring.toNum(String(row[c.actual]).replace(/[^0-9.\-]/g, '')) : NaN;
      const price = parseOdds(c.odds !== -1 ? row[c.odds] : '');

      const pick = {
        player: playerName,
        market: market.key,
        market_label: market.label,
        selection,
        line: Number.isFinite(line) ? line : null,
        price,
      };
      const result = Number.isFinite(actual) ? scoring.gradePick(pick, actual) : 'pending';

      db.prepare(
        `INSERT INTO picks (week_id, user_id, player, market, market_label, selection, line, price,
          bookmaker, result, actual_value, graded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'imported', ?, ?, datetime('now'))`
      ).run(
        weekId, pickOwner.id, pick.player, pick.market, pick.market_label, pick.selection,
        pick.line, pick.price, result, Number.isFinite(actual) ? actual : null
      );
      picks += 1;
    }

    if (!dryRun && weekId && !db.prepare('SELECT 1 FROM bozos WHERE week_id = ?').get(weekId)) {
      db.prepare(`INSERT INTO bozos (week_id, user_id, method, roast) VALUES (?, ?, 'imported', ?)`).run(
        weekId,
        bozoUser.id,
        `${bozoUser.display_name} took the Week ${weekNumber} crown. Imported from the sheet, preserved forever.`
      );
    }

    console.log(`  Week ${String(weekNumber).padStart(2)} → ${bozoUser.display_name}${playerName ? ` (${playerName})` : ''}`);
  }

  console.log(`\n${dryRun ? 'Would import' : 'Imported'} ${weeks} weeks and ${picks} picks into ${season.label}.`);
}

/* ---------------- run ---------------- */

/* ---------------- grid: one row per week, one column per person ---------------- */

const HIT = /^(hit|win|w|y|yes|✓|✔|1|cash|cashed)$/i;
const MISS = /^(miss|loss|lose|l|n|no|x|✗|✘|0|dead)$/i;

/**
 * Does this look like a Hit/Miss grid rather than a list of picks?
 * The giveaway is a first column of weeks and no column we recognise as a
 * pick field — just names.
 */
function looksLikeGrid(rows) {
  const headers = rows[0].map(norm);
  if (!headers.length || !/^week/.test(headers[0])) return false;
  const known = ['player', 'prop', 'market', 'side', 'line', 'odds', 'price', 'actual', 'stake', 'date', 'bozo', 'result'];
  const rest = headers.slice(1).filter(Boolean);
  if (rest.length < 2) return false;
  if (rest.some((h) => known.includes(h))) return false;
  // and the body should be mostly Hit/Miss
  const cells = rows.slice(1).flatMap((r) => r.slice(1)).map((c) => String(c || '').trim()).filter(Boolean);
  if (!cells.length) return false;
  const recognised = cells.filter((c) => HIT.test(c) || MISS.test(c)).length;
  return recognised / cells.length > 0.8;
}

function importGrid(rows) {
  const headers = rows[0];
  const bozoCol = headers.findIndex((h, i) => i > 0 && norm(h) === 'bozo');
  const nameCols = headers
    .map((h, i) => ({ name: String(h || '').trim(), i }))
    .filter((c) => c.i > 0 && c.i !== bozoCol && c.name);

  if (!nameCols.length) {
    console.error('No member columns found. Expected: Week,Name,Name,...');
    process.exit(1);
  }

  const season = findOrCreateSeason(seasonYear);
  console.log(`Members in this sheet: ${nameCols.map((c) => c.name).join(', ')}\n`);
  const users = new Map(nameCols.map((c) => [c.i, findOrCreateUser(c.name)]));

  let weeksMade = 0;
  let picksMade = 0;
  let skipped = 0;
  let autoNumber = 1000; // non-numeric labels get numbers out of the way of real weeks
  const tally = new Map();

  for (const row of rows.slice(1)) {
    const rawLabel = String(row[0] || '').trim();
    if (!rawLabel) continue;

    const cells = nameCols.map((c) => String(row[c.i] || '').trim());
    if (!cells.some(Boolean)) continue; // an untouched row — a week not played yet

    const numeric = /^\d+$/.test(rawLabel);
    const weekNumber = numeric ? parseInt(rawLabel, 10) : autoNumber++;
    const label = numeric ? null : rawLabel;

    let week = db
      .prepare('SELECT * FROM weeks WHERE season_id = ? AND week_number = ?')
      .get(season.id, weekNumber);

    if (!week) {
      if (dryRun) {
        week = { id: -1, week_number: weekNumber };
      } else {
        const info = db
          .prepare(`INSERT INTO weeks (season_id, week_number, label, status) VALUES (?, ?, ?, 'final')`)
          .run(season.id, weekNumber, label);
        week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(info.lastInsertRowid);
      }
      weeksMade += 1;
    }

    for (let k = 0; k < nameCols.length; k += 1) {
      const cell = cells[k];
      if (!cell) continue;
      const isHit = HIT.test(cell);
      const isMiss = MISS.test(cell);
      if (!isHit && !isMiss) {
        console.log(`    ? ${rawLabel} / ${nameCols[k].name}: "${cell}" is neither hit nor miss — skipped`);
        skipped += 1;
        continue;
      }
      const user = users.get(nameCols[k].i);
      if (!user) continue;

      const t = tally.get(user.display_name) || { hit: 0, miss: 0 };
      t[isHit ? 'hit' : 'miss'] += 1;
      tally.set(user.display_name, t);
      picksMade += 1;

      if (dryRun) continue;
      const already = db
        .prepare('SELECT 1 FROM picks WHERE week_id = ? AND user_id = ?')
        .get(week.id, user.id);
      if (already) continue;

      // The sheet recorded the outcome and nothing else. Say so rather than
      // inventing a player and a line that were never written down.
      db.prepare(
        `INSERT INTO picks (week_id, user_id, player, market, market_label, selection,
                            line, price, line_source, result, graded_at)
         VALUES (?, ?, 'Not recorded', 'legacy', 'Imported from the sheet', 'Over',
                 NULL, -110, 'manual', ?, datetime('now'))`
      ).run(week.id, user.id, isHit ? 'win' : 'loss');
    }

    if (bozoCol > 0 && !dryRun) {
      const bozoName = String(row[bozoCol] || '').trim();
      if (bozoName) {
        const bozo = findOrCreateUser(bozoName);
        if (bozo && bozo.id > 0 && !db.prepare('SELECT 1 FROM bozos WHERE week_id = ?').get(week.id)) {
          db.prepare(`INSERT INTO bozos (week_id, user_id, method, roast) VALUES (?, ?, 'imported', ?)`)
            .run(week.id, bozo.id, 'Imported from the old spreadsheet.');
        }
      }
    }
  }

  console.log(`\n  weeks:  ${weeksMade} created`);
  console.log(`  picks:  ${picksMade} results recorded${skipped ? `  (${skipped} unrecognised cells skipped)` : ''}`);
  console.log('\n  All-time record from this sheet:');
  const width = Math.max(...[...tally.keys()].map((n) => n.length), 6);
  for (const [name, t] of [...tally.entries()].sort((a, b) => {
    const pa = a[1].hit / (a[1].hit + a[1].miss);
    const pb = b[1].hit / (b[1].hit + b[1].miss);
    return pb - pa;
  })) {
    const total = t.hit + t.miss;
    const pctStr = total ? `${Math.round((t.hit / total) * 100)}%` : '—';
    console.log(`    ${name.padEnd(width)}  ${String(t.hit).padStart(2)}-${String(t.miss).padStart(2)}   ${pctStr.padStart(4)}`);
  }
  if (bozoCol < 0) {
    console.log('\n  No Bozo column in this sheet, so nobody was crowned. Add one to');
    console.log('  record who paid each week.');
  }
}


console.log(`\n🤡 Importing ${file} into the ${seasonYear} season${dryRun ? ' (DRY RUN — nothing will be written)' : ''}\n`);

const rows = parseCsv(fs.readFileSync(file, 'utf8'));
if (rows.length < 2) {
  console.error('That file has no data rows.');
  process.exit(1);
}
console.log(`Columns detected: ${rows[0].join(' | ')}\n`);

const run = dryRun ? (fn) => fn() : db.transaction((fn) => fn());
const useGrid = gridMode || (!tallyMode && looksLikeGrid(rows));
if (useGrid && !gridMode) console.log('Looks like a Hit/Miss grid — importing it as one.\n');
run(() => (tallyMode ? importTally(rows) : useGrid ? importGrid(rows) : importWeeks(rows)));

console.log(dryRun ? '\nDry run complete. Re-run without --dry-run to apply.\n' : '\nDone. Check the Hall of Shame.\n');
