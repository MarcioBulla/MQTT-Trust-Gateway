import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '../config.js';
import { requireAuth } from '../auth.js';
import { fileExists, loadDb, saveDb } from '../db.js';

const execFileAsync = promisify(execFile);

export function registerGatewayRoutes(app) {
  app.get('/api/status', requireAuth(async (_req, res) => {
    const certDir = path.join(env.letsencryptDir, 'live', env.mqttDomain);
    res.json({
      mqttDomain: env.mqttDomain,
      stepCaUrl: env.stepCaUrl,
      topicPrefix: env.topicPrefix,
      files: {
        letsencryptFullchain: await fileExists(path.join(certDir, 'fullchain.pem')),
        letsencryptPrivateKey: await fileExists(path.join(certDir, 'privkey.pem')),
        mqttClientCa: await fileExists(env.clientCaFile),
      },
    });
  }));

  app.post('/api/certificates/sign', requireAuth(async (req, res) => {
    const deviceId = String(req.body.deviceId || '').trim();
    const csr = String(req.body.csr || '').trim();
    const provisionerPassword = String(req.body.provisionerPassword || '');
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(deviceId)) return res.status(400).json({ error: 'invalid device id' });
    if (!csr.includes('BEGIN CERTIFICATE REQUEST')) return res.status(400).json({ error: 'CSR PEM is required' });
    if (!provisionerPassword) return res.status(400).json({ error: 'provisioner password is required' });
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mqtt-trust-csr-'));
    const csrFile = path.join(workDir, `${deviceId}.csr`);
    const crtFile = path.join(workDir, `${deviceId}.crt`);
    const passwordFile = path.join(workDir, 'password');
    try {
      await fs.writeFile(csrFile, `${csr}\n`, { mode: 0o600 });
      await fs.writeFile(passwordFile, `${provisionerPassword}\n`, { mode: 0o600 });
      await execFileAsync('step', [
        'ca', 'sign', csrFile, crtFile,
        '--ca-url', env.stepCaUrl,
        '--root', env.clientCaFile,
        '--provisioner', env.stepCaProvisioner,
        '--provisioner-password-file', passwordFile,
        '--not-after', env.stepCaTtl,
        '--force',
      ], { timeout: 30000 });
      const certificate = await fs.readFile(crtFile, 'utf8');
      const db = await loadDb();
      db.certificates.push({ deviceId, issuedAt: new Date().toISOString(), issuedBy: req.user.username });
      await saveDb(db);
      res.json({ certificate });
    } catch (error) {
      res.status(500).json({ error: error.stderr || error.message });
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }));
}
