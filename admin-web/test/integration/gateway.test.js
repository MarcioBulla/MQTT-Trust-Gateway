import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mqtt from 'mqtt';
import { chromium } from '@playwright/test';
import * as OTPAuth from 'otpauth';
const run = promisify(execFile),
  delay = (ms) => new Promise((r) => setTimeout(r, ms));
const url = process.env.GATEWAY_TEST_URL,
  data = process.env.GATEWAY_TEST_DATA;
if (!url || !data)
  throw new Error(
    'Set GATEWAY_TEST_URL and GATEWAY_TEST_DATA to an isolated installed test gateway',
  );
const root = path.resolve(data),
  origin = new URL(url).origin;
let cookie = '',
  identity,
  certificate,
  device;
const clients = [];
async function api(route, method = 'GET', body, expected = 200) {
  const res = await fetch(url + '/api' + route, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const c = res.headers.get('set-cookie');
  if (c) cookie = c.split(';')[0];
  const text = await res.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = text;
  }
  assert.equal(res.status, expected, `${method} ${route}: ${text}`);
  return result;
}
async function applied() {
  for (let i = 0; i < 20; i++) {
    const s = await api('/status');
    if (s.enforcement.applied && s.mqtt.connected) return;
    await delay(1000);
  }
  throw new Error('Broker did not apply revision');
}
async function connection(transport = 'tcp', cert = certificate) {
  const client = mqtt.connect(
    `${transport === 'tcp' ? 'mqtts' : 'wss'}://127.0.0.1:${transport === 'tcp' ? process.env.GATEWAY_TEST_MQTT_PORT || 8883 : process.env.GATEWAY_TEST_WS_PORT || 8443}${transport === 'tcp' ? '' : '/mqtt'}`,
    {
      servername: 'localhost',
      ca: await fs.readFile(path.join(root, 'broker/ca.crt')),
      cert,
      key: await fs.readFile(path.join(root, device + '.key')),
      rejectUnauthorized: true,
      reconnectPeriod: 0,
      connectTimeout: 4000,
      protocolVersion: 5,
      wsOptions: { servername: 'localhost' },
    },
  );
  clients.push(client);
  return new Promise((resolve, reject) => {
    client.once('connect', () => resolve(client));
    client.once('error', (e) => {
      client.end(true);
      reject(e);
    });
    client.once('close', () => {
      if (!client.connected) reject(new Error('MQTT connection closed'));
    });
  });
}
await test('installed rootless gateway lifecycle', { timeout: 120000 }, async (t) => {
  await t.test('bootstrap, password login, CSRF and secure transport boundaries', async () => {
    const boot = await api('/bootstrap');
    const credentials = path.join(root, 'test-identity.json');
    if (!boot.hasAdmin) {
      identity = {
        username: 'integration-admin',
        password: crypto.randomBytes(24).toString('base64url'),
      };
      await fs.writeFile(credentials, JSON.stringify(identity), { mode: 0o600 });
      await api('/bootstrap', 'POST', {
        ...identity,
        setupToken: await fs.readFile(path.join(root, 'admin/bootstrap-token'), 'utf8'),
      });
    } else {
      identity = JSON.parse(await fs.readFile(credentials, 'utf8'));
      await api('/login/password', 'POST', identity);
    }
    assert.equal((await api('/me')).user.username, identity.username);
    const noOrigin = await fetch(url + '/api/devices', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(noOrigin.status, 403);
    const bad = await fetch(url + '/api/me', {
      headers: { Origin: 'https://evil.invalid', Cookie: cookie },
    });
    assert.equal(bad.status, 403);
    const spoof = await new Promise((resolve, reject) => {
      http
        .get(
          url + '/api/bootstrap',
          { headers: { Host: 'remote.invalid', 'X-Forwarded-Proto': 'https' } },
          (r) => {
            r.resume();
            resolve(r.statusCode);
          },
        )
        .on('error', reject);
    });
    assert.equal(spoof, 403);
    await api('/logout', 'POST', {});
    await api('/me', 'GET', undefined, 401);
    await api('/login/password', 'POST', { ...identity, password: 'invalid' }, 401);
    await api('/login/password', 'POST', identity);
  });
  await t.test('devices, CSR issuance and renewal', async () => {
    device = 'test-' + crypto.randomBytes(4).toString('hex');
    await api(
      '/devices',
      'POST',
      { id: device, name: 'Integration sensor', description: 'End-to-end test' },
      201,
    );
    await run('openssl', [
      'req',
      '-new',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      path.join(root, device + '.key'),
      '-out',
      path.join(root, device + '.csr'),
      '-subj',
      '/CN=' + device,
    ]);
    const csr = await fs.readFile(path.join(root, device + '.csr'), 'utf8');
    const issued = await api('/certificates/sign', 'POST', { deviceId: device, csr, days: 2 });
    certificate = issued.certificate;
    const renewed = await api('/certificates/' + issued.record.id + '/renew', 'POST', {
      csr,
      days: 3,
    });
    assert.notEqual(renewed.record.serial, issued.record.serial);
    await fs.writeFile(path.join(root, device + '.crt'), certificate);
    const devices = (await api('/devices')).devices;
    assert.equal(devices.find((d) => d.id === device).connectionStatus, 'unknown');
    await applied();
  });
  for (const transport of ['tcp', 'websocket'])
    await t.test(`mTLS ${transport}: publish/subscribe QoS 0, 1, 2 and ACL isolation`, async () => {
      const client = await connection(transport);
      try {
        const topic = `devices/${device}/roundtrip`;
        await client.subscribeAsync(topic, { qos: 2 });
        for (const qos of [0, 1, 2]) {
          const received = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('No MQTT roundtrip')), 5000);
            client.once('message', (t, p, packet) => {
              clearTimeout(timer);
              resolve({ t, p: p.toString(), qos: packet.qos });
            });
          });
          await client.publishAsync(topic, 'hello-' + qos, { qos });
          const m = await received;
          assert.equal(m.p, 'hello-' + qos);
          assert.equal(m.qos, qos);
        }
        await assert.rejects(
          client.publishAsync('devices/unrelated/forbidden', 'no', { qos: 1 }),
          (e) => e.code === 135,
        );
      } finally {
        await client.endAsync(true);
      }
    });
  await t.test('backend MQTT manager: publish, retained removal and bounded history', async () => {
    const topic = `devices/${device}/retained`;
    await api('/mqtt/subscribe', 'POST', { filter: `devices/${device}/#` });
    await api('/mqtt/publish', 'POST', { topic, payload: '{"ok":true}', qos: 2, retain: true });
    await delay(500);
    const h = await api('/mqtt/history');
    assert.ok(h.messages.some((m) => m.topic === topic && m.qos === 2));
    assert.ok(h.retained.some((m) => m.topic === topic));
    await api('/mqtt/retained', 'DELETE', { topic, confirm: 'wrong' }, 400);
    await api('/mqtt/retained', 'DELETE', { topic, confirm: topic });
    assert.ok(!(await api('/mqtt/history')).retained.some((m) => m.topic === topic));
    const remote = await connection();
    try {
      await remote.publishAsync(topic, 'device-retained', { qos: 1, retain: true });
      await delay(200);
      assert.ok(
        (await api('/mqtt/history')).retained.some(
          (m) => m.topic === topic && m.text === 'device-retained',
        ),
      );
      await remote.publishAsync(topic, '', { qos: 1, retain: true });
      await delay(200);
      assert.ok(!(await api('/mqtt/history')).retained.some((m) => m.topic === topic));
    } finally {
      await remote.endAsync(true);
    }
    await api('/mqtt/settings', 'PATCH', { historyLimit: 10 });
    await api('/mqtt/history', 'DELETE', {});
    assert.equal((await api('/mqtt/history')).messages.length, 0);
  });
  await t.test('browser UI, WebAuthn registration/login and TOTP QR/manual setup', async () => {
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/bin/chromium',
      headless: true,
    });
    try {
      const context = await browser.newContext(),
        page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const cdp = await context.newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      await page.goto(url);
      await page.getByLabel('Username', { exact: true }).fill(identity.username);
      await page.getByLabel('Password', { exact: true }).fill(identity.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('heading', { name: 'Your trust boundary' }).waitFor();
      await delay(600);
      await page.screenshot({
        animations: 'disabled',
        path: path.join(root, 'dashboard-desktop.png'),
        fullPage: true,
      });
      await page.getByRole('link', { name: 'Account & audit' }).click();
      await page.getByLabel('Passkey name').fill('Virtual integration key');
      await page.getByRole('button', { name: 'Register passkey' }).click();
      await page.getByText('Virtual integration key', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Set up authenticator' }).click();
      await page.getByAltText('Authenticator setup QR code').waitFor();
      const secret = (await page.getByTestId('totp-secret').innerText()).trim();
      assert.match(secret, /^[A-Z2-7]+$/);
      await page.screenshot({ path: path.join(root, 'totp-setup.png'), fullPage: true });
      const otp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
      await page.getByLabel('Verification code', { exact: true }).fill(otp.generate());
      await page.getByRole('button', { name: 'Enable authenticator', exact: true }).click();
      await page.getByText('Authenticator enabled', { exact: true }).first().waitFor();
      await page.getByRole('button', { name: 'Sign out' }).click();
      await page.getByLabel('Username', { exact: true }).fill(identity.username);
      await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
      await page.getByRole('button', { name: 'Sign out' }).waitFor();
      await page.goto(url + '/#/');
      await page.getByRole('heading', { name: 'Your trust boundary' }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await delay(600);
      await page.screenshot({
        animations: 'disabled',
        path: path.join(root, 'dashboard-mobile.png'),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      // Password-only must now fail. Wait for a fresh time step for replay-safe TOTP.
      await api('/login/password', 'POST', identity, 401);
      const wait = 30000 - (Date.now() % 30000) + 50;
      await delay(wait);
      await api('/login/password', 'POST', { ...identity, totp: otp.generate() });
      await api('/login/password', 'POST', { ...identity, totp: otp.generate() }, 401);
      // Disable with a next-window code to leave test identity reusable.
      await api('/me/totp', 'DELETE', { code: otp.generate({ timestamp: Date.now() + 30000 }) });
      await api(
        '/passkeys/' +
          encodeURIComponent(
            (await api('/me')).user.passkeys.find((p) => p.name === 'Virtual integration key').id,
          ),
        'DELETE',
        {},
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
  await t.test(
    'revocation disconnects an existing session and rejects both transports',
    async () => {
      const active = await connection();
      let closed = false;
      active.on('close', () => {
        closed = true;
      });
      const c = (await api('/certificates')).certificates.find(
        (c) =>
          c.deviceId === device &&
          c.serial === new crypto.X509Certificate(certificate).serialNumber,
      );
      await api('/certificates/' + c.id + '/revoke', 'POST', {});
      await applied();
      assert.equal(closed, true);
      await active.endAsync(true);
      for (const transport of ['tcp', 'websocket']) await assert.rejects(connection(transport));
      const status = await api('/status');
      assert.equal(status.enforcement.applied, true);
      const ca = await fs.readFile(path.join(root, 'broker/ca.crt'));
      const unauth = mqtt.connect(
        'mqtts://127.0.0.1:' + (process.env.GATEWAY_TEST_MQTT_PORT || 8883),
        { ca, servername: 'localhost', reconnectPeriod: 0, connectTimeout: 3000 },
      );
      await new Promise((resolve, reject) => {
        unauth.once('connect', () => {
          unauth.end(true);
          reject(new Error('Missing certificate was accepted'));
        });
        unauth.once('error', () => {
          unauth.end(true);
          resolve();
        });
      });
    },
  );
});

for (const client of clients) client.end(true);
