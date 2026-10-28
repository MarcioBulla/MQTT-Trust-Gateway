import crypto from 'node:crypto';
import path from 'node:path';
import { env } from '../config.js';
import { requireAuth } from '../auth.js';
import { loadDb, saveDb, audit } from '../db.js';
import {
  certificateMetadata,
  signDeviceCsr,
  revokeCertificate,
  syncBroker,
} from '../services/certificate-service.js';
const find = (db, id) => {
  const c = db.certificates.find((c) => c.id === id);
  if (!c) throw Object.assign(new Error('Certificate not found'), { status: 404 });
  return c;
};
const state = (c) =>
  c.status === 'revoked'
    ? 'revoked'
    : Date.parse(c.validTo) <= Date.now()
      ? 'expired'
      : Date.parse(c.validTo) < Date.now() + 30 * 86400000
        ? 'expiring'
        : 'active';
export function publicCertificate(c) {
  const { csr, certificate, ...publicData } = c;
  return { ...publicData, status: state(c), canDownload: Boolean(certificate) };
}
async function issue(req, res, previous) {
  const db = loadDb(),
    deviceId = previous?.deviceId || String(req.body.deviceId || '');
  const device = db.devices.find((d) => d.id === deviceId);
  if (!device?.enabled)
    return res.status(409).json({ error: 'Register or enable the device first' });
  const csr = req.body.csr || previous?.csr;
  if (typeof csr !== 'string' || !csr.includes('BEGIN CERTIFICATE REQUEST'))
    return res.status(400).json({ error: 'A PEM CSR is required' });
  const certificate = await signDeviceCsr({ deviceId, csr, days: req.body.days });
  const record = {
    id: crypto.randomUUID(),
    deviceId,
    certificate,
    csr,
    status: 'active',
    issuedAt: new Date().toISOString(),
    issuedBy: req.user.username,
    renewedFrom: previous?.id || '',
    ...certificateMetadata(certificate),
  };
  db.certificates.unshift(record);
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
      await revokeCertificate(c);
      c.status = 'revoked';
      c.revokedAt = new Date().toISOString();
      c.revokedBy = req.user.username;
      saveDb(db);
      await syncBroker(true);
      audit(req.user.username, 'certificate.revoked', `${c.deviceId}:${c.serial}`);
      res.json({
        certificate: publicCertificate(c),
        enforcement: 'Broker restart requested; check dashboard applied revision',
      });
    }),
  );
  app.get(
    '/api/devices',
    requireAuth((_req, res) => {
      const db = loadDb();
      res.json({
        devices: db.devices.map((d) => ({
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
      if (db.devices.some((d) => d.id === id))
        return res.status(409).json({ error: 'Device already exists' });
      db.devices.push({
        id,
        name: String(req.body.name || id).slice(0, 100),
        description: String(req.body.description || '').slice(0, 1000),
        enabled: true,
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
      if (typeof req.body.name === 'string') d.name = req.body.name.slice(0, 100);
      if (typeof req.body.description === 'string')
        d.description = req.body.description.slice(0, 1000);
      if (typeof req.body.enabled === 'boolean') d.enabled = req.body.enabled;
      saveDb(db);
      await syncBroker(true);
      audit(req.user.username, 'device.updated', d.id);
      res.json({ ok: true });
    }),
  );
}
