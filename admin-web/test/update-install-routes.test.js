import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import argon2 from 'argon2';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-install-api-'));
process.env.ADMIN_DATA_DIR = path.join(directory, 'admin');
process.env.GATEWAY_UPDATER_DIR = path.join(directory, 'bridge');
fs.mkdirSync(process.env.GATEWAY_UPDATER_DIR, { mode: 0o700 });
const [{ registerUpdateRoutes }, db, reauth] = await Promise.all([import('../src/routes/update-routes.js'), import('../src/db.js'), import('../src/reauth.js')]);

test('installation requires scoped fresh authentication and forwards no credentials or commands to host', async () => {
  const calls = [];
  const socket = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      calls.push({ endpoint: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/status' ? { available: true, operation: null, history: [] } : { accepted: true }));
    });
  });
  await new Promise(resolve => socket.listen(path.join(process.env.GATEWAY_UPDATER_DIR, 'control.sock'), resolve));
  const app = express(); app.use(express.json()); registerUpdateRoutes(app);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = crypto.randomBytes(32).toString('base64url');
  const state = db.loadDb();
  state.users.push({ id: 'update-admin', username: 'update-admin', passwordHash: await argon2.hash('fixture-current-password'), credentials: [] });
  state.sessions[crypto.createHash('sha256').update(token).digest('hex')] = { userId: 'update-admin', expiresAt: Date.now() + 60_000 };
  db.saveDb(state);
  const request = (body, authenticated = true) => fetch(origin + '/api/system-updates/install', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: `admin_session=${token}` } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await request({ version: '1.1.0' }, false)).status, 401);
    assert.equal((await request({ version: '1.1.0', confirmation: 'wrong' })).status, 400);
    assert.equal((await request({ version: '1.1.0', confirmation: 'INSTALL 1.1.0', reauth: { method: 'password', password: 'incorrect' } })).status, 403);
    assert.equal(calls.length, 0);
    const accepted = await request({ version: '1.1.0', confirmation: 'INSTALL 1.1.0', reauth: { method: 'password', password: 'fixture-current-password' }, image: 'untrusted/image:latest', command: 'ignored' });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.headers.get('cache-control'), 'no-store');
    assert.deepEqual(calls, [{ endpoint: '/install', body: { version: '1.1.0' } }]);
    assert.ok(!JSON.stringify(calls).includes('fixture-current-password'));
    const progress = await fetch(origin + '/api/system-updates/progress', { headers: { Cookie: `admin_session=${token}` } });
    assert.equal(progress.status, 200);
    assert.equal(progress.headers.get('cache-control'), 'no-store');
    assert.equal(reauth.authenticationOperation('install-update', '1.1.0'), 'install-update:1.1.0');
    assert.notEqual(reauth.authenticationOperation('install-update', '1.2.0'), reauth.authenticationOperation('install-update', '1.1.0'));
    assert.throws(() => reauth.authenticationOperation('install-update', '../unsafe'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => socket.close(resolve));
    db.sqlite.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
