import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import mqtt from 'mqtt';

test('device health monitor handles retained replay, grace cancellation, LWT and broker loss', { timeout: 45000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(process.env.MQTT_TEST_TMPDIR || os.tmpdir(), 'gateway-device-health-mqtt-'));
  await fs.chmod(root, 0o755);
  const dataDir = path.join(root, 'admin');
  const caDir = path.join(root, 'ca');
  const brokerDir = path.join(root, 'broker');
  const persistenceDir = path.join(root, 'mosquitto');
  await Promise.all([dataDir, caDir, brokerDir, persistenceDir].map((dir) => fs.mkdir(dir)));
  process.env.ADMIN_DATA_DIR = dataDir;
  process.env.CA_DIR = caDir;
  process.env.BROKER_CONFIG_DIR = brokerDir;
  process.env.PUBLIC_URL = 'http://localhost:8080';
  process.env.MQTT_HOST = 'health-test.invalid';
  await Promise.all([
    fs.writeFile(path.join(dataDir, 'mqtt-client.crt'), 'synthetic test certificate'),
    fs.writeFile(path.join(dataDir, 'mqtt-client.key'), 'synthetic test key'),
    fs.writeFile(path.join(caDir, 'ca.crt'), 'synthetic test CA'),
    fs.writeFile(path.join(brokerDir, 'revision'), 'applied'),
    fs.writeFile(path.join(brokerDir, 'applied-revision'), 'applied'),
  ]);

  const portProbe = net.createServer();
  await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const config = path.join(root, 'mosquitto.conf');
  await fs.writeFile(config, `listener ${port} 127.0.0.1\nallow_anonymous true\npersistence false\n`);

  let broker;
  const clients = [];
  let monitor;
  const syntheticTopic = 'gateway/health/synthetic-lwt-device/status';
  t.after(async () => {
    try { monitor?.stopDeviceHealthMonitor(); } catch {}
    for (const client of clients) await client.endAsync(true).catch(() => {});
    if (broker && broker.exitCode === null) {
      broker.kill('SIGTERM');
      await new Promise((resolve) => broker.once('exit', resolve));
    }
    try { monitor?.sqlite?.close(); } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });

  broker = spawn(process.env.MOSQUITTO_BIN || 'mosquitto', ['-c', config]);
  let brokerOutput = '';
  broker.stderr.on('data', (chunk) => { brokerOutput += chunk; });
  for (let i = 0; i < 100; i++) {
    if (broker.exitCode !== null) throw new Error(`Synthetic Mosquitto exited: ${brokerOutput}`);
    const ready = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const connectClient = async (url, options = {}) => {
    const client = mqtt.connect(url, { protocolVersion: 5, reconnectPeriod: 0, connectTimeout: 2000, ...options });
    clients.push(client);
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    return client;
  };
  const url = `mqtt://127.0.0.1:${port}`;

  // A retained status from before the monitor subscribes is an observation,
  // not proof that the device currently has a live MQTT connection.
  const retainedSeeder = await connectClient(url);
  await retainedSeeder.publishAsync(syntheticTopic, 'online', { qos: 1, retain: true });
  await retainedSeeder.endAsync();

  const [{ loadDb, saveDb, sqlite }, { startDeviceHealthMonitor, stopDeviceHealthMonitor, getDeviceHealthStore }] = await Promise.all([
    import('../src/db.js'), import('../src/services/device-health-monitor.js'),
  ]);
  monitor = { stopDeviceHealthMonitor, sqlite };
  const db = loadDb();
  db.devices.push({
    id: 'synthetic-lwt-device', name: 'Synthetic LWT device', status: 'active', enabled: true, trusted: true,
    topicRules: { mode: 'all', publish: [], subscribe: [] },
    healthCheck: { enabled: true, topic: syntheticTopic, offlineGrace: 2, recoveryStability: 1 },
  });
  db.certificates.push({ id: 'synthetic-lwt-cert', deviceId: 'synthetic-lwt-device', status: 'active', brokerTrusted: true, validTo: new Date(Date.now() + 86400000).toISOString() });
  saveDb(db);
  const store = getDeviceHealthStore();
  let monitorClient;
  startDeviceHealthMonitor({
    connect: (_ignoredUrl, options) => {
      monitorClient = mqtt.connect(url, { ...options, cert: undefined, key: undefined, ca: undefined, rejectUnauthorized: false, reconnectPeriod: 1000 });
      clients.push(monitorClient);
      return monitorClient;
    },
  });
  await new Promise((resolve, reject) => {
    if (monitorClient.connected) return resolve();
    monitorClient.once('connect', resolve);
    monitorClient.once('error', reject);
  });
  const waitForState = async (expected) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (store.last('synthetic-lwt-device', 'confirmed')?.state === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(store.last('synthetic-lwt-device', 'confirmed')?.state, expected);
  };
  const observationCount = () => store.read('synthetic-lwt-device', 'observation', 0, Date.now()).length;
  const waitForObservation = async (state, retainedReplay, afterCount = -1) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const observations = store.read('synthetic-lwt-device', 'observation', 0, Date.now());
      if (observations.slice(Math.max(0, afterCount)).some((event) => event.state === state && event.retainedReplay === retainedReplay)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`Did not observe ${state} retainedReplay=${retainedReplay}`);
  };

  await waitForObservation('online', true);
  assert.equal(store.last('synthetic-lwt-device', 'confirmed').state, 'unknown');

  const device = await connectClient(url, { will: { topic: syntheticTopic, payload: 'offline', qos: 1, retain: true } });
  await device.publishAsync(syntheticTopic, 'online', { qos: 1, retain: true });
  await waitForObservation('online', false);
  await waitForState('online');

  await device.publishAsync(syntheticTopic, 'offline', { qos: 1, retain: false });
  await waitForObservation('offline', false);
  await device.publishAsync(syntheticTopic, 'online', { qos: 1, retain: true });
  await waitForObservation('online', false);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(store.last('synthetic-lwt-device', 'confirmed').state, 'online', 'recovery cancels a pending offline transition');

  // Destroy the transport without MQTT DISCONNECT; Mosquitto must emit LWT.
  device.stream.destroy();
  await waitForObservation('offline', false);
  await waitForState('offline');

  const recovered = await connectClient(url, { will: { topic: syntheticTopic, payload: 'offline', qos: 1, retain: true } });
  await recovered.publishAsync(syntheticTopic, 'online', { qos: 1, retain: true });
  await waitForState('online');

  const observationsBeforeReconnect = observationCount();
  const monitorClosed = new Promise((resolve) => monitorClient.once('close', resolve));
  monitorClient.stream.destroy();
  await waitForState('unknown');
  await monitorClosed;
  await waitForObservation('online', true, observationsBeforeReconnect);
  assert.equal(store.last('synthetic-lwt-device', 'confirmed').state, 'unknown',
    'the retained online state from before monitor reconnect is not proof of a live device');
  const observationsBeforeLiveStatus = observationCount();
  await recovered.publishAsync(syntheticTopic, 'online', { qos: 1, retain: false });
  await waitForObservation('online', false, observationsBeforeLiveStatus);
  await waitForState('online');
});
