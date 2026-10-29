import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import express from 'express';
import { normalizeTimeZone, timestampParts } from '../shared/time-zone.js';

test('time zones validate IANA identifiers and format UTC instants with DST and day boundaries', () => {
  assert.equal(normalizeTimeZone('auto'), 'auto');
  assert.equal(normalizeTimeZone('UTC'), 'UTC');
  assert.ok(normalizeTimeZone('America/Argentina/Buenos_Aires').startsWith('America/'));
  for (const invalid of [
    null,
    undefined,
    '',
    123,
    {},
    '+03:00',
    'bad/zone',
    'UTC\n',
    'A'.repeat(101),
  ])
    assert.throws(() => normalizeTimeZone(invalid), /valid IANA/);
  assert.deepEqual(timestampParts('2026-01-15T12:34:56Z', 'UTC'), {
    date: '15 Jan 2026',
    time: '12:34:56',
    zone: 'UTC',
    iso: '2026-01-15T12:34:56.000Z',
  });
  assert.equal(timestampParts('2026-01-15T12:34:56Z', 'America/New_York').time, '07:34:56');
  assert.equal(timestampParts('2026-07-15T12:34:56Z', 'America/New_York').time, '08:34:56');
  assert.equal(
    timestampParts('2026-01-01T01:00:00Z', 'America/Argentina/Buenos_Aires').date,
    '31 Dec 2025',
  );
  for (const invalid of [null, undefined, '', 'not-a-date'])
    assert.equal(timestampParts(invalid), null);
});

test('time zone preferences require authentication, affect only the current user and survive reopening SQLite', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-time-zone-'));
  process.env.ADMIN_DATA_DIR = dir;
  const { loadDb, saveDb, sqlite } = await import('../src/db.js');
  const { registerAuthRoutes } = await import('../src/routes/auth-routes.js');
  const db = loadDb(),
    token = crypto.randomBytes(32).toString('hex');
  db.users.push(
    { id: 'first', username: 'first', credentials: [] },
    { id: 'second', username: 'second', credentials: [] },
  );
  db.sessions[crypto.createHash('sha256').update(token).digest('hex')] = {
    userId: 'first',
    expiresAt: Date.now() + 60000,
  };
  saveDb(db);
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  async function preferences(body, authenticated = true) {
    return fetch(url + '/api/me/preferences', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated ? { Cookie: `admin_session=${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }
  try {
    assert.equal((await preferences({ timeZone: 'UTC' }, false)).status, 401);
    for (const timeZone of ['bad/zone', '+03:00', null])
      assert.equal((await preferences({ timeZone })).status, 400);
    assert.equal(loadDb().users[0].timeZone, undefined);
    const response = await preferences({
      timeZone: 'America/Argentina/Buenos_Aires',
      userId: 'second',
    });
    assert.equal(response.status, 200);
    const selected = normalizeTimeZone('America/Argentina/Buenos_Aires');
    assert.equal((await response.json()).user.timeZone, selected);
    assert.equal(loadDb().users[1].timeZone, undefined);
    const reopened = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import {loadDb,sqlite} from './src/db.js'; console.log(loadDb().users[0].timeZone); sqlite.close();",
      ],
      { cwd: path.resolve(import.meta.dirname, '..'), env: process.env, encoding: 'utf8' },
    ).trim();
    assert.equal(reopened, selected);
    const me = await fetch(url + '/api/me', { headers: { Cookie: `admin_session=${token}` } });
    assert.equal((await me.json()).user.timeZone, selected);
    assert.equal((await preferences({ timeZone: 'auto' })).status, 200);
    assert.equal(loadDb().users[0].timeZone, 'auto');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    sqlite.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
