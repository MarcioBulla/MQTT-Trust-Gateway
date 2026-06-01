import { loadDb, saveDb } from '../../db.js';

const topics = new Map();
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

export async function saveTopicsNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const db = await loadDb();
  db.mqttTopics = topicSnapshot();
  await saveDb(db);
}

export async function ensureTopicsLoaded() {
  await loadStoredTopics();
}

export function rememberTopic(topic, payload, packet = {}) {
  if (packet.retain && payload.length === 0) {
    topics.delete(topic);
    scheduleTopicSave();
    return;
  }

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

export async function listObservedTopics() {
  await ensureTopicsLoaded();
  return topicSnapshot().map(({ history, ...topic }) => topic);
}

export async function topicMessages(topicName) {
  await ensureTopicsLoaded();
  return topics.get(topicName)?.history || [];
}

export async function clearTopicMessages(topicName) {
  await ensureTopicsLoaded();
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

export async function removeObservedTopic(topicName) {
  await ensureTopicsLoaded();
  const removed = topics.delete(topicName);
  if (removed) await saveTopicsNow();
  return removed;
}

export async function observedTopicNames() {
  await ensureTopicsLoaded();
  return [...topics.keys()];
}

export async function clearObservedTopics() {
  await ensureTopicsLoaded();
  topics.clear();
  await saveTopicsNow();
}

export function observedTopicCount() {
  return topics.size;
}
