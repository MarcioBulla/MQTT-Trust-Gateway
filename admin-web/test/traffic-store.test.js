import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTrafficStore } from '../src/services/traffic-store.js';
import { createTrafficMetrics } from '../src/services/traffic-metrics.js';

test('one week of hourly counts survives SQLite reopening, prunes old data and preserves missing intervals', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'traffic-week-'));
 const file = path.join(dir, 'history.sqlite');
 let now = 10 * 86400000;
 let db = new DatabaseSync(file);
 let metrics = createTrafficMetrics({ now: () => now, store: createTrafficStore(db) });
 metrics.update('received', '10'); metrics.update('received', '15'); metrics.publicationFailed();
 assert.equal(metrics.snapshot().series.length, 168);
 assert.equal(metrics.snapshot().series[0].received, null);
 assert.equal(metrics.snapshot().series.at(-1).received, 5);
 db.close();
 now += 2 * 3600000;
 db = new DatabaseSync(file);
 metrics = createTrafficMetrics({ now: () => now, store: createTrafficStore(db) });
 assert.equal(metrics.snapshot().series.at(-3).received, 5);
 assert.equal(metrics.snapshot().series.at(-3).publicationFailures, 1);
 assert.equal(metrics.snapshot().series.at(-2).received, null);
 metrics.update('received', '100'); // Restart establishes a new baseline.
 assert.equal(metrics.snapshot().series.at(-1).received, 0);
 now += 8 * 86400000;
 metrics.update('received', '102');
 assert.equal(db.prepare('SELECT COUNT(*) AS count FROM traffic_history').get().count, 1);
 assert.equal(metrics.snapshot().series.length, 168);
 assert.equal(metrics.snapshot().series.at(-1).received, 2);
 db.close(); await fs.rm(dir, { recursive: true });
});
