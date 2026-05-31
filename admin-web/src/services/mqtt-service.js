import fs from 'node:fs/promises';
import mqtt from 'mqtt';
import { env } from '../config.js';
import { loadDb, saveDb } from '../db.js';

const topics = new Map();
let client = null;
let connecting = null;
let lastError = '';
let loadedTopics = false;
let saveTimer = null;

async function loadStoredTopics() {
  if (loadedTopics) return;
  loadedTopics = true;
  const db = await loadDb();
  for (const topic of db.mqttTopics || []) topics.set(topic.name, topic);
}

function topicSnapshot() {
  return [...topics.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 250);
}

function scheduleTopicSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await saveTopicsNow();
  }, 1000);
}

async function saveTopicsNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const db = await loadDb();
  db.mqttTopics = topicSnapshot();
  await saveDb(db);
}

function rememberTopic(topic, payload) {
  const now = new Date().toISOString();
  const existing = topics.get(topic);
  const message = {
    payload: payload.toString('utf8').slice(0, 2000),
    payloadBytes: payload.length,
    receivedAt: now,
  };
  const history = [message, ...(existing?.history || [])].slice(0, 50);
  topics.set(topic, {
    name: topic,
    lastPayload: message.payload.slice(0, 500),
    lastPayloadBytes: payload.length,
    messages: (existing?.messages || 0) + 1,
    firstSeenAt: existing?.firstSeenAt || now,
    updatedAt: now,
    history,
  });
  scheduleTopicSave();
}

async function mqttOptions() {
  return {
    clientId: `${env.adminMqttClientId}-${process.pid}`,
    cert: await fs.readFile(env.adminMqttCertFile),
    key: await fs.readFile(env.adminMqttKeyFile),
    servername: env.mqttDomain,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    rejectUnauthorized: true,
  };
}

async function connectMqtt() {
  if (client?.connected) return client;
  if (connecting) return connecting;

  connecting = new Promise(async (resolve, reject) => {
    try {
      await loadStoredTopics();
      const instance = mqtt.connect(`mqtts://${env.mqttDomain}:${env.mqttTlsPort}`, await mqttOptions());
      let settled = false;
      const fail = (error) => {
        lastError = error.message;
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        client = null;
        instance.end(true);
        reject(error);
      };
      const timeout = setTimeout(() => fail(new Error('MQTT connection timed out')), 12000);
      client = instance;
      instance.on('message', rememberTopic);
      instance.on('error', (error) => { lastError = error.message; });
      instance.once('error', fail);
      instance.on('close', () => {
        if (client === instance && !instance.connected) client = null;
      });
      instance.on('connect', () => {
        lastError = '';
        instance.subscribe('#', { qos: 0 }, (error) => {
          if (error) return fail(error);
          if (settled) return undefined;
          settled = true;
          clearTimeout(timeout);
          return resolve(instance);
        });
      });
    } catch (error) {
      lastError = error.message;
      reject(error);
    }
  }).finally(() => { connecting = null; });

  return connecting;
}

export function mqttConnectionStatus() {
  return {
    connected: Boolean(client?.connected),
    lastError,
    observedTopics: topics.size,
    adminClientId: env.adminMqttClientId,
  };
}

export async function listTopics() {
  await connectMqtt();
  return topicSnapshot().map(({ history, ...topic }) => topic);
}

export async function topicMessages(topicName) {
  await connectMqtt();
  return topics.get(topicName)?.history || [];
}

export async function clearTopicMessages(topicName) {
  await loadStoredTopics();
  const topic = topics.get(topicName);
  if (!topic) return false;
  topics.set(topicName, {
    ...topic,
    history: [],
    messages: 0,
    lastPayload: '',
    lastPayloadBytes: 0,
  });
  await saveTopicsNow();
  return true;
}

export async function removeTopic(topicName) {
  await loadStoredTopics();
  const removed = topics.delete(topicName);
  if (removed) await saveTopicsNow();
  return removed;
}

export async function publishMessage({ topic, payload, qos, retain }) {
  const instance = await connectMqtt();
  await new Promise((resolve, reject) => {
    instance.publish(topic, payload, { qos, retain }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
