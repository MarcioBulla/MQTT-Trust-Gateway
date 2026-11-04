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
    assert.equal(migrateDatabase(database).applied.length, 1);
    assert.equal(migrateDatabase(database).applied.length, 0);
    assert.equal(database.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 1);
    assert.equal(database.prepare('SELECT value FROM state').get().value, before);
  } finally { database.close(); }
});
test('a failed additive migration rolls back schema, data and migration ledger', () => {
  const database = fixture();
  try {
    migrateDatabase(database);
    const bad = [{id:'0002-failing-test',from:1,to:2,apply(db){db.exec('CREATE TABLE temporary_data(value TEXT)');throw new Error('Injected migration failure');}}];
    assert.throws(() => migrateDatabase(database,2,bad), /Injected/);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='temporary_data'").get().n, 0);
    assert.equal(database.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 1);
  } finally { database.close(); }
});
test('unknown and downgrade schema transitions are refused without mutation', () => {
  const database = fixture();
  try {
    migrateDatabase(database);
    assert.throws(() => migrateDatabase(database,2), /not supported/);
    assert.throws(() => migrateDatabase(database,0), /newer/);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version,1);
  } finally { database.close(); }
});
