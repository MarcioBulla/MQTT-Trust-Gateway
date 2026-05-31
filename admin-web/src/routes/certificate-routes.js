import { requireAuth } from '../auth.js';
import { loadDb, saveDb } from '../db.js';
import { signDeviceCsr } from '../services/certificate-service.js';

export function registerCertificateRoutes(app) {
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
      db.certificates.push({ deviceId, issuedAt: new Date().toISOString(), issuedBy: req.user.username });
      await saveDb(db);
      res.json({ certificate });
    } catch (error) {
      res.status(500).json({ error: error.stderr || error.message });
    }
  }));
}
