import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { env } from '../config.js';
import { requireAuth } from '../auth.js';
import { loadDb, saveDb, audit } from '../db.js';
import {
  certificateMetadata,
  signDeviceCsr,
  revokeCertificate,
  syncBroker,
  inspectCsr,
  generateExternalCsr,
  takePendingPrivateKey,
  confirmPendingPrivateKey,
  issueGeneratedCertificate,
  importClientCertificate,
  addTrustedCa,
  initializeCa,
} from '../services/certificate-service.js';
import { zipFiles } from '../zip.js';
import { archiveDeviceRecord, restoreDeviceRecord, permanentlyDeleteDevice } from '../services/identity-service.js';
const find = (db, id) => {
  const c = db.certificates.find((c) => c.id === id);
  if (!c) throw Object.assign(new Error('Certificate not found'), { status: 404 });
  return c;
};
const state = (c) =>
  c.status !== 'active'
    ? c.status
    : c.status === 'revoked'
    ? 'revoked'
    : Date.parse(c.validTo) <= Date.now()
      ? 'expired'
      : Date.parse(c.validTo) < Date.now() + 30 * 86400000
        ? 'expiring'
        : 'active';
export function publicCertificate(c) {
  const { csr, certificate, oneTimeKeyToken, privateKey, publicKey, ...publicData } = c;
  return { ...publicData, status: c.status === 'active' && c.brokerTrusted === false ? 'untrusted' : state(c), canDownload: Boolean(certificate) };
}
const deviceRecord = (db, id) => db.devices.find((device) => device.id === id);
const ensureIdentity = (db, { id, name = id, description = '' }) => {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || id === env.adminMqttClientId)
    throw Object.assign(new Error('Invalid or reserved device identifier'), { status: 400 });
  if ((db.deletedIdentities || []).some((entry) => entry.id === id))
    throw Object.assign(new Error('This identity was permanently deleted and cannot be reused'), { status: 409 });
  let device = deviceRecord(db, id);
  if (!device) {
    device = { id, name: String(name || id).slice(0, 100), description: String(description || '').slice(0, 1000), enabled: true, trusted: true, status: 'active', createdAt: new Date().toISOString() };
    db.devices.push(device);
  }
  if (device.status !== 'active' || !device.enabled || device.trusted === false)
    throw Object.assign(new Error('Device identity is not active and approved'), { status: 409 });
  return device;
};
function addIssuedRecord(db, { deviceId, certificate, method, issuer = 'local', brokerTrusted = true, csr = '', renewedFrom = '', issuedBy }) {
  const metadata = certificateMetadata(certificate);
  const record = {
    id: crypto.randomUUID(), deviceId, certificate, csr, status: 'active', provisioningMethod: method,
    ...metadata, issuer, brokerTrusted, issuedAt: new Date().toISOString(), issuedBy, renewedFrom,
  };
  db.certificates.unshift(record);
  return record;
}
async function issue(req, res, previous) {
  const db = loadDb(),
    deviceId = previous?.deviceId || String(req.body.deviceId || '');
  const device = db.devices.find((d) => d.id === deviceId);
  if (!device?.enabled || device.status === 'archived' || device.status === 'deleted' || device.trusted === false)
    return res.status(409).json({ error: 'Register or enable the device first' });
  const csr = req.body.csr || previous?.csr;
  if (typeof csr !== 'string' || !csr.includes('BEGIN CERTIFICATE REQUEST'))
    return res.status(400).json({ error: 'A PEM CSR is required' });
  const certificate = await signDeviceCsr({ deviceId, csr, days: req.body.days });
  const record = addIssuedRecord(db, { deviceId, certificate, csr, issuedBy: req.user.username, renewedFrom: previous?.id || '', method: 'csr' });
  saveDb(db);
  await syncBroker();
  audit(
    req.user.username,
    previous ? 'certificate.renewed' : 'certificate.issued',
    `${deviceId}:${record.serial}`,
  );
  res.json({ certificate, record: publicCertificate(record) });
}
export function registerCertificateRoutes(app) {
  app.get(
    '/api/certificates/ca',
    requireAuth((_req, res) => res.download(path.join(env.caDir, 'ca.crt'), 'gateway-ca.crt')),
  );
  app.get('/api/trusted-cas', requireAuth((_req, res) => {
    const trustedCas = (loadDb().trustedCas || []).map(({ certificate, ...item }) => item);
    res.json({ trustedCas });
  }));
  app.post('/api/trusted-cas', requireAuth(async (req, res) => {
    if (req.body.confirm !== 'TRUST THIS CA') return res.status(400).json({ error: 'Explicit CA trust confirmation is required' });
    const result = await addTrustedCa(req.body.certificate);
    const db = loadDb();
    for (const cert of db.certificates) {
      if (cert.issuerFingerprint === result.fingerprint) cert.brokerTrusted = true;
    }
    saveDb(db); await syncBroker(true);
    audit(req.user.username, 'ca.trusted', result.fingerprint);
    res.status(201).json({ trustedCa: result, enforcement: 'Broker restart requested to apply its trust bundle.' });
  }));
  app.delete('/api/trusted-cas/:id', requireAuth(async (req, res) => {
    const db = loadDb(), item = db.trustedCas.find((ca) => ca.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Trusted CA not found' });
    db.trustedCas = db.trustedCas.filter((ca) => ca.id !== item.id);
    for (const cert of db.certificates) if (cert.issuerFingerprint === item.fingerprint) cert.brokerTrusted = false;
    saveDb(db); await initializeCa(); await syncBroker(true);
    audit(req.user.username, 'ca.untrusted', item.fingerprint);
    res.json({ ok: true, enforcement: 'Broker restart requested; certificates from this CA are no longer trusted.' });
  }));
  app.get(
    '/api/certificates',
    requireAuth((_req, res) =>
      res.json({ certificates: loadDb().certificates.map(publicCertificate) }),
    ),
  );
  app.get(
    '/api/certificates/:id/download',
    requireAuth((req, res) => {
      const c = find(loadDb(), req.params.id);
      if (!c.certificate)
        return res
          .status(404)
          .json({ error: 'Public certificate is unavailable in imported record' });
      res.attachment('device.crt').send(c.certificate);
    }),
  );
  app.post(
    '/api/certificates/sign',
    requireAuth((req, res) => issue(req, res)),
  );
  app.post('/api/certificates/inspect-csr', requireAuth(async (req, res) => {
    if (typeof req.body.csr !== 'string' || req.body.csr.length > 65536) return res.status(400).json({ error: 'Provide a PEM CSR up to 64 KiB' });
    res.json(await inspectCsr(req.body.csr));
  }));
  app.post('/api/certificates/generate', requireAuth(async (req, res) => {
    const db = loadDb(), device = ensureIdentity(db, req.body);
    const { certificate, privateKey } = await issueGeneratedCertificate({ deviceId: device.id, algorithm: req.body.algorithm, days: req.body.days });
    const record = addIssuedRecord(db, { deviceId: device.id, certificate, method: 'gateway-generated', issuedBy: req.user.username });
    saveDb(db); await syncBroker(); audit(req.user.username, 'certificate.generated', `${device.id}:${record.serial}`);
    const clientCa = await fs.readFile(path.join(env.caDir, 'ca.crt'), 'utf8');
    const serverCa = clientCa;
    const zephyrReadme = `# ${device.id} MQTT credentials\n\nInstall device.crt and device.key in protected persistent storage. Register server-ca.crt as TLS_CREDENTIAL_CA_CERTIFICATE to verify the Gateway MQTT server, and register device.crt/device.key as TLS_CREDENTIAL_PUBLIC_CERTIFICATE/TLS_CREDENTIAL_PRIVATE_KEY. client-ca.crt identifies the issuer of the client certificate; it can differ from server-ca.crt. This private key is delivered only in this response; store it securely and do not commit it.\n`;
    if (req.body.bundle === true) {
      res.set('Cache-Control', 'no-store').type('application/zip').attachment(`${device.id}-zephyr-credentials.zip`).send(zipFiles({ 'device.crt': certificate, 'device.key': privateKey, 'client-ca.crt': clientCa, 'server-ca.crt': serverCa, 'README.md': zephyrReadme }));
    } else {
      res.set('Cache-Control', 'no-store').json({ certificate, privateKey, clientCa, serverCa, readme: zephyrReadme, record: publicCertificate(record), privateKeyDelivery: 'This is the only response containing the private key. Store it securely now.' });
    }
  }));
  app.post('/api/certificates/external-csr', requireAuth(async (req, res) => {
    const db = loadDb(), device = ensureIdentity(db, req.body);
    const pendingId = crypto.randomUUID();
    const generated = await generateExternalCsr({ deviceId: device.id, algorithm: req.body.algorithm, pendingId });
    const record = { id: pendingId, deviceId: device.id, csr: generated.csr, publicKey: generated.publicKey, publicKeyFingerprint: generated.preview.publicKeyFingerprint, algorithm: generated.algorithm, subject: generated.preview.subject, provisioningMethod: 'external-csr', status: 'pending_external_signature', issuedAt: new Date().toISOString(), issuedBy: req.user.username, privateKeyReceived: false };
    db.certificates.unshift(record); saveDb(db); audit(req.user.username, 'certificate.external_csr_created', `${device.id}:${record.id}`);
    res.status(201).json({ record: publicCertificate(record), csr: generated.csr, keyDeliveryExpiresInSeconds: 900 });
  }));
  app.get('/api/certificates/:id/private-key-once', requireAuth(async (req, res) => {
    const db = loadDb(), record = find(db, req.params.id);
    if (record.status !== 'pending_external_signature') return res.status(409).json({ error: 'No pending external CSR exists' });
    const device = deviceRecord(db, record.deviceId);
    if (device?.status !== 'active' || !device.enabled || device.trusted === false) return res.status(409).json({ error: 'Device identity is not approved for key delivery' });
    const key = await takePendingPrivateKey(record.id, record.deviceId);
    if (!key) return res.status(410).json({ error: 'Private-key delivery expired or already used; generate a new CSR' });
    res.set('Cache-Control', 'no-store').attachment(`${record.deviceId}.key`).type('application/x-pem-file').send(key);
  }));
  app.post('/api/certificates/:id/private-key-received', requireAuth(async (req, res) => {
    const db = loadDb(), record = find(db, req.params.id);
    if (record.status !== 'pending_external_signature' || !confirmPendingPrivateKey(record.id)) return res.status(409).json({ error: 'Download the one-time private key first' });
    record.privateKeyReceived = true;
    saveDb(db); audit(req.user.username, 'certificate.private_key_receipt_confirmed', record.id);
    res.json({ ok: true });
  }));
  app.post('/api/certificates/import', requireAuth(async (req, res) => {
    const db = loadDb(), pending = req.body.pendingId ? find(db, req.body.pendingId) : null;
    if (pending && (pending.status !== 'pending_external_signature' || !pending.privateKeyReceived)) return res.status(409).json({ error: 'Confirm receipt of the one-time private key before completing this CSR' });
    const deviceId = pending?.deviceId || String(req.body.deviceId || '');
    const device = ensureIdentity(db, { id: deviceId, name: req.body.name });
    const imported = await importClientCertificate({ certificate: req.body.certificate, chain: req.body.chain, privateKey: req.body.privateKey, expectedPublicKey: pending?.publicKey || '' });
    if (imported.commonName !== deviceId) return res.status(400).json({ error: 'Certificate subject CN must exactly match the MQTT identity' });
    if (db.certificates.some((c) => c.fingerprint === imported.metadata.fingerprint)) return res.status(409).json({ error: 'Certificate is already registered' });
    if ((db.deletedIdentities || []).some((entry) => entry.fingerprints?.includes(imported.metadata.fingerprint))) return res.status(409).json({ error: 'This certificate belongs to a permanently deleted identity' });
    const record = addIssuedRecord(db, { deviceId, certificate: imported.certificate, method: pending ? 'external-csr' : 'imported', issuer: imported.internal ? 'local' : 'external', brokerTrusted: imported.trusted, csr: pending?.csr || '', issuedBy: req.user.username });
    record.issuerName = imported.metadata.issuerName;
    record.chain = imported.chain; record.issuerFingerprint = imported.issuerFingerprint;
    if (pending) { pending.status = 'completed'; pending.completedAt = new Date().toISOString(); delete pending.publicKey; delete pending.csr; }
    saveDb(db); await syncBroker(true); audit(req.user.username, 'certificate.imported', `${deviceId}:${record.fingerprint}`);
    res.status(201).json({ record: publicCertificate(record), brokerTrusted: imported.trusted, message: imported.trusted ? 'Certificate is registered and trusted by the broker.' : 'Certificate is registered, but its issuer is not trusted by the broker.' });
  }));
  app.get('/api/certificates/:id/chain', requireAuth(async (req, res) => {
    const record = find(loadDb(), req.params.id);
    if (!record.certificate) return res.status(404).json({ error: 'Certificate is not issued yet' });
    const issuer = record.issuer === 'local' || record.issuer === 'legacy'
      ? await fs.readFile(path.join(env.caDir, 'ca.crt'), 'utf8')
      : record.chain || (loadDb().trustedCas || []).find((item) => item.fingerprint === record.issuerFingerprint)?.certificate || '';
    res.attachment('client-ca.crt').type('application/x-pem-file').send(issuer);
  }));
  app.post(
    '/api/certificates/:id/renew',
    requireAuth((req, res) => issue(req, res, find(loadDb(), req.params.id))),
  );
  app.post(
    '/api/certificates/:id/revoke',
    requireAuth(async (req, res) => {
      const db = loadDb(),
        c = find(db, req.params.id);
      if (c.status === 'revoked')
        return res.status(409).json({ error: 'Certificate already revoked' });
      let crlUpdated = true;
      if (c.issuer === 'local' || c.issuer === 'legacy') {
        try { await revokeCertificate(c); } catch { crlUpdated = false; }
      }
      c.status = 'revoked';
      c.revokedAt = new Date().toISOString();
      c.revokedBy = req.user.username;
      const device = deviceRecord(db, c.deviceId);
      if (device) { device.enabled = false; device.trusted = false; }
      saveDb(db);
      await syncBroker(true);
      audit(req.user.username, 'certificate.revoked', `${c.deviceId}:${c.serial}`);
      if (!crlUpdated) audit(req.user.username, 'certificate.crl_update_failed', `${c.deviceId}:${c.serial}`);
      res.json({
        certificate: publicCertificate(c),
        enforcement: crlUpdated ? 'Certificate CRL and device ACL updated; broker restart requested.' : 'CRL update failed. Device-wide ACL blocking was applied and the broker restart was requested.',
      });
    }),
  );
  app.get(
    '/api/devices',
    requireAuth((_req, res) => {
      const db = loadDb();
      const archived = _req.query.status === 'archived';
      res.json({
        devices: db.devices.filter((d) => archived ? d.status === 'archived' : d.status !== 'archived' && d.status !== 'deleted').map((d) => ({
          ...d,
          connectionStatus: 'unknown',
          lastActivity: null,
          certificates: db.certificates.filter((c) => c.deviceId === d.id).map(publicCertificate),
        })),
      });
    }),
  );
  app.post(
    '/api/devices',
    requireAuth((req, res) => {
      const db = loadDb(),
        id = String(req.body.id || '');
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || id === env.adminMqttClientId)
        return res.status(400).json({ error: 'Invalid or reserved identifier' });
      if (db.devices.some((d) => d.id === id) || (db.deletedIdentities || []).some((entry) => entry.id === id))
        return res.status(409).json({ error: 'Device already exists' });
      db.devices.push({
        id,
        name: String(req.body.name || id).slice(0, 100),
        description: String(req.body.description || '').slice(0, 1000),
        enabled: true,
        trusted: true,
        status: 'active',
        createdAt: new Date().toISOString(),
      });
      saveDb(db);
      audit(req.user.username, 'device.created', id);
      res.status(201).json({ ok: true });
    }),
  );
  app.patch(
    '/api/devices/:id',
    requireAuth(async (req, res) => {
      const db = loadDb(),
        d = db.devices.find((d) => d.id === req.params.id);
      if (!d) return res.status(404).json({ error: 'Device not found' });
      if (d.status !== 'active') return res.status(409).json({ error: 'Archived devices must be restored before changes' });
      if (typeof req.body.name === 'string') d.name = req.body.name.slice(0, 100);
      if (typeof req.body.description === 'string')
        d.description = req.body.description.slice(0, 1000);
      if (typeof req.body.enabled === 'boolean') { d.enabled = req.body.enabled; d.trusted = req.body.enabled; }
      saveDb(db);
      await syncBroker(true);
      audit(req.user.username, 'device.updated', d.id);
      res.json({ ok: true });
    }),
  );
  app.post('/api/devices/:id/archive', requireAuth(async (req, res) => {
    const db = loadDb(), device = deviceRecord(db, req.params.id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (req.body.confirm !== device.id) return res.status(400).json({ error: 'Confirm by entering the exact device identifier' });
    if (device.status !== 'active') return res.status(409).json({ error: 'Device is not active' });
    archiveDeviceRecord(device);
    for (const cert of db.certificates.filter((item) => item.deviceId === device.id && item.status === 'active')) {
      cert.status = 'blocked';
      cert.blockReason = 'identity-archived';
      cert.revokedAt = new Date().toISOString();
    }
    saveDb(db);
    await syncBroker(true);
    for (const cert of db.certificates.filter((item) => item.deviceId === device.id && item.blockReason === 'identity-archived' && (item.issuer === 'local' || item.issuer === 'legacy'))) {
      await revokeCertificate(cert);
      cert.status = 'revoked';
      saveDb(db);
    }
    await syncBroker(true);
    audit(req.user.username, 'device.archived', device.id);
    res.json({ device, enforcement: 'Broker restart requested; existing sessions are disconnected.' });
  }));
  app.post('/api/devices/:id/restore', requireAuth(async (req, res) => {
    const db = loadDb(), device = deviceRecord(db, req.params.id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    try { restoreDeviceRecord(device); } catch (error) { return res.status(409).json({ error: error.message }); }
    saveDb(db); await syncBroker(true); audit(req.user.username, 'device.restored_pending_approval', device.id);
    res.json({ device, requiresApproval: true, message: 'Device is restored but remains disabled until explicitly approved.' });
  }));
  app.post('/api/devices/:id/approve', requireAuth(async (req, res) => {
    const db = loadDb(), device = deviceRecord(db, req.params.id);
    if (!device || device.status !== 'active') return res.status(404).json({ error: 'Active device not found' });
    if (req.body.confirm !== device.id) return res.status(400).json({ error: 'Confirm approval by entering the exact device identifier' });
    device.enabled = true; device.trusted = true; device.approvedAt = new Date().toISOString(); device.approvedBy = req.user.username;
    saveDb(db); await syncBroker(true); audit(req.user.username, 'device.approved', device.id);
    res.json({ ok: true, enforcement: 'Broker revision requested.' });
  }));
  app.delete('/api/devices/:id', requireAuth(async (req, res) => {
    if (req.body.confirm !== `DELETE ${req.params.id}`) return res.status(400).json({ error: 'Type DELETE and the exact device identifier to confirm' });
    const db = loadDb();
    if (!deviceRecord(db, req.params.id)) return res.status(404).json({ error: 'Device not found' });
    await permanentlyDeleteDevice(db, req.params.id, req.user.username);
    res.json({ ok: true, message: 'Identity removed; public revocation evidence and a permanent identity tombstone were retained.' });
  }));
}
