#!/usr/bin/env node
'use strict';

/**
 * Verify the free ESPN roster feed that powers "group by team" on the prop
 * board. Costs nothing — it is not the Odds API.
 *   node scripts/check-roster.js
 */

require('dotenv').config();
const roster = require('../server/roster');

(async () => {
  console.log('\nBlue Man Bozo — roster feed check\n');
  console.log(roster.TEAMS_URL, '\n');
  console.log('Fetching 32 team rosters (a few seconds)…');

  const res = await roster.getRoster({ force: true });

  if (!res.roster) {
    console.error(`\nCould not read the rosters: ${res.error}\n`);
    console.error('  This is an undocumented public endpoint, so it can change or');
    console.error('  rate-limit. The prop board still works without it — it just');
    console.error('  hides the "By team" grouping and falls back to "By game".\n');
    process.exit(1);
  }

  const players = Object.keys(res.roster.players).length;
  console.log(`\n  ${players} players across ${res.roster.rosters_loaded}/${res.roster.team_count} rosters`);

  const sample = Object.entries(res.roster.players).slice(0, 6);
  console.log('\n  Sample:');
  for (const [, v] of sample) {
    console.log(`    ${String(v.position).padEnd(4)} #${String(v.jersey).padEnd(3)} ${v.team}`);
  }

  console.log('\nFeed works. The prop board can group by team.\n');
})();
