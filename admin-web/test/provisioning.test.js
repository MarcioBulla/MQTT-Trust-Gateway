import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-provisioning-'));
process.env.ADMIN_DATA_DIR = path.join(root, 'admin');
process.env.CA_DIR = path.join(root, 'ca');
process.env.BROKER_CONFIG_DIR = path.join(root, 'broker');
const pki = await import('../src/services/certificate-service.js');
const dbApi = await import('../src/db.js');
const lifecycle = await import('../src/services/identity-service.js');
const { loadDb, saveDb } = dbApi;

test('provisioning supports both approved algorithms and private keys remain outside persistence', async () => {
  await pki.prepareGateway();
  for (const algorithm of ['ecdsa-p256', 'rsa-2048']) {
    const issued = await pki.issueGeneratedCertificate({ deviceId: `generated-${algorithm}`, algorithm, days: 30 });
    const cert = new crypto.X509Certificate(issued.certificate);
    assert.equal(cert.checkPrivateKey(crypto.createPrivateKey(issued.privateKey)), true);
    const certFile = path.join(root, `${algorithm}.crt`);
    await fs.writeFile(certFile, issued.certificate);
    assert.match((await pki.openssl(['x509', '-in', certFile, '-purpose', '-noout'])).stdout, /SSL client\s*:\s*Yes/);
  }
  assert.equal(JSON.stringify(loadDb()).includes('privateKey'), false);
});

test('external CSR validation, identity override, CSR matching and untrusted issuer handling', async () => {
  const pendingId = crypto.randomUUID();
  const generated = await pki.generateExternalCsr({ deviceId: 'external-sensor', algorithm: 'ecdsa-p256', pendingId });
  const inspected = await pki.inspectCsr(generated.csr);
  assert.equal(inspected.algorithm, 'ECDSA-prime256v1');
  assert.equal(inspected.publicKeyFingerprint, crypto.createHash('sha256').update(crypto.createPublicKey(generated.publicKey).export({ type: 'spki', format: 'der' })).digest('hex'));
  const signed = await pki.signDeviceCsr({ deviceId: 'external-sensor', csr: generated.csr, days: 30 });
  const imported = await pki.importClientCertificate({ certificate: signed, expectedPublicKey: generated.publicKey });
  assert.equal(imported.trusted, true);
  assert.throws(() => crypto.createPublicKey('invalid'));
  const other = await pki.issueGeneratedCertificate({ deviceId: 'other-sensor', algorithm: 'ecdsa-p256', days: 30 });
  await assert.rejects(pki.importClientCertificate({ certificate: signed, privateKey: other.privateKey }));
  await assert.rejects(pki.importClientCertificate({ certificate: other.certificate, expectedPublicKey: generated.publicKey }));
});

test('trusted external CAs require explicit approval and CA revocation of trust is separate', async () => {
  const dir = path.join(root, 'external'); await fs.mkdir(dir, { recursive: true });
  await pki.openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', path.join(dir, 'ca.key'), '-out', path.join(dir, 'ca.crt'), '-days', '365', '-subj', '/CN=External Test CA', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  const pendingId = crypto.randomUUID();
  const generated = await pki.generateExternalCsr({ deviceId: 'trusted-sensor', algorithm: 'ecdsa-p256', pendingId });
  await fs.writeFile(path.join(dir, 'csr'), generated.csr);
  await fs.writeFile(path.join(dir, 'ext.cnf'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n');
  await pki.openssl(['x509', '-req', '-in', path.join(dir, 'csr'), '-CA', path.join(dir, 'ca.crt'), '-CAkey', path.join(dir, 'ca.key'), '-set_serial', '0x202610280001', '-days', '30', '-sha256', '-extfile', path.join(dir, 'ext.cnf'), '-out', path.join(dir, 'client.crt')]);
  const certificate = await fs.readFile(path.join(dir, 'client.crt'), 'utf8'), ca = await fs.readFile(path.join(dir, 'ca.crt'), 'utf8');
  const untrusted = await pki.importClientCertificate({ certificate, chain: ca, expectedPublicKey: generated.publicKey });
  assert.equal(untrusted.trusted, false);
  await pki.addTrustedCa(ca);
  const trusted = await pki.importClientCertificate({ certificate, chain: ca, expectedPublicKey: generated.publicKey });
  assert.equal(trusted.trusted, true);
  assert.ok(trusted.issuerFingerprint);
});

test('archiving persists UTC deadlines, restoration requires approval, and expiry deletion is idempotent', async () => {
  const now = Date.UTC(2026, 0, 1), db = loadDb();
  const device = { id: 'archive-test', enabled: true, trusted: true, status: 'active' };
  db.devices.push(device); saveDb(db);
  lifecycle.archiveDeviceRecord(device, now); saveDb(db);
  assert.equal(device.archivedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(device.scheduledDeletionAt, '2026-01-31T00:00:00.000Z');
  assert.equal(loadDb().devices.find((entry) => entry.id === device.id).enabled, false);
  lifecycle.restoreDeviceRecord(device); saveDb(db);
  assert.equal(device.enabled, false); assert.equal(device.trusted, false);
  lifecycle.archiveDeviceRecord(device, now); saveDb(db);
  assert.deepEqual(await lifecycle.purgeExpiredArchives(now + lifecycle.ARCHIVE_RETENTION_MS), ['archive-test']);
  assert.equal(loadDb().devices.some((entry) => entry.id === 'archive-test'), false);
  assert.equal(loadDb().deletedIdentities.some((entry) => entry.id === 'archive-test'), true);
  assert.deepEqual(await lifecycle.purgeExpiredArchives(now + lifecycle.ARCHIVE_RETENTION_MS + 1), []);
});

test('archive and deletion remove broker ACL access while preserving revocation evidence', async () => {
  const id = 'lifecycle-mtls-test';
  const db = loadDb();
  const issued = await pki.issueGeneratedCertificate({ deviceId: id, algorithm: 'ecdsa-p256', days: 30 });
  const metadata = pki.certificateMetadata(issued.certificate);
  const device = { id, name: id, status: 'active', enabled: true, trusted: true };
  db.devices.push(device);
  db.certificates.push({ id: crypto.randomUUID(), deviceId: id, certificate: issued.certificate, status: 'active', issuer: 'local', brokerTrusted: true, ...metadata });
  saveDb(db);

  await pki.syncBroker(true);
  assert.match(await fs.readFile(path.join(root, 'broker/acl'), 'utf8'), new RegExp(`user ${id}\\n`));
  lifecycle.archiveDeviceRecord(device);
  saveDb(db);
  await pki.syncBroker(true);
  assert.doesNotMatch(await fs.readFile(path.join(root, 'broker/acl'), 'utf8'), new RegExp(`user ${id}\\n`));

  lifecycle.restoreDeviceRecord(device);
  saveDb(db);
  await pki.syncBroker(true);
  assert.doesNotMatch(await fs.readFile(path.join(root, 'broker/acl'), 'utf8'), new RegExp(`user ${id}\\n`));

  await lifecycle.permanentlyDeleteDevice(db, id, 'test-admin');
  assert.equal(loadDb().devices.some((item) => item.id === id), false);
  const tombstone = loadDb().deletedIdentities.find((item) => item.id === id);
  assert.ok(tombstone?.fingerprints.includes(metadata.fingerprint));
  assert.doesNotMatch(await fs.readFile(path.join(root, 'broker/acl'), 'utf8'), new RegExp(`user ${id}\\n`));
  const certPath = path.join(root, 'deleted-test.crt');
  await fs.writeFile(certPath, issued.certificate);
  await assert.rejects(pki.openssl(['verify', '-CAfile', path.join(root, 'ca/ca.crt'), '-CRLfile', path.join(root, 'broker/ca.crl'), '-crl_check', certPath]));
});
