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
