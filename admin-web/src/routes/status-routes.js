import fs from 'node:fs/promises';
import { pendingBrokerChanges } from '../services/pending-broker-changes.js';
import path from 'node:path';
import { env } from '../config.js';
import { requireAuth } from '../auth.js';
import { loadDb, auditLog, audit } from '../db.js';
import { certificateMetadata, applyBrokerChanges } from '../services/certificate-service.js';
import { mqttConnectionStatus } from '../services/mqtt-service.js';
async function brokerChangeStatus() {
  const read = (name) => fs.readFile(path.join(env.brokerDir, name), 'utf8').catch(() => null);
  const [revision, appliedRevision, pendingRevision] = await Promise.all([read('revision'), read('applied-revision'), read('pending-revision')]);
  const changes = pendingRevision ? await pendingBrokerChanges(revision) : [];
  return { changes, revision, appliedRevision, pendingRevision, pendingChanges: Boolean(pendingRevision), applied: Boolean(revision && revision === appliedRevision && !pendingRevision), applying: Boolean(!pendingRevision && revision && revision !== appliedRevision) };
}
export function registerStatusRoutes(app) {
  app.get('/api/broker/status', requireAuth(async (_req, res) => res.json(await brokerChangeStatus())));
  app.post('/api/broker/apply', requireAuth(async (req, res) => {
    const changed = await applyBrokerChanges();
    if (changed) audit(req.user.username, 'broker.changes_applied', 'Pending broker configuration submitted');
    res.json({ changed, ...await brokerChangeStatus() });
  }));
  app.get(
    '/api/status',
    requireAuth(async (_req, res) => {
      const db = loadDb(),
        now = Date.now();
      const read = (n) => fs.readFile(path.join(env.brokerDir, n), 'utf8').catch(() => null);
      const [revision, appliedRevision, ca, server] = await Promise.all([
        read('revision'),
        read('applied-revision'),
        read('ca.crt'),
        read('server.crt'),
      ]);
      res.json({
        hostname: env.hostname,
        domain: env.domain,
        publicIP: env.publicIP || null,
        localAddress: env.localAddress,
        publicUrl: env.origin,
        mqttTlsPort: env.mqttTlsPort,
        mqttWsPort: env.mqttWsPort,
        adminPort: env.port,
        topicPrefix: env.topicPrefix,
        mqtt: mqttConnectionStatus(),
        ca: ca ? certificateMetadata(ca) : null,
        serverCertificate: server ? certificateMetadata(server) : null,
        registeredDevices: db.devices.length,
        validCertificates: db.certificates.filter(
          (c) => c.status !== 'revoked' && Date.parse(c.validTo) > now,
        ).length,
        expiringCertificates: db.certificates.filter(
          (c) =>
            c.status !== 'revoked' &&
            Date.parse(c.validTo) > now &&
            Date.parse(c.validTo) < now + 30 * 86400000,
        ).length,
        expiredCertificates: db.certificates.filter((c) => Date.parse(c.validTo) <= now).length,
        enforcement: await brokerChangeStatus(),
        defaultDays: env.certDays,
        maxDays: env.maxCertDays,
      });
    }),
  );
  app.get(
    '/api/audit',
    requireAuth((_req, res) => res.json({ entries: auditLog() })),
  );
}
