import { randomUUID } from 'node:crypto';

export const renewalLimits = Object.freeze({
  pemBytes: 4096,
  jsonBytes: 4608,
  installMs: 600_000,
  confirmMs: 120_000,
  renewBeforeMs: 30 * 86_400_000,
});

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const statuses = new Set(['requested', 'staged', 'testing', 'confirmed', 'rejected', 'rolled_back']);
export const newRenewalId = randomUUID;

export function renewalTopics(deviceId) {
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(deviceId))
    throw new Error('Invalid renewal device ID');
  return Object.fromEntries(['request', 'csr', 'install', 'confirm', 'status']
    .map((name) => [name, `${deviceId}/pki/${name}`]));
}

export function decodeRenewalMessage(payload, packet, kind) {
  if (packet?.retain !== false || packet.qos !== 1 ||
      !Buffer.isBuffer(payload) || payload.length > renewalLimits.jsonBytes)
    return null;
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    if (typeof value?.request_id !== 'string' || !uuidV4.test(value.request_id)) return null;
    if (kind === 'csr') {
      if (value.csr !== undefined && value.pem !== undefined && value.csr !== value.pem) return null;
      const pem = value.csr === undefined ? value.pem : value.csr;
      if (typeof pem !== 'string' || !pem || Buffer.byteLength(pem) > renewalLimits.pemBytes)
        return null;
      return { request_id: value.request_id, pem };
    }
    if (kind === 'status' && statuses.has(value.status))
      return { request_id: value.request_id, status: value.status };
  } catch {
    return null;
  }
  return null;
}

export function encodeRenewalMessage(value) {
  if (typeof value.request_id !== 'string' || !uuidV4.test(value.request_id))
    throw new Error('Invalid renewal request ID');
  if (value.pem !== undefined &&
      (typeof value.pem !== 'string' || !value.pem || Buffer.byteLength(value.pem) > renewalLimits.pemBytes))
    throw new Error('Invalid renewal PEM size');
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > renewalLimits.jsonBytes)
    throw new Error('Renewal JSON exceeds the message limit');
  return json;
}

export function configuredRenewalTopics(deviceId, configured) {
  const defaults = renewalTopics(deviceId);
  if (configured === undefined) return defaults;
  if (!configured || typeof configured !== 'object') throw new Error('Invalid renewal topics');
  const topics = Object.fromEntries(Object.keys(defaults).map((kind) => [kind, configured[kind]]));
  const values = Object.values(topics);
  if (values.some((topic) => typeof topic !== 'string' || !topic || topic.startsWith('$') ||
      Buffer.byteLength(topic) > 256 || /[\s+#\x00-\x1f\x7f]/u.test(topic)) ||
      new Set(values).size !== values.length)
    throw new Error('Enter five distinct MQTT topics without wildcards or whitespace');
  return topics;
}
