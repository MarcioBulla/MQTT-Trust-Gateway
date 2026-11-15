import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

test('monitor restart marks prior online state unknown from the persisted checkpoint', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-device-health-monitor-'));
  const dataDir = path.join(root, 'admin');
  const caDir = path.join(root, 'ca');
  const brokerDir = path.join(root, 'broker');
  process.env.ADMIN_DATA_DIR = dataDir;
  process.env.CA_DIR = caDir;
  process.env.BROKER_CONFIG_DIR = brokerDir;
  process.env.PUBLIC_URL = 'http://localhost:8080';
  process.env.MQTT_HOST = 'health-monitor-test.invalid';
  await Promise.all([fs.mkdir(dataDir, { recursive: true }), fs.mkdir(caDir), fs.mkdir(brokerDir)]);
  await Promise.all([
    fs.writeFile(path.join(dataDir, 'mqtt-client.crt'), 'synthetic test certificate'),
    fs.writeFile(path.join(dataDir, 'mqtt-client.key'), 'synthetic test key'),
    fs.writeFile(path.join(caDir, 'ca.crt'), 'synthetic test CA'),
    fs.writeFile(path.join(brokerDir, 'revision'), 'applied'),
    fs.writeFile(path.join(brokerDir, 'applied-revision'), 'applied'),
  ]);

  const fakeMqtt = path.join(root, 'fake-mqtt.js');
  await fs.writeFile(fakeMqtt, `
    import { EventEmitter } from 'node:events';
    export let lastClient;
    export let subscribeCalls = 0;
    export const subscribeResults = [
      { granted: [{ qos: 1 }] }, { granted: [{ qos: 128 }] }, { granted: [{ qos: 1 }] },
    ];
    export const pendingSubscriptions = [];
    export function connect() {
      const client = new EventEmitter();
      lastClient = client;
      client.connected = true;
      client.subscribe = (_topic, _options, callback) => {
        subscribeCalls++;
        const result = subscribeResults.shift() || { granted: [{ qos: 1 }] };
        if (callback) pendingSubscriptions.push(() => callback(result.error || null, result.granted));
      };
      client.end = () => {};
      return client;
    }
    export default { connect };
  `);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'mqtt') return { url: pathToFileURL(fakeMqtt).href, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });

  const [{ loadDb, saveDb, sqlite }, { createDeviceHealthStore }, monitor] = await Promise.all([
    import('../src/db.js'),
    import('../src/services/device-health-store.js'),
    import(`../src/services/device-health-monitor.js?checkpoint-test=${Date.now()}`),
  ]);
  const mqttMock = await import(pathToFileURL(fakeMqtt).href);
  try {
    const db = loadDb();
    db.devices.push({
      id: 'synthetic-health-device', name: 'Synthetic health device', status: 'active', enabled: true, trusted: true,
      topicRules: { mode: 'all', publish: [], subscribe: [] },
      healthCheck: { enabled: true, topic: 'gateway/health/synthetic-health-device/status', offlineGrace: 0, recoveryStability: 0 },
    });
    db.certificates.push({
      id: 'synthetic-health-cert', deviceId: 'synthetic-health-device', status: 'active', brokerTrusted: true,
      validTo: new Date(Date.now() + 86400000).toISOString(),
    });
    saveDb(db);

    const store = createDeviceHealthStore(sqlite);
    const checkpoint = Date.now() - 5000;
    store.append({ deviceId: 'synthetic-health-device', at: checkpoint - 5000, kind: 'confirmed', state: 'online' });
    store.checkpoint('synthetic-health-device', checkpoint);

    monitor.startDeviceHealthMonitor();
    mqttMock.lastClient.emit('connect');
    assert.equal(mqttMock.subscribeCalls, 1);
    const events = store.read('synthetic-health-device', 'confirmed', checkpoint - 10000, Date.now());
    assert.ok(events.some((event) => event.state === 'unknown' && Date.parse(event.at) === checkpoint),
      'restart should close the last known online interval at its persisted checkpoint');
    assert.equal(events.at(-1).state, 'unknown', 'a restart must not continue reporting the stale online state');

    const topic = 'gateway/health/synthetic-health-device/status';
    mqttMock.lastClient.emit('message', topic, Buffer.from('online'), { retain: false, qos: 1 });
    assert.equal(store.last('synthetic-health-device', 'confirmed').state, 'unknown',
      'a message received before SUBACK must not change status before authorization');
    assert.equal(store.read('synthetic-health-device', 'observation', 0, Date.now()).length, 0,
      'messages are buffered until the subscription result arrives');

    mqttMock.lastClient.emit('close');
    mqttMock.lastClient.connected = true;
    mqttMock.lastClient.emit('connect');
    assert.equal(mqttMock.subscribeCalls, 2);
    mqttMock.pendingSubscriptions.shift()();
    assert.equal(store.last('synthetic-health-device', 'confirmed').state, 'unknown',
      'a stale successful SUBACK from an earlier connection must not authorize monitoring');
    assert.equal(store.read('synthetic-health-device', 'observation', 0, Date.now()).length, 0,
      'a stale SUBACK must not process messages queued by the new connection');

    mqttMock.lastClient.emit('message', topic, Buffer.from('online'), { retain: false, qos: 1 });
    mqttMock.pendingSubscriptions.shift()();
    assert.equal(store.last('synthetic-health-device', 'confirmed').state, 'unknown',
      'a denied SUBACK must discard buffered status messages');
    assert.equal(store.read('synthetic-health-device', 'observation', 0, Date.now()).length, 0,
      'a refused subscription does not persist buffered messages');

    mqttMock.lastClient.emit('close');
    mqttMock.lastClient.connected = true;
    mqttMock.lastClient.emit('connect');
    assert.equal(mqttMock.subscribeCalls, 3, 'the monitor resubscribes after reconnect');
    mqttMock.lastClient.emit('message', topic, Buffer.from('offline'), { retain: true, qos: 1 });
    mqttMock.lastClient.emit('message', topic, Buffer.from('online'), { retain: false, qos: 1 });
    assert.equal(store.last('synthetic-health-device', 'confirmed').state, 'unknown',
      'messages received before the reconnect SUBACK remain buffered');
    mqttMock.pendingSubscriptions.shift()();
    assert.equal(store.last('synthetic-health-device', 'confirmed').state, 'online',
      'successful SUBACK processes buffered live status while ignoring the retained replay');
    const bufferedObservations = store.read('synthetic-health-device', 'observation', 0, Date.now());
    assert.deepEqual(bufferedObservations.map((event) => [event.state, event.retainedReplay]), [
      ['offline', true], ['online', false],
    ]);
    mqttMock.lastClient.emit('message', topic, Buffer.from('online'), { retain: false, qos: 1 });
    assert.equal(store.last('synthetic-health-device', 'confirmed').state, 'online', 'a live QoS 1 status confirms online');
    mqttMock.lastClient.emit('message', topic, Buffer.from('offline'), { retain: true, qos: 1 });
    assert.equal(store.last('synthetic-health-device', 'confirmed').state, 'online', 'a retained replay is observational only');
    mqttMock.lastClient.emit('message', topic, Buffer.from('offline'), { retain: false, qos: 1 });
    assert.equal(store.last('synthetic-health-device', 'confirmed').state, 'offline', 'a live QoS 1 LWT confirms offline');
  } finally {
    monitor.stopDeviceHealthMonitor();
    assert.doesNotThrow(() => mqttMock.lastClient.emit('connect'), 'late broker connection after stop is safely ignored');
    assert.equal(mqttMock.subscribeCalls, 3, 'stopped monitor does not resubscribe after a late connect');
    sqlite.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
