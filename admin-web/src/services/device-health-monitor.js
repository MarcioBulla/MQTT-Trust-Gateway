import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mqtt from 'mqtt';
import { env } from '../config.js';
import { loadDb, sqlite } from '../db.js';
import { createDeviceHealthStore } from './device-health-store.js';
import { topicRulesForDevice } from './topic-rules.js';
import { healthTopicMatches } from './device-health-config.js';

const store = createDeviceHealthStore(sqlite);
const maxStatusPayloadBytes = 128;
const states = new Map();
const suspended = new Set();
let healthTopics = new Set();
let client, timer, subscribed = false, awaitingSubscription = false, subscriptionAttempt = 0, lastCheckpoint = 0, lastPrune = 0;
let queuedMessages = [], queueOverflow = false;
function configured() {
  const db = loadDb(), now = Date.now();
  return db.devices.filter((d) => d.status === 'active' && d.healthCheck?.enabled).map((d) => ({ ...d,
    healthAuthorized: Boolean(d.enabled && d.trusted !== false && db.certificates.some((c) =>
      c.deviceId === d.id && c.status === 'active' && c.brokerTrusted !== false && Date.parse(c.validTo) > now)),
  }));
}
function aclApplied() {
  try {
    const read = (name) => fs.readFileSync(path.join(env.brokerDir, name), 'utf8');
    if (fs.existsSync(path.join(env.brokerDir, 'pending-revision'))) return false;
    const revision = read('revision');
    return Boolean(revision && revision === read('applied-revision'));
  } catch { return false; }
}
function stateFor(device) {
  let entry = states.get(device.id);
  if (!entry) { entry = { state: null, pending: null, topic: device.healthCheck.topic }; states.set(device.id, entry); }
  return entry;
}
function setState(device, value, at = Date.now()) {
  const entry = stateFor(device);
  if (entry.state === value) return;
  entry.state = value;
  store.append({ deviceId: device.id, at, kind: 'confirmed', state: value });
}
function unknown(device) {
  const entry = stateFor(device);
  entry.pending = null;
  setState(device, 'unknown');
}
function reconcile() {
  const devices = configured(), ids = new Set(devices.map((d) => d.id));
  healthTopics = new Set(devices.map((device) => device.healthCheck.topic));
  for (const [id, entry] of states) if (!ids.has(id)) {
    store.append({ deviceId: id, at: Date.now(), kind: 'confirmed', state: 'disabled' });
    states.delete(id);
  }
  const available = Boolean(client?.connected && subscribed && aclApplied());
  for (const device of devices) {
    const entry = stateFor(device);
    if (entry.topic !== device.healthCheck.topic) { entry.topic = device.healthCheck.topic; entry.pending = null; setState(device, 'unknown'); }
    const rules = topicRulesForDevice(device);
    const allowed = rules.mode === 'all' || rules.publish.some((filter) => healthTopicMatches(filter, device.healthCheck.topic));
    if (!available || !allowed || !device.healthAuthorized || suspended.has(device.id)) { unknown(device); continue; }
    if (entry.state === null) setState(device, 'unknown');
    if (entry.pending && entry.pending.until <= Date.now()) {
      const value = entry.pending.state;
      const at = entry.pending.until;
      entry.pending = null;
      setState(device, value, at);
    }
  }
  if (Date.now() - lastCheckpoint >= 10000) {
    const at = Date.now();
    for (const device of devices) store.checkpoint(device.id, at);
    lastCheckpoint = at;
  }
  if (Date.now() - lastPrune >= 21600000) {
    store.prune(Date.now() - 32 * 86400000);
    lastPrune = Date.now();
  }
}
export function startDeviceHealthMonitor({ connect = mqtt.connect } = {}) {
  if (client) return;
  for (const device of configured()) {
    const previous = store.last(device.id, 'confirmed');
    if (previous && ['online', 'offline'].includes(previous.state)) {
      const lastKnown = Math.max(Date.parse(previous.at), store.lastCheckpoint(device.id) ?? 0);
      store.append({ deviceId: device.id, at: Math.min(Date.now(), lastKnown), kind: 'confirmed', state: 'unknown' });
    }
    unknown(device);
  }
  client = connect(`mqtts://${env.mqttHost}:8883`, {
    clientId: `mqtt-trust-health-${crypto.randomBytes(4).toString('hex')}`,
    cert: fs.readFileSync(path.join(env.dataDir, 'mqtt-client.crt')),
    key: fs.readFileSync(path.join(env.dataDir, 'mqtt-client.key')),
    ca: fs.readFileSync(path.join(env.caDir, 'ca.crt')),
    rejectUnauthorized: true, reconnectPeriod: 3000, connectTimeout: 10000,
    clean: true, protocolVersion: 5, resubscribe: false,
  });
  const activeClient = client;
  activeClient.on('error', () => {});
  activeClient.on('connect', () => {
    if (client !== activeClient) return;
    subscribed = false;
    try { for (const device of configured()) unknown(device); } catch { activeClient.end(true); return; }
    awaitingSubscription = true;
    queuedMessages = [];
    queueOverflow = false;
    const attempt = ++subscriptionAttempt;
    activeClient.subscribe('#', { qos: 1, rap: false }, (error, grants) => {
      if (client !== activeClient || !activeClient.connected || attempt !== subscriptionAttempt) return;
      subscribed = !error && Array.isArray(grants) && grants.some((grant) => grant.qos === 1);
      awaitingSubscription = false;
      const pending = subscribed && !queueOverflow ? queuedMessages : [];
      queuedMessages = [];
      queueOverflow = false;
      try {
        reconcile();
        for (const [topic, payload, packet] of pending) processMessage(topic, payload, packet);
      } catch { activeClient.end(true); }
    });
  });
  activeClient.on('close', () => {
    if (client !== activeClient) return;
    subscriptionAttempt++;
    subscribed = false;
    awaitingSubscription = false;
    queuedMessages = [];
    try { for (const device of configured()) unknown(device); } catch { /* database unavailable */ }
  });
  function processMessage(topic, payload, packet) {
    if (!healthTopics.has(topic)) return;
    if (!aclApplied()) { reconcile(); return; }
    const device = configured().find((d) => d.healthCheck.topic === topic);
    if (!device || !device.healthAuthorized || suspended.has(device.id)) return;
    const rules = topicRulesForDevice(device);
    if (rules.mode !== 'all' && !rules.publish.some((filter) => healthTopicMatches(filter, topic))) { unknown(device); return; }
    if (payload.length > maxStatusPayloadBytes) return;
    const value = payload.toString('utf8');
    const health = device.healthCheck;
    if (value !== (health.onlinePayload ?? 'online') && value !== (health.offlinePayload ?? 'offline')) return;
    const state = value === (health.onlinePayload ?? 'online') ? 'online' : 'offline';
    store.append({ deviceId: device.id, at: Date.now(), kind: 'observation', state, retainedReplay: packet.retain });
    if (packet.retain || packet.qos !== 1) return;
    const entry = stateFor(device);
    if (entry.state === state) { entry.pending = null; return; }
    if (entry.pending?.state === state) return;
    const seconds = state === 'online' ? health.recoveryStability : health.offlineGrace;
    entry.pending = { state, until: Date.now() + seconds * 1000 };
    reconcile();
  }
  activeClient.on('message', (topic, payload, packet) => {
    try {
      if (client !== activeClient || !healthTopics.has(topic) || payload.length > maxStatusPayloadBytes) return;
      if (awaitingSubscription) {
        if (queuedMessages.length >= 256) { queuedMessages = []; queueOverflow = true; }
        else if (!queueOverflow) queuedMessages.push([topic, Buffer.from(payload), { retain: packet.retain, qos: packet.qos }]);
        return;
      }
      if (subscribed) processMessage(topic, payload, packet);
    } catch { client?.end(true); }
  });
  reconcile();
  timer = setInterval(() => { try { reconcile(); } catch { client?.end(true); } }, 1000);
  timer.unref();
}
export function stopDeviceHealthMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
  if (client) { for (const device of configured()) unknown(device); client.end(true); }
  subscribed = false;
  awaitingSubscription = false;
  queuedMessages = [];
  subscriptionAttempt++;
  client = undefined;
}
export function getDeviceHealthStore() { return store; }
export function suspendDeviceHealth(device) { suspended.add(device.id); unknown(device); }
export function resumeDeviceHealth(deviceId) { suspended.delete(deviceId); }
export function resetDeviceHealth(device, enabled) {
  const entry = stateFor(device);
  entry.topic = device.healthCheck.topic;
  entry.pending = null;
  setState(device, enabled ? 'unknown' : 'disabled');
  if (!enabled) states.delete(device.id);
}
