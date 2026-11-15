import { topicRulesForDevice } from './topic-rules.js';

export function healthTopicMatches(filter, topic) {
  const f = filter.split('/'), t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length || (f[i] !== '+' && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}

export function validateDeviceHealthConfig(input, device, devices) {
  if (!input || typeof input.enabled !== 'boolean') throw new Error('Health Check enabled must be a boolean');
  const topic = input.topic === undefined ? `gateway/health/${device.id}/status` : String(input.topic);
  if (!topic || topic.startsWith('$') || Buffer.byteLength(topic) > 512 || /[\s\x00-\x1f\x7f+#]/u.test(topic)) throw new Error('Provide a valid literal MQTT topic');
  if (devices.some((other) => other.id !== device.id && other.healthCheck?.enabled && other.healthCheck.topic === topic)) throw new Error('Health topic is already used by another device');
  const payload = (value, fallback, label) => {
    const result = value === undefined ? fallback : String(value).trim();
    if (!result || Buffer.byteLength(result) > 128 || /[\x00-\x1f\x7f]/u.test(result)) throw new Error(`${label} must be 1–128 UTF-8 bytes without control characters`);
    return result;
  };
  const onlinePayload = payload(input.onlinePayload, 'online', 'Online payload');
  const offlinePayload = payload(input.offlinePayload, 'offline', 'Offline payload');
  if (onlinePayload === offlinePayload) throw new Error('Online and offline payloads must be different');
  const seconds = (value, fallback) => {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 3600) throw new Error('Health periods must be between 0 and 3600 seconds');
    return n;
  };
  const rules = topicRulesForDevice(device);
  if (input.enabled && rules.mode === 'custom' && !rules.publish.some((filter) => healthTopicMatches(filter, topic)))
    throw new Error('Device publish Rules must allow the health topic');
  const readers = input.readers === undefined ? [] : input.readers;
  if (!Array.isArray(readers) || readers.length > 100) throw new Error('Provide up to 100 reader identities');
  const allowedReaders = new Set();
  for (const readerId of readers) {
    if (typeof readerId !== 'string' || readerId === device.id) throw new Error('Health topic readers must be other device identities');
    const reader = devices.find((candidate) => candidate.id === readerId);
    if (!reader || reader.status !== 'active' || !reader.enabled || reader.trusted === false)
      throw new Error('Health topic readers must be active, enabled, trusted identities');
    const readerRules = topicRulesForDevice(reader);
    if (readerRules.mode !== 'custom' || !readerRules.subscribe.some((filter) => healthTopicMatches(filter, topic)))
      throw new Error('Health topic readers need a matching Subscribe Rule');
    if (readerRules.publish.some((filter) => healthTopicMatches(filter, topic)))
      throw new Error('Health topic readers must not have a Publish Rule for this topic');
    allowedReaders.add(readerId);
  }
  return { enabled: input.enabled, topic, onlinePayload, offlinePayload, readers: [...allowedReaders], offlineGrace: seconds(input.offlineGrace, 30), recoveryStability: seconds(input.recoveryStability, 5) };
}
