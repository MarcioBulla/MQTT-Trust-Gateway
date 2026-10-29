import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import argon2 from 'argon2';
import { chromium } from '@playwright/test';
import * as OTPAuth from 'otpauth';

await test('authentication changes require fresh, scoped authentication', async (t) => {
  process.env.ADMIN_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-reauth-'));
  const { env } = await import('../src/config.js');
  const { loadDb, saveDb, exclusive, sqlite } = await import('../src/db.js');
  const { registerAuthRoutes } = await import('../src/routes/auth-routes.js');
  const password = 'Isolated authentication test password',
    fakeId = crypto.randomBytes(24).toString('base64url');
  const db = loadDb();
  db.users.push({
    id: crypto.randomBytes(16).toString('base64url'),
    username: 'test-admin',
    passwordHash: await argon2.hash(password),
    credentials: [{ id: fakeId, publicKey: '', counter: 0 }],
  });
  saveDb(db);
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) =>
    exclusive(
      () =>
        new Promise((resolve) => {
          res.once('finish', resolve);
          res.once('close', resolve);
          next();
        }),
    ).catch(next),
  );
  registerAuthRoutes(app);
  app.get('/', (_req, res) => res.send('<!doctype html><title>Isolated WebAuthn test</title>'));
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://localhost:${server.address().port}`;
  env.origin = origin;
  env.rpID = 'localhost';
  let cookie = '',
    browser;
  async function api(route, method = 'GET', body, expected = 200, session) {
    const response = await fetch(origin + '/api' + route, {
      method,
      headers: { Origin: origin, Cookie: session ?? cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (session === undefined && response.headers.get('set-cookie'))
      cookie = response.headers.get('set-cookie').split(';')[0];
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(result)}`);
    return result;
  }
  t.after(async () => {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    sqlite.close();
  });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/bin/chromium',
    headless: true,
  });
  const context = await browser.newContext(),
    page = await context.newPage(),
    cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  let authenticatorId;
  const authenticatorOptions = {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  };
  await page.goto(origin);
  async function ceremony(options, register = false) {
    return page.evaluate(
      async ({ options, register }) => {
        const decode = (s) =>
          Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
            c.charCodeAt(0),
          );
        const publicKey = { ...options, challenge: decode(options.challenge) };
        if (register) {
          publicKey.user = { ...options.user, id: decode(options.user.id) };
          publicKey.excludeCredentials = options.excludeCredentials.map((c) => ({
            ...c,
            id: decode(c.id),
          }));
        } else
          publicKey.allowCredentials = options.allowCredentials.map((c) => ({
            ...c,
            id: decode(c.id),
          }));
        return (await navigator.credentials[register ? 'create' : 'get']({ publicKey })).toJSON();
      },
      { options, register },
    );
  }
  async function registerKey() {
    if (authenticatorId) await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    ({ authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: authenticatorOptions,
    }));
    if (!registerKey.checked) {
      await api('/passkeys/options', 'POST', {}, 403);
      await api('/passkeys/options', 'POST', { reauth: { method: 'password', password } }, 403);
      registerKey.checked = true;
    }
    const { enrollTotp } = await import('../src/totp.js');
    const enrollment = await enrollTotp('test-admin');
    const state = loadDb(), previousTotp = state.users[0].totp, previousPassword = state.users[0].passwordHash;
    state.users[0].passwordHash = await argon2.hash(password);
    state.users[0].totp = { encrypted: enrollment.pending.encrypted };
    saveDb(state);
    const otp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(enrollment.secret) });
    const credential = await ceremony(await api('/passkeys/options', 'POST', { reauth: { method: 'password', password, totp: otp.generate() } }), true);
    const updated = loadDb();
    updated.users[0].totp = previousTotp;
    updated.users[0].passwordHash = previousPassword;
    saveDb(updated);
    await api('/passkeys/verify', 'POST', { credential, name: 'Virtual test key' });
    return credential.id;
  }
  async function proof(action, target = '') {
    return {
      method: 'passkey',
      credential: await ceremony(await api('/reauth/options', 'POST', { action, target })),
    };
  }
  const passwordProof = (totp) => ({ reauth: { method: 'password', password, totp } });
  await api('/login/password', 'POST', { username: 'test-admin', password });
  await t.test('password alone bootstraps only accounts without a second factor', async () => {
    const state = loadDb(), credentials = state.users[0].credentials;
    state.users[0].credentials = [];
    saveDb(state);
    await api('/passkeys/options', 'POST', {}, 403);
    await api('/passkeys/options', 'POST', { reauth: { method: 'password', password: 'incorrect password' } }, 403);
    await api('/passkeys/options', 'POST', { reauth: { method: 'password', password } });
    const updated = loadDb();
    updated.users[0].credentials = credentials;
    saveDb(updated);
    await api('/passkeys/options', 'POST', { reauth: { method: 'password', password } }, 403);
    registerKey.checked = true;
  });
  const firstSession = cookie;
  await api('/login/password', 'POST', { username: 'test-admin', password });
  const otherSession = cookie;
  cookie = firstSession;
  const firstKey = await registerKey(),
    secondKey = await registerKey();
  await t.test(
    'missing/wrong proof is rejected and valid password removal rotates sessions',
    async () => {
      await api('/passkeys/' + fakeId, 'DELETE', {}, 403);
      await api(
        '/passkeys/' + fakeId,
        'DELETE',
        { reauth: { method: 'password', password: 'wrong' } },
        403,
      );
      await api('/passkeys/' + fakeId, 'DELETE', passwordProof(), 403);
      await api('/passkeys/' + fakeId, 'DELETE', { reauth: await proof('remove-passkey', fakeId) });
      assert.notEqual(cookie, firstSession);
      await api('/me', 'GET', undefined, 401, firstSession);
      await api('/me', 'GET', undefined, 401, otherSession);
      assert.equal((await api('/me')).user.passkeys.length, 2);
    },
  );
  await t.test('password also requires TOTP when enabled and rejects reused codes', async () => {
    await api('/me/totp/options', 'POST', {}, 403);
    await api('/me/totp/options', 'POST', passwordProof(), 403);
    const setup = await api('/me/totp/options', 'POST', { reauth: await proof('enable-totp') }),
      otp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.secret) });
    await api('/me/totp/verify', 'POST', { code: otp.generate() });
    await api('/passkeys/' + firstKey, 'DELETE', passwordProof(), 403);
    await api('/me/totp', 'DELETE', { code: otp.generate() }, 403);
    const freshCode = otp.generate({ timestamp: Date.now() + 30000 });
    await api('/passkeys/' + firstKey, 'DELETE', passwordProof(freshCode));
    await api('/me/totp', 'DELETE', passwordProof(freshCode), 403);
    assert.equal((await api('/me')).user.totpEnabled, true);
  });
  await t.test('passkey proof is action-bound and cannot be replayed', async () => {
    const reauth = await proof('disable-totp');
    await api('/passkeys/' + secondKey, 'DELETE', { reauth }, 403);
    await api('/me/totp', 'DELETE', { reauth });
    const setup = await api('/me/totp/options', 'POST', { reauth: await proof('enable-totp') }),
      otp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.secret) });
    await api('/me/totp/verify', 'POST', { code: otp.generate() });
    await api('/me/totp', 'DELETE', { reauth }, 403);
  });
  await t.test('passkey proof is bound to the current session', async () => {
    const original = cookie,
      options = await api('/login/options', 'POST', { username: 'test-admin' });
    await api('/login/verify', 'POST', {
      username: 'test-admin',
      credential: await ceremony(options),
    });
    const secondSession = cookie;
    cookie = original;
    const reauth = await proof('disable-totp');
    await api('/me/totp', 'DELETE', { reauth }, 403, secondSession);
    await api('/me/totp', 'DELETE', { reauth });
    await api('/me', 'GET', undefined, 401, secondSession);
  });
  await t.test(
    'passkey-only users can verify removal but cannot remove their final sign-in method',
    async () => {
      const db = loadDb();
      delete db.users[0].passwordHash;
      saveDb(db);
      assert.equal((await api('/me')).user.hasPassword, false);
      await api('/passkeys/' + secondKey, 'DELETE', {}, 409);
      await registerKey();
      await api('/passkeys/' + secondKey, 'DELETE', {
        reauth: await proof('remove-passkey', secondKey),
      });
      assert.equal((await api('/me')).user.passkeys.length, 1);
    },
  );
  await t.test('bad signatures and expired challenges cannot remove a passkey', async () => {
    const target = await registerKey(),
      invalid = await proof('remove-passkey', target);
    invalid.credential.response.signature = 'AAAA';
    await api('/passkeys/' + target, 'DELETE', { reauth: invalid }, 403);
    const expired = await proof('remove-passkey', target),
      db = loadDb();
    for (const [key, c] of Object.entries(db.challenges))
      if (key.startsWith('reauth:')) c.expiresAt = Date.now() - 1;
    saveDb(db);
    await api('/passkeys/' + target, 'DELETE', { reauth: expired }, 403);
    await api('/passkeys/' + target, 'DELETE', { reauth: await proof('remove-passkey', target) });
    assert.equal((await api('/me')).user.passkeys.length, 1);
  });
  await t.test('password changes accept a scoped passkey and require password plus TOTP as the fallback', async (t) => {
    // Move beyond the rate-limit window without weakening production limits.
    const realNow = Date.now;
    Date.now = () => realNow() + 61000;
    t.after(() => { Date.now = realNow; });
    const target = await registerKey();
    assert.equal((await api('/me')).user.hasPassword, false);
    const newPassword = 'New password approved by a passkey';
    await api('/me/password', 'POST', { password: newPassword }, 403);
    await api('/me/password', 'POST', { password: 'short' }, 400);
    const wrongAction = await proof('remove-passkey', target);
    await api('/me/password', 'POST', { password: newPassword, reauth: wrongAction }, 403);
    const invalid = await proof('change-password');
    invalid.credential.response.signature = 'AAAA';
    await api('/me/password', 'POST', { password: newPassword, reauth: invalid }, 403);
    const originalSession = cookie;
    const loginOptions = await api('/login/options', 'POST', { username: 'test-admin' });
    await api('/login/verify', 'POST', { username: 'test-admin', credential: await ceremony(loginOptions) });
    const otherSession = cookie;
    cookie = originalSession;
    const reauth = await proof('change-password');
    await api('/me/password', 'POST', { password: newPassword, reauth }, 403, otherSession);
    await api('/me/password', 'POST', { password: newPassword, reauth });
    assert.notEqual(cookie, originalSession);
    await api('/me', 'GET', undefined, 401, originalSession);
    await api('/me', 'GET', undefined, 401, otherSession);
    assert.equal((await api('/me')).user.hasPassword, true);
    assert.ok(await argon2.verify(loadDb().users[0].passwordHash, newPassword));
    await api('/me/password', 'POST', { password: 'Replay must not change this password', reauth }, 403);
    await api('/me/password', 'POST', { password: newPassword, currentPassword: 'wrong' }, 403);
    const setup = await api('/me/totp/options', 'POST', { reauth: await proof('enable-totp') });
    const otp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.secret) });
    await api('/me/totp/verify', 'POST', { code: otp.generate() });
    await api('/me/password', 'POST', { password: 'Password fallback without TOTP', currentPassword: newPassword }, 403);
    const finalPassword = 'Password fallback with fresh authenticator';
    await api('/me/password', 'POST', { password: finalPassword, currentPassword: newPassword, totp: otp.generate({ timestamp: Date.now() + 30000 }) });
    assert.ok(await argon2.verify(loadDb().users[0].passwordHash, finalPassword));
    assert.equal((await api('/me')).user.totpEnabled, true);
    assert.ok((await api('/me')).user.passkeys.some((key) => key.id === target));
  });

});
