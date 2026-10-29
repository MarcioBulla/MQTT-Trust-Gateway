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
    signal: AbortSignal.timeout(15000),
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
  await api('/broker/apply', 'POST', {});
  for (let i = 0; i < 20; i++) {
    const s = await api('/status');
    if (s.enforcement.applied && s.mqtt.connected) return;
    await delay(1000);
  }
  throw new Error('Broker did not apply revision');
}
async function connection(transport = 'tcp', cert = certificate, keyFile = path.join(root, device + '.key')) {
  const client = mqtt.connect(
    `${transport === 'tcp' ? 'mqtts' : 'wss'}://127.0.0.1:${transport === 'tcp' ? process.env.GATEWAY_TEST_MQTT_PORT || 8883 : process.env.GATEWAY_TEST_WS_PORT || 8443}${transport === 'tcp' ? '' : '/mqtt'}`,
    {
      servername: 'localhost',
      ca: await fs.readFile(path.join(root, 'broker/ca.crt')),
      cert,
      key: await fs.readFile(keyFile),
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
  await t.test('four certificate provisioning methods and explicit external CA trust', async () => {
    const generatedId = 'generated-' + crypto.randomBytes(4).toString('hex');
    const generated = await api('/certificates/generate', 'POST', { id: generatedId, algorithm: 'ecdsa-p256', days: 30 });
    assert.match(generated.privateKey, /BEGIN PRIVATE KEY/);
    assert.ok(new crypto.X509Certificate(generated.certificate).checkPrivateKey(crypto.createPrivateKey(generated.privateKey)));
    assert.equal((await api('/certificates')).certificates.some((item) => item.deviceId === generatedId && 'privateKey' in item), false);
    const generatedCertPath = path.join(root, generatedId + '.crt'), generatedKeyPath = path.join(root, generatedId + '.key');
    await fs.writeFile(generatedCertPath, generated.certificate); await fs.writeFile(generatedKeyPath, generated.privateKey, { mode: 0o600 });
    const generatedClient = await connection('tcp', generated.certificate, generatedKeyPath); await generatedClient.endAsync(true);

    const externalCsrId = 'pending-' + crypto.randomBytes(4).toString('hex');
    const pending = await api('/certificates/external-csr', 'POST', { id: externalCsrId, algorithm: 'ecdsa-p256' }, 201);
    assert.equal(pending.record.status, 'pending_external_signature');
    const keyResponse = await fetch(`${url}/api/certificates/${pending.record.id}/private-key-once`, { headers: { Cookie: cookie } });
    assert.equal(keyResponse.status, 200);
    const pendingKey = await keyResponse.text();
    assert.match(pendingKey, /BEGIN PRIVATE KEY/);
    const secondKeyResponse = await fetch(`${url}/api/certificates/${pending.record.id}/private-key-once`, { headers: { Cookie: cookie } });
    assert.equal(secondKeyResponse.status, 410);
    await api(`/certificates/${pending.record.id}/private-key-received`, 'POST', {});
    const pendingCsrPath = path.join(root, externalCsrId + '.csr'), pendingCertPath = path.join(root, externalCsrId + '.crt'), pendingKeyPath = path.join(root, externalCsrId + '.key');
    await fs.writeFile(pendingCsrPath, pending.csr); await fs.writeFile(pendingKeyPath, pendingKey, { mode: 0o600 });
    await fs.writeFile(path.join(root, 'client-extensions.cnf'), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n`);
    await run('openssl', ['x509', '-req', '-in', pendingCsrPath, '-CA', path.join(root, 'admin/ca/ca.crt'), '-CAkey', path.join(root, 'admin/ca/ca.key'), '-set_serial', `0x${crypto.randomBytes(8).toString('hex')}`, '-days', '30', '-sha256', '-extfile', path.join(root, 'client-extensions.cnf'), '-out', pendingCertPath]);
    const signedPending = await fs.readFile(pendingCertPath, 'utf8');
    const completed = await api('/certificates/import', 'POST', { pendingId: pending.record.id, certificate: signedPending, chain: await fs.readFile(path.join(root, 'admin/ca/ca.crt'), 'utf8') }, 201);
    assert.equal(completed.brokerTrusted, true);
    const pendingClient = await connection('tcp', signedPending, pendingKeyPath); await pendingClient.endAsync(true);

    const caDir = path.join(root, 'external-ca-test'); await fs.mkdir(caDir, { recursive: true });
    const caPath = path.join(caDir, 'ca.crt'), caKeyPath = path.join(caDir, 'ca.key'), clientCsrPath = path.join(caDir, 'device.csr'), clientCertPath = path.join(caDir, 'device.crt'), clientKeyPath = path.join(caDir, 'device.key');
    const importedId = 'imported-' + crypto.randomBytes(4).toString('hex');
    await run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', caKeyPath, '-out', caPath, '-days', '365', '-subj', '/CN=Integration External CA', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    await run('openssl', ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', clientKeyPath, '-out', clientCsrPath, '-subj', `/CN=${importedId}`]);
    await run('openssl', ['x509', '-req', '-in', clientCsrPath, '-CA', caPath, '-CAkey', caKeyPath, '-set_serial', `0x${crypto.randomBytes(8).toString('hex')}`, '-days', '30', '-sha256', '-extfile', path.join(root, 'client-extensions.cnf'), '-out', clientCertPath]);
    const externalCert = await fs.readFile(clientCertPath, 'utf8'), externalCa = await fs.readFile(caPath, 'utf8');
    const imported = await api('/certificates/import', 'POST', { deviceId: importedId, certificate: externalCert, chain: externalCa, privateKey: await fs.readFile(clientKeyPath, 'utf8') }, 201);
    assert.equal(imported.brokerTrusted, false);
    assert.match(imported.message, /not trusted/);
    await assert.rejects(connection('tcp', externalCert, clientKeyPath));
    await api('/trusted-cas', 'POST', { certificate: externalCa, confirm: 'TRUST THIS CA' }, 201);
    await applied();
    const trusted = (await api('/certificates')).certificates.find((item) => item.id === imported.record.id);
    assert.equal(trusted.brokerTrusted, true);
    const externalClient = await connection('tcp', externalCert, clientKeyPath); await externalClient.endAsync(true);
    await api(`/trusted-cas/${(await api('/trusted-cas')).trustedCas.find((item) => item.fingerprint === trusted.issuerFingerprint)?.id}`, 'DELETE', {});
    await applied();
    await assert.rejects(connection('tcp', externalCert, clientKeyPath));
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
      await api('/me/totp', 'DELETE', { reauth: { method: 'password', password: identity.password, totp: otp.generate({ timestamp: Date.now() + 30000 }) } });
      await api(
        '/passkeys/' +
          encodeURIComponent(
            (await api('/me')).user.passkeys.find((p) => p.name === 'Virtual integration key').id,
          ),
        'DELETE',
        { reauth: { method: 'password', password: identity.password } },
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
  await t.test(
    'archive and restore blocks MQTT until explicit approval',
    async () => {
      const active = await connection(); let closed = false; active.on('close', () => { closed = true; });
      await api(`/devices/${device}/archive`, 'POST', { confirm: device });
      await applied(); assert.equal(closed, true); await active.endAsync(true);
      assert.equal((await api('/devices')).devices.some((item) => item.id === device), false);
      const archived = await api('/devices?status=archived');
      assert.equal(archived.devices.some((item) => item.id === device && item.scheduledDeletionAt), true);
      for (const transport of ['tcp', 'websocket']) await assert.rejects(connection(transport));
      await api(`/devices/${device}/restore`, 'POST', {});
      await applied();
      for (const transport of ['tcp', 'websocket']) await assert.rejects(connection(transport));
      await api(`/devices/${device}/approve`, 'POST', { confirm: device }, 409);
      for (const transport of ['tcp', 'websocket']) await assert.rejects(connection(transport));
      const csr = await fs.readFile(path.join(root, device + '.csr'), 'utf8');
      const replacement = await api('/certificates/sign', 'POST', { deviceId: device, csr, days: 2 });
      certificate = replacement.certificate;
      await api(`/devices/${device}/approve`, 'POST', { confirm: device });
      await applied();
      const restored = await connection(); await restored.endAsync(true);
    },
  );
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
