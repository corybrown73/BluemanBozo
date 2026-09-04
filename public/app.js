/* ============================================================
   Blue Man Bozo — client
   ============================================================ */
'use strict';

/* ---------------- tiny helpers ---------------- */

const esc = (v) =>
  String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

/** Tagged template that escapes every interpolation. Use raw() to opt out. */
function html(strings, ...vals) {
  return strings.reduce((out, str, i) => {
    if (i === 0) return str;
    const v = vals[i - 1];
    const rendered = Array.isArray(v)
      ? v.map((x) => (x && x.__raw ? x.value : esc(x))).join('')
      : v && v.__raw
      ? v.value
      : esc(v);
    return out + rendered + str;
  }, '');
}
const raw = (value) => ({ __raw: true, value });

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const money = (cents) => '$' + ((Number(cents) || 0) / 100).toFixed(2);
const oddsStr = (p) => (Number(p) > 0 ? '+' + p : String(p));
const pct = (n) => Math.round((Number(n) || 0) * 100) + '%';

function fmtKickoff(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function timeUntil(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (isNaN(ms)) return null;
  if (ms <= 0) return 'locked';
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

const RESULT_ICON = { win: '✅', loss: '❌', push: '➖', void: '🚫', pending: '⏳' };

const isYesNo = (p) => p.selection === 'Yes' || p.selection === 'No';

/** "needed 74.5, got 11" reads fine for a line; a TD prop has no line to miss. */
function outcomeText(p) {
  if (isYesNo(p)) {
    if (p.actual_value === null || p.actual_value === undefined) return `${p.market_label} — not graded`;
    return Number(p.actual_value) >= 1 ? `${p.market_label} — it happened` : `${p.market_label} — never happened`;
  }
  const line = p.line === null || p.line === undefined ? '—' : p.line;
  const actual = p.actual_value === null || p.actual_value === undefined ? '—' : p.actual_value;
  return `needed ${line}, got ${actual}`;
}

function describePick(p) {
  if (!p || p.hidden) return '';
  const line = p.line === null || p.line === undefined ? '' : ' ' + p.line;
  return `${p.player} ${p.selection}${line} — ${p.market_label}`;
}

/* ---------------- toasts & modal ---------------- */

function toast(message, kind = 'info', ms = 3800) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, ms);
}

function modal(innerHtml) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal">${innerHtml}</div>`;
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() {
    document.removeEventListener('keydown', onKey);
    back.remove();
  }
  $('#modalRoot').appendChild(back);
  return { el: back, close };
}

function confetti(colors = ['#2563eb', '#3b82f6', '#22d3ee', '#ef4444', '#f59e0b', '#a855f7']) {
  const layer = document.createElement('div');
  layer.className = 'confetti';
  for (let i = 0; i < 90; i++) {
    const bit = document.createElement('i');
    bit.style.left = Math.random() * 100 + '%';
    bit.style.top = -20 - Math.random() * 120 + 'px';
    bit.style.background = colors[Math.floor(Math.random() * colors.length)];
    bit.style.animationDuration = 2.2 + Math.random() * 2.2 + 's';
    bit.style.animationDelay = Math.random() * 0.7 + 's';
    layer.appendChild(bit);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 6000);
}

/* ---------------- api ---------------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Signed out.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

/* ---------------- state ---------------- */

const S = {
  user: null,
  settings: {},
  users: [],
  season: null,
  week: null,        // current week detail
  quota: null,
  channels: null,
  tab: 'week',
  // pick builder
  events: [],
  eventsState: 'idle', // idle | loading | ready | error
  eventsError: null,
  eventsMeta: null,
  selectedEvent: null,
  props: null,
  propsLoading: false,
  propFilter: '',
  selectedProp: null,
  // other views
  leaderboard: null,
  historyRows: null,
  adminData: null,
};

async function loadState() {
  const data = await api('/api/state');
  S.user = data.user;
  S.settings = data.settings || {};
  S.users = data.users || [];
  S.season = data.season;
  S.week = data.current_week;
  S.quota = data.quota;
  S.channels = data.channels;
}

function myPick() {
  if (!S.week) return null;
  return S.week.picks.find((p) => p.user_id === S.user.id) || null;
}

function userById(id) {
  return S.users.find((u) => u.id === id) || null;
}

/* ---------------- tabs / routing ---------------- */

const TABS = [
  { key: 'week', label: 'This Week' },
  { key: 'pick', label: 'Make a Pick' },
  { key: 'vote', label: 'Vote' },
  { key: 'shame', label: 'Hall of Shame' },
  { key: 'history', label: 'History' },
  { key: 'admin', label: 'Commissioner', adminOnly: true },
];

function renderTabs() {
  const needsVote = S.week && S.week.week.voting_open && !S.week.my_vote;
  $('#tabs').innerHTML = TABS.filter((t) => !t.adminOnly || S.user?.is_admin)
    .map(
      (t) => html`<button class="tab ${t.key === S.tab ? 'active' : ''}" data-tab="${t.key}">${t.label}${raw(
        t.key === 'vote' && needsVote ? '<span class="dot"></span>' : ''
      )}</button>`
    )
    .join('');
  $$('#tabs .tab').forEach((btn) =>
    btn.addEventListener('click', () => {
      window.location.hash = btn.dataset.tab;
    })
  );
}

function currentHashTab() {
  const key = (window.location.hash || '').replace('#', '');
  return TABS.some((t) => t.key === key) ? key : 'week';
}

window.addEventListener('hashchange', () => {
  S.tab = currentHashTab();
  render();
});

/* ---------------- shared fragments ---------------- */

function quotaBar() {
  const q = S.quota;
  if (!q) return '';
  if (!q.configured) {
    return html`<div class="quota" title="No Odds API key configured">
      <span>⚠️ Odds API not connected</span>
    </div>`;
  }
  const usedPct = q.local_cap ? Math.min(100, (q.used_this_month / q.local_cap) * 100) : 0;
  return html`<div class="quota" title="Odds API credits used this month (local cap)">
    <span class="bar"><i class="${usedPct > 75 ? 'hot' : ''}" style="width:${raw(usedPct.toFixed(1))}%"></i></span>
    <span>${q.used_this_month}/${q.local_cap} credits${raw(
      q.provider_remaining !== null ? ` · ${esc(q.provider_remaining)} left at the source` : ''
    )}</span>
  </div>`;
}

function statusPill(status) {
  const labels = { open: '🟢 Picks Open', locked: '🔒 Locked', graded: '🗳️ Voting', final: '🤡 Final' };
  return html`<span class="statuspill ${status}">${labels[status] || status}</span>`;
}

function pickRow(p, opts = {}) {
  const isMe = p.user_id === S.user.id;
  const isBozo = opts.bozoUserId === p.user_id;
  if (p.hidden) {
    return html`<div class="pickrow hiddenpick">
      <span class="av">${p.avatar}</span>
      <div class="who"><b>${p.display_name}</b><div class="bet">🔒 Locked in — hidden until kickoff</div></div>
      <div class="num"><span class="badge">In</span></div>
    </div>`;
  }
  return html`<div class="pickrow ${isMe ? 'mine' : ''} ${isBozo ? 'is-bozo' : ''}">
    <span class="av">${p.avatar}</span>
    <div class="who">
      <b>${p.display_name}${raw(isMe ? ' <span class="badge blue">You</span>' : '')}${raw(
        isBozo ? ' <span class="badge loss">Bozo</span>' : ''
      )}</b>
      <div class="bet">${describePick(p)}${raw(
        p.trash_talk ? ` <em class="faint">“${esc(p.trash_talk)}”</em>` : ''
      )}</div>
    </div>
    <div class="num">
      <div class="big">${oddsStr(p.price)}</div>
      <div class="tiny faint">${raw(
        p.actual_value !== null && p.actual_value !== undefined
          ? `${RESULT_ICON[p.result] || ''} actual ${esc(p.actual_value)}`
          : RESULT_ICON[p.result] || ''
      )}</div>
    </div>
  </div>`;
}

function ticket(parlay, week) {
  if (!parlay) {
    return html`<div class="ticket">
      <div class="eyebrow">The Ticket</div>
      <div class="odds">?????</div>
      <p class="muted tiny" style="margin:8px 0 0">Odds appear once picks lock. No peeking.</p>
    </div>`;
  }
  const statusText = { live: '⏳ Live', cashed: '🤑 CASHED', dead: '💀 Dead', empty: 'No legs yet' }[parlay.status];
  return html`<div class="ticket ${parlay.status}">
    <div class="row">
      <div class="eyebrow">The Ticket · Week ${week.week_number}</div>
      <div class="spacer" style="margin-left:auto"></div>
      <span class="badge ${parlay.status === 'cashed' ? 'win' : parlay.status === 'dead' ? 'loss' : 'live'}">${statusText}</span>
    </div>
    <div class="odds" style="margin:10px 0 6px">${parlay.american_display}</div>
    <div class="row tiny muted">
      <span><b>${parlay.leg_count}</b> legs</span>
      <span>·</span>
      <span>${money(parlay.stake_cents)} to win <b>${money(parlay.profit_cents)}</b></span>
      <span>·</span>
      <span>${pct(parlay.implied_probability)} implied</span>
    </div>
  </div>`;
}

/* ============================================================
   VIEW: This Week
   ============================================================ */

function viewWeek() {
  if (!S.week) {
    return html`<div class="card"><div class="empty">
      <div class="big">🏈</div>
      <h2>No week is open yet</h2>
      <p class="muted">${raw(
        S.user.is_admin
          ? 'Head to <b>Commissioner</b> and open Week 1 to get things rolling.'
          : 'Sit tight — the commissioner has not opened a week yet.'
      )}</p>
    </div></div>`;
  }

  const w = S.week.week;
  const mine = myPick();
  const bozo = S.week.bozo;
  const countdown = timeUntil(w.lock_at);

  const parts = [];

  /* --- bozo reveal --- */
  if (bozo) {
    parts.push(html`<div class="bozo-hero card" style="border:1px solid rgba(239,68,68,.4)">
      <div class="nose">🤡</div>
      <div class="eyebrow" style="color:#ff9a9a">Week ${w.week_number} Bozo</div>
      <h2>${bozo.display_name}</h2>
      <div class="muted tiny">crowned by ${raw(
        { vote: 'group vote', 'vote-tiebreak': 'group vote (tiebreak by Bozo Index)', auto: 'the Bozo Index', commissioner: 'commissioner ruling' }[
          bozo.method
        ] || esc(bozo.method)
      )}${raw(bozo.votes_received ? ` · ${esc(bozo.votes_received)} votes` : '')}</div>
      <p class="roast">${bozo.roast}</p>
      <div class="tally">
        <div><b>${bozo.counts.season}</b><span>this season</span></div>
        <div><b>${bozo.counts.all_time}</b><span>all time</span></div>
      </div>
      <div class="row" style="justify-content:center;margin-top:18px">
        <button class="btn sm" id="copySummons">📋 Copy for the group chat</button>
        ${raw(S.user.is_admin ? '<button class="btn sm primary" id="sendSummons">📣 Send the summons</button>' : '')}
        ${raw(
          S.user.is_admin
            ? `<button class="btn sm ghost" id="togglePaid">${bozo.paid ? '✅ Paid' : '💸 Mark paid'}</button>`
            : bozo.paid
            ? '<span class="badge win">Paid up</span>'
            : ''
        )}
      </div>
    </div>`);
  }

  /* --- header --- */
  parts.push(html`<div class="card">
    <div class="card-head">
      <h2>Week ${w.week_number}${raw(w.label ? ` — ${esc(w.label)}` : '')}</h2>
      ${raw(statusPill(w.status))}
      <div class="spacer"></div>
      ${raw(quotaBar())}
    </div>
    <div class="grid two">
      <div>
        ${raw(
          S.week.payer
            ? html`<div class="card tight" style="margin:0 0 12px">
                <div class="eyebrow">Paying for this week's ticket</div>
                <div class="row" style="margin-top:6px">
                  <span style="font-size:26px">${S.week.payer.avatar}</span>
                  <b style="font-size:16px">${S.week.payer.display_name}</b>
                  <span class="badge loss">Last week's bozo</span>
                </div>
                ${raw(
                  S.week.payer.venmo
                    ? html`<div class="tiny faint" style="margin-top:6px">Venmo: ${S.week.payer.venmo}</div>`
                    : ''
                )}
              </div>`
            : html`<div class="card tight" style="margin:0 0 12px">
                <div class="eyebrow">Paying for this week's ticket</div>
                <p class="muted tiny" style="margin:6px 0 0">Nobody assigned yet — crown a bozo and they inherit the bill.</p>
              </div>`
        )}
        <div class="row tiny muted">
          <span>Stake: <b>${money(w.stake_cents)}</b></span>
          ${raw(countdown ? `<span>·</span><span>Locks in <b>${esc(countdown)}</b></span>` : '')}
        </div>
      </div>
      <div>${raw(ticket(S.week.parlay, w))}</div>
    </div>
  </div>`);

  /* --- your pick --- */
  if (w.status === 'open') {
    parts.push(html`<div class="card">
      <div class="card-head"><h2>Your pick</h2><div class="spacer"></div></div>
      ${raw(
        mine
          ? html`<div class="pickrow mine">
                <span class="av">${mine.avatar}</span>
                <div class="who"><b>Locked in</b><div class="bet">${describePick(mine)}</div></div>
                <div class="num"><div class="big">${oddsStr(mine.price)}</div></div>
              </div>
              <div class="row" style="margin-top:12px">
                <a class="btn sm" href="#pick">✏️ Change it</a>
                <button class="btn sm danger" id="deletePick">🗑️ Delete</button>
              </div>`
          : html`<div class="empty" style="padding:26px">
                <div class="big">🎯</div>
                <p class="muted">You have not made a pick yet. The clock is running.</p>
                <a class="btn primary" href="#pick">Make your pick</a>
              </div>`
      )}
    </div>`);
  }

  /* --- the board --- */
  const picks = S.week.picks;
  parts.push(html`<div class="card">
    <div class="card-head">
      <h2>The board</h2>
      <span class="badge">${picks.length} / ${S.users.length} in</span>
      <div class="spacer"></div>
    </div>
    ${raw(
      picks.length
        ? picks.map((p) => pickRow(p, { bozoUserId: bozo?.user_id })).join('')
        : '<div class="empty"><div class="big">🦗</div><p>Nobody has picked yet.</p></div>'
    )}
    ${raw(
      S.week.missing_picks.length
        ? html`<hr class="sep"><div class="tiny faint">Still missing: ${raw(
            S.week.missing_picks.map((m) => `${esc(m.avatar)} ${esc(m.display_name)}`).join(', ')
          )}</div>`
        : ''
    )}
  </div>`);

  /* --- awards --- */
  if (S.week.awards && S.week.awards.length) {
    parts.push(html`<div class="card">
      <div class="card-head"><h2>Week superlatives</h2></div>
      <div class="grid three">
        ${raw(
          S.week.awards
            .map((a) => {
              const u = userById(a.user_id);
              return html`<div class="card tight" style="margin:0">
                <div style="font-size:26px">${a.emoji}</div>
                <b style="font-size:13.5px">${a.title}</b>
                <div class="tiny muted">${raw(u ? `${esc(u.avatar)} ${esc(u.display_name)}` : '')}</div>
                <div class="tiny faint">${a.detail}</div>
              </div>`;
            })
            .join('')
        )}
      </div>
    </div>`);
  }

  return parts.join('');
}

function wireWeek() {
  const copyBtn = $('#copySummons');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        const data = await api(`/api/weeks/${S.week.week.id}/summons`);
        await copyText(data.text);
        toast('Summons copied — go paste it in the chat.', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  const sendBtn = $('#sendSummons');
  if (sendBtn) sendBtn.addEventListener('click', () => openSummonsModal());

  const paidBtn = $('#togglePaid');
  if (paidBtn) {
    paidBtn.addEventListener('click', async () => {
      try {
        S.week = await api(`/api/weeks/${S.week.week.id}/bozo/paid`, {
          method: 'PATCH',
          body: { paid: !S.week.bozo.paid },
        });
        render();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  const del = $('#deletePick');
  if (del) {
    del.addEventListener('click', async () => {
      const mine = myPick();
      if (!mine || !confirm('Delete your pick for this week?')) return;
      try {
        S.week = await api(`/api/picks/${mine.id}`, { method: 'DELETE' });
        toast('Pick deleted.', 'ok');
        render();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  // Fallback for plain-http local testing.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

function openSummonsModal() {
  const m = modal(html`
    <h2 style="font-size:18px;margin-bottom:4px">Send the summons</h2>
    <p class="tiny muted">Email and text the bozo their bad news.</p>
    <div class="checkline"><input type="checkbox" id="chEmail" ${raw(S.channels?.email.configured ? 'checked' : 'disabled')}>
      <label for="chEmail">Email ${raw(S.channels?.email.configured ? '' : '<span class="badge">not configured</span>')}</label></div>
    <div class="checkline"><input type="checkbox" id="chSms" ${raw(S.channels?.sms.configured ? 'checked' : 'disabled')}>
      <label for="chSms">Text message ${raw(S.channels?.sms.configured ? '' : '<span class="badge">not configured</span>')}</label></div>
    <label class="field"><span>Who gets it</span>
      <select id="audience"><option value="bozo">Just the bozo</option><option value="everyone">The whole group</option></select>
    </label>
    <div class="row" style="margin-top:16px">
      <button class="btn primary" id="doSend">Send it</button>
      <button class="btn ghost" id="cancelSend">Cancel</button>
    </div>
    <div id="sendResult" class="tiny" style="margin-top:12px"></div>
  `);

  $('#cancelSend', m.el).addEventListener('click', m.close);
  $('#doSend', m.el).addEventListener('click', async () => {
    const channels = [];
    if ($('#chEmail', m.el).checked) channels.push('email');
    if ($('#chSms', m.el).checked) channels.push('sms');
    if (!channels.length) return toast('Pick at least one channel.', 'err');

    const btn = $('#doSend', m.el);
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const res = await api(`/api/weeks/${S.week.week.id}/notify`, {
        method: 'POST',
        body: { channels, audience: $('#audience', m.el).value },
      });
      $('#sendResult', m.el).innerHTML = res.results
        .map((r) => html`<div>${raw(r.ok ? '✅' : '⚠️')} ${r.user} · ${r.channel}${raw(r.error ? ` — ${esc(r.error)}` : '')}</div>`)
        .join('');
      toast(res.ok ? 'Summons delivered.' : 'Nothing sent — check the details.', res.ok ? 'ok' : 'err');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send it';
    }
  });
}

/* ============================================================
   VIEW: Make a Pick
   ============================================================ */

function viewPick() {
  if (!S.week) {
    return html`<div class="card"><div class="empty"><div class="big">🏈</div><p>No week is open.</p></div></div>`;
  }
  const w = S.week.week;
  if (w.status !== 'open' && !S.user.is_admin) {
    return html`<div class="card"><div class="empty">
      <div class="big">🔒</div><h2>Picks are locked</h2>
      <p class="muted">Week ${w.week_number} is ${w.status}. Nothing to do here but wait.</p>
      <a class="btn" href="#week">Back to the board</a>
    </div></div>`;
  }

  const mine = myPick();

  return html`
    ${raw(
      mine
        ? html`<div class="card tight" style="border-color:rgba(59,130,246,.5)">
            <div class="row">
              <span style="font-size:22px">✏️</span>
              <div style="flex:1;min-width:0">
                <b class="tiny">Replacing your current pick</b>
                <div class="tiny muted">${describePick(mine)} (${oddsStr(mine.price)})</div>
              </div>
            </div>
          </div>`
        : ''
    )}

    <div class="card">
      <div class="card-head">
        <h2>1 · Pick a game</h2>
        <div class="spacer"></div>
        ${raw(quotaBar())}
        <button class="btn sm ghost" id="refreshEvents" title="Reload the slate (free — costs no credits)">↻ Refresh</button>
      </div>
      <p class="tiny faint" style="margin-top:-6px">Browsing games is free. Loading a game's props costs credits, so open only what you need.</p>
      <div id="eventList" class="grid three">${raw(eventListBody())}</div>
    </div>

    ${raw(S.selectedEvent ? propBoard() : '')}

    <div class="card">
      <div class="card-head"><h2>${raw(S.selectedEvent ? '3' : '2')} · Or enter it by hand</h2></div>
      <p class="tiny faint" style="margin-top:-6px">If the book you use has a number the API doesn't, type it in.</p>
      ${raw(manualForm())}
    </div>
  `;
}

function eventListBody() {
  if (S.eventsState === 'loading' || S.eventsState === 'idle') {
    return '<div class="empty" style="grid-column:1/-1"><div class="spinner"></div></div>';
  }
  if (S.eventsState === 'error') {
    return html`<div class="empty" style="grid-column:1/-1">
      <div class="big">📡</div>
      <p class="muted">Could not reach the Odds API.</p>
      <p class="tiny faint">${S.eventsError}</p>
      <button class="btn sm" id="retryEvents">Try again</button>
      <p class="tiny faint" style="margin-top:10px">You can still enter a pick by hand below.</p>
    </div>`;
  }
  if (!S.events.length) {
    return html`<div class="empty" style="grid-column:1/-1">
      <div class="big">🏝️</div>
      <p class="muted">No upcoming NFL games on the board.</p>
      <p class="tiny faint">Offseason, or the slate hasn't posted yet. Enter a pick by hand below.</p>
    </div>`;
  }
  return S.events
    .map(
      (e) => html`<button class="gamecard ${S.selectedEvent?.id === e.id ? 'selected' : ''}" data-event="${e.id}">
        <div class="teams">${e.away_team} @ ${e.home_team}</div>
        <div class="when">${fmtKickoff(e.commence_time)}</div>
      </button>`
    )
    .join('');
}

function propBoard() {
  const ev = S.selectedEvent;
  if (S.propsLoading) {
    return html`<div class="card"><div class="card-head"><h2>2 · Pick a player prop</h2></div>
      <div class="empty"><div class="spinner"></div><p class="tiny faint" style="margin-top:10px">Pulling the board…</p></div></div>`;
  }
  if (!S.props) {
    return html`<div class="card">
      <div class="card-head"><h2>2 · Pick a player prop</h2></div>
      <div class="empty">
        <div class="big">📉</div>
        <p class="muted">No props loaded for ${esc(ev.away_team)} @ ${esc(ev.home_team)}.</p>
        <button class="btn primary" id="loadProps">Load the board</button>
      </div>
    </div>`;
  }

  const filter = S.propFilter.trim().toLowerCase();
  const rows = S.props.props.filter(
    (p) => !filter || p.player.toLowerCase().includes(filter) || p.market_label.toLowerCase().includes(filter)
  );

  const byGroup = {};
  for (const p of rows) (byGroup[p.market_label] = byGroup[p.market_label] || []).push(p);

  const cacheNote = S.props.cached
    ? `cached${S.props.fetched_at ? ' ' + fmtKickoff(S.props.fetched_at) : ''} — free`
    : `fresh — cost ${S.props.cost} credit${S.props.cost === 1 ? '' : 's'}`;

  return html`<div class="card">
    <div class="card-head">
      <h2>2 · Pick a player prop</h2>
      <span class="badge">${ev.away_team} @ ${ev.home_team}</span>
      <div class="spacer"></div>
      <span class="tiny faint">${cacheNote}</span>
      ${raw(S.user.is_admin ? '<button class="btn sm ghost" id="forceProps" title="Bypass the cache — costs credits">↻ Force</button>' : '')}
    </div>
    <input id="propFilter" placeholder="Filter by player or market…" value="${S.propFilter}" style="margin-bottom:12px">
    ${raw(
      rows.length
        ? Object.entries(byGroup)
            .map(
              ([label, list]) => html`<div style="margin-bottom:16px">
                <div class="eyebrow" style="margin-bottom:7px">${label}</div>
                ${raw(
                  list
                    .map((p, i) => {
                      const idx = S.props.props.indexOf(p);
                      const sel = S.selectedProp === idx;
                      return html`<button class="proprow ${sel ? 'selected' : ''}" data-prop="${idx}">
                        <div class="pname">
                          <b>${p.player}</b>
                          <small>${p.selection}${raw(p.line !== null && p.line !== undefined ? ' ' + esc(p.line) : '')} · ${p.bookmaker}${raw(
                            p.book_count > 1 ? ` +${esc(p.book_count - 1)} more` : ''
                          )}</small>
                        </div>
                        <div class="pline">${raw(p.line !== null && p.line !== undefined ? esc(p.line) : '—')}</div>
                        <div class="pprice">${oddsStr(p.price)}</div>
                      </button>`;
                    })
                    .join('')
                )}
              </div>`
            )
            .join('')
        : '<div class="empty"><p class="muted">Nothing matches that filter.</p></div>'
    )}
    ${raw(
      S.selectedProp !== null && S.props.props[S.selectedProp]
        ? html`<hr class="sep">
          <label class="field"><span>Trash talk (optional, shown on the board)</span>
            <input id="trashTalk" maxlength="280" placeholder="Free money. Book it."></label>
          <button class="btn primary block" id="submitProp">
            Lock in ${describeProp(S.props.props[S.selectedProp])}
          </button>`
        : ''
    )}
  </div>`;
}

function describeProp(p) {
  const line = p.line === null || p.line === undefined ? '' : ' ' + p.line;
  return `${p.player} ${p.selection}${line} (${oddsStr(p.price)})`;
}

function manualForm() {
  return html`<div class="grid two">
    <label class="field"><span>Player</span><input id="mPlayer" placeholder="Ja'Marr Chase"></label>
    <label class="field"><span>Market</span>
      <select id="mMarket">${raw(
        (S.marketCatalog || [])
          .map((m) => html`<option value="${m.key}" data-type="${m.type}">${m.label}</option>`)
          .join('')
      )}</select>
    </label>
    <label class="field"><span>Side</span>
      <select id="mSide"><option>Over</option><option>Under</option><option>Yes</option><option>No</option></select>
    </label>
    <label class="field"><span>Line <span class="faint">(blank for Anytime TD)</span></span><input id="mLine" type="number" step="0.5" placeholder="74.5"></label>
    <label class="field"><span>American odds</span><input id="mPrice" type="number" step="5" placeholder="-110"></label>
    <label class="field"><span>Book</span><input id="mBook" placeholder="DraftKings"></label>
  </div>
  <label class="field"><span>Trash talk (optional)</span><input id="mTrash" maxlength="280" placeholder="Lock of the century."></label>
  <button class="btn primary block" id="submitManual">Lock in my pick</button>`;
}

async function loadEvents(force = false, { rerender = false } = {}) {
  S.eventsState = 'loading';
  S.eventsError = null;
  if (rerender) render();
  try {
    const data = await api('/api/odds/events' + (force ? '?force=1' : ''));
    S.events = data.events || [];
    S.eventsMeta = data;
    S.quota = data.quota || S.quota;
    S.eventsState = 'ready';
    if (data.error) {
      S.eventsError = data.error;
      toast(data.error, 'err', 6000);
    }
  } catch (err) {
    S.events = [];
    S.eventsState = 'error';
    S.eventsError = err.message;
  }
  if (rerender || S.tab === 'pick') render();
}

async function loadProps(force = false) {
  if (!S.selectedEvent) return;
  S.propsLoading = true;
  S.props = null;
  S.selectedProp = null;
  render();
  try {
    const data = await api(`/api/odds/events/${S.selectedEvent.id}/props` + (force ? '?force=1' : ''));
    S.props = data;
    S.quota = data.quota || S.quota;
    if (data.error) toast(data.error, 'err', 6000);
    else if (!data.cached) toast(`Board loaded — ${data.cost} credits used.`, 'info');
  } catch (err) {
    toast(err.message, 'err', 7000);
  } finally {
    S.propsLoading = false;
    render();
  }
}

async function submitPick(body) {
  try {
    S.week = await api(`/api/weeks/${S.week.week.id}/picks`, {
      method: 'POST',
      body: { ...body, pick_id: myPick()?.id },
    });
    toast('Locked in. Good luck, you will need it.', 'ok');
    window.location.hash = 'week';
  } catch (err) {
    toast(err.message, 'err', 6000);
  }
}

function wirePick() {
  // The slate is free to fetch, so load it the first time this tab is opened.
  if (S.eventsState === 'idle') loadEvents(false, { rerender: false });

  const retry = $('#retryEvents');
  if (retry) retry.addEventListener('click', () => loadEvents(false, { rerender: true }));

  const refresh = $('#refreshEvents');
  if (refresh) {
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      await loadEvents(S.user.is_admin, { rerender: true });
    });
  }

  $$('#eventList [data-event]').forEach((btn) =>
    btn.addEventListener('click', () => {
      S.selectedEvent = S.events.find((e) => e.id === btn.dataset.event) || null;
      S.props = null;
      S.selectedProp = null;
      S.propFilter = '';
      render();
      loadProps(false);
    })
  );

  const loadBtn = $('#loadProps');
  if (loadBtn) loadBtn.addEventListener('click', () => loadProps(false));

  const forceBtn = $('#forceProps');
  if (forceBtn) forceBtn.addEventListener('click', () => loadProps(true));

  const filter = $('#propFilter');
  if (filter) {
    filter.addEventListener('input', () => {
      S.propFilter = filter.value;
      const pos = filter.selectionStart;
      render();
      const again = $('#propFilter');
      if (again) {
        again.focus();
        again.setSelectionRange(pos, pos);
      }
    });
  }

  $$('[data-prop]').forEach((btn) =>
    btn.addEventListener('click', () => {
      S.selectedProp = Number(btn.dataset.prop);
      render();
    })
  );

  const submitProp = $('#submitProp');
  if (submitProp) {
    submitProp.addEventListener('click', () => {
      const p = S.props.props[S.selectedProp];
      submitPick({
        event_id: S.selectedEvent.id,
        home_team: S.selectedEvent.home_team,
        away_team: S.selectedEvent.away_team,
        commence_time: S.selectedEvent.commence_time,
        player: p.player,
        market: p.market,
        market_label: p.market_label,
        selection: p.selection,
        line: p.line,
        price: p.price,
        bookmaker: p.bookmaker,
        trash_talk: $('#trashTalk')?.value || '',
      });
    });
  }

  const submitManual = $('#submitManual');
  if (submitManual) {
    submitManual.addEventListener('click', () => {
      const marketSel = $('#mMarket');
      const marketKey = marketSel.value;
      const marketLabel = marketSel.options[marketSel.selectedIndex].textContent;
      const lineRaw = $('#mLine').value;
      submitPick({
        player: $('#mPlayer').value.trim(),
        market: marketKey,
        market_label: marketLabel,
        selection: $('#mSide').value,
        line: lineRaw === '' ? null : Number(lineRaw),
        price: Number($('#mPrice').value),
        bookmaker: $('#mBook').value.trim(),
        trash_talk: $('#mTrash').value,
      });
    });
  }
}

/* ============================================================
   VIEW: Vote
   ============================================================ */

function viewVote() {
  if (!S.week) return html`<div class="card"><div class="empty"><div class="big">🗳️</div><p>No week open.</p></div></div>`;
  const w = S.week.week;

  if (w.status === 'final') {
    return html`<div class="card"><div class="empty">
      <div class="big">🤡</div><h2>The votes are counted</h2>
      <p class="muted">${raw(S.week.bozo ? `${esc(S.week.bozo.display_name)} is the Week ${esc(w.week_number)} bozo.` : '')}</p>
      <a class="btn primary" href="#week">See the damage</a>
    </div></div>`;
  }
  if (!w.voting_open) {
    return html`<div class="card"><div class="empty">
      <div class="big">⏳</div><h2>Voting is not open yet</h2>
      <p class="muted">Once the commissioner enters the stat lines, you get to point fingers.</p>
    </div></div>`;
  }

  const cands = S.week.candidates;
  const maxScore = Math.max(1, ...cands.map((c) => c.bozo_score || 0));
  const myVote = S.week.my_vote;
  const totalVotes = S.week.vote_tally.reduce((n, t) => n + t.count, 0);

  return html`
    <div class="card">
      <div class="card-head">
        <h2>Who's the Week ${w.week_number} bozo?</h2>
        <div class="spacer"></div>
        <span class="badge">${totalVotes} / ${S.users.length} voted</span>
      </div>
      <p class="tiny faint" style="margin-top:-6px">
        The <b>Bozo Index</b> ranks each loss by how badly the number was missed (65%) and how safe the bet was
        supposed to be (35%). It is a suggestion. You are the jury.
      </p>

      ${raw(
        cands.length
          ? html`<div class="grid two" style="margin-top:14px">${raw(
              cands
                .map(
                  (c) => html`<button class="votecard ${myVote?.nominee_id === c.user_id ? 'voted' : ''}" data-vote="${c.user_id}">
                    ${raw(c.votes ? `<span class="votecount">${esc(c.votes)}</span>` : '')}
                    <div class="head">
                      <span class="av">${c.avatar}</span>
                      <div><b>${c.display_name}</b>
                        <div class="tiny faint">${raw(myVote?.nominee_id === c.user_id ? 'your vote' : '&nbsp;')}</div>
                      </div>
                    </div>
                    <div class="bet">${c.player} ${c.selection}${raw(
                      c.line !== null && c.line !== undefined ? ' ' + esc(c.line) : ''
                    )} — ${c.market_label} <span class="mono">${oddsStr(c.price)}</span></div>
                    <div class="row tiny" style="justify-content:space-between">
                      <span class="muted">${outcomeText(c)}</span>
                      <span class="mono" style="font-weight:900">${c.bozo_score}</span>
                    </div>
                    <div class="meter"><i style="width:${raw((((c.bozo_score || 0) / maxScore) * 100).toFixed(1))}%"></i></div>
                    <div class="row tiny faint" style="justify-content:space-between">
                      <span>missed by ${c.miss_percent}%</span>
                      <span>${pct(c.implied_probability)} implied</span>
                    </div>
                  </button>`
                )
                .join('')
            )}</div>`
          : '<div class="empty"><div class="big">😇</div><h2>Nobody lost.</h2><p class="muted">A perfect week. Deeply suspicious.</p></div>'
      )}

      ${raw(
        cands.length
          ? html`<hr class="sep">
            <div class="row">
              <span class="tiny faint">Prefer to nominate someone who isn't listed?</span>
              <select id="voteOther" style="width:auto;min-width:190px">
                <option value="">Pick a member…</option>
                ${raw(
                  S.users
                    .filter((u) => u.id !== S.user.id || S.settings.allow_self_vote)
                    .map((u) => html`<option value="${u.id}">${u.avatar} ${u.display_name}</option>`)
                    .join('')
                )}
              </select>
              <button class="btn sm" id="voteOtherBtn">Vote</button>
              ${raw(myVote ? '<button class="btn sm ghost" id="clearVote">Retract my vote</button>' : '')}
            </div>`
          : ''
      )}
    </div>

    ${raw(
      S.week.votes.length
        ? html`<div class="card">
            <div class="card-head"><h2>Who voted for whom</h2></div>
            ${raw(
              S.week.votes
                .map(
                  (v) => html`<div class="pickrow">
                    <span class="av">${v.voter_avatar}</span>
                    <div class="who"><b>${v.voter_name} → ${v.nominee_name}</b>
                      ${raw(v.reason ? `<div class="bet">“${esc(v.reason)}”</div>` : '')}
                    </div>
                  </div>`
                )
                .join('')
            )}
          </div>`
        : ''
    )}

    ${raw(
      S.user.is_admin && cands.length
        ? html`<div class="card">
            <div class="card-head"><h2>Commissioner</h2></div>
            <p class="tiny muted">Close voting and crown the bozo. The winner inherits next week's bill.</p>
            <div class="row">
              <button class="btn danger" id="crownBozo">👑 Crown the bozo</button>
              <span class="tiny faint">Uses the vote leader; ties break by Bozo Index.</span>
            </div>
          </div>`
        : ''
    )}
  `;
}

function wireVote() {
  $$('[data-vote]').forEach((btn) =>
    btn.addEventListener('click', () => castVote(Number(btn.dataset.vote)))
  );

  const otherBtn = $('#voteOtherBtn');
  if (otherBtn) {
    otherBtn.addEventListener('click', () => {
      const id = Number($('#voteOther').value);
      if (!id) return toast('Choose someone first.', 'err');
      castVote(id);
    });
  }

  const clear = $('#clearVote');
  if (clear) {
    clear.addEventListener('click', async () => {
      try {
        S.week = await api(`/api/weeks/${S.week.week.id}/vote`, { method: 'DELETE' });
        toast('Vote retracted.', 'ok');
        render();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  const crown = $('#crownBozo');
  if (crown) {
    crown.addEventListener('click', async () => {
      if (!confirm('Crown the bozo and close the week? This assigns next week\'s bill.')) return;
      try {
        S.week = await api(`/api/weeks/${S.week.week.id}/bozo`, { method: 'POST', body: {} });
        confetti(['#ef4444', '#f59e0b', '#ffffff']);
        toast('The bozo has been crowned.', 'ok');
        window.location.hash = 'week';
      } catch (err) {
        toast(err.message, 'err', 6000);
      }
    });
  }
}

async function castVote(nomineeId) {
  const reason = prompt('Why them? (optional — this gets shown to everyone)') ?? '';
  try {
    S.week = await api(`/api/weeks/${S.week.week.id}/vote`, {
      method: 'POST',
      body: { nominee_id: nomineeId, reason },
    });
    toast('Vote cast.', 'ok');
    render();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ============================================================
   VIEW: Hall of Shame
   ============================================================ */

function viewShame() {
  if (!S.leaderboard) {
    loadLeaderboard();
    return html`<div class="card"><div class="spinner"></div></div>`;
  }
  const { rows, season } = S.leaderboard;
  const maxAll = Math.max(1, ...rows.map((r) => r.bozos_all_time));

  return html`
    <div class="card">
      <div class="card-head">
        <h2>🏆 Hall of Shame</h2>
        <span class="badge">${season.label}</span>
        <div class="spacer"></div>
      </div>
      <div style="overflow-x:auto">
      <table class="lb">
        <thead><tr>
          <th></th><th>Member</th><th>Season</th><th>All time</th>
          <th class="hide-sm">Record</th><th class="hide-sm">Rate</th><th class="hide-sm">Title</th>
        </tr></thead>
        <tbody>${raw(
          rows
            .map(
              (r, i) => html`<tr class="${i === 0 && r.bozos_season > 0 ? 'top' : ''}">
                <td class="rank">${raw(i === 0 && r.bozos_season > 0 ? '🤡' : '#' + (i + 1))}</td>
                <td>
                  <div class="person">
                    <span class="av">${r.user.avatar}</span>
                    <div>
                      <b>${r.user.display_name}</b>
                      <small>${raw('🤡'.repeat(Math.min(r.bozos_all_time, 10)) || '—')}</small>
                    </div>
                  </div>
                </td>
                <td><span class="count ${r.bozos_season > 0 ? 'hot' : ''}">${r.bozos_season}</span></td>
                <td><span class="count">${r.bozos_all_time}</span>
                  <div class="meter small" style="width:60px"><i style="width:${raw(
                    ((r.bozos_all_time / maxAll) * 100).toFixed(0)
                  )}%"></i></div>
                </td>
                <td class="hide-sm mono tiny">${r.record.wins}-${r.record.losses}${raw(
                  r.record.pushes ? `-${esc(r.record.pushes)}` : ''
                )}<div class="faint">${pct(r.record.win_pct)}</div></td>
                <td class="hide-sm mono tiny">${raw((r.bozo_rate * 100).toFixed(0))}%<div class="faint">of weeks</div></td>
                <td class="hide-sm tiny"><b>${r.title.title}</b><div class="faint">${r.title.blurb}</div></td>
              </tr>`
            )
            .join('')
        )}</tbody>
      </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>💀 Worst picks ever recorded</h2></div>
      ${raw(
        rows.filter((r) => r.worst_pick).length
          ? rows
              .filter((r) => r.worst_pick)
              .sort((a, b) => b.worst_pick.bozo_score - a.worst_pick.bozo_score)
              .slice(0, 8)
              .map(
                (r) => html`<div class="pickrow">
                  <span class="av">${r.user.avatar}</span>
                  <div class="who">
                    <b>${r.user.display_name} <span class="faint tiny">· ${r.worst_pick.year} Wk ${r.worst_pick.week_number}</span></b>
                    <div class="bet">${r.worst_pick.player} ${r.worst_pick.selection}${raw(
                      r.worst_pick.line !== null && r.worst_pick.line !== undefined ? ' ' + esc(r.worst_pick.line) : ''
                    )} — ${outcomeText(r.worst_pick)}</div>
                  </div>
                  <div class="num">
                    <div class="big">${r.worst_pick.bozo_score}</div>
                    <div class="tiny faint">missed ${r.worst_pick.miss_percent}%</div>
                  </div>
                </div>`
              )
              .join('')
          : '<div class="empty"><p class="muted">No graded losses yet. Give it a week.</p></div>'
      )}
    </div>

    <div class="card">
      <div class="card-head"><h2>🔥 Streaks</h2></div>
      <div class="grid three">${raw(
        rows
          .filter((r) => r.streak.longest > 0)
          .sort((a, b) => b.streak.longest - a.streak.longest)
          .map(
            (r) => html`<div class="card tight" style="margin:0">
              <div class="row"><span style="font-size:22px">${r.user.avatar}</span><b class="tiny">${r.user.display_name}</b></div>
              <div class="row tiny muted" style="margin-top:6px">
                <span>current <b class="mono">${r.streak.current}</b></span>
                <span>·</span>
                <span>longest <b class="mono">${r.streak.longest}</b></span>
              </div>
            </div>`
          )
          .join('') || '<p class="muted tiny">No streaks yet.</p>'
      )}</div>
    </div>
  `;
}

async function loadLeaderboard() {
  try {
    S.leaderboard = await api('/api/leaderboard');
    render();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ============================================================
   VIEW: History
   ============================================================ */

function viewHistory() {
  if (!S.historyRows) {
    loadHistory();
    return html`<div class="card"><div class="spinner"></div></div>`;
  }
  if (!S.historyRows.length) {
    return html`<div class="card"><div class="empty"><div class="big">📜</div><p>No weeks recorded yet.</p></div></div>`;
  }

  return html`<div class="card">
    <div class="card-head"><h2>📜 Season history</h2></div>
    ${raw(
      S.historyRows
        .map(
          (w) => html`<div class="pickrow" style="cursor:pointer" data-week="${w.id}">
            <span class="av">${raw(w.bozo_avatar || '⏳')}</span>
            <div class="who">
              <b>${w.year} · Week ${w.week_number} ${raw(
                w.bozo_name ? `— <span style="color:#ff9a9a">${esc(w.bozo_name)}</span>` : '<span class="faint">in progress</span>'
              )}</b>
              <div class="bet">${raw(w.roast ? esc(w.roast) : `${esc(w.pick_count)} picks · ${esc(w.win_count)}W-${esc(w.loss_count)}L`)}</div>
            </div>
            <div class="num">
              <div class="tiny faint">${money(w.stake_cents)}</div>
              ${raw(w.paid ? '<span class="badge win">paid</span>' : w.bozo_name ? '<span class="badge loss">owes</span>' : '')}
            </div>
          </div>`
        )
        .join('')
    )}
  </div>`;
}

async function loadHistory() {
  try {
    const data = await api('/api/weeks');
    S.historyRows = data.weeks;
    render();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function wireHistory() {
  $$('[data-week]').forEach((row) =>
    row.addEventListener('click', async () => {
      try {
        const detail = await api(`/api/weeks/${row.dataset.week}`);
        showWeekModal(detail);
      } catch (err) {
        toast(err.message, 'err');
      }
    })
  );
}

function showWeekModal(detail) {
  const w = detail.week;
  modal(html`
    <div class="card-head"><h2>${w.season_year} · Week ${w.week_number}</h2>${raw(statusPill(w.status))}</div>
    ${raw(
      detail.bozo
        ? html`<div class="card tight" style="border-color:rgba(239,68,68,.4);margin-bottom:14px">
            <div class="row"><span style="font-size:26px">🤡</span><b>${detail.bozo.display_name}</b></div>
            <p class="tiny muted" style="margin:8px 0 0;font-style:italic">${detail.bozo.roast}</p>
          </div>`
        : ''
    )}
    ${raw(detail.picks.map((p) => pickRow(p, { bozoUserId: detail.bozo?.user_id })).join(''))}
    ${raw(detail.parlay ? ticket(detail.parlay, w) : '')}
  `);
}

/* ============================================================
   VIEW: Commissioner
   ============================================================ */

function viewAdmin() {
  if (!S.user.is_admin) return html`<div class="card"><div class="empty"><div class="big">🚫</div><p>Commissioners only.</p></div></div>`;
  if (!S.adminData) {
    loadAdmin();
    return html`<div class="card"><div class="spinner"></div></div>`;
  }

  const { settings, users, usage, key } = S.adminData;
  const w = S.week?.week;

  return html`
    <div class="card">
      <div class="card-head"><h2>⚙️ Week control</h2><div class="spacer"></div>${raw(w ? statusPill(w.status) : '')}</div>
      ${raw(
        w
          ? html`<div class="row" style="margin-bottom:14px">
              <b>Week ${w.week_number}</b>
              <span class="tiny faint">${S.week.picks.length} picks in</span>
              <div class="spacer" style="margin-left:auto"></div>
              ${raw(
                w.status === 'open'
                  ? '<button class="btn sm" data-status="locked">🔒 Lock picks</button>'
                  : w.status === 'locked'
                  ? '<span class="tiny faint">Enter stat lines below to open voting</span>'
                  : w.status === 'graded'
                  ? '<a class="btn sm primary" href="#vote">🗳️ Go to voting</a>'
                  : '<button class="btn sm ghost" data-status="graded">↩︎ Reopen voting</button>'
              )}
            </div>
            <div class="grid three">
              <label class="field"><span>Stake ($)</span>
                <input id="wStake" type="number" step="1" min="0" value="${raw((w.stake_cents / 100).toFixed(2))}"></label>
              <label class="field"><span>Auto-lock at</span>
                <input id="wLock" type="datetime-local" value="${raw(toLocalInput(w.lock_at))}"></label>
              <label class="field"><span>Label</span><input id="wLabel" value="${raw(w.label || '')}" placeholder="Divisional round"></label>
            </div>
            <button class="btn sm" id="saveWeek">Save week settings</button>`
          : '<p class="muted tiny">No week open.</p>'
      )}
      <hr class="sep">
      <div class="row">
        <button class="btn primary" id="newWeek">➕ Open the next week</button>
        <span class="tiny faint">Last week's bozo is auto-assigned as the payer.</span>
      </div>
    </div>

    ${raw(w && (w.status === 'locked' || w.status === 'graded' || w.status === 'final') ? gradePanel() : '')}

    <div class="card">
      <div class="card-head"><h2>👥 Members</h2><div class="spacer"></div>
        <button class="btn sm primary" id="addMember">➕ Add member</button></div>
      ${raw(
        users
          .map(
            (u) => html`<div class="pickrow ${u.is_active ? '' : 'hiddenpick'}">
              <span class="av">${u.avatar}</span>
              <div class="who">
                <b>${u.display_name} <span class="faint tiny">@${u.username}</span>${raw(
                  u.is_admin ? ' <span class="badge blue">commissioner</span>' : ''
                )}${raw(u.is_active ? '' : ' <span class="badge">inactive</span>')}</b>
                <div class="bet tiny">${raw(u.email ? esc(u.email) : '<span class="faint">no email</span>')} · ${raw(
                  u.phone ? esc(u.phone) : '<span class="faint">no phone</span>'
                )}</div>
              </div>
              <div class="num"><button class="btn sm ghost" data-edit-user="${u.id}">Edit</button></div>
            </div>`
          )
          .join('')
      )}
    </div>

    <div class="card">
      <div class="card-head"><h2>📡 Odds API</h2><div class="spacer"></div>${raw(quotaBar())}</div>
      <div class="grid two">
        <div>
          <p class="tiny muted">Key status: <b>${raw(
            key.set ? `connected (from ${esc(key.source)})` : '<span style="color:#ff9a9a">not configured</span>'
          )}</b></p>
          <label class="field"><span>Monthly credit cap</span>
            <input id="sCap" type="number" min="0" value="${settings.monthly_credit_cap}"></label>
          <p class="tiny faint" style="margin-top:-6px">The app refuses paid calls past this. The free tier is 500/month.</p>
          <label class="field"><span>Props cache (minutes)</span>
            <input id="sCache" type="number" min="1" value="${settings.props_cache_minutes}"></label>
          <p class="tiny faint" style="margin-top:-6px">Longer cache = fewer credits. One fetch serves everybody.</p>
        </div>
        <div>
          <span class="eyebrow">Prop markets to load</span>
          <p class="tiny faint">Each market costs 1 credit per game loaded. Keep this tight.</p>
          <div style="max-height:230px;overflow-y:auto;padding-right:6px;margin-top:8px">
            ${raw(
              (S.marketCatalog || [])
                .map(
                  (m) => html`<div class="checkline">
                    <input type="checkbox" class="mkt" value="${m.key}" ${raw(
                    settings.odds_markets.split(',').includes(m.key) ? 'checked' : ''
                  )}>
                    <label>${m.label} <span class="faint tiny">${m.group}</span></label>
                  </div>`
                )
                .join('')
            )}
          </div>
        </div>
      </div>
      <div class="row" style="margin-top:6px">
        <button class="btn primary" id="saveOdds">Save API settings</button>
        <button class="btn ghost" id="clearCache">🗑️ Clear odds cache</button>
      </div>
      ${raw(
        usage.by_endpoint.length
          ? html`<hr class="sep"><div class="eyebrow">Credit spend</div>
            ${raw(
              usage.by_endpoint
                .map(
                  (r) => html`<div class="row tiny muted" style="justify-content:space-between;padding:4px 0">
                    <span>${r.month} · ${r.endpoint}</span><span class="mono">${r.credits} credits / ${r.calls} calls</span>
                  </div>`
                )
                .join('')
            )}`
          : ''
      )}
    </div>

    <div class="card">
      <div class="card-head"><h2>🎛️ Group settings</h2></div>
      <div class="grid two">
        <label class="field"><span>Group name</span><input id="sGroup" value="${settings.group_name}"></label>
        <label class="field"><span>Site URL (used in messages)</span>
          <input id="sSite" value="${raw(settings.site_url || '')}" placeholder="https://www.bluemanbozo.com"></label>
        <label class="field"><span>Picks per person per week</span>
          <input id="sPicks" type="number" min="1" max="10" value="${settings.picks_per_user}"></label>
        <label class="field"><span>Default stake ($)</span>
          <input id="sStake" type="number" min="0" value="${raw((Number(settings.default_stake_cents) / 100).toFixed(2))}"></label>
      </div>
      <div class="checkline"><input type="checkbox" id="sHide" ${raw(settings.hide_picks_until_lock === '1' ? 'checked' : '')}>
        <label for="sHide">Hide everyone's picks until the week locks</label></div>
      <div class="checkline"><input type="checkbox" id="sSelf" ${raw(settings.allow_self_vote === '1' ? 'checked' : '')}>
        <label for="sSelf">Allow voting for yourself</label></div>
      <button class="btn primary" id="saveGroup">Save group settings</button>
    </div>

    <div class="card">
      <div class="card-head"><h2>📬 Notifications</h2></div>
      <p class="tiny muted">Email: <b>${raw(S.channels.email.configured ? 'ready' : 'not configured')}</b> ·
         SMS: <b>${raw(S.channels.sms.configured ? 'ready' : 'not configured')}</b></p>
      <p class="tiny faint">Configured with environment variables (SMTP_* and TWILIO_*). See the README.</p>
      <div class="row">
        <input id="testTarget" placeholder="you@example.com or +15551234567" style="max-width:280px">
        <select id="testChannel" style="width:auto"><option value="email">Email</option><option value="sms">SMS</option></select>
        <button class="btn sm" id="sendTest">Send test</button>
      </div>
    </div>
  `;
}

function gradePanel() {
  const picks = S.week.picks;
  return html`<div class="card">
    <div class="card-head"><h2>📋 Enter the stat lines</h2><div class="spacer"></div>
      <span class="tiny faint">Results are computed from the numbers — no manual W/L</span></div>
    ${raw(
      picks
        .map(
          (p) => html`<div class="pickrow">
            <span class="av">${p.avatar}</span>
            <div class="who">
              <b>${p.display_name}</b>
              <div class="bet">${describePick(p)} <span class="mono">${oddsStr(p.price)}</span></div>
            </div>
            <div class="num" style="display:flex;gap:6px;align-items:center">
              <input class="statline" data-pick="${p.id}" type="number" step="any"
                     value="${raw(p.actual_value ?? '')}" placeholder="actual"
                     style="width:96px;text-align:right">
              <span class="badge ${p.result}">${raw(RESULT_ICON[p.result] || '')} ${p.result}</span>
            </div>
          </div>`
        )
        .join('')
    )}
    <div class="row" style="margin-top:12px">
      <button class="btn primary" id="saveGrades">Save & compute results</button>
      <span class="tiny faint">Leave a box blank to keep it pending. All settled → voting opens.</span>
    </div>
  </div>`;
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function loadAdmin() {
  try {
    const [settingsRes, usersRes, usageRes] = await Promise.all([
      api('/api/admin/settings'),
      api('/api/admin/users'),
      api('/api/admin/usage'),
    ]);
    S.marketCatalog = settingsRes.available_markets;
    S.adminData = {
      settings: settingsRes.settings,
      users: usersRes.users,
      usage: usageRes,
      key: { set: settingsRes.odds_api_key_set, source: settingsRes.odds_api_key_source },
    };
    S.quota = settingsRes.quota;
    S.channels = settingsRes.channels;
    render();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function saveSettings(patch, successMsg) {
  try {
    await api('/api/admin/settings', { method: 'PATCH', body: patch });
    toast(successMsg || 'Saved.', 'ok');
    S.adminData = null;
    await loadState();
    render();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function wireAdmin() {
  $$('[data-status]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        S.week = await api(`/api/weeks/${S.week.week.id}`, { method: 'PATCH', body: { status: btn.dataset.status } });
        toast(`Week is now ${btn.dataset.status}.`, 'ok');
        S.adminData = null;
        render();
      } catch (err) {
        toast(err.message, 'err');
      }
    })
  );

  const saveWeek = $('#saveWeek');
  if (saveWeek) {
    saveWeek.addEventListener('click', async () => {
      try {
        const lockVal = $('#wLock').value;
        S.week = await api(`/api/weeks/${S.week.week.id}`, {
          method: 'PATCH',
          body: {
            stake_cents: Math.round(Number($('#wStake').value) * 100),
            lock_at: lockVal ? new Date(lockVal).toISOString() : null,
            label: $('#wLabel').value,
          },
        });
        toast('Week updated.', 'ok');
        render();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  const newWeek = $('#newWeek');
  if (newWeek) {
    newWeek.addEventListener('click', async () => {
      try {
        await api('/api/weeks', { method: 'POST', body: {} });
        toast('New week opened.', 'ok');
        S.adminData = null;
        S.historyRows = null;
        await loadState();
        window.location.hash = 'week';
        render();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  const saveGrades = $('#saveGrades');
  if (saveGrades) {
    saveGrades.addEventListener('click', async () => {
      const results = $$('.statline').map((input) => ({
        pick_id: Number(input.dataset.pick),
        actual_value: input.value,
      }));
      try {
        S.week = await api(`/api/weeks/${S.week.week.id}/grade`, { method: 'POST', body: { results } });
        toast('Results computed.', 'ok');
        S.leaderboard = null;
        render();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  const saveOdds = $('#saveOdds');
  if (saveOdds) {
    saveOdds.addEventListener('click', () => {
      const markets = $$('.mkt:checked').map((c) => c.value);
      if (!markets.length) return toast('Enable at least one market.', 'err');
      saveSettings(
        {
          monthly_credit_cap: $('#sCap').value,
          props_cache_minutes: $('#sCache').value,
          odds_markets: markets.join(','),
        },
        `Saved. Each game now costs ${markets.length} credit${markets.length === 1 ? '' : 's'} to load.`
      );
    });
  }

  const clearCache = $('#clearCache');
  if (clearCache) {
    clearCache.addEventListener('click', async () => {
      if (!confirm('Clear cached odds? The next load will spend credits again.')) return;
      try {
        const res = await api('/api/admin/cache/clear', { method: 'POST' });
        toast(`Cleared ${res.cleared} cached responses.`, 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  const saveGroup = $('#saveGroup');
  if (saveGroup) {
    saveGroup.addEventListener('click', () =>
      saveSettings({
        group_name: $('#sGroup').value,
        site_url: $('#sSite').value,
        picks_per_user: $('#sPicks').value,
        default_stake_cents: Math.round(Number($('#sStake').value) * 100),
        hide_picks_until_lock: $('#sHide').checked ? '1' : '0',
        allow_self_vote: $('#sSelf').checked ? '1' : '0',
      })
    );
  }

  const sendTest = $('#sendTest');
  if (sendTest) {
    sendTest.addEventListener('click', async () => {
      try {
        await api('/api/admin/notifications/test', {
          method: 'POST',
          body: { channel: $('#testChannel').value, target: $('#testTarget').value },
        });
        toast('Test sent.', 'ok');
      } catch (err) {
        toast(err.message, 'err', 6000);
      }
    });
  }

  const addMember = $('#addMember');
  if (addMember) addMember.addEventListener('click', () => memberModal(null));

  $$('[data-edit-user]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const user = S.adminData.users.find((u) => u.id === Number(btn.dataset.editUser));
      memberModal(user);
    })
  );
}

function memberModal(user) {
  const isNew = !user;
  const m = modal(html`
    <h2 style="font-size:18px;margin-bottom:14px">${raw(isNew ? 'Add a member' : `Edit ${esc(user.display_name)}`)}</h2>
    ${raw(
      isNew
        ? html`<label class="field"><span>Username</span><input id="fUsername" autocapitalize="none" placeholder="dave"></label>`
        : ''
    )}
    <label class="field"><span>Display name</span><input id="fDisplay" value="${raw(user?.display_name || '')}"></label>
    <div class="grid two">
      <label class="field"><span>Emoji</span><input id="fAvatar" maxlength="4" value="${raw(user?.avatar || '🤡')}"></label>
      <label class="field"><span>Venmo</span><input id="fVenmo" value="${raw(user?.venmo || '')}" placeholder="@dave-smith"></label>
      <label class="field"><span>Email</span><input id="fEmail" type="email" value="${raw(user?.email || '')}"></label>
      <label class="field"><span>Phone (E.164)</span><input id="fPhone" value="${raw(user?.phone || '')}" placeholder="+15551234567"></label>
    </div>
    <label class="field"><span>${raw(isNew ? 'Password' : 'New password (blank = unchanged)')}</span>
      <input id="fPassword" type="text" placeholder="at least 8 characters"></label>
    <div class="checkline"><input type="checkbox" id="fAdmin" ${raw(user?.is_admin ? 'checked' : '')}>
      <label for="fAdmin">Commissioner</label></div>
    ${raw(
      isNew
        ? ''
        : html`<div class="checkline"><input type="checkbox" id="fActive" ${raw(user.is_active ? 'checked' : '')}>
            <label for="fActive">Active member</label></div>`
    )}
    <div class="row" style="margin-top:16px">
      <button class="btn primary" id="fSave">${raw(isNew ? 'Create' : 'Save')}</button>
      <button class="btn ghost" id="fCancel">Cancel</button>
    </div>
  `);

  $('#fCancel', m.el).addEventListener('click', m.close);
  $('#fSave', m.el).addEventListener('click', async () => {
    const body = {
      display_name: $('#fDisplay', m.el).value.trim(),
      avatar: $('#fAvatar', m.el).value.trim() || '🤡',
      email: $('#fEmail', m.el).value.trim(),
      phone: $('#fPhone', m.el).value.trim(),
      venmo: $('#fVenmo', m.el).value.trim(),
      is_admin: $('#fAdmin', m.el).checked,
    };
    const password = $('#fPassword', m.el).value;
    if (password) body.password = password;
    if (!isNew) body.is_active = $('#fActive', m.el).checked;

    try {
      if (isNew) {
        body.username = $('#fUsername', m.el).value.trim().toLowerCase();
        if (!password) throw new Error('New members need a password.');
        await api('/api/admin/users', { method: 'POST', body });
        toast(`${body.display_name} added. Send them the password.`, 'ok');
      } else {
        await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body });
        toast('Member updated.', 'ok');
      }
      m.close();
      S.adminData = null;
      await loadState();
      render();
    } catch (err) {
      toast(err.message, 'err', 6000);
    }
  });
}

/* ============================================================
   Bootstrap
   ============================================================ */

const VIEWS = { week: viewWeek, pick: viewPick, vote: viewVote, shame: viewShame, history: viewHistory, admin: viewAdmin };
const WIRES = { week: wireWeek, pick: wirePick, vote: wireVote, history: wireHistory, admin: wireAdmin };

function render() {
  renderTabs();
  $('#view').innerHTML = VIEWS[S.tab]();
  if (WIRES[S.tab]) WIRES[S.tab]();
}

async function boot() {
  try {
    await loadState();
  } catch (err) {
    if (err.message !== 'Signed out.') toast(err.message, 'err');
    return;
  }

  $('#groupName').textContent = S.settings.group_name || 'Bozo of the Week';
  $('#userChip').hidden = false;
  $('#userAvatar').textContent = S.user.avatar;
  $('#userName').textContent = S.user.display_name;
  $('#logoutBtn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  });

  // The manual-entry form and admin market list both need the catalog.
  try {
    const marketsRes = await api('/api/odds/markets');
    S.marketCatalog = marketsRes.markets;
  } catch {
    S.marketCatalog = [];
  }

  S.tab = currentHashTab();
  render();

  if (S.week && S.week.week.status === 'open') loadEvents();
  if (S.week && S.week.bozo && S.week.bozo.user_id === S.user.id) {
    setTimeout(() => confetti(['#ef4444', '#f59e0b', '#ffffff']), 400);
  }
}

boot();
