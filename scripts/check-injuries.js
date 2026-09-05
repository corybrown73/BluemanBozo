#!/usr/bin/env node
'use strict';

/**
 * Verify the free ESPN injury feed. Costs nothing — it is not the Odds API.
 *   node scripts/check-injuries.js
 */

require('dotenv').config();
const injuries = require('../server/injuries');

(async () => {
  console.log('\n🚑 Blue Man Bozo — injury feed check\n');
  console.log(injuries.FEED, '\n');

  const res = await injuries.getInjuries({ force: true });

  if (res.error && !res.injuries.length) {
    console.error(`❌ Could not read the feed: ${res.error}\n`);
    console.error('   This is an undocumented public endpoint, so it can change or');
    console.error('   rate-limit. The weekly digests still work without it — they just');
    console.error('   skip the injury section. Turn it off in Commissioner → Weekly');
    console.error('   schedule if it stays broken.\n');
    process.exit(1);
  }

  console.log(`✓ ${res.injuries.length} injury designations${res.stale ? ' (from cache — live fetch failed)' : ''}`);

  const counts = {};
  for (const i of res.injuries) counts[i.status] = (counts[i.status] || 0) + 1;
  console.log('\n  By status:');
  for (const [status, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${status}`);
  }

  console.log('\n  Sample:');
  for (const i of res.injuries.slice(0, 8)) {
    console.log(`    ${i.player} (${i.position}, ${i.team}) — ${i.status}${i.detail ? `: ${i.detail}` : ''}`);
  }
  console.log('\n✅ Feed works. Injuries will appear in the Thursday digest.\n');
})();
