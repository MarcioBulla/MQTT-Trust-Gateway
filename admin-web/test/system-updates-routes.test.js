import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-update-routes-'));
process.env.ADMIN_DATA_DIR = path.join(testDir, 'admin');
const [{ registerUpdateRoutes }, db, updates] = await Promise.all([
  import('../src/routes/update-routes.js'),
  import('../src/db.js'),
  import('../src/services/system-updates.js'),
]);
const app = express();
app.use(express.json());
registerUpdateRoutes(app);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

test('release settings require an authenticated administrator and reject unknown channels', async (t) => {
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(testDir, { recursive: true, force: true });
  });
  const unauthorized = await fetch(`${baseUrl}/api/system-updates/config`);
  assert.equal(unauthorized.status, 401);

  const token = crypto.randomBytes(32).toString('base64url');
  const sessionId = crypto.createHash('sha256').update(token).digest('hex');
  const state = db.loadDb();
  state.users.push({ id: 'admin-test', username: 'admin-test' });
  state.sessions[sessionId] = { userId: 'admin-test', expiresAt: Date.now() + 60_000 };
  db.saveDb(state);
  const headers = { cookie: `admin_session=${token}`, 'content-type': 'application/json' };

  const badChannel = await fetch(`${baseUrl}/api/system-updates/config`, { method: 'PATCH', headers, body: JSON.stringify({ channel: 'nightly' }) });
  assert.equal(badChannel.status, 400);
  const changed = await fetch(`${baseUrl}/api/system-updates/config`, { method: 'PATCH', headers, body: JSON.stringify({ channel: 'beta' }) });
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), { channel: 'beta', automaticChecks: true, checkIntervalHours: 6, snapshotRetention: 5, notifications: true, automaticInstallation: false });
  const config = await fetch(`${baseUrl}/api/system-updates/config`, { headers });
  assert.equal((await config.json()).channel, 'beta');
  assert.equal(config.headers.get('cache-control'), 'no-store');

  updates.configureUpdateFetchForTests(async () => new Response(JSON.stringify([
    { tag_name: 'v9.0.0', name: 'Gateway 9.0.0', assets: [], body: 'Update notes' },
  ]), { status: 200, headers: { etag: '"route-fixture"' } }));
  const status = await fetch(`${baseUrl}/api/system-updates/status?channel=stable`, { headers });
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.equal((await status.json()).latest.version, '9.0.0');
  updates.configureUpdateFetchForTests();
});
