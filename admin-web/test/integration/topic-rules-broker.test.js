import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import mqtt from 'mqtt';
import { deviceAcl } from '../../src/services/topic-rules.js';

test('Mosquitto enforces independent publish and subscribe filters across restart', { timeout: 20000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-acl-broker-'));
  // Some packaged Mosquitto builds drop privileges before reading config.
  // This temporary directory contains only synthetic ACLs and no credentials.
  await fs.chmod(root, 0o755);
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const acl = path.join(root, 'acl'), config = path.join(root, 'mosquitto.conf');
  await fs.writeFile(acl, `user admin\ntopic readwrite #\n${deviceAcl({ id: 'AutoBootWeb', topicRules: { mode: 'custom', publish: ['AutoBoot/command/+'], subscribe: ['AutoBoot/state', 'AutoBoot/availability', 'AutoBoot/result'] } })}`);
  await fs.writeFile(config, `listener ${port} 127.0.0.1\nallow_anonymous true\npersistence false\nacl_file ${acl}\n`);
  await fs.chmod(acl, 0o644);
  await fs.chmod(config, 0o644);
  let broker;
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.endAsync(true).catch(() => {});
    if (broker && broker.exitCode === null) { broker.kill('SIGTERM'); await new Promise((resolve) => broker.once('exit', resolve)); }
    await fs.rm(root, { recursive: true, force: true });
  });
  async function start() {
    broker = spawn('mosquitto', ['-c', config]);
    let error = '';
    broker.stderr.on('data', (chunk) => { error += chunk; });
    for (let i = 0; i < 50; i++) {
      if (broker.exitCode !== null) throw new Error(`Mosquitto exited: ${error}`);
      const ready = await new Promise((resolve) => { const socket = net.connect(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
      if (ready) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Mosquitto did not start');
  }
  async function connect(username) {
    const client = mqtt.connect(`mqtt://127.0.0.1:${port}`, { username, protocolVersion: 5, reconnectPeriod: 0, connectTimeout: 2000 });
    clients.push(client);
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
    return client;
  }
  async function verify() {
    const device = await connect('AutoBootWeb'), admin = await connect('admin');
    try {
      await assert.doesNotReject(device.publishAsync('AutoBoot/command/on', 'on', { qos: 1 }));
      await assert.rejects(device.publishAsync('AutoBoot/state', 'bad', { qos: 1 }), /authoriz|denied/i);
      await device.subscribeAsync('AutoBoot/#', { qos: 1 });
      const seen = [];
      device.on('message', (topic) => seen.push(topic));
      await admin.publishAsync('AutoBoot/state', 'on', { qos: 1 });
      await admin.publishAsync('AutoBoot/private', 'no', { qos: 1 });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.deepEqual(seen, ['AutoBoot/state']);
    } finally { await device.endAsync(true); await admin.endAsync(true); }
  }
  await start(); await verify();
  broker.kill('SIGTERM'); await new Promise((resolve) => broker.once('exit', resolve));
  await start(); await verify();
});
