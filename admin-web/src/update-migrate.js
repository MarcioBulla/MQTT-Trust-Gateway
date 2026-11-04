// Offline release migration entrypoint: never initialize or modify PKI.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { migrateDatabase, CURRENT_SCHEMA_VERSION } from './migrations/index.js';
const target = Number(process.argv[2]);
if (!Number.isSafeInteger(target) || target !== CURRENT_SCHEMA_VERSION) throw new Error('Unsupported target schema');
const file = path.join(process.env.ADMIN_DATA_DIR || '/data', 'gateway.sqlite');
if (!fs.existsSync(file)) throw new Error('An existing Gateway database is required');
const database = new DatabaseSync(file);
try {
  if (database.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Database integrity check failed');
  migrateDatabase(database, target);
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log(JSON.stringify({ ok: true, schemaVersion: target }));
} finally { database.close(); }
