'use strict';

const express = require('express');
const { db, getSetting, activeSeason, currentWeek, upcomingWeek } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const game = require('../game');
const scoring = require('../scoring');
const roastEngine = require('../roast');
const notify = require('../notify');
const odds = require('../odds');
const shortlist = require('../shortlist');
const calendar = require('../calendar');

const router = express.Router();
router.use(requireAuth);

/** Flip a week from open to locked once its kickoff deadline passes. */
function applyAutoLock(week) {
  if (!week || week.status !== 'open' || !week.lock_at) return week;
  if (new Date(week.lock_at).getTime() <= Date.now()) {
    db.prepare("UPDATE weeks SET status = 'locked' WHERE id = ? AND status = 'open'").run(week.id);
    return game.getWeek(week.id);
  }
  return week;
}

/* ---------------- state ---------------- */

router.get('/state', (req, res) => {
  const season = activeSeason();
  let week = currentWeek();
  if (week) week = applyAutoLock(week);

  res.json({
    user: req.user,
    season,
    seasons: db.prepare('SELECT * FROM seasons ORDER BY year DESC').all(),
    users: game.listUsers(),
    settings: {
      group_name: getSetting('group_name'),
      picks_per_user: parseInt(getSetting('picks_per_user'), 10) || 1,
      allow_self_vote: getSetting('allow_self_vote') === '1',
      hide_picks_until_lock: getSetting('hide_picks_until_lock') === '1',
      site_url: getSetting('site_url', process.env.SITE_URL || ''),
    },
    current_week: week ? game.weekDetail(week.id, req.user) : null,
    // Next week may already be open behind one still being settled. Named so
    // the pick tab can say when picking starts instead of just "locked".
    upcoming_week: week && week.status !== 'open' ? upcomingWeek(week) : null,
    // What the clock will do next, so the screens can say it.
    clock: require('../scheduler').clockStatus(),
    quota: odds.quotaStatus(),
    channels: notify.channelStatus(),
  });
});

/* ---------------- weeks ---------------- */

router.get('/weeks', (req, res) => {
  res.json({ weeks: game.history({ limit: parseInt(req.query.limit, 10) || 50 }) });
});

router.get('/weeks/:id', (req, res) => {
  const detail = game.weekDetail(parseInt(req.params.id, 10), req.user);
  if (!detail) return res.status(404).json({ error: 'Week not found.' });
  res.json(detail);
});

router.post('/weeks', requireAdmin, (req, res) => {
  const season = req.body?.season_id
    ? db.prepare('SELECT * FROM seasons WHERE id = ?').get(req.body.season_id)
    : activeSeason();
  if (!season) return res.status(400).json({ error: 'Season not found.' });

  const next = db.prepare('SELECT COALESCE(MAX(week_number), 0) + 1 AS n FROM weeks WHERE season_id = ?').get(season.id).n;
  const weekNumber = parseInt(req.body?.week_number, 10) || next;

  if (db.prepare('SELECT 1 FROM weeks WHERE season_id = ? AND week_number = ?').get(season.id, weekNumber)) {
    return res.status(409).json({ error: `Week ${weekNumber} already exists for ${season.label}.` });
  }

  // Two open weeks means the pick board quietly fills the newer one while
  // everyone thinks they are picking the older — the slip that reverses a
  // season's numbering. One at a time.
  const stillOpen = db
    .prepare(`SELECT week_number FROM weeks WHERE season_id = ? AND status = 'open' ORDER BY week_number DESC LIMIT 1`)
    .get(season.id);
  if (stillOpen) {
    return res.status(409).json({
      error: `Week ${stillOpen.week_number} is still open for picks. Lock it first — the next week opens itself on Tuesday.`,
    });
  }

  // Whoever was the bozo last week is on the hook for this week's ticket.
  const prevBozo = db
    .prepare(
      `SELECT b.user_id FROM bozos b JOIN weeks w ON w.id = b.week_id
       WHERE w.season_id = ? AND w.week_number < ? ORDER BY w.week_number DESC LIMIT 1`
    )
    .get(season.id, weekNumber);

  const stake = parseInt(req.body?.stake_cents, 10) || parseInt(getSetting('default_stake_cents'), 10) || 2000;

  // No lock time given: the clock supplies Sunday 12:55 ET for that week,
  // provided it is still ahead of us. A week opened after its own Sunday is
  // left for the commissioner to time by hand rather than locked on arrival.
  let lockAt = req.body?.lock_at || null;
  if (!lockAt && getSetting('auto_lock') === '1') {
    const at = calendar.lockAtFor(weekNumber, season.year, getSetting('lock_time_et') || '12:55');
    if (at.getTime() > Date.now()) lockAt = at.toISOString();
  }

  const info = db
    .prepare(
      `INSERT INTO weeks (season_id, week_number, label, status, lock_at, stake_cents, payer_user_id, notes)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`
    )
    .run(
      season.id,
      weekNumber,
      req.body?.label || null,
      lockAt,
      stake,
      prevBozo?.user_id || null,
      req.body?.notes || null
    );

  res.status(201).json(game.weekDetail(info.lastInsertRowid, req.user));
});

router.patch('/weeks/:id', requireAdmin, (req, res) => {
  const week = game.getWeek(parseInt(req.params.id, 10));
  if (!week) return res.status(404).json({ error: 'Week not found.' });

  const updates = {};
  if (req.body?.status !== undefined) {
    if (!game.STATUSES.includes(req.body.status)) {
      return res.status(400).json({ error: `Status must be one of: ${game.STATUSES.join(', ')}.` });
    }
    // A week can close without a bozo only when nobody lost. Otherwise there
    // is someone on the hook and closing would skip the crowning.
    if (req.body.status === 'final' && !game.getBozo(week.id)) {
      const losses = game.rawPicks(week.id).map(game.decoratePick).filter((p) => p.result === 'loss');
      if (losses.length) {
        return res.status(400).json({ error: 'Declare a bozo before closing the week.' });
      }
    }
    updates.status = req.body.status;
  }
  for (const key of ['label', 'lock_at', 'notes']) {
    if (req.body?.[key] !== undefined) updates[key] = req.body[key] || null;
  }
  if (req.body?.stake_cents !== undefined) updates.stake_cents = parseInt(req.body.stake_cents, 10) || 0;
  if (req.body?.payer_user_id !== undefined) updates.payer_user_id = req.body.payer_user_id || null;

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update.' });
  const sets = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE weeks SET ${sets} WHERE id = @id`).run({ ...updates, id: week.id });

  res.json(game.weekDetail(week.id, req.user));
});

/**
 * Give a week its right number. One opened too soon leaves the record reading
 * backwards — last Sunday's stats filed under week 2, this Sunday's picks
 * under week 1 — and nothing else is wrong with either. So nothing else
 * moves: every pick, stat line, vote and crown stays with its week, and if
 * the number asked for is taken, the two weeks trade places.
 *
 * Two things hang off the number and are re-derived for the weeks that
 * moved (and the ones right after them, whose bill may have come from a
 * week that moved): who is on the hook — the previous week's bozo — and,
 * for a week still open, when it locks — that week's Sunday.
 */
router.post('/weeks/:id/renumber', requireAdmin, (req, res) => {
  const week = game.getWeek(parseInt(req.params.id, 10));
  if (!week) return res.status(404).json({ error: 'Week not found.' });
  const target = Number(req.body?.week_number);
  if (!Number.isInteger(target) || target < 1 || target > 22) {
    return res.status(400).json({ error: 'Week number must be a whole number from 1 to 22.' });
  }
  const from = week.week_number;
  if (target === from) return res.status(400).json({ error: `This is already week ${from}.` });

  const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(week.season_id);
  const other = db.prepare('SELECT * FROM weeks WHERE season_id = ? AND week_number = ?').get(week.season_id, target);
  const notes = [];

  db.transaction(() => {
    const bozoOf = db.prepare(
      `SELECT b.user_id FROM bozos b JOIN weeks w ON w.id = b.week_id WHERE w.season_id = ? AND w.week_number = ?`
    );
    const moved = other ? [week.id, other.id] : [week.id];
    // Whose bill any of these weeks might be carrying from before the move:
    // the bozo of a week that moved, or of the week that used to sit in
    // front of one. Read under the old numbering, before anything shifts.
    const staleSources = new Set();
    for (const n of [from - 1, target - 1]) {
      const b = bozoOf.get(season.id, n)?.user_id;
      if (b) staleSources.add(b);
    }
    for (const id of moved) {
      const b = game.getBozo(id)?.user_id;
      if (b) staleSources.add(b);
    }

    const setNumber = db.prepare('UPDATE weeks SET week_number = ? WHERE id = ?');
    // The pair is unique per season, so go by way of a number nothing uses.
    setNumber.run(-week.id, week.id);
    if (other) setNumber.run(from, other.id);
    setNumber.run(target, week.id);
    notes.push(
      other
        ? `Week ${from} is now week ${target}, and week ${target} is now week ${from}.`
        : `Week ${from} is now week ${target}.`
    );
    notes.push('Every pick, stat line, vote and crown stayed with its week.');
    const byNumber = db.prepare('SELECT * FROM weeks WHERE season_id = ? AND week_number = ?');
    const setPayer = db.prepare('UPDATE weeks SET payer_user_id = ? WHERE id = ?');
    const nameOf = (id) => db.prepare('SELECT display_name FROM users WHERE id = ?').get(id)?.display_name || 'Somebody';

    for (const n of new Set([from, target, from + 1, target + 1])) {
      const w = byNumber.get(season.id, n);
      if (!w) continue;
      const owed = bozoOf.get(season.id, n - 1)?.user_id || null;
      if (owed) {
        if (w.payer_user_id !== owed) setPayer.run(owed, w.id);
        if (w.status !== 'final') notes.push(`${nameOf(owed)} is on the hook for week ${n}'s ticket.`);
      } else if (w.payer_user_id && staleSources.has(w.payer_user_id)) {
        // The bill came from a week that is no longer in front of this one.
        setPayer.run(null, w.id);
      }
    }

    if (getSetting('auto_lock') === '1') {
      const time = getSetting('lock_time_et') || '12:55';
      for (const id of moved) {
        const w = game.getWeek(id);
        if (w.status !== 'open') continue;
        const at = calendar.lockAtFor(w.week_number, season.year, time);
        if (at.getTime() <= Date.now()) {
          db.prepare(`UPDATE weeks SET lock_at = ?, status = 'locked' WHERE id = ?`).run(at.toISOString(), w.id);
          notes.push(`Week ${w.week_number}'s lock time has passed, so its picks are locked.`);
        } else {
          db.prepare('UPDATE weeks SET lock_at = ? WHERE id = ?').run(at.toISOString(), w.id);
          const when = at.toLocaleString('en-US', {
            timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit',
          });
          notes.push(`Week ${w.week_number} locks ${when} ET.`);
        }
      }
    }
  })();

  res.json({
    ok: true,
    from,
    to: target,
    swapped_with: other ? { id: other.id, week_number: from } : null,
    notes,
    week: game.weekDetail(week.id, req.user),
  });
});

/**
 * Undo an accidentally opened week. Only an EMPTY one: deleting a week takes
 * its picks, votes and bozo with it, and that is the season's record, not a
 * slip to be undone with a button.
 */
router.delete('/weeks/:id', requireAdmin, (req, res) => {
  const week = game.getWeek(parseInt(req.params.id, 10));
  if (!week) return res.status(404).json({ error: 'Week not found.' });

  const picks = db.prepare('SELECT COUNT(*) AS n FROM picks WHERE week_id = ?').get(week.id).n;
  if (picks || week.status !== 'open') {
    return res.status(409).json({
      error: picks
        ? `Week ${week.week_number} has ${picks} pick${picks === 1 ? '' : 's'} in it. Delete those first if you really mean it.`
        : `Week ${week.week_number} is ${week.status}, not a fresh one. Reopen it instead of deleting it.`,
    });
  }
  db.prepare('DELETE FROM weeks WHERE id = ?').run(week.id);
  res.json({ ok: true, deleted: week.week_number });
});

/* ---------------- picks ---------------- */

router.post('/weeks/:id/picks', (req, res) => {
  let week = game.getWeek(parseInt(req.params.id, 10));
  if (!week) return res.status(404).json({ error: 'Week not found.' });
  week = applyAutoLock(week);

  if (week.status !== 'open' && !req.user.is_admin) {
    return res.status(409).json({ error: 'Picks are locked for this week. You snooze, you lose.' });
  }

  const targetUserId = req.user.is_admin && req.body?.user_id ? parseInt(req.body.user_id, 10) : req.user.id;
  const body = req.body || {};

  const player = String(body.player || '').trim();
  const market = String(body.market || '').trim();
  const selection = String(body.selection || '').trim();
  if (!player) return res.status(400).json({ error: 'Pick a player.' });
  if (!market) return res.status(400).json({ error: 'Pick a market.' });
  if (!selection) return res.status(400).json({ error: 'Pick a side (Over/Under/Yes).' });

  const meta = odds.marketMeta(market);

  // "Anytime TD Over 27.5" is not a bet that exists. Reject it outright.
  if (!odds.sideIsValid(market, selection)) {
    return res.status(400).json({
      error: `${meta.label} is a ${meta.sides.join('/')} bet — "${selection}" isn't an option for it.`,
    });
  }

  const line = body.line === '' || body.line === null || body.line === undefined ? null : Number(body.line);
  if (meta.type === 'ou' && !Number.isFinite(line)) {
    return res.status(400).json({ error: `${meta.label} needs a line (e.g. 62.5).` });
  }
  if (meta.type === 'yesno' && line !== null) {
    return res.status(400).json({ error: `${meta.label} has no line — leave it blank.` });
  }
  const price = parseInt(body.price, 10);
  if (!Number.isFinite(price) || price === 0) {
    return res.status(400).json({ error: 'Odds must be an American price like -110 or +225.' });
  }

  const limit = parseInt(getSetting('picks_per_user'), 10) || 1;
  const existing = db.prepare('SELECT COUNT(*) AS n FROM picks WHERE week_id = ? AND user_id = ?').get(week.id, targetUserId).n;
  // The pick being replaced must belong to THIS week. Without the week_id
  // constraint a member could aim an open week's URL at their pick from a
  // locked week and rewrite a loser into a winner before grading.
  const replacing = body.pick_id
    ? db.prepare('SELECT * FROM picks WHERE id = ? AND week_id = ?').get(body.pick_id, week.id)
    : null;
  if (body.pick_id && !replacing) {
    return res.status(404).json({ error: 'That pick is not in this week.' });
  }
  if (replacing && replacing.user_id !== targetUserId && !req.user.is_admin) {
    return res.status(403).json({ error: "That's not your pick." });
  }
  if (!replacing && existing >= limit) {
    return res.status(409).json({
      error: `You already have ${existing} pick${existing === 1 ? '' : 's'} this week (limit ${limit}). Edit or delete it first.`,
    });
  }

  const payload = {
    week_id: week.id,
    user_id: targetUserId,
    event_id: body.event_id || null,
    home_team: body.home_team || null,
    away_team: body.away_team || null,
    commence_time: body.commence_time || null,
    player,
    market,
    market_label: body.market_label || meta.label,
    selection,
    line,
    price,
    bookmaker: body.bookmaker || null,
    line_source: ['book', 'adjusted', 'manual'].includes(body.line_source) ? body.line_source : 'book',
    trash_talk: body.trash_talk ? String(body.trash_talk).slice(0, 280) : null,
  };

  if (replacing) {
    db.prepare(
      `UPDATE picks SET event_id=@event_id, home_team=@home_team, away_team=@away_team, commence_time=@commence_time,
        player=@player, market=@market, market_label=@market_label, selection=@selection, line=@line, price=@price,
        bookmaker=@bookmaker, line_source=@line_source, trash_talk=@trash_talk, updated_at=datetime('now')
       WHERE id=@id AND week_id=@week_id`
    ).run({ ...payload, id: replacing.id });
  } else {
    db.prepare(
      `INSERT INTO picks (week_id, user_id, event_id, home_team, away_team, commence_time, player, market,
        market_label, selection, line, price, bookmaker, line_source, trash_talk)
       VALUES (@week_id, @user_id, @event_id, @home_team, @away_team, @commence_time, @player, @market,
        @market_label, @selection, @line, @price, @bookmaker, @line_source, @trash_talk)`
    ).run(payload);
  }

  // The list did its job. Keeping it after the bet is made just leaves stale
  // numbers lying around for a member to tap next week.
  const cleared = shortlist.clear(week.id, targetUserId);

  const detail = game.weekDetail(week.id, req.user);
  const warning = odds.lineWarning(market, line);
  res.json({ ...detail, ...(warning ? { warning } : {}), shortlist_cleared: cleared });
});

/* ---------------- the shortlist: bets you are weighing ---------------- */

/** Put one on your list. Costs nothing and commits to nothing. */
router.post('/weeks/:id/shortlist', (req, res) => {
  let week = game.getWeek(parseInt(req.params.id, 10));
  if (!week) return res.status(404).json({ error: 'Week not found.' });
  week = applyAutoLock(week);
  if (week.status !== 'open') {
    return res.status(409).json({ error: 'Picks are locked for this week.' });
  }

  const result = shortlist.add(week.id, req.user.id, req.body || {});
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
  res.json({ ...game.weekDetail(week.id, req.user), added: result.entry, already: Boolean(result.already) });
});

/** Take one off your own list. */
router.delete('/weeks/:id/shortlist/:entryId', (req, res) => {
  const week = game.getWeek(parseInt(req.params.id, 10));
  if (!week) return res.status(404).json({ error: 'Week not found.' });

  const gone = shortlist.remove(week.id, req.user.id, parseInt(req.params.entryId, 10));
  if (!gone) return res.status(404).json({ error: 'That is not on your list.' });
  res.json(game.weekDetail(week.id, req.user));
});

router.delete('/picks/:id', (req, res) => {
  const pick = db.prepare('SELECT * FROM picks WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!pick) return res.status(404).json({ error: 'Pick not found.' });
  const week = applyAutoLock(game.getWeek(pick.week_id));
  if (pick.user_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: "That's not your pick." });
  if (week.status !== 'open' && !req.user.is_admin) return res.status(409).json({ error: 'Too late — picks are locked.' });

  db.prepare('DELETE FROM picks WHERE id = ?').run(pick.id);
  res.json(game.weekDetail(week.id, req.user));
});

/** Enter the real stat lines. Results are computed, never hand-typed. */
// Pull the real numbers from ESPN and hand them back for review. It fills the
// boxes; the commissioner still presses Grade. An undocumented feed does not
// get to settle a bet on its own.
router.post('/weeks/:id/stats', requireAdmin, async (req, res) => {
  const week = game.getWeek(parseInt(req.params.id, 10));
  if (!week) return res.status(404).json({ error: 'Week not found.' });

  const picks = game.rawPicks(week.id);
  if (!picks.length) return res.json({ results: [], unresolved: [], checked: 0 });

  try {
    const out = await require('../boxscore').statsForPicks(picks, { force: req.query.force === '1' });
    if (out.error) return res.status(502).json({ error: out.error });
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: `Could not read the box scores: ${err.message}` });
  }
});

router.post('/weeks/:id/grade', requireAdmin, (req, res) => {
  const week = game.getWeek(parseInt(req.params.id, 10));
  if (!week) return res.status(404).json({ error: 'Week not found.' });

  const results = Array.isArray(req.body?.results) ? req.body.results : [];
  if (!results.length) return res.status(400).json({ error: 'No stat lines submitted.' });

  // Once the week is graded, a blank box is far more likely a slip than an
  // intent to un-settle a bet. Inactive players get voided, not blanked.
  if (game.statusRank(week.status) >= game.statusRank('graded')) {
    const blanking = results.filter(
      (row) => row.result !== 'void' && !Number.isFinite(scoring.toNum(row.actual_value))
    );
    if (blanking.length) {
      const names = blanking
        .map((row) => db.prepare('SELECT player FROM picks WHERE id = ? AND week_id = ?').get(row.pick_id, week.id)?.player)
        .filter(Boolean);
      return res.status(400).json({
        error: `This week is already graded. ${names.join(', ') || 'A pick'} can't go back to pending — enter the number, or mark it void.`,
      });
    }
  }
  const crowned = game.getBozo(week.id);
  const { warnings } = game.gradePicks(week, results);
  const picks = game.rawPicks(week.id);

  // A corrected stat line can turn the crowned bozo's loss into a win. The
  // crown cannot stand on a bet that didn't lose, so it comes off, the week
  // reopens for a vote, and next week's ticket is nobody's again. Said out
  // loud rather than left as a Hall of Shame entry that no longer adds up.
  if (crowned) {
    const stillLost = picks.some((p) => p.user_id === crowned.user_id && p.result === 'loss');
    if (!stillLost) {
      db.transaction(() => {
        db.prepare('DELETE FROM bozos WHERE week_id = ?').run(week.id);
        db.prepare("UPDATE weeks SET status = 'graded' WHERE id = ? AND status = 'final'").run(week.id);
        db.prepare('UPDATE weeks SET payer_user_id = NULL WHERE season_id = ? AND week_number = ? AND payer_user_id = ?')
          .run(week.season_id, week.week_number + 1, crowned.user_id);
      })();
      warnings.unshift(
        `${crowned.display_name} was the bozo, but that pick no longer lost. The crown is off and the week is back to voting.`
      );
    }
  }

  const graded = game.weekDetail(week.id, req.user);
  res.json(warnings.length ? { ...graded, warnings } : graded);
});

/* ---------------- voting ---------------- */

router.post('/weeks/:id/vote', (req, res) => {
  const week = game.getWeek(parseInt(req.params.id, 10));
  if (!week) return res.status(404).json({ error: 'Week not found.' });
  if (week.status !== 'graded') {
    return res.status(409).json({
      error: week.status === 'final' ? 'Voting is closed — the bozo has been crowned.' : 'Voting opens once results are in.',
    });
  }

  const nomineeId = parseInt(req.body?.nominee_id, 10);
  const nominee = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(nomineeId);
  if (!nominee) return res.status(400).json({ error: 'Pick someone who actually exists.' });

  // The vote screen only offers the losers, but the API has to hold the same
  // line: a bozo is someone whose pick lost, and the crown goes to the top of
  // the tally. Without this a vote for a winner could put a crown on them.
  const lost = db
    .prepare("SELECT 1 FROM picks WHERE week_id = ? AND user_id = ? AND result = 'loss'")
    .get(week.id, nomineeId);
  if (!lost) {
    return res.status(400).json({ error: `${nominee.display_name} didn't lose this week. Only a loser can be the bozo.` });
  }

  if (nomineeId === req.user.id && getSetting('allow_self_vote') !== '1') {
    return res.status(400).json({ error: 'Self-nomination is disabled. Admirable, but no.' });
  }

  db.prepare(
    `INSERT INTO votes (week_id, voter_id, nominee_id, reason) VALUES (?, ?, ?, ?)
     ON CONFLICT(week_id, voter_id) DO UPDATE SET nominee_id = excluded.nominee_id,
       reason = excluded.reason, created_at = datetime('now')`
  ).run(week.id, req.user.id, nomineeId, req.body?.reason ? String(req.body.reason).slice(0, 280) : null);

  res.json(game.weekDetail(week.id, req.user));
});

router.delete('/weeks/:id/vote', (req, res) => {
  const week = game.getWeek(parseInt(req.params.id, 10));
  if (!week) return res.status(404).json({ error: 'Week not found.' });
  if (week.status !== 'graded') return res.status(409).json({ error: 'Voting is closed.' });
  db.prepare('DELETE FROM votes WHERE week_id = ? AND voter_id = ?').run(week.id, req.user.id);
  res.json(game.weekDetail(week.id, req.user));
});

/* ---------------- the crowning ---------------- */

router.post('/weeks/:id/bozo', requireAdmin, (req, res) => {
  const week = game.getWeek(parseInt(req.params.id, 10));
  if (!week) return res.status(404).json({ error: 'Week not found.' });
  if (game.statusRank(week.status) < game.statusRank('graded')) {
    return res.status(409).json({ error: 'Grade the picks before crowning a bozo.' });
  }

  const forced = req.body?.user_id ? parseInt(req.body.user_id, 10) : null;
  if (forced && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(forced)) {
    return res.status(400).json({ error: 'That person is not in the group.' });
  }

  const crowned = game.crownBozo(week, { userId: forced, roastText: req.body?.roast || null });
  if (!crowned) {
    return res.status(400).json({
      error: 'Nobody lost this week — no bozo to crown.',
      perfect_week: roastEngine.perfectWeek(`w${week.id}`),
    });
  }

  res.json(game.weekDetail(week.id, req.user));
});

router.delete('/weeks/:id/bozo', requireAdmin, (req, res) => {
  const week = game.getWeek(parseInt(req.params.id, 10));
  if (!week) return res.status(404).json({ error: 'Week not found.' });
  if (!game.getBozo(week.id)) return res.status(404).json({ error: 'No bozo to remove for this week.' });
  db.prepare('DELETE FROM bozos WHERE week_id = ?').run(week.id);
  // Only a final week steps back to graded. Anything earlier keeps its status.
  db.prepare("UPDATE weeks SET status = 'graded' WHERE id = ? AND status = 'final'").run(week.id);
  db.prepare('UPDATE weeks SET payer_user_id = NULL WHERE season_id = ? AND week_number = ?').run(
    week.season_id,
    week.week_number + 1
  );
  res.json(game.weekDetail(week.id, req.user));
});

router.patch('/weeks/:id/bozo/paid', requireAdmin, (req, res) => {
  const week = game.getWeek(parseInt(req.params.id, 10));
  if (!week) return res.status(404).json({ error: 'Week not found.' });
  db.prepare('UPDATE bozos SET paid = ? WHERE week_id = ?').run(req.body?.paid ? 1 : 0, week.id);
  res.json(game.weekDetail(week.id, req.user));
});

/* ---------------- the summons ---------------- */

router.post('/weeks/:id/notify', requireAdmin, async (req, res) => {
  const week = game.getWeek(parseInt(req.params.id, 10));
  if (!week) return res.status(404).json({ error: 'Week not found.' });

  const bozo = game.getBozo(week.id);
  if (!bozo) return res.status(400).json({ error: 'No bozo has been crowned for this week yet.' });

  const picks = game.rawPicks(week.id).map(game.decoratePick);
  const parlayInfo = scoring.parlay(picks, week.stake_cents);
  const siteUrl = getSetting('site_url', process.env.SITE_URL || '');
  const careerCount = game.bozoCounts(bozo.user_id, week.season_id).all_time;

  const payload = {
    bozo: { id: bozo.user_id, display_name: bozo.display_name },
    week,
    roastLine: bozo.roast || '',
    parlayInfo,
    picks,
    siteUrl,
    careerCount,
  };
  const text = notify.bozoSummonsText(payload);
  const html = notify.bozoSummonsHtml(payload);

  const channels = Array.isArray(req.body?.channels) ? req.body.channels : ['email', 'sms'];
  const audience = req.body?.audience === 'everyone' ? game.listUsers() : [db.prepare('SELECT * FROM users WHERE id = ?').get(bozo.user_id)];

  const results = [];
  for (const person of audience) {
    if (channels.includes('email')) {
      results.push({
        user: person.display_name,
        channel: 'email',
        ...(await notify.sendEmail({
          to: person.email,
          subject: `🤡 Week ${week.week_number} Bozo: ${bozo.display_name}`,
          text,
          html,
          week_id: week.id,
          user_id: person.id,
        })),
      });
    }
    if (channels.includes('sms')) {
      results.push({
        user: person.display_name,
        channel: 'sms',
        ...(await notify.sendSms({ to: person.phone, body: text, week_id: week.id, user_id: person.id })),
      });
    }
  }

  res.json({ ok: results.some((r) => r.ok), results, preview: { text, html }, channels: notify.channelStatus() });
});

/** Render the summons without sending it — for copy/paste into the group chat. */
router.get('/weeks/:id/summons', (req, res) => {
  const week = game.getWeek(parseInt(req.params.id, 10));
  if (!week) return res.status(404).json({ error: 'Week not found.' });
  // The summons lists everyone's pick by name. Before lock that is exactly the
  // information the game hides, so members get it only once the week is locked.
  if (!req.user.is_admin && game.statusRank(week.status) < game.statusRank('locked')) {
    return res.status(409).json({ error: 'Picks are still hidden — the summons is available once the week locks.' });
  }
  const bozo = game.getBozo(week.id);
  const picks = game.rawPicks(week.id).map(game.decoratePick);
  const parlayInfo = scoring.parlay(picks, week.stake_cents);

  if (!bozo) {
    return res.json({
      text: [
        `📋 Week ${week.week_number} — ${getSetting('group_name')} ticket`,
        '',
        ...picks.map(
          (p) =>
            `${p.result === 'win' ? '✅' : p.result === 'loss' ? '❌' : p.result === 'push' ? '➖' : '⏳'} ` +
            `${p.display_name}: ${p.player} ${p.selection}${p.line !== null ? ' ' + p.line : ''} (${p.market_label}) ${p.price_display}`
        ),
        '',
        `${parlayInfo.leg_count} legs at ${parlayInfo.american_display} — ${notify.money(parlayInfo.stake_cents)} to win ${notify.money(parlayInfo.profit_cents)}.`,
      ].join('\n'),
    });
  }

  res.json({
    text: notify.bozoSummonsText({
      bozo: { id: bozo.user_id, display_name: bozo.display_name },
      week,
      roastLine: bozo.roast || '',
      parlayInfo,
      picks,
      siteUrl: getSetting('site_url', process.env.SITE_URL || ''),
      careerCount: game.bozoCounts(bozo.user_id, week.season_id).all_time,
    }),
  });
});

/* ---------------- stats ---------------- */

router.get('/leaderboard', (req, res) => {
  const seasonId = req.query.season_id ? parseInt(req.query.season_id, 10) : null;
  const board = game.leaderboard({ seasonId });
  if (!board) return res.status(404).json({ error: 'Season not found.' });
  res.json(board);
});

module.exports = router;
