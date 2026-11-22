import { startClientRenewal, stopClientRenewal, beginClientRenewal, approveClientRenewal, clientRenewalStatus } from './services/client-renewal-service.js';
import { requireAuth } from './auth.js';
import { requireSensitive } from './sensitive-access.js';
import { updatePreferences } from './services/update-preferences.js';
import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './config.js';
import { exclusive, audit, loadDb, sqlite } from './db.js';
import { registerHealthRoutes } from './routes/health-routes.js';
import { registerAdminRoutes } from './routes/admin-routes.js';
import { startMqtt, stopMqtt } from './services/mqtt-service.js';
import { refreshPki, syncBroker, hasPendingProvisioningDelivery } from './services/certificate-service.js';
import { purgeExpiredArchives } from './services/identity-service.js';
import { captureAdminLogs } from './services/runtime-logs.js';
import { checkForGatewayUpdates } from './services/system-updates.js';
import { updateMaintenance } from './services/updater-client.js';
import { startDeviceHealthMonitor, stopDeviceHealthMonitor } from './services/device-health-monitor.js';
captureAdminLogs();
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env.trustedProxies.length ? env.trustedProxies : false);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    strictTransportSecurity: false,
  }),
);
registerHealthRoutes(app, {
  sqlite,
  enqueue: exclusive,
  updateReady: () => !hasPendingProvisioningDelivery(),
});
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(req.hostname);
  if (
    !req.secure &&
    !(local && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.origin).hostname))
  )
    return res
      .status(403)
      .json({ error: 'Administrative access requires HTTPS. Use localhost for local setup.' });
  if (req.headers.origin && !env.allowedOrigins.includes(req.headers.origin))
    return res.status(403).json({ error: 'Origin is not allowed' });
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
    (!env.allowedOrigins.includes(req.headers.origin) || !req.is('application/json'))
  )
    return res
      .status(403)
      .json({ error: 'Mutation requires an allowed Origin and application/json' });
  next();
});
app.use(express.json({ limit: '128kb' }));
app.use('/api', (req, res, next) => {
  if (updateMaintenance() && !['GET', 'HEAD', 'OPTIONS'].includes(req.method))
    return res.status(503).json({ error: 'Gateway update maintenance is active', maintenance: true });
  next();
});
app.post('/api/devices/:deviceId/mqtt-renewals', requireAuth(async (req, res) => {
  if (!requireSensitive(req, res, 'devices')) return;
  const id = await beginClientRenewal(req.params.deviceId, req.body?.certificateId, req.body?.topics, req.body?.cnPolicy);
  res.status(202).json({ id });
}));
app.post('/api/devices/:deviceId/mqtt-renewals/:id/approve', requireAuth(async (req, res) => {
  if (!requireSensitive(req, res, 'devices')) return;
  res.json(await approveClientRenewal(req.params.deviceId, req.params.id, req.body?.cn));
}));
app.get('/api/devices/:deviceId/mqtt-renewals', requireAuth((req, res) => {
  res.json(clientRenewalStatus(req.params.deviceId));
}));
app.get('/api/devices/:deviceId/mqtt-renewals/:id', requireAuth((req, res) => {
  const operation = clientRenewalStatus(req.params.deviceId, req.params.id);
  if (!operation) return res.status(404).json({ error: 'Renewal not found' });
  res.json(operation);
}));
app.use('/api', (req, res, next) => {
  if (req.path === '/mqtt/events' || req.path === '/logs/events' || req.path === '/system-updates/status' || req.path === '/system-updates/check') return next();
  exclusive(
    () =>
      new Promise((resolve) => {
        res.once('finish', resolve);
        res.once('close', resolve);
        if (updateMaintenance() && !['GET', 'HEAD', 'OPTIONS'].includes(req.method))
          res.status(503).json({ error: 'Gateway update maintenance is active', maintenance: true });
        else next();
      }),
  ).catch(next);
});
registerAdminRoutes(app);
app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' }));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
app.use(express.static(dist, { etag: true, maxAge: 0 }));
app.get(/.*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
app.use((error, req, res, _next) => {
  const status = error.status || 500;
  audit(req.user?.username || 'anonymous', 'request.failed', `${req.method} ${req.path}`);
  console.error(`${req.method} ${req.path}: ${error.message}`);
  res.status(status).json({
    error:
      status === 500 ? 'Operation failed. Check the administrative service log.' : error.message,
  });
});
await exclusive(async () => {
  const purged = updateMaintenance() ? [] : await purgeExpiredArchives();
  if (purged.length) await syncBroker(true);
});
startMqtt();
startDeviceHealthMonitor();
startClientRenewal();
const aclTimer = setInterval(
  () => exclusive(() => updateMaintenance() ? undefined : syncBroker()).catch((e) => console.error(e.message)),
  30000,
);
const pkiTimer = setInterval(
  () =>
    exclusive(async () => {
      if (updateMaintenance()) return;
      await refreshPki();
      await stopMqtt();
      startMqtt();
    }).catch((e) => console.error(e.message)),
  86400000,
);
const archiveTimer = setInterval(
  () => exclusive(() => updateMaintenance() ? [] : purgeExpiredArchives()).catch((e) => console.error(e.message)),
  60000,
);
let lastAutomaticUpdateCheck = 0;
const refreshReleaseInfo = () => {
  const preferences = updatePreferences(loadDb().settings);
  if (!preferences.automaticChecks || Date.now() - lastAutomaticUpdateCheck < preferences.checkIntervalHours * 3600000) return;
  lastAutomaticUpdateCheck = Date.now();
  checkForGatewayUpdates({ channel: preferences.channel }).catch(() => {});
};
refreshReleaseInfo();
const updateTimer = setInterval(refreshReleaseInfo, 60 * 1000);
const server =
  env.tlsCert && env.tlsKey
    ? https.createServer(
        {
          cert: fs.readFileSync(env.tlsCert),
          key: fs.readFileSync(env.tlsKey),
          minVersion: 'TLSv1.2',
        },
        app,
      )
    : app;
const listener = server.listen(env.port, env.host, () =>
  console.log(`Admin listening on ${env.host}:${env.port}`),
);
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopDeviceHealthMonitor();
    clearInterval(aclTimer);
    clearInterval(pkiTimer);
    clearInterval(archiveTimer);
    clearInterval(updateTimer);
    listener.close();
    await stopClientRenewal();
    await exclusive(stopMqtt);
    process.exit(0);
  });
