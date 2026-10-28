import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mqtt from 'mqtt';
import { EventEmitter } from 'node:events';
import { env } from '../config.js';
import { loadDb } from '../db.js';
export const events = new EventEmitter();
events.setMaxListeners(50);
let client,
  lastError = '',
  messages = [],
  retained = new Map(),
  subscriptions = new Set(['#']);
const settings = () => ({
  historyLimit: loadDb().settings.historyLimit || env.historyLimit,
  retainEnabled: env.retainedEnabled,
});
export function startMqtt() {
  client = mqtt.connect(`mqtts://${env.mqttHost}:8883`, {
    clientId: `${env.adminMqttClientId}-${crypto.randomBytes(4).toString('hex')}`,
    cert: fs.readFileSync(path.join(env.dataDir, 'mqtt-client.crt')),
    key: fs.readFileSync(path.join(env.dataDir, 'mqtt-client.key')),
    ca: fs.readFileSync(path.join(env.caDir, 'ca.crt')),
    rejectUnauthorized: true,
    reconnectPeriod: 3000,
    connectTimeout: 10000,
    clean: true,
    protocolVersion: 5,
  });
  client.on('error', (e) => {
    lastError = e.message;
  });
  client.on('connect', () => {
    lastError = '';
    retained.clear();
    for (const filter of subscriptions) client.subscribe(filter, { qos: 2, rap: true });
  });
  client.on('message', (topic, payload, packet) => {
    const message = {
      id: crypto.randomUUID(),
      topic,
      text: payload.toString('utf8').slice(0, 16384),
      base64: payload.subarray(0, 16384).toString('base64'),
      bytes: payload.length,
      truncated: payload.length > 16384,
      qos: packet.qos,
      retain: packet.retain,
      timestamp: new Date().toISOString(),
    };
    if (packet.retain) {
      if (payload.length) retained.set(topic, message);
      else retained.delete(topic);
    }
    if (retained.size > 1000) retained.delete(retained.keys().next().value);
    messages.push(message);
    messages = messages.slice(-settings().historyLimit);
    events.emit('message', message);
  });
}
export const mqttConnectionStatus = () => ({
  connected: Boolean(client?.connected),
  lastError,
  connectedDevices: null,
  connectionStatusNote: 'Individual device connections are not exposed by this broker integration.',
});
export const mqttHistory = () => ({
  messages,
  retained: [...retained.values()],
  subscriptions: [...subscriptions],
  ...settings(),
});
export function clearHistory() {
  messages = [];
}
export async function subscribe(filter) {
  if (
    typeof filter !== 'string' ||
    !filter.length ||
    Buffer.byteLength(filter) > 256 ||
    filter.includes('\0') ||
    filter
      .split('/')
      .some(
        (l, i, a) =>
          (l.includes('#') && (l !== '#' || i !== a.length - 1)) || (l.includes('+') && l !== '+'),
      )
  )
    throw Object.assign(new Error('Invalid subscription filter'), { status: 400 });
  if (!client?.connected) throw Object.assign(new Error('Broker is unavailable'), { status: 503 });
  if (subscriptions.size >= 20 && !subscriptions.has(filter))
    throw Object.assign(new Error('Subscription limit reached'), { status: 400 });
  await new Promise((resolve, reject) =>
    client.subscribe(filter, { qos: 2, rap: true }, (e, grants) =>
      e
        ? reject(e)
        : grants.some((g) => g.qos === 128)
          ? reject(new Error('Subscription denied'))
          : resolve(),
    ),
  );
  subscriptions.add(filter);
}
export async function publishMessage({
  topic,
  payload = '',
  qos = 0,
  retain = false,
  encoding = 'text',
}) {
  if (
    typeof topic !== 'string' ||
    !topic.length ||
    Buffer.byteLength(topic) > 256 ||
    /[#+\0]/.test(topic) ||
    ![0, 1, 2].includes(qos) ||
    typeof retain !== 'boolean' ||
    typeof payload !== 'string' ||
    !['text', 'base64'].includes(encoding)
  )
    throw Object.assign(new Error('Invalid publication'), { status: 400 });
  if (retain && !env.retainedEnabled)
    throw Object.assign(new Error('Retained publication is disabled'), { status: 403 });
  const body = Buffer.from(payload, encoding === 'base64' ? 'base64' : 'utf8');
  if (body.length > 16384)
    throw Object.assign(new Error('Payload limit is 16 KiB'), { status: 400 });
  if (!client?.connected) throw Object.assign(new Error('Broker is unavailable'), { status: 503 });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Object.assign(new Error('Publication timed out'), { status: 504 })),
      10000,
    );
    client.publish(topic, body, { qos, retain }, (e) => {
      clearTimeout(timer);
      e ? reject(e) : resolve();
    });
  });
  if (retain) {
    if (!body.length) retained.delete(topic);
    else
      retained.set(topic, {
        topic,
        text: body.toString('utf8'),
        base64: body.toString('base64'),
        bytes: body.length,
        qos,
        retain: true,
        timestamp: new Date().toISOString(),
      });
  }
}
export function stopMqtt() {
  return client?.endAsync(true);
}
