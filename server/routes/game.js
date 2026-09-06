'use strict';

const express = require('express');
const { db, getSetting, activeSeason, currentWeek } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const game = require('../game');
const scoring = require('../scoring');
const roastEngine = require('../roast');
const notify = require('../notify');
const odds = require('../odds');

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

  // Whoever was the bozo last week is on the hook for this week's ticket.
  const prevBozo = db
    .prepare(
      `SELECT b.user_id FROM bozos b JOIN weeks w ON w.id = b.week_id
       WHERE w.season_id = ? AND w.week_number < ? ORDER BY w.week_number DESC LIMIT 1`
    )
    .get(season.id, weekNumber);

  const stake = parseInt(req.body?.stake_cents, 10) || parseInt(getSetting('default_stake_cents'), 10) || 2000;

  const info = db
    .prepare(
      `INSERT INTO weeks (season_id, week_number, label, status, lock_at, stake_cents, payer_user_id, notes)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`
    )
    .run(
      season.id,
      weekNumber,
      req.body?.label || null,
      req.body?.lock_at || null,
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

router.delete('/weeks/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM weeks WHERE id = ?').run(parseInt(req.params.id, 10));
  if (!info.changes) return res.status(404).json({ error: 'Week not found.' });
  res.json({ ok: true });
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

  const detail = game.weekDetail(week.id, req.user);
  const warning = odds.lineWarning(market, line);
  res.json(warning ? { ...detail, warning } : detail);
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
router.post('/weeks/:id/grade', requireAdmin, (req, res) => {
  const week = game.getWeek(parseInt(req.params.id, 10));
  if (!week) return res.status(404).json({ error: 'Week not found.' });

  const results = Array.isArray(req.body?.results) ? req.body.results : [];
  if (!results.length) return res.status(400).json({ error: 'No stat lines submitted.' });

  const update = db.prepare(
    `UPDATE picks SET actual_value = @actual_value, result = @result, graded_at = datetime('now'),
      updated_at = datetime('now') WHERE id = @id AND week_id = @week_id`
  );

  const apply = db.transaction((rows) => {
    for (const row of rows) {
      const pick = db.prepare('SELECT * FROM picks WHERE id = ? AND week_id = ?').get(row.pick_id, week.id);
      if (!pick) continue;

      // An explicit void stays void; everything else is derived from the stat line.
      if (row.result === 'void') {
        update.run({ id: pick.id, week_id: week.id, actual_value: null, result: 'void' });
        continue;
      }
      const actual = scoring.toNum(row.actual_value);
      const result = Number.isFinite(actual) ? scoring.gradePick(pick, actual) : 'pending';
      update.run({
        id: pick.id,
        week_id: week.id,
        actual_value: Number.isFinite(actual) ? actual : null,
        result,
      });
    }
  });
  apply(results);

  const warnings = [];
  for (const row of results) {
    const pick = db.prepare('SELECT * FROM picks WHERE id = ? AND week_id = ?').get(row.pick_id, week.id);
    if (!pick || row.result === 'void') continue;
    const w = odds.actualWarning(pick.market, scoring.toNum(row.actual_value));
    if (w) warnings.push(`${pick.player}: ${w}`);
  }

  const picks = game.rawPicks(week.id);
  const allSettled = picks.length > 0 && picks.every((p) => p.result !== 'pending');
  if (allSettled && game.statusRank(week.status) < game.statusRank('graded')) {
    db.prepare("UPDATE weeks SET status = 'graded' WHERE id = ?").run(week.id);
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

  const picks = game.rawPicks(week.id).map(game.decoratePick);
  const votes = game.getVotes(week.id);

  let resolution;
  if (req.body?.user_id) {
    const forced = parseInt(req.body.user_id, 10);
    const tally = votes.filter((v) => v.nominee_id === forced).length;
    resolution = { user_id: forced, method: 'commissioner', votes_received: tally };
  } else {
    resolution = scoring.resolveBozo(votes, picks);
  }

  if (!resolution) {
    return res.status(400).json({
      error: 'Nobody lost this week — no bozo to crown.',
      perfect_week: roastEngine.perfectWeek(`w${week.id}`),
    });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(resolution.user_id);
  if (!user) return res.status(400).json({ error: 'That person is not in the group.' });

  // Count every OTHER week's bozos, then add this one — re-crowning the same
  // person must not count their existing row for this week twice.
  const priorCount = db
    .prepare('SELECT COUNT(*) AS n FROM bozos WHERE user_id = ? AND week_id <> ?')
    .get(user.id, week.id).n;
  const careerCount = priorCount + 1;
  const losingPick = picks.find((p) => p.user_id === user.id && p.result === 'loss') || null;
  const roastLine =
    req.body?.roast?.trim() ||
    roastEngine.roast({
      name: user.display_name,
      week: week.week_number,
      group: getSetting('group_name'),
      count: careerCount,
      pick: losingPick,
      seed: `w${week.id}u${user.id}`,
    });

  const finalize = db.transaction(() => {
    db.prepare(
      `INSERT INTO bozos (week_id, user_id, method, votes_received, roast) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(week_id) DO UPDATE SET user_id = excluded.user_id, method = excluded.method,
         votes_received = excluded.votes_received, roast = excluded.roast, created_at = datetime('now')`
    ).run(week.id, user.id, resolution.method, resolution.votes_received || 0, roastLine);

    db.prepare("UPDATE weeks SET status = 'final' WHERE id = ?").run(week.id);

    // The bozo owes next week's ticket.
    db.prepare(
      `UPDATE weeks SET payer_user_id = ? WHERE season_id = ? AND week_number = ?`
    ).run(user.id, week.season_id, week.week_number + 1);
  });
  finalize();

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
