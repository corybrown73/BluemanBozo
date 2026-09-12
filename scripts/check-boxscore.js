#!/usr/bin/env node
'use strict';

/**
 * Can we grade player props for free, off ESPN?
 *
 *   npm run check-boxscore              # most recent finished games
 *   npm run check-boxscore -- 20260914  # a particular date (YYYYMMDD)
 *
 * The Odds API has no player stats at any tier — its /scores endpoint returns
 * game scores only. ESPN's public JSON does have box scores, with no key and
 * no quota, so grading a week could cost nothing.
 *
 * This proves whether that is true against a real finished game, and prints
 * the exact stat labels so the market mapping is read off the feed rather
 * than guessed at. Run it from a machine with internet access.
 *
 * Nothing here touches your database.
 */

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const dateArg = process.argv.slice(2).find((a) => /^\d{8}$/.test(a));

// What we need out of the feed, per market we let people pick.
const WANTED = {
  player_pass_yds: { category: 'passing', label: 'YDS', as: 'Passing Yards' },
  player_rush_yds: { category: 'rushing', label: 'YDS', as: 'Rushing Yards' },
  player_reception_yds: { category: 'receiving', label: 'YDS', as: 'Receiving Yards' },
  player_receptions: { category: 'receiving', label: 'REC', as: 'Receptions' },
  player_anytime_td: { category: 'rushing+receiving', label: 'TD', as: 'Anytime TD' },
};

async function getJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'BlueManBozo/1.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`ESPN returned ${res.status} for ${url}`);
  return res.json();
}

(async () => {
  console.log('\n🤡 Blue Man Bozo — can we grade for free off ESPN?\n');
  console.log('─'.repeat(64));

  const url = `${BASE}/scoreboard${dateArg ? `?dates=${dateArg}` : ''}`;
  console.log(`\nScoreboard: ${url}`);

  let board;
  try {
    board = await getJson(url);
  } catch (err) {
    console.error(`\n✖ Could not reach ESPN: ${err.message}`);
    console.error('  Run this from a machine with normal internet access.\n');
    process.exit(1);
  }

  const events = board.events || [];
  const done = events.filter((e) => e.status?.type?.completed);
  console.log(`  ${events.length} games, ${done.length} finished`);

  if (!done.length) {
    console.log('\n  No finished games on that date. Try a Monday after a slate:');
    console.log('    npm run check-boxscore -- 20260914\n');
    process.exit(0);
  }

  const game = done[0];
  console.log(`\nGame: ${game.name}`);
  console.log(`  id ${game.id} · ${game.date}`);

  const summary = await getJson(`${BASE}/summary?event=${game.id}`);
  const teams = summary?.boxscore?.players || [];
  if (!teams.length) {
    console.error('\n✖ That game has no player box score in the feed.');
    console.error('  Auto-grading would not be reliable. Keep grading by hand.\n');
    process.exit(1);
  }

  console.log('\n─'.repeat(1) + '─'.repeat(63));
  console.log('\nStat categories in the feed, and their column labels:\n');
  const seen = new Map();
  for (const t of teams) {
    for (const cat of t.statistics || []) {
      if (!seen.has(cat.name)) seen.set(cat.name, cat.labels || []);
    }
  }
  for (const [name, labels] of seen) {
    console.log(`  ${name.padEnd(14)} ${labels.join('  ')}`);
  }

  console.log('\n─'.repeat(64));
  console.log('\nWhat each of our markets would read:\n');
  let allFound = true;
  for (const [key, want] of Object.entries(WANTED)) {
    const cats = want.category.split('+');
    const missing = cats.filter((c) => !seen.has(c));
    const hasLabel = cats.every((c) => (seen.get(c) || []).includes(want.label));
    const ok = !missing.length && hasLabel;
    if (!ok) allFound = false;
    console.log(
      `  ${ok ? '✓' : '✗'} ${want.as.padEnd(18)} ${want.category}.${want.label}` +
        (ok ? '' : `   MISSING (${missing.join(', ') || 'label not in feed'})`)
    );
  }

  console.log('\n─'.repeat(64));
  console.log('\nSample — real numbers this game would have graded:\n');
  for (const t of teams) {
    const abbr = t.team?.abbreviation || '?';
    for (const cat of t.statistics || []) {
      if (!['passing', 'rushing', 'receiving'].includes(cat.name)) continue;
      const labels = cat.labels || [];
      for (const a of (cat.athletes || []).slice(0, 2)) {
        const name = a.athlete?.displayName || '?';
        const pairs = labels
          .map((l, i) => `${l}=${a.stats?.[i]}`)
          .filter((x) => /^(YDS|REC|TD|CAR|C\/ATT)=/.test(x))
          .join('  ');
        console.log(`  ${abbr.padEnd(4)} ${cat.name.padEnd(10)} ${name.padEnd(22)} ${pairs}`);
      }
    }
  }

  /* ---------------- first touchdown ---------------- */
  console.log('\n─'.repeat(64));
  console.log('\nFirst TD — is the scoring ORDER in the feed?\n');
  const plays = summary?.scoringPlays;
  if (!Array.isArray(plays) || !plays.length) {
    console.log('  ✗ no scoringPlays array. First TD cannot be graded automatically.');
  } else {
    console.log(`  ✓ scoringPlays has ${plays.length} entries, in order`);
    const firstTd = plays.find(
      (p) => /touchdown/i.test(p.type?.text || '') || /TD/i.test(p.type?.abbreviation || '')
    );
    if (!firstTd) {
      console.log('  ✗ none of them is a touchdown — check a higher-scoring game.');
    } else {
      console.log('\n  The first touchdown of the game, as the feed describes it:');
      console.log(`    type        ${firstTd.type?.abbreviation} — ${firstTd.type?.text}`);
      console.log(`    team        ${firstTd.team?.displayName || firstTd.team?.abbreviation || '(none)'}`);
      console.log(`    clock       Q${firstTd.period?.number} ${firstTd.clock?.displayValue || ''}`);
      console.log(`    text        ${firstTd.text}`);
      const parts = firstTd.participants || firstTd.athletes;
      if (Array.isArray(parts) && parts.length) {
        console.log('    participants:');
        for (const pt of parts) {
          console.log(`      ${pt.type || pt.role || '?'} -> ${pt.athlete?.displayName || pt.athlete?.fullName || '?'}`);
        }
        console.log('\n  ✓ the scorer is named in structured data — reliable to grade on.');
      } else {
        console.log('\n  ! no participants array; the scorer would have to be parsed out of');
        console.log('    the text above, which is guesswork. Paste this back either way.');
      }
      console.log('\n  Raw keys on that play: ' + Object.keys(firstTd).join(', '));
    }
  }

  console.log('\n─'.repeat(64));
  if (allFound) {
    console.log('\n✅ Every market we offer can be graded from this feed, free.');
    console.log('   Paste this output back and the auto-grader can be built against it.\n');
  } else {
    console.log('\n⚠️  Some markets are not in this feed. Those would stay manual.');
    console.log('   Paste this output back so the mapping matches reality.\n');
  }
})().catch((err) => {
  console.error(`\n✖ ${err.message}\n`);
  process.exit(1);
});
