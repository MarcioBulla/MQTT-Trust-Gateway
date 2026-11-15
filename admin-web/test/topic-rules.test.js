import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeTopicRules, deviceAcl } from '../src/services/topic-rules.js';

test('reserved health topics deny other identities even with broad access', () => {
  const topics = [{ deviceId: 'one', topic: 'gateway/health/one/status' }, { deviceId: 'two', topic: 'custom/two' }];
  const acl = deviceAcl({ id: 'one' }, topics);
  assert.match(acl, /topic deny custom\/two\ntopic readwrite #/);
  assert.doesNotMatch(acl, /topic deny gateway\/health\/one\/status/);
  assert.throws(() => deviceAcl({ id: 'one' }, [{ deviceId: 'two', topic: 'x\nuser evil' }]));
  assert.throws(() => deviceAcl({ id: 'one' }, [...topics, { deviceId: 'three', topic: 'custom/two' }]));
});

test('health topic owners can grant a precise reader without allowing publication', () => {
  const topics = [
    { deviceId: 'device-a', topic: 'gateway/health/device-a/status', readers: ['device-c'] },
    { deviceId: 'device-b', topic: 'gateway/health/device-b/status' },
  ];
  const own = deviceAcl({ id: 'device-a', topicRules: { mode: 'custom', publish: ['#'], subscribe: ['#'] } }, topics);
  const reader = deviceAcl({ id: 'device-c', topicRules: { mode: 'custom', publish: ['other/#'], subscribe: ['gateway/health/device-a/status'] } }, topics);
  const other = deviceAcl({ id: 'device-d', topicRules: { mode: 'custom', publish: ['#'], subscribe: ['#'] } }, topics);
  assert.doesNotMatch(own, /topic deny gateway\/health\/device-a\/status/);
  assert.match(own, /topic deny gateway\/health\/device-b\/status/);
  assert.doesNotMatch(reader, /topic deny gateway\/health\/device-a\/status/);
  assert.match(reader, /topic deny gateway\/health\/device-b\/status/);
  assert.match(reader, /topic read gateway\/health\/device-a\/status/);
  assert.doesNotMatch(reader, /topic write gateway\/health\/device-a\/status/);
  assert.match(other, /topic deny gateway\/health\/device-a\/status/);
  assert.match(other, /topic deny gateway\/health\/device-b\/status/);
  assert.match(other, /topic write #/);
  assert.match(other, /topic read #/);
});

test('topic rules validate MQTT wildcards, deduplicate filters and fail closed for corrupt policies', () => {
  const rules = normalizeTopicRules({ mode: 'custom', publish: ['example/command/+', 'example/command/+'], subscribe: ['example/state', 'example/availability', 'example/result'] });
  assert.deepEqual(rules.publish, ['example/command/+']);
  assert.match(deviceAcl({ id: 'ExampleClient', topicRules: rules }), /topic write example\/command\/\+/);
  assert.match(deviceAcl({ id: 'ExampleClient' }), /topic readwrite #/);
  for (const invalid of ['a/#/b', 'a+', 'a/+x', 'a\nuser attacker', 'a b', ''])
    assert.throws(() => normalizeTopicRules({ mode: 'custom', publish: [invalid], subscribe: [] }));
  assert.doesNotMatch(deviceAcl({ id: 'sensor', topicRules: { mode: 'broken' } }), /topic /);
});

test('saved rules survive reload and broker synchronization, and remain staged until applied', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-topic-rules-'));
  process.env.ADMIN_DATA_DIR = path.join(root, 'admin');
  process.env.CA_DIR = path.join(root, 'ca');
  process.env.BROKER_CONFIG_DIR = path.join(root, 'broker');
  const { loadDb, saveDb } = await import('../src/db.js');
  const { prepareGateway, syncBroker, stageBroker, applyBrokerChanges } = await import('../src/services/certificate-service.js');
  await prepareGateway();
  const db = loadDb();
  db.devices.push({ id: 'ExampleClient', enabled: true, trusted: true, status: 'active' });
  db.certificates.push({ deviceId: 'ExampleClient', status: 'active', serial: '1', validTo: new Date(Date.now() + 86400000).toISOString() });
  saveDb(db);
  await syncBroker();
  assert.match(await fs.readFile(path.join(root, 'broker/acl'), 'utf8'), /user ExampleClient\ntopic readwrite #/);
  const revision = await fs.readFile(path.join(root, 'broker/revision'), 'utf8');
  const saved = loadDb();
  saved.devices[0].topicRules = normalizeTopicRules({ mode: 'custom', publish: ['example/command/+'], subscribe: ['example/state', 'example/availability', 'example/result'] });
  saveDb(saved);
  await stageBroker();
  assert.equal(await fs.readFile(path.join(root, 'broker/revision'), 'utf8'), revision);
  assert.ok(await fs.readFile(path.join(root, 'broker/pending-revision'), 'utf8'));
  await syncBroker();
  const acl = await fs.readFile(path.join(root, 'broker/acl'), 'utf8');
  assert.match(acl, /user ExampleClient\ntopic write example\/command\/\+\ntopic read example\/state\ntopic read example\/availability\ntopic read example\/result\n/);
  assert.deepEqual(loadDb().devices[0].topicRules, saved.devices[0].topicRules);
  await applyBrokerChanges();
  assert.notEqual(await fs.readFile(path.join(root, 'broker/revision'), 'utf8'), revision);
  const { default: express } = await import('express');
  const { createSession, sessionKey } = await import('../src/auth.js');
  const { sensitiveGrants } = await import('../src/sensitive-grants.js');
  const { registerCertificateRoutes } = await import('../src/routes/certificate-routes.js');
  const withUser = loadDb(), user = { id: 'rules-admin', username: 'rules-admin' };
  withUser.users.push(user);
  let cookie;
  createSession(withUser, user, { secure: false }, { setHeader: (_name, value) => { cookie = value.split(';')[0]; } });
  saveDb(withUser);
  const token = cookie.split('=')[1];
  const sessionId = sessionKey({ headers: { cookie } });
  assert.ok(token && sessionId);
  const grant = sensitiveGrants.issue({ userId: user.id, sessionId, scope: 'devices', sessionExpiresAt: Date.now() + 60000 });
  const app = express(); app.use(express.json()); registerCertificateRoutes(app);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/devices/ExampleClient/rules`;
    assert.equal((await fetch(url, { headers: { Cookie: cookie } })).status, 403);
    const headers = { Cookie: `${cookie}; sensitive_devices=${grant.token}`, 'Content-Type': 'application/json' };
    assert.equal((await fetch(url, { headers })).status, 200);
    assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ mode: 'custom', publish: ['a/#/b'], subscribe: [] }) })).status, 400);
    assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ mode: 'custom', publish: [], subscribe: ['other/#'] }) })).status, 200);
    assert.deepEqual(loadDb().devices[0].topicRules.subscribe, ['other/#']);
    const list = await (await fetch(`http://127.0.0.1:${server.address().port}/api/devices`, { headers: { Cookie: cookie } })).json();
    assert.equal('topicRules' in list.devices[0], false);
    const extra = loadDb();
    extra.devices.push({ id: 'archive-rules', status: 'active', enabled: false, topicRules: { mode: 'custom', publish: ['private/topic'], subscribe: [] } });
    saveDb(extra);
    const archiveUrl = `http://127.0.0.1:${server.address().port}/api/devices/archive-rules`;
    const ordinaryHeaders = { Cookie: cookie, 'Content-Type': 'application/json' };
    const archived = await (await fetch(`${archiveUrl}/archive`, { method: 'POST', headers: ordinaryHeaders, body: JSON.stringify({ confirm: 'archive-rules' }) })).json();
    assert.equal('topicRules' in archived.device, false);
    const restored = await (await fetch(`${archiveUrl}/restore`, { method: 'POST', headers: ordinaryHeaders, body: '{}' })).json();
    assert.equal('topicRules' in restored.device, false);
  } finally { await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }); }
  const disabled = loadDb(); disabled.devices[0].enabled = false; saveDb(disabled);
  await syncBroker();
  assert.doesNotMatch(await fs.readFile(path.join(root, 'broker/acl'), 'utf8'), /user ExampleClient/);
});
