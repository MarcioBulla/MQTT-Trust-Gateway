import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import argon2 from 'argon2';

test('visibility preferences require authentication and control server-side reveal grants', async () => {
  process.env.ADMIN_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'visibility-policy-'));
  const { loadDb, saveDb, sqlite } = await import('../src/db.js');
  const { createSession } = await import('../src/auth.js');
  const { registerSensitiveRoutes } = await import('../src/routes/sensitive-routes.js');
  const { sensitiveGrants } = await import('../src/sensitive-grants.js');
  const { sessionKey } = await import('../src/auth.js');
  const user = { id: 'policy-admin', username: 'policy-admin', credentials: [], passwordHash: await argon2.hash('Isolated test password') };
  const db = loadDb(); db.users.push(user);
  let cookie;
  createSession(db, user, { secure: false }, { cookie() {}, setHeader(_name, value) { cookie = value.split(';')[0]; } });
  saveDb(db);
  const app = express(); app.use(express.json()); registerSensitiveRoutes(app);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  async function request(url, body, method = 'POST') {
    return fetch(`http://127.0.0.1:${server.address().port}/api${url}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  try {
    assert.equal((await request('/sensitive/reveal', { scope: 'devices' })).status, 403);
    assert.equal((await request('/me/sensitive-preferences', { timeoutSeconds: 20, requireAuthentication: false }, 'PATCH')).status, 403);
    const reauth = { method: 'password', password: 'Isolated test password' };
    assert.equal((await request('/me/sensitive-preferences', { timeoutSeconds: 0, requireAuthentication: false, reauth }, 'PATCH')).status, 400);
    assert.equal((await request('/me/sensitive-preferences', { timeoutSeconds: 20, requireAuthentication: false, reauth }, 'PATCH')).status, 200);
    const revealed = await request('/sensitive/reveal', { scope: 'devices' });
    assert.equal(revealed.status, 200); assert.equal(revealed.headers.get('cache-control'), 'no-store');
    const grant = await revealed.json(); assert.ok(grant.expiresInMs > 19000 && grant.expiresInMs <= 20000);
    const token = revealed.headers.get('set-cookie').match(/sensitive_devices=([^;]+)/)[1];
    assert.equal(sensitiveGrants.allows(token, { userId: user.id, sessionId: sessionKey({ headers: { cookie } }), scope: 'devices' }), true);
    assert.equal((await request('/me/sensitive-preferences', { timeoutSeconds: 60, requireAuthentication: true, reauth }, 'PATCH')).status, 200);
    assert.equal(sensitiveGrants.allows(token, { userId: user.id, sessionId: sessionKey({ headers: { cookie } }), scope: 'devices' }), false);
    assert.equal((await request('/sensitive/reveal', { scope: 'devices' })).status, 403);
    const verified = sensitiveGrants.issue({ userId: user.id, sessionId: sessionKey({ headers: { cookie } }), scope: 'reveal-auth', lifetimeMs: 20000 });
    cookie += `; sensitive_reveal-auth=${verified.token}`;
    assert.equal((await request('/sensitive/reveal', { scope: 'mqtt' })).status, 200);
    sensitiveGrants.revoke(verified.token);
    assert.equal((await request('/sensitive/reveal', { scope: 'mqtt' })).status, 403);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); sqlite.close(); }
});
