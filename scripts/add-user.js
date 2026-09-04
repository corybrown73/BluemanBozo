#!/usr/bin/env node
'use strict';

/**
 * Add or update one member from the command line.
 *
 *   node scripts/add-user.js dave "Dave Smith" --email dave@x.com --phone +15551234567
 *   node scripts/add-user.js dave --password newpass123
 *   node scripts/add-user.js dave --admin
 */

require('dotenv').config();

const crypto = require('crypto');
const { db } = require('../server/db');
const { hashPassword } = require('../server/auth');

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--') && !isFlagValue(a));

function isFlagValue(arg) {
  const i = args.indexOf(arg);
  return i > 0 && args[i - 1].startsWith('--');
}
function flag(name) {
  const i = args.indexOf('--' + name);
  return i === -1 ? undefined : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
}

const username = (positional[0] || '').toLowerCase();
const displayName = positional[1];

if (!username) {
  console.error('Usage: node scripts/add-user.js <username> [display name] [--email x] [--phone +1...] [--venmo @x] [--avatar 🤡] [--password x] [--admin]');
  process.exit(1);
}
if (!/^[a-z0-9_.-]{2,32}$/.test(username)) {
  console.error('Username must be 2-32 characters: letters, numbers, dot, dash, underscore.');
  process.exit(1);
}

const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
const password = flag('password') === true ? null : flag('password');
const generated = !password && !existing ? `${crypto.randomBytes(4).toString('hex')}` : null;

const fields = {
  display_name: displayName || existing?.display_name || username,
  email: flag('email') ?? existing?.email ?? null,
  phone: flag('phone') ?? existing?.phone ?? null,
  venmo: flag('venmo') ?? existing?.venmo ?? null,
  avatar: flag('avatar') ?? existing?.avatar ?? '🤡',
  is_admin: flag('admin') ? 1 : existing?.is_admin ?? 0,
};

if (existing) {
  const sets = Object.keys(fields).map((k) => `${k} = @${k}`);
  if (password) sets.push('password_hash = @password_hash');
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = @id`).run({
    ...fields,
    ...(password ? { password_hash: hashPassword(password) } : {}),
    id: existing.id,
  });
  console.log(`\n✓ Updated ${fields.display_name} (@${username})${password ? ' — password changed' : ''}\n`);
} else {
  const pw = password || generated;
  if (pw.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  db.prepare(
    `INSERT INTO users (username, display_name, password_hash, email, phone, venmo, avatar, is_admin)
     VALUES (@username, @display_name, @password_hash, @email, @phone, @venmo, @avatar, @is_admin)`
  ).run({ ...fields, username, password_hash: hashPassword(pw) });
  console.log(`\n✓ Added ${fields.display_name} (@${username})`);
  console.log(`  password: ${pw}${generated ? '  (generated — save it now)' : ''}\n`);
}
