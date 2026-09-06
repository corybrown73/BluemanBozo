'use strict';

/**
 * First-boot bootstrapping. A hosted deploy has no terminal, so getting the
 * first commissioner in has to work from environment variables alone — and a
 * redeploy must never touch an account that already exists.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-boot-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'boot.db');
process.env.SESSION_SECRET = 'bootstrap-secret-that-is-long-enough';
process.env.NODE_ENV = 'test';

const { db } = require('../server/db');
const { bootstrap } = require('../server/bootstrap');
const { verifyPassword } = require('../server/auth');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ENV = {
  ADMIN_USERNAME: 'cory',
  ADMIN_PASSWORD: 'correct-horse-battery',
  ADMIN_DISPLAY_NAME: 'Cory',
  GROUP_NAME: 'Blue Man Group',
};

test('an empty database with no credentials is reported, not guessed at', () => {
  const res = bootstrap({});
  assert.strictEqual(res.status, 'no-admin');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0, 'no account is invented');
});

test('a weak or malformed admin credential is refused, not silently accepted', () => {
  assert.strictEqual(bootstrap({ ADMIN_USERNAME: 'cory', ADMIN_PASSWORD: 'short' }).status, 'refused');
  assert.strictEqual(bootstrap({ ADMIN_USERNAME: 'no spaces allowed', ADMIN_PASSWORD: 'longenough123' }).status, 'refused');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
});

test('the first boot creates the commissioner and an active season', () => {
  const res = bootstrap(ENV);
  assert.strictEqual(res.status, 'created');

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get('cory');
  assert.ok(user, 'the commissioner exists');
  assert.strictEqual(user.is_admin, 1, 'and is an admin');
  assert.strictEqual(user.display_name, 'Cory');
  assert.ok(verifyPassword('correct-horse-battery', user.password_hash), 'the password works');
  assert.ok(!String(user.password_hash).includes('correct-horse-battery'), 'and is stored hashed');

  const season = db.prepare('SELECT * FROM seasons WHERE is_active = 1').get();
  assert.ok(season, 'an active season exists so a week can be opened');
});

test('a redeploy cannot reset the password, rename the admin, or add a second account', () => {
  const before = db.prepare('SELECT * FROM users WHERE username = ?').get('cory');

  const res = bootstrap({ ...ENV, ADMIN_PASSWORD: 'attacker-tries-to-reset', ADMIN_DISPLAY_NAME: 'Not Cory' });
  assert.strictEqual(res.status, 'skipped', 'the bootstrap stands down once anybody exists');

  const after = db.prepare('SELECT * FROM users WHERE username = ?').get('cory');
  assert.strictEqual(after.password_hash, before.password_hash, 'the password is untouched');
  assert.strictEqual(after.display_name, 'Cory', 'the name is untouched');
  assert.ok(!verifyPassword('attacker-tries-to-reset', after.password_hash), 'the new password does not work');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1, 'no second account appears');
});

test('a different admin username on redeploy does not create a second commissioner', () => {
  const res = bootstrap({ ADMIN_USERNAME: 'someone_else', ADMIN_PASSWORD: 'longenoughpassword' });
  assert.strictEqual(res.status, 'skipped');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
});
