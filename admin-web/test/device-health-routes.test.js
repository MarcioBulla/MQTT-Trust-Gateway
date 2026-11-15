import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('device health API requires step-up, validates rules and stages isolated health ACLs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-device-health-route-'));
  process.env.ADMIN_DATA_DIR = path.join(root, 'admin');
  process.env.CA_DIR = path.join(root, 'ca');
  process.env.BROKER_CONFIG_DIR = path.join(root, 'broker');
  process.env.PUBLIC_URL = 'http://localhost:8080';
  await fs.mkdir(process.env.BROKER_CONFIG_DIR, { recursive: true });

  const [{ loadDb, saveDb, sqlite }, { createSession, sessionKey }, { sensitiveGrants }, { registerDeviceHealthRoutes }] = await Promise.all([
    import('../src/db.js'), import('../src/auth.js'), import('../src/sensitive-grants.js'), import('../src/routes/device-health-routes.js'),
  ]);
  const db = loadDb();
  const user = { id: 'health-test-admin', username: 'health-test-admin', credentials: [] };
  db.users.push(user);
  db.devices.push(
    { id: 'device-a', name: 'Synthetic A', enabled: true, trusted: true, status: 'active', topicRules: { mode: 'custom', publish: ['gateway/health/+/status'], subscribe: [] } },
    { id: 'device-b', name: 'Synthetic B', enabled: true, trusted: true, status: 'active', topicRules: { mode: 'all' }, healthCheck: { enabled: true, topic: 'gateway/health/device-b/status' } },
  );
  for (const id of ['device-a', 'device-b']) db.certificates.push({ id: `cert-${id}`, deviceId: id, status: 'active', brokerTrusted: true, serial: id, validTo: new Date(Date.now() + 86400000).toISOString() });
  let cookie;
  createSession(db, user, { secure: false }, { setHeader(_name, value) { cookie = value.split(';')[0]; } });
  saveDb(db);
  await fs.writeFile(path.join(process.env.BROKER_CONFIG_DIR, 'revision'), 'already-applied');
  await fs.writeFile(path.join(process.env.BROKER_CONFIG_DIR, 'applied-revision'), 'already-applied');

  const app = express();
  app.use(express.json());
  registerDeviceHealthRoutes(app);
  const { registerCertificateRoutes } = await import('../src/routes/certificate-routes.js');
  registerCertificateRoutes(app);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: 'Request failed' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (url, session = cookie) => fetch(base + url, { headers: session ? { Cookie: session } : {} });
  const grant = sensitiveGrants.issue({ userId: user.id, sessionId: sessionKey({ headers: { cookie } }), scope: 'devices', sessionExpiresAt: Date.now() + 60000 });
  const authorizedCookie = `${cookie}; sensitive_devices=${grant.token}`;
  const put = (body, session = authorizedCookie) => fetch(`${base}/api/devices/device-a/health`, {
    method: 'PUT', headers: { Cookie: session, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await get('/api/devices/device-a/health', '')).status, 401);
    const denied = await get('/api/devices/device-a/health');
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'Additional authentication required', stepUpRequired: true, scope: 'devices' });
    assert.equal((await put({ enabled: true }, cookie)).status, 403);

    assert.equal((await put({ enabled: true, topic: 'outside/rules' })).status, 400);
    assert.equal((await put({ enabled: true, topic: 'gateway/health/+' })).status, 400);
    assert.equal((await put({ enabled: true, topic: 'gateway/health/device-b/status' })).status, 400);

    const response = await put({ enabled: true });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.config, { enabled: true, topic: 'gateway/health/device-a/status', offlineGrace: 30, recoveryStability: 5 });
    assert.equal(result.status, 'unknown');
    assert.match(result.message, /Apply pending broker changes/);
    assert.equal((await fs.readFile(path.join(process.env.BROKER_CONFIG_DIR, 'revision'), 'utf8')), 'already-applied');
    assert.ok(await fs.readFile(path.join(process.env.BROKER_CONFIG_DIR, 'pending-revision'), 'utf8'));
    const acl = await fs.readFile(path.join(process.env.BROKER_CONFIG_DIR, 'acl'), 'utf8');
    assert.match(acl, /user device-a\ntopic deny gateway\/health\/device-b\/status\ntopic write gateway\/health\/\+\/status/);
    assert.match(acl, /user device-b\ntopic deny gateway\/health\/device-a\/status\ntopic readwrite #/);
    assert.equal(loadDb().devices.find((device) => device.id === 'device-a').healthCheck.topic, 'gateway/health/device-a/status');
    const listing = await (await get('/api/devices')).json();
    assert.ok(listing.devices.every((device) => device.healthCheck === undefined));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    sensitiveGrants.revoke(grant.token);
    sqlite.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
