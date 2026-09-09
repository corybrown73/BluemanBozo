#!/usr/bin/env node
'use strict';

/**
 * Checks a LIVE deployment from the outside — the things that are wrong
 * silently rather than loudly.
 *
 *   npm run check-deploy -- https://bluemanbozo.fly.dev
 *   npm run check-deploy -- https://bluemanbozo.fly.dev --user cory --pass 'secret'
 *
 * Without credentials it checks everything reachable while signed out. With
 * them it signs in and reports what the group would actually see: the week,
 * the members, whether live odds are loading, and what credits are left.
 *
 * Nothing here writes to your data. It never creates a week, a pick or a vote.
 */

const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith('http')) || '').replace(/\/+$/, '');
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};
const username = argOf('user');
const password = argOf('pass');

if (!base) {
  console.error('\nUsage: npm run check-deploy -- https://your-app.fly.dev [--user cory --pass secret]\n');
  process.exit(2);
}

const problems = [];
const warnings = [];
let cookie = null;

const ok = (m, d = '') => console.log(`  ✓ ${m}${d ? `  ${d}` : ''}`);
const bad = (m, fix) => { console.log(`  ✗ ${m}`); problems.push({ m, fix }); };
const warn = (m, fix) => { console.log(`  !  ${m}`); warnings.push({ m, fix }); };
const rule = () => console.log('─'.repeat(64));

async function req(path, options = {}) {
  const res = await fetch(base + path, {
    redirect: 'manual',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) },
    ...options,
    signal: AbortSignal.timeout(20000),
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of setCookie) {
    const [pair] = c.split(';');
    if (pair.startsWith('bmb_session=')) cookie = pair;
  }
  return { res, setCookie };
}

async function json(path, options) {
  const { res } = await req(path, options);
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}

(async () => {
  console.log(`\n🤡 Blue Man Bozo — deployment check\n   ${base}\n`);
  rule();

  /* ---------- reachable at all ---------- */
  console.log('\nReachable');
  let health;
  try {
    const t0 = Date.now();
    health = await json('/healthz');
    const ms = Date.now() - t0;
    if (health.status !== 200) {
      bad(`/healthz returned ${health.status}`, 'The app is not serving. Check `fly logs` for a crash or a port mismatch.');
    } else {
      ok('the app is up', `${ms}ms${ms > 3000 ? '  (slow — machine was probably asleep, that is normal)' : ''}`);
    }
  } catch (err) {
    bad(`cannot reach ${base} — ${err.message}`,
      'No public IP, DNS not pointed yet, or the machine is down. Try: fly ips list && fly logs');
    rule();
    report();
    return;
  }

  /* ---------- has anybody been created ---------- */
  const users = health.data?.users;
  if (users === 0) {
    bad('the database has zero members — nobody can sign in',
      'Set ADMIN_USERNAME and ADMIN_PASSWORD, then redeploy:\n     fly secrets set ADMIN_USERNAME=cory ADMIN_PASSWORD=something-long');
  } else if (typeof users === 'number') {
    ok(`${users} member${users === 1 ? '' : 's'} in the database`);
  }

  /* ---------- HTTPS and cookie safety ---------- */
  console.log('\nSecurity');
  if (!base.startsWith('https://')) {
    warn('checked over http, so cookie flags could not be verified', 'Re-run against the https:// URL.');
  }
  const { res: rootRes } = await req('/');
  if (rootRes.status === 302 || rootRes.status === 301) {
    ok('signed-out visitors are redirected to the login page');
  } else if (rootRes.status === 200) {
    bad('the app served the site to a signed-out visitor', 'This should redirect to /login. Report this.');
  }
  const stateProbe = await json('/api/state');
  if (stateProbe.status === 401) ok('the API refuses unauthenticated requests');
  else bad(`/api/state returned ${stateProbe.status} while signed out (expected 401)`, 'Your data may be readable by anyone. Report this.');

  /* ---------- login page ---------- */
  const { res: loginRes } = await req('/login');
  if (loginRes.status === 200) ok('the login page loads');
  else bad(`/login returned ${loginRes.status}`, 'Static files are not being served.');

  /* ---------- signed-in checks ---------- */
  if (!username || !password) {
    console.log('\nSigned-in checks skipped');
    console.log('  Add --user and --pass to check the week, the odds and your credits.');
    rule();
    report();
    return;
  }

  console.log('\nSigning in');
  const login = await json('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (login.status !== 200) {
    bad(`sign-in failed: ${login.data.error || login.status}`,
      'If this is a fresh deploy, ADMIN_USERNAME/ADMIN_PASSWORD only apply when the database is empty.');
    rule();
    report();
    return;
  }
  ok(`signed in as ${login.data.user.display_name}`, login.data.user.is_admin ? '(commissioner)' : '');

  const cookieLine = (await req('/api/auth/me')).setCookie.join(' ') || '';
  if (base.startsWith('https://')) {
    const probe = await req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const c = probe.setCookie.find((x) => x.startsWith('bmb_session=')) || cookieLine;
    if (c) {
      if (/HttpOnly/i.test(c)) ok('the session cookie is HttpOnly'); else bad('the session cookie is not HttpOnly', 'Report this.');
      if (/Secure/i.test(c)) ok('the session cookie is Secure'); else bad('the session cookie is not Secure', 'Set NODE_ENV=production on the host.');
    }
  }

  /* ---------- the state the group would see ---------- */
  console.log('\nWhat the group sees');
  const state = await json('/api/state');
  if (state.status !== 200) {
    bad(`/api/state returned ${state.status} when signed in`, 'Report this.');
  } else {
    const s = state.data;
    console.log(`  · group name    ${s.settings?.group_name}`);
    console.log(`  · members       ${s.users?.length}`);
    if (s.users?.length === 1) warn('only one member — nobody else can pick yet', 'Add them under Commissioner → Members.');
    const w = s.current_week?.week;
    if (!w) warn('no week is open', 'Open one under Commissioner, or on the This Week tab.');
    else console.log(`  · week          ${w.week_number} (${w.status}) · ${s.current_week.picks.length} pick(s) in`);

    const q = s.quota;
    if (q) {
      console.log(`  · odds credits  ${q.used_this_month}/${q.local_cap} used this month` +
        (q.provider_remaining !== null && q.provider_remaining !== undefined ? ` · ${q.provider_remaining} left on plan` : ''));
      if (q.cap_warning) warn(q.cap_warning, 'Adjust the cap under Commissioner → Odds API.');
    }
    const ch = s.channels;
    if (ch) {
      const on = [ch.email?.configured && 'email', ch.sms?.configured && 'text'].filter(Boolean);
      if (on.length) ok(`notifications ready: ${on.join(' and ')}`);
      else warn('no email or text configured — weekly reminders cannot send',
        'Optional. The "copy the summons" button works without it.');
    }
  }

  /* ---------- live odds ---------- */
  console.log('\nLive odds');
  const ev = await json('/api/odds/events');
  // The app forwards the upstream failure verbatim, so print it rather than the
  // status code — "401" tells you nothing, "the key was rejected" tells you
  // everything. A 403 here is usually the host's network policy, not the key.
  if (ev.status !== 200) {
    const why = ev.data.error || ev.data._raw || `HTTP ${ev.status}`;
    bad(`the odds feed is not working: ${why}`,
      /allowlist|egress|denied/i.test(why)
        ? "The host is blocking outbound calls to api.the-odds-api.com. Allow it in your host's network settings."
        : /401|rejected|key/i.test(why)
        ? 'The Odds API rejected the key. Set a valid one:  fly secrets set ODDS_API_KEY=your_key'
        : /429|quota/i.test(why)
        ? 'You are out of Odds API credits for the month. Picks can still be entered by hand.'
        : 'Check `fly logs` for the upstream error.');
  } else if (ev.data.error) {
    bad(`the odds feed is not working: ${ev.data.error}`,
      'Set the key on the host:  fly secrets set ODDS_API_KEY=your_key');
  } else if (!ev.data.events?.length) {
    warn('no upcoming games on the board', 'Normal in the offseason or between slates. Picks can still be entered by hand.');
  } else {
    ok(`${ev.data.events.length} upcoming games loaded`, ev.data.cached ? '(from cache — free)' : '(fresh)');
    const next = ev.data.events[0];
    console.log(`  · next          ${next.away_team} @ ${next.home_team}`);
  }

  rule();
  report();
})().catch((err) => {
  console.error(`\n✖ The check itself failed: ${err.message}\n`);
  process.exit(1);
});

function report() {
  console.log('');
  if (!problems.length && !warnings.length) {
    console.log('✅ Everything checks out. Send your friends the link.\n');
    console.log('   One thing this cannot check from outside: whether your data survives a');
    console.log('   redeploy. Confirm the volume is mounted before you trust it with a season —');
    console.log('   see "Confirming the disk is really mounted" in the README.\n');
    return;
  }
  if (problems.length) {
    console.log(`❌ ${problems.length} problem${problems.length === 1 ? '' : 's'} to fix:\n`);
    problems.forEach((p, i) => console.log(`  ${i + 1}. ${p.m}\n     ${p.fix}\n`));
  }
  if (warnings.length) {
    console.log(`⚠️  ${warnings.length} thing${warnings.length === 1 ? '' : 's'} worth knowing:\n`);
    warnings.forEach((w, i) => console.log(`  ${i + 1}. ${w.m}\n     ${w.fix}\n`));
  }
  if (problems.length) process.exitCode = 1;
}
