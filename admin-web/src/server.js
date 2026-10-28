import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './config.js';
import { exclusive, audit } from './db.js';
import { registerAdminRoutes } from './routes/admin-routes.js';
import { startMqtt, stopMqtt } from './services/mqtt-service.js';
import { refreshPki, syncBroker } from './services/certificate-service.js';
import { purgeExpiredArchives } from './services/identity-service.js';
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
app.get('/healthz', (_req, res) => res.json({ ok: true }));
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
  if (req.path === '/mqtt/events') return next();
  exclusive(
    () =>
      new Promise((resolve) => {
        res.once('finish', resolve);
        res.once('close', resolve);
        next();
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
  const purged = await purgeExpiredArchives();
  if (purged.length) await syncBroker(true);
});
startMqtt();
const aclTimer = setInterval(
  () => exclusive(() => syncBroker()).catch((e) => console.error(e.message)),
  30000,
);
const pkiTimer = setInterval(
  () =>
    exclusive(async () => {
      await refreshPki();
      await stopMqtt();
      startMqtt();
    }).catch((e) => console.error(e.message)),
  86400000,
);
const archiveTimer = setInterval(
  () => exclusive(purgeExpiredArchives).catch((e) => console.error(e.message)),
  60000,
);
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
    clearInterval(aclTimer);
    clearInterval(pkiTimer);
    clearInterval(archiveTimer);
    listener.close();
    await exclusive(stopMqtt);
    process.exit(0);
  });
