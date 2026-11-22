import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import express from 'express';
import { registerHealthRoutes } from '../src/routes/health-routes.js';

let server;
let baseUrl;
let sqliteAvailable = true;
let readinessGate;
let onReadinessQueued;

before(async () => {
  const app = express();
  app.set('trust proxy', true);
  registerHealthRoutes(app, {
    sqlite: {
      prepare(sql) {
        assert.equal(sql, 'SELECT id FROM state WHERE id = 1');
        return { get: () => {
          if (!sqliteAvailable) throw new Error('/private/path/gateway.sqlite unavailable');
          return { id: 1 };
        } };
      },
    },
    async enqueue(check) {
      onReadinessQueued?.();
      await readinessGate;
      return check();
    },
    trustedProxies: ['127.0.0.1'],
    updateReady: () => true,
  });
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('GET /health is lightweight, public and never queries SQLite', async () => {
  sqliteAvailable = false;
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await response.json(), { status: 'healthy' });
});

test('GET /ready returns ready after a read-only SQLite check', async () => {
  sqliteAvailable = true;
  const response = await fetch(`${baseUrl}/ready`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ready' });
});

test('GET /ready returns a sanitized 503 when SQLite is unavailable', async () => {
  sqliteAvailable = false;
  const response = await fetch(`${baseUrl}/ready`);
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.equal(body, '{"status":"unavailable"}');
  assert.doesNotMatch(body, /gateway\.sqlite|private\/path|Error/);
});

test('GET /ready denies public clients reported through a trusted proxy', async () => {
  sqliteAvailable = true;
  const response = await fetch(`${baseUrl}/ready`, { headers: { 'x-forwarded-for': '203.0.113.45' } });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { status: 'unavailable' });
});

test('readiness endpoints deny forwarded private addresses as well', async () => {
  for (const endpoint of ['/ready', '/healthz']) {
    const response = await fetch(`${baseUrl}${endpoint}`, { headers: { 'x-forwarded-for': '10.0.0.1' } });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { status: 'unavailable' });
  }
});

test('GET /healthz preserves the updater readiness response with no caching', async () => {
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await response.json(), { ok: true, updateReady: true });
});

test('readiness waits for the API queue while liveness remains responsive', async () => {
  sqliteAvailable = true;
  let release;
  readinessGate = new Promise((resolve) => { release = resolve; });
  const queued = new Promise((resolve) => { onReadinessQueued = resolve; });
  const controller = new AbortController();
  const ready = fetch(`${baseUrl}/ready`, { signal: controller.signal });
  try {
    await queued;
    const live = await fetch(`${baseUrl}/health`);
    assert.equal(live.status, 200);
    controller.abort();
    await assert.rejects(ready, { name: 'AbortError' });
  } finally {
    release();
    readinessGate = undefined;
    onReadinessQueued = undefined;
  }
  assert.equal((await fetch(`${baseUrl}/ready`)).status, 200);
});
