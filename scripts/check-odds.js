#!/usr/bin/env node
'use strict';

/**
 * Verifies the Odds API key end to end and reports exactly what each call costs.
 * Run this first on a machine with internet access:
 *
 *   node scripts/check-odds.js            # free checks only (0 credits)
 *   node scripts/check-odds.js --props    # also pull one game's props (costs credits)
 */

require('dotenv').config();

const odds = require('../server/odds');
const { getSetting } = require('../server/db');

const wantProps = process.argv.includes('--props');

function line(char = '─') {
  console.log(char.repeat(60));
}

(async () => {
  console.log('\n🤡 Blue Man Bozo — Odds API check\n');
  line();

  if (!odds.hasApiKey()) {
    console.error('\n❌ No API key found.');
    console.error('   Set ODDS_API_KEY in your .env file, or add it in the app under');
    console.error('   Commissioner → Odds API.\n');
    process.exit(1);
  }
  console.log('✓ API key present');

  const markets = (getSetting('odds_markets') || '').split(',').filter(Boolean);
  const regions = (getSetting('odds_regions') || 'us').split(',').filter(Boolean);
  console.log(`  markets enabled: ${markets.length} (${markets.join(', ')})`);
  console.log(`  regions:         ${regions.join(', ')}`);
  console.log(`  cost per game:   ${markets.length * regions.length} credits`);
  line();

  console.log('\n1. Fetching the NFL slate (costs 0 credits)…');
  let events;
  try {
    const res = await odds.getEvents({ force: true });
    events = res.events;
    console.log(`   ✓ ${events.length} upcoming games`);
    for (const e of events.slice(0, 6)) {
      console.log(`     · ${e.away_team} @ ${e.home_team} — ${new Date(e.commence_time).toLocaleString()}`);
    }
    if (events.length > 6) console.log(`     … and ${events.length - 6} more`);
  } catch (err) {
    console.error(`   ❌ ${err.message}`);
    process.exit(1);
  }

  const quota = odds.quotaStatus();
  console.log(`\n   Provider says: ${quota.provider_remaining ?? 'unknown'} credits remaining this cycle`);
  console.log(`   Local tally:   ${quota.used_this_month}/${quota.local_cap} used in ${quota.month}`);

  if (!wantProps) {
    line();
    console.log('\n✅ Free checks passed. Re-run with --props to test a real prop pull');
    console.log(`   (that one call will spend ${markets.length * regions.length} credits).\n`);
    return;
  }

  if (!events.length) {
    console.log('\n⚠️  No games on the board, so there are no props to pull.\n');
    return;
  }

  const game = events[0];
  console.log(`\n2. Pulling props for ${game.away_team} @ ${game.home_team}…`);
  try {
    const res = await odds.getEventProps(game.id, { force: true });
    console.log(`   ✓ ${res.props.length} prop lines from ${res.bookmakers.length} books (cost ${res.cost} credits)`);
    for (const p of res.props.slice(0, 10)) {
      const l = p.line === null ? '' : ` ${p.line}`;
      console.log(`     · ${p.player} — ${p.market_label} ${p.selection}${l} @ ${p.price > 0 ? '+' : ''}${p.price} (${p.bookmaker})`);
    }
    if (res.props.length > 10) console.log(`     … and ${res.props.length - 10} more`);
  } catch (err) {
    console.error(`   ❌ ${err.message}`);
    process.exit(1);
  }

  const after = odds.quotaStatus();
  line();
  console.log(`\n✅ Everything works. ${after.used_this_month}/${after.local_cap} credits used locally this month.\n`);
})();
