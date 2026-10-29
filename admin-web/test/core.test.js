import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-unit-'));
process.env.ADMIN_DATA_DIR = path.join(dir, 'admin');
process.env.CA_DIR = path.join(dir, 'ca');
process.env.BROKER_CONFIG_DIR = path.join(dir, 'broker');
const {
  prepareGateway,
  signDeviceCsr,
  revokeCertificate,
  certificateMetadata,
  syncBroker,
  openssl,
} = await import('../src/services/certificate-service.js');
const { loadDb, saveDb, exclusive, sqlite } = await import('../src/db.js');
const { enrollTotp, verifyTotp } = await import('../src/totp.js');
const OTPAuth = await import('otpauth');
test('CA lifecycle: idempotence, CSR constraints, issuance, renewal, CRL and ACL enforcement', async () => {
  await prepareGateway();
  const original = await fs.readFile(path.join(dir, 'ca/ca.crt'), 'utf8');
  await prepareGateway();
  assert.equal(await fs.readFile(path.join(dir, 'ca/ca.crt'), 'utf8'), original);
  const key = path.join(dir, 'device.key'),
    csrFile = path.join(dir, 'device.csr');
  await openssl([
    'req',
    '-new',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-keyout',
    key,
    '-out',
    csrFile,
    '-subj',
    '/CN=attacker',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
  ]);
  const csr = await fs.readFile(csrFile, 'utf8');
  await assert.rejects(signDeviceCsr({ deviceId: 'mqtt-trust-admin', csr }));
  await assert.rejects(signDeviceCsr({ deviceId: 'sensor', csr, days: 99999 }));
  const pem = await signDeviceCsr({ deviceId: 'sensor', csr, days: 1 });
  const metadata = certificateMetadata(pem);
  assert.equal(metadata.subject, 'CN=sensor');
  const cert = path.join(dir, 'device.crt');
  await fs.writeFile(cert, pem);
  const { stdout } = await openssl(['x509', '-in', cert, '-text', '-noout']);
  assert.match(stdout, /CA:FALSE/);
  assert.match(stdout, /TLS Web Client Authentication/);
  const renewed = await signDeviceCsr({ deviceId: 'sensor', csr, days: 2 });
  assert.notEqual(certificateMetadata(renewed).serial, metadata.serial);
  const db = loadDb();
  db.devices.push({ id: 'sensor', enabled: true });
  db.certificates.push({ deviceId: 'sensor', certificate: pem, status: 'active', ...metadata });
  saveDb(db);
  await syncBroker();
  assert.match(await fs.readFile(path.join(dir, 'broker/acl'), 'utf8'), /user sensor/);
  await revokeCertificate({ certificate: pem });
  await assert.rejects(
    openssl([
      'verify',
      '-CAfile',
      path.join(dir, 'ca/ca.crt'),
      '-CRLfile',
      path.join(dir, 'broker/ca.crl'),
      '-crl_check',
      cert,
    ]),
  );
  db.certificates[0].status = 'revoked';
  saveDb(db);
  await syncBroker(true);
  assert.doesNotMatch(await fs.readFile(path.join(dir, 'broker/acl'), 'utf8'), /user sensor/);
  assert.equal((await fs.stat(path.join(dir, 'ca/ca.key'))).mode & 0o777, 0o600);
});
test('SQLite mutation queue preserves concurrent updates', async () => {
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      exclusive(async () => {
        const db = loadDb();
        await Promise.resolve();
        db.settings[i] = true;
        saveDb(db);
      }),
    ),
  );
  assert.equal(Object.keys(loadDb().settings).length, 20);
});
test('TOTP enrollment uses encrypted storage, validates codes, and rejects replay', async () => {
  const setup = await enrollTotp('admin');
  assert.match(setup.qr, /^data:image\/png;base64,/);
  assert.ok(!setup.pending.encrypted.includes(setup.secret));
  const otp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.secret) }),
    now = Date.now(),
    token = otp.generate({ timestamp: now });
  assert.equal(verifyTotp(setup.pending, 'wrong', now), false);
  assert.equal(verifyTotp(setup.pending, token, now), true);
  assert.equal(verifyTotp(setup.pending, token, now), false);
});
test('legacy JSON imports identities, credential counters and certificates once, without reusing sessions', async () => {
  const legacy = path.join(dir, 'legacy');
  await fs.mkdir(legacy);
  await fs.writeFile(
    path.join(legacy, 'admin-db.json'),
    JSON.stringify({
      users: [{ id: 'legacy', credentials: [{ id: 'credential', counter: 42 }] }],
      certificates: [{ deviceId: 'old-device', serial: '01' }],
      sessions: { old: { userId: 'legacy' } },
      challenges: {},
    }),
  );
  const result = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {loadDb} from ${JSON.stringify(new URL('../src/db.js', import.meta.url).href)}; console.log(JSON.stringify(loadDb()))`,
    ],
    { env: { ...process.env, ADMIN_DATA_DIR: legacy }, encoding: 'utf8' },
  );
  const db = JSON.parse(result);
  assert.equal(db.users[0].credentials[0].counter, 42);
  assert.equal(db.devices[0].id, 'old-device');
  assert.deepEqual(db.sessions, {});
  assert.ok(await fs.stat(path.join(legacy, 'admin-db.json')));
});
test('certificate expiry requests a broker restart even when a renewed certificate keeps the same device authorized', async () => {
  const db = loadDb();
  db.devices.push({ id: 'renewed-device', enabled: true });
  db.certificates.push(
    {
      deviceId: 'renewed-device',
      serial: 'older',
      validTo: new Date(Date.now() + 60000).toISOString(),
      status: 'active',
    },
    {
      deviceId: 'renewed-device',
      serial: 'newer',
      validTo: new Date(Date.now() + 120000).toISOString(),
      status: 'active',
    },
  );
  saveDb(db);
  await syncBroker();
  const revision = await fs.readFile(path.join(dir, 'broker/revision'), 'utf8');
  db.certificates.find((c) => c.serial === 'older').validTo = new Date(
    Date.now() - 1,
  ).toISOString();
  saveDb(db);
  await syncBroker();
  assert.notEqual(await fs.readFile(path.join(dir, 'broker/revision'), 'utf8'), revision);
  assert.match(await fs.readFile(path.join(dir, 'broker/acl'), 'utf8'), /user renewed-device/);
});
test('bootstrap tokens tolerate surrounding whitespace while rejecting incorrect and malformed input', async () => {
  const { matchesBootstrapToken } = await import('../src/auth.js');
  const token = 'correct-private-bootstrap-token';
  assert.equal(matchesBootstrapToken(token, token), true);
  assert.equal(matchesBootstrapToken(` \n${token}\r\n `, `${token}\n`), true);
  assert.equal(matchesBootstrapToken('incorrect', token), false);
  assert.equal(matchesBootstrapToken('é', 'a'), false);
  assert.equal(matchesBootstrapToken('', ''), false);
  assert.equal(matchesBootstrapToken(null, token), false);
  assert.equal(matchesBootstrapToken({ token }, token), false);
});
test('manual changes batch into one apply and license removal preserves the device and other credentials', async (t) => {
  const { default: express } = await import('express');
  const { createSession } = await import('../src/auth.js');
  const { registerCertificateRoutes } = await import('../src/routes/certificate-routes.js');
  const { registerStatusRoutes } = await import('../src/routes/status-routes.js');
  const db = loadDb(), user = { id: 'batch-admin', username: 'batch-admin', credentials: [] };
  db.users.push(user);
  let cookie;
  createSession(db, user, { secure: false }, { setHeader: (_name, value) => { cookie = value.split(';')[0]; } });
  saveDb(db);
  const app = express(); app.use(express.json());
  registerCertificateRoutes(app); registerStatusRoutes(app);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  async function request(route, method = 'GET', body, expected = 200) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, expected, `${method} ${route}: ${response.status}`);
    return response.headers.get('content-type')?.includes('application/zip') ? response.arrayBuffer() : response.json();
  }
  const revisionFile = path.join(dir, 'broker/revision'), before = await fs.readFile(revisionFile, 'utf8');
  await request('/devices', 'POST', { id: 'batch-device' }, 201);
  await request('/devices/batch-device/approve', 'POST', { confirm: 'batch-device' }, 409);
  await request('/certificates/generate', 'POST', { id: 'batch-device', algorithm: 'ecdsa-p256', days: 2, bundle: true });
  await request('/devices/batch-device/approve', 'POST', { confirm: 'batch-device' });
  const second = await request('/certificates/generate', 'POST', { id: 'batch-device', algorithm: 'ecdsa-p256', days: 2 });
  const first = loadDb().certificates.find((c) => c.deviceId === 'batch-device' && c.id !== second.record.id);
  await request(`/certificates/${first.id}/archive`, 'POST', { confirm: `ARCHIVE ${first.serial}` });
  await request(`/certificates/${first.id}`, 'DELETE', { confirm: `DELETE ${first.serial}` });
  const after = loadDb();
  assert.ok(after.devices.some((d) => d.id === 'batch-device'));
  assert.equal(after.certificates.find((c) => c.id === second.record.id).status, 'active');
  assert.ok(after.certificates.find((c) => c.id === first.id).licenseDeletedAt);
  assert.equal(await fs.readFile(revisionFile, 'utf8'), before);
  const pendingStatus = await request('/broker/status');
  assert.equal(pendingStatus.pendingChanges, true);
  for (const type of ['certificate.generated', 'device.approved', 'license.archived', 'license.deleted'])
    assert.ok(pendingStatus.changes.some((change) => change.action === type));
  assert.equal((await request('/broker/apply', 'POST', {})).changed, true);
  const applied = await fs.readFile(revisionFile, 'utf8');
  assert.notEqual(applied, before);
  assert.deepEqual((await request('/broker/status')).changes, []);
  assert.equal((await request('/broker/apply', 'POST', {})).changed, false);
  assert.equal(await fs.readFile(revisionFile, 'utf8'), applied);
});
