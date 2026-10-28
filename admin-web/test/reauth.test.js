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

await test('authenticator removal requires fresh, scoped authentication', async (t) => {
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
    const credential = await ceremony(await api('/passkeys/options', 'POST', {}), true);
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
      await api('/passkeys/' + fakeId, 'DELETE', passwordProof());
      assert.notEqual(cookie, firstSession);
      await api('/me', 'GET', undefined, 401, firstSession);
      await api('/me', 'GET', undefined, 401, otherSession);
      assert.equal((await api('/me')).user.passkeys.length, 2);
    },
  );
  await t.test('password also requires TOTP when enabled and rejects reused codes', async () => {
    const setup = await api('/me/totp/options', 'POST', {}),
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
    const setup = await api('/me/totp/options', 'POST', {}),
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
});
