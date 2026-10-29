import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

test('pending changes follow the submitted revision, persist and exclude unrelated audit data', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-pending-'));
  process.env.ADMIN_DATA_DIR = path.join(dir, 'admin');
  process.env.BROKER_CONFIG_DIR = path.join(dir, 'broker');
  const { sqlite, audit } = await import('../src/db.js');
  const { pendingBrokerChanges } = await import('../src/services/pending-broker-changes.js');
  await fs.mkdir(process.env.BROKER_CONFIG_DIR);
  const file = (name) => path.join(process.env.BROKER_CONFIG_DIR, name);
  const cursor = async (revision) => {
    const auditId = sqlite.prepare('SELECT COALESCE(MAX(id),0) AS id FROM audit').get().id;
    await fs.writeFile(file('audit-cursor'), JSON.stringify({ revision, auditId }));
    await fs.writeFile(file('revision'), revision);
  };
  try {
    audit('admin', 'certificate.generated', 'old-device:old-serial');
    await cursor('first');
    audit('admin', 'certificate.generated', 'new-device:serial-1');
    audit('admin', 'device.authorization_enabled', 'new-device');
    audit('admin', 'certificate.revoked', 'new-device:serial-0');
    audit('admin', 'login.password', 'unrelated authentication detail');
    audit('admin', 'preferences.updated', 'timeZone=UTC');
    audit('admin', 'device.metadata_updated', 'label edit');
    audit('admin', 'mqtt.publish', 'unrelated MQTT topic');
    const changes = await pendingBrokerChanges('first');
    assert.deepEqual(
      changes.map((change) => change.summary),
      ['Certificate generated', 'Device authorization enabled', 'Certificate revoked'],
    );
    assert.ok(changes.every((change) => change.actor === 'admin'));
    assert.ok(!JSON.stringify(changes).includes('unrelated'));
    const persisted = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import { pendingBrokerChanges } from './src/services/pending-broker-changes.js'; import {sqlite} from './src/db.js'; console.log(JSON.stringify(await pendingBrokerChanges('first'))); sqlite.close();",
        ],
        { cwd: path.resolve(import.meta.dirname, '..'), env: process.env, encoding: 'utf8' },
      ),
    );
    assert.deepEqual(persisted, changes);
    await cursor('second');
    assert.deepEqual(await pendingBrokerChanges('second'), []);
    for (let i = 0; i < 505; i++) audit('admin', 'device.approved', `device-${i}`);
    assert.equal(
      (await pendingBrokerChanges('second')).length,
      505,
      'do not truncate to the audit UI page limit',
    );
    // Upgrade compatibility when there is no cursor: use the revision timestamp.
    await fs.rm(file('audit-cursor'));
    sqlite.prepare('DELETE FROM audit').run();
    const insert = sqlite.prepare('INSERT INTO audit(at,actor,action,detail) VALUES(?,?,?,?)');
    insert.run('2020-01-01T00:00:00.000Z', 'admin', 'certificate.generated', 'already applied');
    insert.run('2026-01-01T00:00:00.000Z', 'admin', 'certificate.generated', 'legacy pending');
    await fs.utimes(file('revision'), new Date('2025-01-01Z'), new Date('2025-01-01Z'));
    assert.deepEqual(
      (await pendingBrokerChanges('second')).map((change) => change.detail),
      ['legacy pending'],
    );
  } finally {
    sqlite.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
