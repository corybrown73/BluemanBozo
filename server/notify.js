'use strict';

/**
 * Outbound notifications: email over SMTP (nodemailer) and SMS over the Twilio
 * REST API (plain fetch — no SDK dependency). Both are optional; if the env
 * vars are missing the app still works and just reports the channel as
 * unconfigured. Every send attempt is logged to the notifications table.
 */

const nodemailer = require('nodemailer');
const { db } = require('./db');

function emailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function smsConfigured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
}

function channelStatus() {
  return {
    email: { configured: emailConfigured(), from: process.env.SMTP_FROM || process.env.SMTP_USER || null },
    sms: { configured: smsConfigured(), from: process.env.TWILIO_FROM || null },
  };
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT, 10) || 587,
      secure: String(process.env.SMTP_SECURE || '') === 'true' || parseInt(process.env.SMTP_PORT, 10) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

function log(entry) {
  db.prepare(
    `INSERT INTO notifications (week_id, user_id, channel, target, subject, body, status, error)
     VALUES (@week_id, @user_id, @channel, @target, @subject, @body, @status, @error)`
  ).run({
    week_id: entry.week_id ?? null,
    user_id: entry.user_id ?? null,
    channel: entry.channel,
    target: entry.target ?? null,
    subject: entry.subject ?? null,
    body: entry.body ?? null,
    status: entry.status,
    error: entry.error ?? null,
  });
}

async function sendEmail({ to, subject, text, html, week_id, user_id }) {
  if (!to) {
    log({ week_id, user_id, channel: 'email', target: null, subject, body: text, status: 'skipped', error: 'No email address on file.' });
    return { ok: false, skipped: true, error: 'No email address on file.' };
  }
  if (!emailConfigured()) {
    log({ week_id, user_id, channel: 'email', target: to, subject, body: text, status: 'skipped', error: 'SMTP not configured.' });
    return { ok: false, skipped: true, error: 'SMTP not configured.' };
  }
  try {
    const info = await getTransporter().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
      html,
    });
    log({ week_id, user_id, channel: 'email', target: to, subject, body: text, status: 'sent' });
    return { ok: true, id: info.messageId };
  } catch (err) {
    log({ week_id, user_id, channel: 'email', target: to, subject, body: text, status: 'failed', error: err.message });
    return { ok: false, error: err.message };
  }
}

async function sendSms({ to, body, week_id, user_id }) {
  if (!to) {
    log({ week_id, user_id, channel: 'sms', target: null, body, status: 'skipped', error: 'No phone number on file.' });
    return { ok: false, skipped: true, error: 'No phone number on file.' };
  }
  if (!smsConfigured()) {
    log({ week_id, user_id, channel: 'sms', target: to, body, status: 'skipped', error: 'Twilio not configured.' });
    return { ok: false, skipped: true, error: 'Twilio not configured.' };
  }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Twilio ${res.status}`);
    log({ week_id, user_id, channel: 'sms', target: to, body, status: 'sent' });
    return { ok: true, id: data.sid };
  } catch (err) {
    log({ week_id, user_id, channel: 'sms', target: to, body, status: 'failed', error: err.message });
    return { ok: false, error: err.message };
  }
}

/* ---------------- message templates ---------------- */

function money(cents) {
  return `$${((Number(cents) || 0) / 100).toFixed(2)}`;
}

function bozoSummonsText({ bozo, week, roastLine, parlayInfo, picks, siteUrl, careerCount }) {
  const lines = [
    `🤡 BOZO ALERT — Week ${week.week_number} 🤡`,
    '',
    `${bozo.display_name}, you are the Bozo of the Week.`,
    '',
    roastLine,
    '',
    `That is bozo #${careerCount} on your record.`,
    '',
    `YOUR PENANCE: you place next week's parlay. Stake ${money(week.stake_cents)}.`,
    '',
    'This week\'s ticket:',
    ...picks.map(
      (p) =>
        `  ${p.result === 'win' ? '✅' : p.result === 'loss' ? '❌' : p.result === 'push' ? '➖' : '⏳'} ` +
        `${p.display_name}: ${p.player} ${p.selection}${p.line !== null && p.line !== undefined ? ' ' + p.line : ''} ` +
        `(${p.market_label}) ${p.price > 0 ? '+' : ''}${p.price}` +
        `${p.actual_value !== null && p.actual_value !== undefined ? ` → ${p.actual_value}` : ''}`
    ),
    '',
    parlayInfo
      ? `Parlay: ${parlayInfo.leg_count} legs at ${parlayInfo.american_display} — ${money(parlayInfo.stake_cents)} to win ${money(parlayInfo.profit_cents)}.`
      : '',
    '',
    siteUrl ? `Full damage report: ${siteUrl}` : '',
  ];
  return lines.filter((l) => l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function bozoSummonsHtml({ bozo, week, roastLine, parlayInfo, picks, siteUrl, careerCount }) {
  const rows = picks
    .map((p) => {
      const icon = p.result === 'win' ? '✅' : p.result === 'loss' ? '❌' : p.result === 'push' ? '➖' : '⏳';
      const isBozo = p.user_id === bozo.id;
      return `<tr style="background:${isBozo ? '#fff1f0' : '#ffffff'}">
        <td style="padding:8px 10px;border-bottom:1px solid #eee">${icon}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;font-weight:${isBozo ? 700 : 400}">${escapeHtml(p.display_name)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee">${escapeHtml(p.player)} ${escapeHtml(p.selection)} ${p.line ?? ''}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;color:#666">${escapeHtml(p.market_label)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right">${p.price > 0 ? '+' : ''}${p.price}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right">${p.actual_value ?? '—'}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html><html><body style="margin:0;background:#0b1020;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:620px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#1d4ed8,#3b82f6);padding:28px 24px;text-align:center;color:#fff">
      <div style="font-size:44px;line-height:1">🤡</div>
      <h1 style="margin:8px 0 4px;font-size:26px;letter-spacing:-.02em">Bozo of the Week</h1>
      <p style="margin:0;opacity:.85;font-size:14px">Week ${week.week_number}</p>
    </div>
    <div style="padding:24px">
      <p style="font-size:20px;margin:0 0 4px"><strong>${escapeHtml(bozo.display_name)}</strong>, it's you.</p>
      <p style="font-size:13px;color:#888;margin:0 0 16px">Career bozo count: <strong>${careerCount}</strong></p>
      <blockquote style="margin:0 0 20px;padding:14px 16px;background:#f8fafc;border-left:4px solid #ef4444;border-radius:0 8px 8px 0;font-size:15px;line-height:1.5;color:#334155">
        ${escapeHtml(roastLine)}
      </blockquote>
      <div style="padding:14px 16px;background:#fef3c7;border-radius:10px;margin-bottom:20px">
        <strong>Your penance:</strong> you place next week's parlay. Stake ${money(week.stake_cents)}.
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="text-align:left;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:.05em">
          <th style="padding:0 10px 6px"></th><th style="padding:0 10px 6px">Who</th><th style="padding:0 10px 6px">Pick</th>
          <th style="padding:0 10px 6px">Market</th><th style="padding:0 10px 6px;text-align:right">Odds</th>
          <th style="padding:0 10px 6px;text-align:right">Actual</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${
        parlayInfo
          ? `<p style="margin:18px 0 0;font-size:14px;color:#475569">Parlay: <strong>${parlayInfo.leg_count} legs</strong> at <strong>${parlayInfo.american_display}</strong> — ${money(parlayInfo.stake_cents)} to win ${money(parlayInfo.profit_cents)}.</p>`
          : ''
      }
      ${siteUrl ? `<p style="margin:24px 0 0;text-align:center"><a href="${escapeHtml(siteUrl)}" style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600">See the full damage</a></p>` : ''}
    </div>
  </div>
</body></html>`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = {
  sendEmail,
  sendSms,
  channelStatus,
  emailConfigured,
  smsConfigured,
  bozoSummonsText,
  bozoSummonsHtml,
  money,
  escapeHtml,
};
