import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('Gateway refuses a database schema newer than the running application', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-future-schema-'));
  const adminDirectory = path.join(directory, 'admin');
  fs.mkdirSync(adminDirectory, { mode: 0o700 });
  const databasePath = path.join(adminDirectory, 'gateway.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL); INSERT INTO state VALUES(1, '{\"users\":[],\"sessions\":{},\"challenges\":{},\"certificates\":[],\"devices\":[],\"trustedCas\":[],\"deletedIdentities\":[],\"settings\":{}}'); PRAGMA user_version=2;");
  database.close();
  const moduleUrl = new URL('../src/db.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)})`], {
    env: { ...process.env, ADMIN_DATA_DIR: adminDirectory },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /newer than this Gateway supports/);
  fs.rmSync(directory, { recursive: true, force: true });
});
