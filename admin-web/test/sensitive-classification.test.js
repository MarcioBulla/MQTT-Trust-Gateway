import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

test('ordinary device metadata stays visible while serials and fingerprints require a reveal grant', async () => {
  process.env.ADMIN_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'sensitive-list-'));
  const { loadDb, saveDb, sqlite } = await import('../src/db.js');
  const { createSession, sessionKey } = await import('../src/auth.js');
  const { sensitiveGrants } = await import('../src/sensitive-grants.js');
  const { guardSensitiveApi } = await import('../src/sensitive-access.js');
  const { registerCertificateRoutes } = await import('../src/routes/certificate-routes.js');
  const db = loadDb(), user = { id: 'classification-user', username: 'classification', credentials: [] };
  db.users.push(user);
  db.devices.push({ id: 'ordinary-device', name: 'Visible name', labels: [{ name: 'Visible label', color: 'blue' }], enabled: true, trusted: true, status: 'active' });
  db.certificates.push({ id: 'certificate-id', deviceId: 'ordinary-device', serial: 'SECRET-SERIAL', fingerprint: 'SECRET-FINGERPRINT', subject: 'CN=ordinary-device', san: 'SECRET-SAN', issuerFingerprint: 'SECRET-ISSUER-FINGERPRINT', algorithm: 'ECDSA-prime256v1', provisioningMethod: 'gateway-generated', validFrom: '2026-10-01T00:00:00Z', validTo: '2027-10-01T00:00:00Z', issuedAt: '2026-10-01T00:00:00Z', status: 'active' });
  db.trustedCas.push({ id: 'ca-id', subject: 'Visible issuer', serial: 'SECRET-CA-SERIAL', fingerprint: 'SECRET-CA-FINGERPRINT', certificate: 'SECRET-CA-PEM' });
  let cookie;
  createSession(db, user, { secure: false }, { setHeader(_key, value) { cookie = value.split(';')[0]; } });
  saveDb(db);
  const app = express(); app.use(express.json()); app.use('/api', guardSensitiveApi); registerCertificateRoutes(app);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const get = (route, session = cookie) => fetch(`http://127.0.0.1:${server.address().port}/api${route}`, { headers: { Cookie: session } });
  try {
    assert.equal((await get('/devices', '')).status, 401);
    for (const route of ['/devices', '/certificates', '/trusted-cas']) {
      const response = await get(route); assert.equal(response.status, 200);
      const text = await response.text(); assert.equal(text.includes('SECRET-'), false, route);
    }
    const { devices } = await (await get('/devices')).json();
    assert.equal(devices[0].name, 'Visible name'); assert.equal(devices[0].labels[0].name, 'Visible label'); assert.equal(devices[0].enabled, true);
    const certificate = devices[0].certificates[0];
    for (const field of ['subject', 'algorithm', 'provisioningMethod', 'issuedAt', 'validFrom', 'validTo', 'status']) assert.ok(certificate[field]);
    assert.equal((await get('/certificates/certificate-id/download')).status, 403);
    const grant = sensitiveGrants.issue({ userId: user.id, sessionId: sessionKey({ headers: { cookie } }), scope: 'devices' });
    const revealedCookie = `${cookie}; sensitive_devices=${grant.token}`;
    const revealed = await (await get('/certificates', revealedCookie)).json(); assert.equal(revealed.certificates[0].serial, 'SECRET-SERIAL');
    sensitiveGrants.revoke(grant.token);
    assert.equal((await (await get('/certificates', revealedCookie)).text()).includes('SECRET-SERIAL'), false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); sqlite.close(); }
});
