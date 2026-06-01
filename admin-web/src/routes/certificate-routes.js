import crypto from 'node:crypto';
import { requireAuth } from '../auth.js';
import { loadDb, saveDb } from '../db.js';
import { env } from '../config.js';
import { certificateMetadata, revokeCertificate, signDeviceCsr } from '../services/certificate-service.js';

function publicCertificate(certificate) {
  return {
    id: certificate.id,
    deviceId: certificate.deviceId,
    serial: certificate.serial || '',
    subject: certificate.subject || '',
    issuedAt: certificate.issuedAt,
    issuedBy: certificate.issuedBy,
    validFrom: certificate.validFrom || '',
    validTo: certificate.validTo || '',
    status: certificate.status || 'active',
    revokedAt: certificate.revokedAt || '',
    revokedBy: certificate.revokedBy || '',
    renewedFrom: certificate.renewedFrom || '',
    canDownload: Boolean(certificate.certificate),
    canRenew: Boolean(certificate.csr),
    canRevoke: Boolean(certificate.serial) && (certificate.status || 'active') === 'active',
  };
}

function findCertificate(db, id) {
  return db.certificates.find((certificate) => certificate.id === id);
}

function ensureCertificateIds(db) {
  let changed = false;
  for (const certificate of db.certificates) {
    if (!certificate.id) {
      certificate.id = crypto.randomUUID();
      changed = true;
    }
    certificate.status ||= 'active';
  }
  return changed;
}

function storeIssuedCertificate(db, { deviceId, csr, certificate, issuedBy, renewedFrom = '' }) {
  const metadata = certificateMetadata(certificate);
  const record = {
    id: crypto.randomUUID(),
    deviceId,
    csr,
    certificate,
    issuedAt: new Date().toISOString(),
    issuedBy,
    status: 'active',
    renewedFrom,
    ...metadata,
  };
  db.certificates.unshift(record);
  return record;
}

export function registerCertificateRoutes(app) {
  app.get('/api/certificates/ca', requireAuth((_req, res) => {
    res.download(env.clientCaFile, 'mqtt-trust-gateway-ca.crt');
  }));

  app.get('/api/certificates', requireAuth(async (_req, res) => {
    const db = await loadDb();
    if (ensureCertificateIds(db)) await saveDb(db);
    res.json({ certificates: db.certificates.map(publicCertificate) });
  }));

  app.get('/api/certificates/:id/download', requireAuth(async (req, res) => {
    const db = await loadDb();
    const certificate = findCertificate(db, req.params.id);
    if (!certificate?.certificate) return res.status(404).json({ error: 'certificate not found' });
    res.setHeader('content-type', 'application/x-pem-file');
    res.setHeader('content-disposition', `attachment; filename="${certificate.deviceId || 'device'}.crt"`);
    res.send(certificate.certificate);
  }));

  app.post('/api/certificates/sign', requireAuth(async (req, res) => {
    const deviceId = String(req.body.deviceId || '').trim();
    const csr = String(req.body.csr || '').trim();
    const provisionerPassword = String(req.body.provisionerPassword || '');
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(deviceId)) return res.status(400).json({ error: 'invalid device id' });
    if (!csr.includes('BEGIN CERTIFICATE REQUEST')) return res.status(400).json({ error: 'CSR PEM is required' });
    if (!provisionerPassword) return res.status(400).json({ error: 'provisioner password is required' });

    try {
      const certificate = await signDeviceCsr({ deviceId, csr, provisionerPassword });
      const db = await loadDb();
      const record = storeIssuedCertificate(db, {
        deviceId,
        csr,
        certificate,
        issuedBy: req.user.username,
      });
      await saveDb(db);
      res.json({ certificate, record: publicCertificate(record) });
    } catch (error) {
      res.status(500).json({ error: error.stderr || error.message });
    }
  }));

  app.post('/api/certificates/:id/revoke', requireAuth(async (req, res) => {
    const provisionerPassword = String(req.body.provisionerPassword || '');
    const reason = String(req.body.reason || 'keyCompromise');
    if (!provisionerPassword) return res.status(400).json({ error: 'provisioner password is required' });

    const db = await loadDb();
    const certificate = findCertificate(db, req.params.id);
    if (!certificate) return res.status(404).json({ error: 'certificate not found' });
    if (!certificate.serial) return res.status(400).json({ error: 'certificate serial is not available' });
    if ((certificate.status || 'active') === 'revoked') return res.status(409).json({ error: 'certificate already revoked' });

    try {
      await revokeCertificate({ serial: certificate.serial, provisionerPassword, reason });
      certificate.status = 'revoked';
      certificate.revokedAt = new Date().toISOString();
      certificate.revokedBy = req.user.username;
      certificate.revocationReason = reason;
      await saveDb(db);
      res.json({ certificate: publicCertificate(certificate) });
    } catch (error) {
      res.status(500).json({ error: error.stderr || error.message });
    }
  }));

  app.post('/api/certificates/:id/renew', requireAuth(async (req, res) => {
    const provisionerPassword = String(req.body.provisionerPassword || '');
    if (!provisionerPassword) return res.status(400).json({ error: 'provisioner password is required' });

    const db = await loadDb();
    const certificate = findCertificate(db, req.params.id);
    if (!certificate) return res.status(404).json({ error: 'certificate not found' });
    if (!certificate.csr) return res.status(400).json({ error: 'original CSR is not available for renewal' });

    try {
      const renewedCertificate = await signDeviceCsr({
        deviceId: certificate.deviceId,
        csr: certificate.csr,
        provisionerPassword,
      });
      const record = storeIssuedCertificate(db, {
        deviceId: certificate.deviceId,
        csr: certificate.csr,
        certificate: renewedCertificate,
        issuedBy: req.user.username,
        renewedFrom: certificate.id,
      });
      await saveDb(db);
      res.json({ certificate: renewedCertificate, record: publicCertificate(record) });
    } catch (error) {
      res.status(500).json({ error: error.stderr || error.message });
    }
  }));
}
