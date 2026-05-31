import path from 'node:path';
import { env } from '../config.js';
import { requireAuth } from '../auth.js';
import { fileExists } from '../db.js';
import { mqttConnectionStatus } from '../services/mqtt-service.js';

export function registerStatusRoutes(app) {
  app.get('/api/status', requireAuth(async (_req, res) => {
    const certDir = path.join(env.letsencryptDir, 'live', env.mqttDomain);
    res.json({
      mqttDomain: env.mqttDomain,
      mqttTlsPort: env.mqttTlsPort,
      stepCaUrl: env.stepCaUrl,
      topicPrefix: env.topicPrefix,
      mqtt: mqttConnectionStatus(),
      files: {
        letsencryptFullchain: await fileExists(path.join(certDir, 'fullchain.pem')),
        letsencryptPrivateKey: await fileExists(path.join(certDir, 'privkey.pem')),
        mqttClientCa: await fileExists(env.clientCaFile),
        adminMqttCert: await fileExists(env.adminMqttCertFile),
        adminMqttKey: await fileExists(env.adminMqttKeyFile),
      },
    });
  }));
}
