import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-entity-id-test-'));
process.env.ADMIN_DATA_DIR = path.join(temp, 'admin');
process.env.CA_DIR = path.join(temp, 'ca');
process.env.BROKER_CONFIG_DIR = path.join(temp, 'broker');
const { createEntityIdAllocator } = await import('../src/services/entity-ids.js');

test('entity ID allocation retries SQLite collisions and separates device/certificate namespaces', () => {
  const used = new Set(['device:dev_collision']);
  const candidates = ['collision', 'unique-device', 'unique-certificate'];
  const allocator = createEntityIdAllocator((kind, id) => {
    const key = `${kind}:${id}`;
    if (used.has(key)) return false;
    used.add(key);
    return true;
  }, () => candidates.shift());
  assert.equal(allocator('device'), 'dev_unique-device');
  assert.equal(allocator('certificate'), 'cert_unique-certificate');
});

test('entity ID allocation fails closed after bounded repeated collisions', () => {
  const allocator = createEntityIdAllocator(() => false, () => 'collision', 3);
  assert.throws(() => allocator('device'), /after 3 attempts/);
  assert.throws(() => allocator('unknown'), /Unknown entity ID type/);
});
