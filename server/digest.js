'use strict';

/**
 * The three weekly bulletins.
 *
 *   TUESDAY  "open"   Week is live, get your pick in. Costs 0 credits — nobody
 *                     has picked yet, so there is nothing to price.
 *   THURSDAY "mid"    How the numbers moved, who is injured, who is missing.
 *   SATURDAY "final"  The placement sheet. This is the one that matters: the
 *                     bozo places the ticket on Sunday, days after everyone
 *                     picked, so they need the line as it stands NOW, not the
 *                     one that was chosen on Tuesday.
 *
 * Thursday and Saturday refresh props only for games somebody actually picked
 * — typically five of sixteen — which is what keeps the whole schedule inside
 * the free tier.
 */

const { db, getSetting } = require('./db');
const game = require('./game');
const scoring = require('./scoring');
const odds = require('./odds');
const injuries = require('./injuries');
const notify = require('./notify');
const altlines = require('./altlines');

const money = notify.money;
const sign = (n) => (n > 0 ? `+${n}` : String(n));

/* ------------------------------------------------------------------ */
/* Line refresh                                                        */
/* ------------------------------------------------------------------ */

/**
 * Re-price every pick in the week and record a snapshot.
 * Only touches games that have a pick on them.
 */
async function refreshPickLines(weekId, { force = false } = {}) {
  const picks = game.rawPicks(weekId).map(game.decoratePick);
  const eventIds = [...new Set(picks.map((p) => p.event_id).filter(Boolean))];

  const result = { moves: [], cost: 0, games_checked: 0, failures: [], unpriced: [] };
  if (!eventIds.length || !odds.hasApiKey()) {
    result.unpriced = picks.map((p) => p.player);
    return result;
  }

  const boards = new Map();
  for (const eventId of eventIds) {
    try {
      const board = await odds.getEventProps(eventId, { force });
      boards.set(eventId, board);
      result.cost += board.cost || 0;
      result.games_checked += 1;
    } catch (err) {
      result.failures.push({ event_id: eventId, error: err.message });
    }
  }

  const insert = db.prepare(
    `INSERT INTO line_snapshots (pick_id, line, price, bookmaker, source) VALUES (?, ?, ?, ?, ?)`
  );

  for (const pick of picks) {
    const board = boards.get(pick.event_id);
    if (!board) {
      result.unpriced.push(pick.player);
      continue;
    }
    const match = board.props.find(
      (p) =>
        p.market === pick.market &&
        injuries.normalizeName(p.player) === injuries.normalizeName(pick.player) &&
        String(p.selection).toLowerCase() === String(pick.selection).toLowerCase()
    );
    if (!match) {
      result.unpriced.push(pick.player);
      continue;
    }

    // A pick taken at an alternate line was never sitting on the posted number,
    // so comparing it against today's posted number would report a 45-yard
    // "move" that never happened. Re-price the picker's OWN line off the
    // current board instead, and compare like for like.
    let current = { line: match.line, price: match.price, bookmaker: match.bookmaker, estimated: false };
    const isAlternate =
      pick.line !== null && match.line !== null && Math.abs(Number(pick.line) - Number(match.line)) > 1e-9;

    if (isAlternate) {
      const opposite = board.props.find(
        (p) =>
          p.market === match.market &&
          p.player === match.player &&
          p.line === match.line &&
          String(p.selection).toLowerCase() !== String(match.selection).toLowerCase()
      );
      const curve = altlines.buildCurve({
        market: match.market,
        line: match.line,
        selection: match.selection,
        price: match.price,
        opposite_price: opposite ? opposite.price : undefined,
      });
      const quote = curve ? curve.priceAt(pick.line) : null;
      if (quote && quote.price !== null) {
        current = { line: pick.line, price: quote.price, bookmaker: `${match.bookmaker} (est.)`, estimated: true };
      } else {
        // Their number is off the quotable curve now — say so rather than guess.
        result.unpriced.push(`${pick.player} (${pick.line} no longer quotable)`);
        continue;
      }
    }

    insert.run(pick.id, current.line, current.price, current.bookmaker, 'scheduled');

    const lineMove = pick.line === null || current.line === null ? null : Number((current.line - pick.line).toFixed(1));
    result.moves.push({
      pick_id: pick.id,
      user_id: pick.user_id,
      display_name: pick.display_name,
      player: pick.player,
      market_label: pick.market_label,
      selection: pick.selection,
      original_line: pick.line,
      current_line: current.line,
      line_move: lineMove,
      original_price: pick.price,
      current_price: current.price,
      price_move: current.price - pick.price,
      bookmaker: current.bookmaker,
      estimated: current.estimated,
      posted_line: match.line,
      // Did the number drift the wrong way for the person holding it?
      // For a same-line pick, "worse" means the number drifted against you. For
      // an alternate the number is fixed, so worse means the price got shorter.
      worse:
        lineMove === null || lineMove === 0
          ? current.price < pick.price
          : pick.selection === 'Over'
          ? lineMove > 0
          : lineMove < 0,
      moved: (lineMove !== null && lineMove !== 0) || current.price !== pick.price,
    });
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Report bodies                                                       */
/* ------------------------------------------------------------------ */

function pickLine(p) {
  const line = p.line === null || p.line === undefined ? '' : ` ${p.line}`;
  return `${p.player} ${p.selection}${line} (${p.market_label}) ${sign(p.price)}`;
}

function buildOpen(weekId) {
  const detail = game.weekDetail(weekId, { id: 0, is_admin: true });
  const w = detail.week;
  const group = getSetting('group_name');
  const site = getSetting('site_url', process.env.SITE_URL || '');

  const missing = detail.missing_picks.map((m) => m.display_name);
  const lines = [
    `🏈 WEEK ${w.week_number} IS OPEN — ${group}`,
    '',
    'Get your player prop in.',
    '',
    detail.payer
      ? `💸 ${detail.payer.display_name} is paying for this week's ticket (last week's bozo).`
      : `Nobody is on the hook yet — first bozo of the season inherits the bill.`,
    `Stake: ${money(w.stake_cents)}`,
    w.lock_at ? `Picks lock: ${new Date(w.lock_at).toLocaleString('en-US', { timeZone: getSetting('schedule_timezone') })}` : '',
    '',
    missing.length ? `Still need picks from: ${missing.join(', ')}` : 'Everyone is already in. Suspicious.',
    '',
    site ? `Make your pick: ${site}` : '',
  ];

  return {
    subject: `🏈 Week ${w.week_number} is open — get your pick in`,
    text: lines.filter((l) => l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    week: w,
    detail,
  };
}

function buildMid({ weekId, moves, injuryFlags, injuryChecked }) {
  const detail = game.weekDetail(weekId, { id: 0, is_admin: true });
  const w = detail.week;
  const site = getSetting('site_url', process.env.SITE_URL || '');
  const missing = detail.missing_picks.map((m) => m.display_name);

  const moved = moves.filter((m) => m.moved);
  const lines = [
    `📊 WEEK ${w.week_number} MIDWEEK UPDATE`,
    '',
    missing.length
      ? `⏰ STILL MISSING: ${missing.join(', ')} — get in before it locks.`
      : '✅ Everyone is in.',
    '',
  ];

  if (injuryFlags.length) {
    lines.push('🚑 INJURY WATCH');
    for (const f of injuryFlags) {
      lines.push(`  ${f.serious ? '🔴' : '🟡'} ${f.player} (${f.position || '?'}, ${f.team}) — ${f.status}` +
        `${f.detail ? `: ${f.detail}` : ''}  [${f.display_name}'s pick]`);
    }
    lines.push('');
  } else if (injuryChecked) {
    lines.push('🚑 No injury designations on anybody\'s guy. For now.', '');
  }

  if (moved.length) {
    lines.push('📈 LINE MOVEMENT since you picked');
    for (const m of moved) {
      const flag = m.worse ? '⚠️' : '  ';
      if (m.line_move === null || m.line_move === 0) {
        // Same number, different price — the usual case for an alternate line.
        lines.push(
          `  ${flag} ${m.display_name}: ${m.player} ${m.selection} ${m.current_line ?? ''} ` +
            `${sign(m.original_price)} → ${sign(m.current_price)}${m.estimated ? ' (est.)' : ''}`
        );
      } else {
        const dir = m.line_move > 0 ? '↑' : '↓';
        lines.push(
          `  ${flag} ${m.display_name}: ${m.player} ${m.selection} ` +
            `${m.original_line} → ${m.current_line} ${dir}${Math.abs(m.line_move)} ` +
            `(${sign(m.original_price)} → ${sign(m.current_price)})`
        );
      }
    }
    lines.push('', '⚠️ = the number moved against you.');
  } else if (moves.length) {
    lines.push('📈 No line movement on anybody\'s pick yet.');
  }

  lines.push('', site ? site : '');

  return {
    subject: `📊 Week ${w.week_number} midweek — ${missing.length ? `${missing.length} still missing` : 'lines and injuries'}`,
    text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    week: w,
    detail,
  };
}

function buildFinal({ weekId, moves, injuryFlags }) {
  const detail = game.weekDetail(weekId, { id: 0, is_admin: true });
  const w = detail.week;
  const site = getSetting('site_url', process.env.SITE_URL || '');
  const picks = game.rawPicks(weekId).map(game.decoratePick);
  const parlay = scoring.parlay(picks, w.stake_cents);
  const byPick = new Map(moves.map((m) => [m.pick_id, m]));

  const lines = [
    `🎫 WEEK ${w.week_number} — PLACE THE TICKET`,
    '',
    detail.payer ? `${detail.payer.display_name}, you're placing this one.` : 'Whoever is paying — this is the ticket.',
    `Stake: ${money(w.stake_cents)}`,
    '',
    'THE LEGS — current numbers, not what was picked:',
  ];

  for (const p of picks) {
    const m = byPick.get(p.id);
    const current = m ? `${p.player} ${p.selection} ${m.current_line ?? ''} ${sign(m.current_price)}` : pickLine(p);
    lines.push(`  • ${p.display_name}: ${current.trim()}${m ? `  [${m.bookmaker}]` : ''}`);
    if (m && m.moved) {
      const same = m.line_move === null || m.line_move === 0;
      lines.push(
        same
          ? `      ↳ was ${sign(m.original_price)} when picked${m.estimated ? ' · price estimated off the posted line' : ''}`
          : `      ↳ moved from ${m.original_line} ${sign(m.original_price)} when picked`
      );
    }
  }

  lines.push(
    '',
    `${parlay.leg_count} leg${parlay.leg_count === 1 ? '' : 's'} at ${parlay.american_display} — ` +
      `${money(parlay.stake_cents)} to win ${money(parlay.profit_cents)}.`,
    '(Odds shown are from the picked numbers; your book will price its own.)'
  );

  if (injuryFlags.length) {
    lines.push('', '🚑 HEADS UP BEFORE YOU PLACE:');
    for (const f of injuryFlags) {
      lines.push(`  ${f.serious ? '🔴' : '🟡'} ${f.player} — ${f.status}${f.detail ? `: ${f.detail}` : ''}`);
    }
  }

  const unmatched = picks.filter((p) => !byPick.has(p.id));
  if (unmatched.length) {
    lines.push('', `⚠️ Could not re-price: ${unmatched.map((p) => p.player).join(', ')}. Check these by hand.`);
  }

  lines.push('', site ? site : '');

  return {
    subject: `🎫 Week ${w.week_number} — place the ticket`,
    text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    week: w,
    detail,
  };
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build one digest. Pure with respect to sending — the caller decides that,
 * so previews cost nothing extra and behave identically to the real thing.
 *
 * @param {'open'|'mid'|'final'} kind
 */
async function build(kind, weekId, { force = false } = {}) {
  const week = game.getWeek(weekId);
  if (!week) throw new Error('Week not found.');

  if (kind === 'open') {
    return { ...buildOpen(weekId), kind, cost: 0, credits: 0 };
  }

  const refreshed = await refreshPickLines(weekId, { force });
  const picks = game.rawPicks(weekId).map(game.decoratePick);

  let flags = [];
  let checked = false;
  if (getSetting('injury_feed') === '1') {
    const res = await injuries.flagPicks(picks);
    flags = res.flags;
    checked = res.checked;
  }

  const body =
    kind === 'final'
      ? buildFinal({ weekId, moves: refreshed.moves, injuryFlags: flags })
      : buildMid({ weekId, moves: refreshed.moves, injuryFlags: flags, injuryChecked: checked });

  return {
    ...body,
    kind,
    credits: refreshed.cost,
    games_checked: refreshed.games_checked,
    moves: refreshed.moves,
    injury_flags: flags,
    failures: refreshed.failures,
    unpriced: refreshed.unpriced,
  };
}

/** Send a built digest to the group (or just the bozo/payer, for 'final'). */
async function send(digest, { audience = 'group', channels = null } = {}) {
  const chans = channels || (getSetting('schedule_channels') || 'email').split(',').map((s) => s.trim()).filter(Boolean);
  const everyone = game.listUsers();

  let recipients = everyone;
  if (audience === 'payer') {
    const payerId = digest.detail?.payer?.id;
    recipients = payerId ? everyone.filter((u) => u.id === payerId) : everyone;
  }

  const results = [];
  for (const person of recipients) {
    if (chans.includes('email')) {
      results.push({
        user: person.display_name,
        channel: 'email',
        ...(await notify.sendEmail({
          to: person.email,
          subject: digest.subject,
          text: digest.text,
          week_id: digest.week?.id,
          user_id: person.id,
        })),
      });
    }
    if (chans.includes('sms')) {
      results.push({
        user: person.display_name,
        channel: 'sms',
        ...(await notify.sendSms({ to: person.phone, body: digest.text, week_id: digest.week?.id, user_id: person.id })),
      });
    }
  }
  return results;
}

module.exports = { build, send, refreshPickLines };
