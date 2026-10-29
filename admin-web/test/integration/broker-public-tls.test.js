// Explicitly opt in: this suite connects to a real configured broker, using
// existing authorized device credentials. It never provisions/revokes devices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import mqtt from 'mqtt';
const host = process.env.MQTT_TEST_HOST;
const directory = process.env.MQTT_TEST_CREDENTIALS;
const enabled = Boolean(host && directory);
const token = crypto.randomUUID();
let credentials;
if (enabled) {
  credentials = Object.fromEntries(
    await Promise.all(
      [
        ['ca', 'server-ca.crt'],
        ['cert', 'device.crt'],
        ['key', 'device.key'],
      ].map(async ([name, file]) => [name, await fs.readFile(path.join(directory, file))]),
    ),
  );
}
function connect(url, overrides = {}) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(url, {
      ...credentials,
      rejectUnauthorized: true,
      protocolVersion: 5,
      reconnectPeriod: 0,
      connectTimeout: 7000,
      ...overrides,
    });
    const timer = setTimeout(() => fail(new Error('MQTT handshake timed out')), 9000);
    function fail(error) {
      clearTimeout(timer);
      client.end(true);
      reject(error);
    }
    client.once('error', fail);
    client.once('connect', () => {
      clearTimeout(timer);
      client.removeListener('error', fail);
      client.on('error', () => {}); // assertions below report publication errors
      resolve(client);
    });
  });
}
for (const [transport, port, suffix] of [
  ['mqtts', process.env.MQTT_TEST_TLS_PORT || '8883', ''],
  ['wss', process.env.MQTT_TEST_WSS_PORT || '8443', '/mqtt'],
]) {
  const url = `${transport}://${host}:${port}${suffix}`;
  test(
    `${transport}: public SAN and chain, mTLS pub/sub QoS 0/1/2, and ACL isolation`,
    { skip: !enabled, timeout: 45000 },
    async () => {
      const name = new crypto.X509Certificate(credentials.cert).subject.match(
        /(?:^|\n)CN=([^\n]+)/,
      )?.[1];
      assert.ok(name, 'Device identity must be the certificate CN');
      const client = await connect(url);
      try {
        for (const qos of [0, 1, 2]) {
          const topic = `${name}/san-check/${token}/${transport}/${qos}`;
          const payload = `verified-public-tls-${qos}`;
          const grants = await client.subscribeAsync(topic, { qos });
          assert.equal(grants[0].qos, qos);
          const received = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              client.off('message', listener);
              reject(new Error('Subscribed payload not received'));
            }, 7000);
            function listener(actualTopic, actualPayload, packet) {
              if (actualTopic !== topic) return;
              clearTimeout(timer);
              client.off('message', listener);
              resolve({ payload: actualPayload.toString(), qos: packet.qos });
            }
            client.on('message', listener);
          });
          await Promise.all([
            client.publishAsync(topic, payload, { qos, retain: false }),
            received.then((message) => assert.deepEqual(message, { payload, qos })),
          ]);
          await client.unsubscribeAsync(topic);
        }
        await assert.rejects(
          client.publishAsync(`mqtt-trust-admin/san-check/${token}`, 'must-be-denied', { qos: 1 }),
          /authoriz|denied/i,
        );
      } finally {
        await client.endAsync(false);
      }
    },
  );
  test(
    `${transport}: missing device certificate is rejected`,
    { skip: !enabled, timeout: 12000 },
    async () => {
      await assert.rejects(connect(url, { cert: undefined, key: undefined }));
    },
  );
}
