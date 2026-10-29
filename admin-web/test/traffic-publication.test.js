import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('offline console publications produce failure markers; validation errors are not delivery failures', async () => {
  process.env.ADMIN_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'traffic-publication-'));
  const { publishMessage } = await import('../src/services/mqtt-service.js');
  const { trafficMetrics } = await import('../src/services/traffic-metrics.js');
  const { sqlite } = await import('../src/db.js');
  try {
    await assert.rejects(publishMessage({ topic: 'invalid/#', qos: 1 }), error => error.status === 400);
    assert.equal(trafficMetrics.snapshot().series.reduce((sum, sample) => sum + (sample.publicationFailures || 0), 0), 0);
    for (const qos of [1, 2]) await assert.rejects(publishMessage({ topic: 'devices/test/event', qos }), error => error.status === 503);
    assert.equal(trafficMetrics.snapshot().series.reduce((sum, sample) => sum + (sample.publicationFailures || 0), 0), 2);
  } finally { sqlite.close(); }
});
