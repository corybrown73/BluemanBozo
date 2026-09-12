'use strict';

/**
 * Importing the old Google Sheet.
 *
 * The sheet every group actually keeps is a grid: one row per week, one column
 * per person, Hit or Miss in the cells. It records who was right, and nothing
 * else — not the player, not the line, not the price. This imports exactly
 * that, and is honest in the database about what it does not know.
 *
 * Two things this does that the command-line script cannot:
 *
 *   1. It runs from inside the app, so it works on a host with no terminal.
 *   2. It maps each column to an ACCOUNT, chosen by the commissioner, rather
 *      than matching on whatever name happens to be in the header. Names
 *      change — Michael becomes Mike — and matching on them would quietly
 *      create a second account and split a career record in half. Everything
 *      here is keyed to user id.
 *
 * Nothing is written until someone has seen the preview and pressed the
 * button, and a second import is a no-op rather than a double count.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, nflSeasonYear } = require('./db');
const { hashPassword } = require('./auth');

/** The sheet that ships with the app, if it is still there. */
const BUNDLED = path.join(__dirname, '..', '2025-history.csv');

const HIT = /^(hit|win|w|y|yes|✓|✔|1|cash|cashed)$/i;
const MISS = /^(miss|loss|lose|l|n|no|x|✗|✘|0|dead)$/i;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Minimal RFC-4180 parser: quoted fields, embedded commas and newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
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

/**
 * Does this look like a Hit/Miss grid rather than a list of picks? A first
 * column of weeks, nothing we recognise as a pick field, and a body that is
 * mostly hits and misses.
 */
function looksLikeGrid(rows) {
  if (!rows.length) return false;
  const headers = rows[0].map(norm);
  if (!headers.length || !/^week/.test(headers[0])) return false;
  const known = ['player', 'prop', 'market', 'side', 'line', 'odds', 'price', 'actual', 'stake', 'date', 'result'];

  // The Bozo column holds names, not results, so it has to sit out the test
  // below — counting it dragged a perfectly good sheet under the threshold
  // and got it refused for having recorded who paid.
  const bozoCol = headers.findIndex((h, i) => i > 0 && h === 'bozo');
  const memberCols = headers
    .map((h, i) => ({ h, i }))
    .filter((c) => c.i > 0 && c.i !== bozoCol && c.h);

  if (!memberCols.length) return false;
  if (memberCols.some((c) => known.includes(c.h))) return false;

  const cells = rows
    .slice(1)
    .flatMap((r) => memberCols.map((c) => String(r[c.i] || '').trim()))
    .filter(Boolean);
  if (!cells.length) return false;
  return cells.filter((c) => HIT.test(c) || MISS.test(c)).length / cells.length > 0.8;
}

/** The sheet text: whatever was pasted in, or the copy that ships with the app. */
function readSheet(csv) {
  if (typeof csv === 'string' && csv.trim()) return csv;
  if (fs.existsSync(BUNDLED)) return fs.readFileSync(BUNDLED, 'utf8');
  return null;
}

/** Best guess at which existing account a column belongs to. Never binding. */
function guessUser(columnName, users) {
  const n = norm(columnName);
  if (!n) return null;
  return (
    users.find((u) => norm(u.display_name) === n) ||
    users.find((u) => norm(u.username) === n) ||
    // "Mike" against "Michael", or the other way round. Offered as a guess the
    // commissioner can override, never applied silently.
    users.find((u) => norm(u.display_name).startsWith(n) || n.startsWith(norm(u.display_name))) ||
    null
  );
}

/** Pull the grid apart into columns and per-week cells. */
function readGrid(rows) {
  const headers = rows[0];
  const bozoCol = headers.findIndex((h, i) => i > 0 && norm(h) === 'bozo');
  const columns = headers
    .map((h, i) => ({ name: String(h || '').trim(), index: i }))
    .filter((c) => c.index > 0 && c.index !== bozoCol && c.name);

  const weeks = [];
  let autoNumber = 1000; // labels like TGD get numbers clear of real weeks
  for (const row of rows.slice(1)) {
    const rawLabel = String(row[0] || '').trim();
    if (!rawLabel) continue;
    const cells = columns.map((c) => String(row[c.index] || '').trim());
    if (!cells.some(Boolean)) continue; // a week nobody played

    const numeric = /^\d+$/.test(rawLabel);
    weeks.push({
      raw_label: rawLabel,
      week_number: numeric ? parseInt(rawLabel, 10) : autoNumber++,
      label: numeric ? null : rawLabel,
      cells,
      bozo_name: bozoCol > 0 ? String(row[bozoCol] || '').trim() : '',
    });
  }
  return { columns, weeks, has_bozo_column: bozoCol > 0 };
}

/**
 * What an import would do, without doing any of it.
 *
 * @returns {{ok:boolean, error?:string, season_year:number, weeks:number,
 *            has_bozo_column:boolean, columns:Array, unreadable:Array}}
 */
function preview({ csv, seasonYear } = {}) {
  const text = readSheet(csv);
  if (!text) return { ok: false, error: 'No sheet to read. Paste one in.' };

  const rows = parseCsv(text);
  if (rows.length < 2) return { ok: false, error: 'That sheet has no data rows.' };
  if (!looksLikeGrid(rows)) {
    return {
      ok: false,
      error:
        'That does not look like a Hit/Miss grid. Expected a Week column, then one column per person, with Hit or Miss in the cells.',
    };
  }

  const year = Number.isFinite(seasonYear) ? seasonYear : nflSeasonYear(new Date()) - 1;
  const { columns, weeks, has_bozo_column } = readGrid(rows);
  const users = db.prepare('SELECT id, username, display_name, avatar FROM users ORDER BY display_name').all();
  const season = db.prepare('SELECT * FROM seasons WHERE year = ?').get(year) || null;

  const unreadable = [];
  const out = columns.map((c) => {
    const guess = guessUser(c.name, users);
    let hit = 0;
    let miss = 0;
    for (const w of weeks) {
      const cell = w.cells[columns.indexOf(c)];
      if (!cell) continue;
      if (HIT.test(cell)) hit += 1;
      else if (MISS.test(cell)) miss += 1;
      else unreadable.push({ week: w.raw_label, column: c.name, value: cell });
    }
    return {
      name: c.name,
      hit,
      miss,
      played: hit + miss,
      win_pct: hit + miss ? Number((hit / (hit + miss)).toFixed(3)) : 0,
      suggested_user_id: guess ? guess.id : null,
      suggested_name: guess ? guess.display_name : null,
      exact: Boolean(guess && norm(guess.display_name) === norm(c.name)),
    };
  });

  // Already imported? Say so rather than letting someone press it twice and
  // wonder why nothing changed.
  let already = 0;
  if (season) {
    already = db
      .prepare(`SELECT COUNT(*) AS n FROM picks p JOIN weeks w ON w.id = p.week_id WHERE w.season_id = ?`)
      .get(season.id).n;
  }

  return {
    ok: true,
    season_year: year,
    season_exists: Boolean(season),
    weeks: weeks.length,
    has_bozo_column,
    columns: out,
    unreadable: unreadable.slice(0, 20),
    already_imported: already,
    members: users.map((u) => ({ id: u.id, display_name: u.display_name, avatar: u.avatar })),
  };
}

function findOrCreateSeason(year) {
  const found = db.prepare('SELECT * FROM seasons WHERE year = ?').get(year);
  if (found) return found;
  db.prepare('INSERT INTO seasons (year, label, is_active) VALUES (?, ?, 0)').run(year, `${year} Season`);
  return db.prepare('SELECT * FROM seasons WHERE year = ?').get(year);
}

function createMember(displayName) {
  const base = String(displayName).toLowerCase().replace(/[^a-z0-9]/g, '') || 'member';
  let username = base;
  let n = 2;
  while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) username = `${base}${n++}`;
  // A password nobody knows, on purpose: the commissioner sets a real one in
  // Members. An account with a guessable password is worse than a locked one.
  const info = db
    .prepare('INSERT INTO users (username, display_name, password_hash, avatar, is_active) VALUES (?, ?, ?, ?, 1)')
    .run(username, displayName, hashPassword(crypto.randomBytes(18).toString('hex')), '🤡');
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Write the sheet in.
 *
 * @param {object}  opts
 * @param {string}  opts.csv         the sheet, or omitted for the bundled one
 * @param {number}  opts.seasonYear  which season these weeks belong to
 * @param {object}  opts.mapping     column name -> user id, 'create', or 'skip'
 * @returns {{ok:boolean, error?:string, weeks_created:number, results:number,
 *            created:Array, skipped:Array, per_person:Array}}
 */
function importGrid({ csv, seasonYear, mapping = {} } = {}) {
  const text = readSheet(csv);
  if (!text) return { ok: false, error: 'No sheet to read.' };

  const rows = parseCsv(text);
  if (rows.length < 2) return { ok: false, error: 'That sheet has no data rows.' };
  if (!looksLikeGrid(rows)) return { ok: false, error: 'That does not look like a Hit/Miss grid.' };

  const year = Number.isFinite(seasonYear) ? seasonYear : nflSeasonYear(new Date()) - 1;
  const { columns, weeks } = readGrid(rows);
  if (!columns.length) return { ok: false, error: 'No member columns found.' };

  const report = {
    ok: true,
    season_year: year,
    weeks_created: 0,
    results: 0,
    duplicates: 0,
    unreadable: 0,
    created: [],
    skipped: [],
    per_person: [],
  };

  const run = db.transaction(() => {
    const season = findOrCreateSeason(year);

    // Column -> account, decided up front so a half-applied mapping cannot
    // leave some weeks pointing at one account and some at another.
    const target = new Map();
    for (const c of columns) {
      const choice = mapping[c.name];
      if (choice === 'skip') {
        report.skipped.push(c.name);
        continue;
      }
      if (choice === 'create' || choice === undefined || choice === null) {
        // Belt and braces against a double-press: if an account already goes
        // by exactly this name, that is the person, not a second one.
        const existing = db
          .prepare('SELECT * FROM users WHERE display_name = ? COLLATE NOCASE')
          .get(c.name);
        if (existing) {
          report.reused = report.reused || [];
          report.reused.push({ name: c.name, id: existing.id });
          target.set(c.index, existing);
          continue;
        }
        const made = createMember(c.name);
        report.created.push({ name: c.name, username: made.username, id: made.id });
        target.set(c.index, made);
        continue;
      }
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(choice);
      if (!user) throw new Error(`No member with id ${choice} for column "${c.name}".`);
      target.set(c.index, user);
    }

    const tally = new Map();
    for (const w of weeks) {
      let week = db
        .prepare('SELECT * FROM weeks WHERE season_id = ? AND week_number = ?')
        .get(season.id, w.week_number);
      if (!week) {
        const info = db
          .prepare(`INSERT INTO weeks (season_id, week_number, label, status) VALUES (?, ?, ?, 'final')`)
          .run(season.id, w.week_number, w.label);
        week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(info.lastInsertRowid);
        report.weeks_created += 1;
      }

      columns.forEach((c, k) => {
        const cell = w.cells[k];
        if (!cell) return;
        const user = target.get(c.index);
        if (!user) return;

        const isHit = HIT.test(cell);
        const isMiss = MISS.test(cell);
        if (!isHit && !isMiss) { report.unreadable += 1; return; }

        if (db.prepare('SELECT 1 FROM picks WHERE week_id = ? AND user_id = ?').get(week.id, user.id)) {
          report.duplicates += 1;
          return;
        }

        // The sheet recorded the outcome and nothing else. Saying so beats
        // inventing a player and a line that were never written down.
        db.prepare(
          `INSERT INTO picks (week_id, user_id, player, market, market_label, selection,
                              line, price, line_source, result, graded_at)
           VALUES (?, ?, 'Not recorded', 'legacy', 'Imported from the sheet', 'Over',
                   NULL, -110, 'manual', ?, datetime('now'))`
        ).run(week.id, user.id, isHit ? 'win' : 'loss');
        report.results += 1;

        const t = tally.get(user.id) || { user, hit: 0, miss: 0 };
        t[isHit ? 'hit' : 'miss'] += 1;
        tally.set(user.id, t);
      });

      if (w.bozo_name) {
        const bozo = [...target.values()].find((u) => norm(u.display_name) === norm(w.bozo_name));
        if (bozo && !db.prepare('SELECT 1 FROM bozos WHERE week_id = ?').get(week.id)) {
          db.prepare(`INSERT INTO bozos (week_id, user_id, method, roast) VALUES (?, ?, 'imported', ?)`)
            .run(week.id, bozo.id, 'Imported from the old spreadsheet.');
        }
      }
    }

    report.per_person = [...tally.values()]
      .map((t) => ({
        user_id: t.user.id,
        display_name: t.user.display_name,
        hit: t.hit,
        miss: t.miss,
        win_pct: t.hit + t.miss ? Number((t.hit / (t.hit + t.miss)).toFixed(3)) : 0,
      }))
      .sort((a, b) => b.win_pct - a.win_pct);
  });

  try {
    run();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return report;
}

module.exports = { preview, importGrid, parseCsv, looksLikeGrid, readGrid, BUNDLED };
