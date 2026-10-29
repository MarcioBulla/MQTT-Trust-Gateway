import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-logs-'));
process.env.ADMIN_DATA_DIR = path.join(root, 'admin');
process.env.BROKER_CONFIG_DIR = path.join(root, 'broker');
const { appendAdminLog, logSnapshot, LOG_LIMIT, LOG_TAIL_BYTES } = await import('../src/services/runtime-logs.js');
const { loadDb, saveDb, sqlite } = await import('../src/db.js');
const { createSession } = await import('../src/auth.js');
const { registerLogRoutes } = await import('../src/routes/log-routes.js');

test('service log tails are bounded, redact admin secrets, rotate, and reject arbitrary paths', async () => {
  appendAdminLog('error', 'password=private-test-value', '-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----');
  const snapshot = await logSnapshot('admin');
  assert.match(snapshot.text, /REDACTED/);
  assert.doesNotMatch(snapshot.text, /private-test-value|private material/);
  await fs.writeFile(path.join(root, 'admin/logs/admin.log'), 'x'.repeat(LOG_LIMIT));
  appendAdminLog('info', 'after rotation');
  assert.ok((await fs.stat(path.join(root, 'admin/logs/admin.log.1'))).size <= LOG_LIMIT);
  assert.match((await logSnapshot('admin')).text, /after rotation/);
  await fs.mkdir(path.join(root, 'broker/logs'), { recursive: true });
  await fs.writeFile(path.join(root, 'broker/logs/mosquitto.log'), 'broker connection\n'.repeat(20000));
  const broker = await logSnapshot('broker');
  assert.ok(Buffer.byteLength(broker.text) <= LOG_TAIL_BYTES);
  assert.ok(broker.text.split('\n').length <= 500);
  await assert.rejects(logSnapshot('../../ca/ca.key'), /Unknown log source/);
  await fs.unlink(path.join(root, 'broker/logs/mosquitto.log'));
  await fs.symlink(path.join(root, 'admin/logs/admin.log'), path.join(root, 'broker/logs/mosquitto.log'));
  await assert.rejects(logSnapshot('broker'));
});

test('live log SSE requires authentication, follows new lines, and ends when the session expires', async (t) => {
  const app = express(); registerLogRoutes(app);
  const db = loadDb(), user = { id: 'log-admin', username: 'log-admin' };
  db.users.push(user);
  let cookie;
  createSession(db, user, { secure: false }, { setHeader: (_name, value) => { cookie = value.split(';')[0]; } }); saveDb(db);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); sqlite.close(); await fs.rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/api/logs/events`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(`${url}?source=../../ca/ca.key`, { headers: { Cookie: cookie } })).status, 400);
  const response = await fetch(`${url}?source=admin`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const read = () => Promise.race([reader.read(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Log stream timed out')), 5000); timer.unref(); })]);
  assert.match(decoder.decode((await read()).value), /after rotation/);
  appendAdminLog('info', 'live follow test marker');
  assert.match(decoder.decode((await read()).value), /live follow test marker/);
  const expired = loadDb(); expired.sessions = {}; saveDb(expired);
  let ended = false;
  for (let i = 0; i < 3 && !ended; i++) ended = (await read()).done;
  assert.equal(ended, true);
});
