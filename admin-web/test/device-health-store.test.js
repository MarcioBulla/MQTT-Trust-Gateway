import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDeviceHealthStore, createDeviceHealthTables } from '../src/services/device-health-store.js';

test('device health history preserves raw observations and the last state before the window', () => {
  const db = new DatabaseSync(':memory:');
  try {
    createDeviceHealthTables(db);
    const store = createDeviceHealthStore(db);
    for (const [at, kind, state] of [[1000, 'confirmed', 'online'], [2000, 'observation', 'offline'], [3000, 'confirmed', 'offline']])
      store.append({ deviceId: 'sensor-a', at, kind, state });
    store.append({ deviceId: 'sensor-b', at: 2500, kind: 'confirmed', state: 'online' });
    assert.deepEqual(store.read('sensor-a', 'confirmed', 2500, 4000).map((row) => row.state), ['online', 'offline']);
    assert.deepEqual(store.read('sensor-a', 'observation', 0, 4000).map((row) => row.state), ['offline']);
    assert.throws(() => store.append({ deviceId: 'sensor-a', at: 1, kind: 'confirmed', state: 'invalid' }));
  } finally { db.close(); }
});
