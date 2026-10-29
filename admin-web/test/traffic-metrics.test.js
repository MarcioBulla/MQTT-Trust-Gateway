import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrafficMetrics } from '../src/services/traffic-metrics.js';

test('traffic charts use broker counter deltas, bounded UTC buckets and real failure markers', () => {
  let now = 60000;
  const metrics = createTrafficMetrics({ now: () => now, capacity: 3, intervalMs: 60000 });
  assert.equal(metrics.snapshot().available, false);
  assert.equal(metrics.snapshot().counters.received, null);
  for (const metric of ['received', 'sent', 'dropped']) metrics.update(metric, '100');
  assert.equal(metrics.snapshot().available, true);
  assert.equal(metrics.snapshot().series.at(-1).received, 0);
  metrics.update('received', '105'); metrics.update('sent', '110'); metrics.update('dropped', '102'); metrics.publicationFailed();
  assert.deepEqual(metrics.snapshot().series.at(-1), { timestamp: 60000, received: 5, sent: 10, dropped: 2, publicationFailures: 1 });
  assert.equal(metrics.update('received', '-1'), false);
  assert.equal(metrics.update('received', 'NaN'), false);
  now += 60000;
  assert.equal(metrics.snapshot().available, false);
  metrics.update('received', '2'); // Broker restart: never produce a negative spike.
  assert.equal(metrics.snapshot().series.at(-1).received, 0);
  // Mosquitto can omit unchanged counters; an old zero-drop sample is not a stalled feed.
  assert.equal(metrics.snapshot().available, true);
  metrics.update('received', '4');
  assert.equal(metrics.snapshot().series.at(-1).received, 2);
  now += 60000 * 20;
  assert.equal(metrics.snapshot().series.length, 3);
  assert.equal(JSON.stringify(metrics.snapshot()).includes('topic'), false);
});
