import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config.js';
import { requireAuth } from '../auth.js';
import { loadDb, auditLog } from '../db.js';
import { certificateMetadata } from '../services/certificate-service.js';
import { mqttConnectionStatus } from '../services/mqtt-service.js';
export function registerStatusRoutes(app) {
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
        enforcement: {
          revision,
          appliedRevision,
          applied: Boolean(revision && revision === appliedRevision),
        },
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
