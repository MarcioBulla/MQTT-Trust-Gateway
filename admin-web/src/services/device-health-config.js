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
  const seconds = (value, fallback) => {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 3600) throw new Error('Health periods must be between 0 and 3600 seconds');
    return n;
  };
  const rules = topicRulesForDevice(device);
  if (input.enabled && rules.mode === 'custom' && !rules.publish.some((filter) => healthTopicMatches(filter, topic)))
    throw new Error('Device publish Rules must allow the health topic');
  return { enabled: input.enabled, topic, offlineGrace: seconds(input.offlineGrace, 30), recoveryStability: seconds(input.recoveryStability, 5) };
}
