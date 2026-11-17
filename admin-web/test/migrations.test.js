import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from '../src/migrations/index.js';
function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec("CREATE TABLE state(id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE audit(id INTEGER PRIMARY KEY, at TEXT, actor TEXT, action TEXT, detail TEXT); INSERT INTO state VALUES(1,'{\"devices\":[],\"certificates\":[]}');");
  return database;
}
test('versioned baseline preserves state and is never applied twice', () => {
  const database = fixture();
  try {
    const before = database.prepare('SELECT value FROM state').get().value;
    assert.equal(migrateDatabase(database).applied.length, 4);
    assert.equal(migrateDatabase(database).applied.length, 0);
    assert.equal(database.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 4);
    assert.equal(database.prepare('SELECT value FROM state').get().value, before);
  } finally { database.close(); }
});
test('a failed additive migration rolls back schema, data and migration ledger', () => {
  const database = fixture();
  try {
    migrateDatabase(database);
    const bad = [{id:'0005-failing-test',from:4,to:5,apply(db){db.exec('CREATE TABLE temporary_data(value TEXT)');throw new Error('Injected migration failure');}}];
    assert.throws(() => migrateDatabase(database,5,bad), /Injected/);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='temporary_data'").get().n, 0);
    assert.equal(database.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 4);
  } finally { database.close(); }
});
test('unknown and downgrade schema transitions are refused without mutation', () => {
  const database = fixture();
  try {
    migrateDatabase(database);
    assert.throws(() => migrateDatabase(database,5), /not supported/);
    assert.throws(() => migrateDatabase(database,0), /newer/);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version,4);
  } finally { database.close(); }
});

test('entity ID migration preserves existing IDs and enforces per-type SQLite uniqueness', () => {
  const database = fixture();
  try {
    database.prepare('UPDATE state SET value=? WHERE id=1').run(JSON.stringify({
      devices: [{ id: 'legacy-device' }],
      certificates: [{ id: 'legacy-certificate' }],
      deletedIdentities: [{ id: 'deleted-device' }],
    }));
    migrateDatabase(database);
    const registered = database.prepare('SELECT kind,id FROM entity_ids ORDER BY kind,id').all().map(row => ({ ...row }));
    assert.deepEqual(registered, [
      { kind: 'certificate', id: 'legacy-certificate' },
      { kind: 'device', id: 'deleted-device' },
      { kind: 'device', id: 'legacy-device' },
    ]);
    assert.throws(() => database.prepare('INSERT INTO entity_ids VALUES(?,?,?)').run('device', 'legacy-device', 'now'), /constraint|unique/i);
  } finally { database.close(); }
});

test('schema v1 installations migrate only the additive entity-ID registry and keep legacy IDs', () => {
  const database = fixture();
  try {
    database.prepare('UPDATE state SET value=? WHERE id=1').run(JSON.stringify({
      devices: [{ id: 'legacy-device' }],
      certificates: [{ id: 'legacy-certificate' }],
      deletedIdentities: [],
    }));
    database.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES('0001-state-audit-baseline',0,1,'2026-01-01T00:00:00.000Z'); PRAGMA user_version=1;");
    assert.deepEqual(migrateDatabase(database).applied, ['0002-entity-id-registry', '0003-device-health', '0004-device-renewal-planning']);
    const state = JSON.parse(database.prepare('SELECT value FROM state WHERE id=1').get().value);
    assert.equal(state.devices[0].id, 'legacy-device');
    assert.equal(state.certificates[0].id, 'legacy-certificate');
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 4);
  } finally { database.close(); }
});

test('schema v2 migrates to health tables while preserving state and entity IDs', () => {
  const database = fixture();
  try {
    const stateBefore = {
      devices: [{ id: 'device-v2', name: 'Synthetic' }],
      certificates: [{ id: 'certificate-v2', deviceId: 'device-v2', serial: 'abcd' }],
      deletedIdentities: [], settings: { healthCheck: 'preserve' },
    };
    database.prepare('UPDATE state SET value=? WHERE id=1').run(JSON.stringify(stateBefore));
    database.exec(`CREATE TABLE entity_ids(kind TEXT NOT NULL, id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(kind,id)) WITHOUT ROWID;
      INSERT INTO entity_ids VALUES('device','device-v2','2026-01-01T00:00:00.000Z');
      INSERT INTO entity_ids VALUES('certificate','certificate-v2','2026-01-01T00:00:00.000Z');
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES('0001-state-audit-baseline',0,1,'2026-01-01T00:00:00.000Z');
      INSERT INTO schema_migrations VALUES('0002-entity-id-registry',1,2,'2026-01-01T00:00:00.000Z');
      PRAGMA user_version=2;`);
    assert.deepEqual(migrateDatabase(database).applied, ['0003-device-health', '0004-device-renewal-planning']);
    const migrated = JSON.parse(database.prepare('SELECT value FROM state WHERE id=1').get().value);
    assert.equal(migrated.devices[0].id, stateBefore.devices[0].id);
    assert.deepEqual(migrated.devices[0].renewal, {
      deviceLicenseTemplateConfigured: false,
      deviceLicenseAutoRenewEnabled: false,
      gatewayCaTemplateConfigured: false,
      gatewayCaAutoRenewEnabled: false,
    });
    assert.deepEqual(database.prepare('SELECT kind,id FROM entity_ids ORDER BY kind,id').all().map(row => ({ ...row })), [
      { kind: 'certificate', id: 'certificate-v2' }, { kind: 'device', id: 'device-v2' },
    ]);
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='device_health_events'").get());
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 4);
  } finally { database.close(); }
});
