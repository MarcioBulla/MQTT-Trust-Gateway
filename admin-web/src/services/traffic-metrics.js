// Bounded, aggregate-only telemetry. Never stores topics, payloads or identities.
export function createTrafficMetrics({ now = Date.now, capacity = 168, intervalMs = 3600000, store = null } = {}) {
  const counters = {}, updated = {}, buckets = new Map();
  const startedAt = now();
  let storage;
  const cutoff = () => Math.floor(now() / intervalMs) * intervalMs - (capacity - 1) * intervalMs;
  function attachStore(value) {
    if (storage) return;
    storage = value;
    for (const sample of storage.load(cutoff())) buckets.set(sample.timestamp, { ...sample });
  }
  if (store) attachStore(store);
  function save(sample) { storage?.save(sample, cutoff()); }
  function bucket() {
    const timestamp = Math.floor(now() / intervalMs) * intervalMs;
    if (!buckets.has(timestamp)) buckets.set(timestamp, { timestamp, received: 0, sent: 0, dropped: 0, publicationFailures: 0 });
    for (const key of buckets.keys()) if (key < timestamp - (capacity - 1) * intervalMs) buckets.delete(key);
    return buckets.get(timestamp);
  }
  return {
    attachStore,
    update(metric, payload) {
      if (!['received', 'sent', 'dropped'].includes(metric) || !/^\d+$/.test(String(payload).trim())) return false;
      const value = Number(String(payload).trim());
      if (!Number.isSafeInteger(value)) return false;
      const previous = counters[metric];
      counters[metric] = value; updated[metric] = now();
      // First observation is a baseline, not traffic seen during this interval.
      if (previous !== undefined && value >= previous) bucket()[metric] += value - previous;
      else bucket();
      save(bucket());
      return true;
    },
    publicationFailed() { const sample = bucket(); sample.publicationFailures++; save(sample); },
    snapshot() {
      const first = cutoff();
      const series = [];
      for (let timestamp = first; timestamp <= now(); timestamp += intervalMs) series.push(buckets.get(timestamp) || { timestamp, received: null, sent: null, dropped: null, publicationFailures: null });
      return { source: 'mosquitto-sys', intervalSeconds: intervalMs / 1000, retentionDays: capacity * intervalMs / 86400000, windowStart: now() - capacity * intervalMs, windowEnd: now(), startedAt, counters: { received: counters.received ?? null, sent: counters.sent ?? null, dropped: counters.dropped ?? null },
        updatedAt: Object.keys(updated).length ? Math.max(...Object.values(updated)) : null,
        available: ['received', 'sent', 'dropped'].every(metric => updated[metric] !== undefined) && now() - Math.max(...Object.values(updated)) < 45000, series };
    },
  };
}
export const trafficMetrics = createTrafficMetrics();
