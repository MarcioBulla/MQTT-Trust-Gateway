import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { env } from './config.js';
fs.mkdirSync(env.dataDir, { recursive: true, mode: 0o700 });
const file = path.join(env.dataDir, 'gateway.sqlite');
export const sqlite = new DatabaseSync(file);
fs.chmodSync(file, 0o600);
sqlite.exec(
  'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);',
);
const empty = () => ({
  users: [],
  sessions: {},
  challenges: {},
  certificates: [],
  devices: [],
  trustedCas: [],
  deletedIdentities: [],
  settings: {},
});
if (!sqlite.prepare('SELECT id FROM state WHERE id=1').get()) {
  const legacy = path.join(env.dataDir, 'admin-db.json');
  let db = fs.existsSync(legacy)
    ? { ...empty(), ...JSON.parse(fs.readFileSync(legacy, 'utf8')) }
    : empty();
  db.sessions = {};
  db.challenges = {};
  db.trustedCas ||= [];
  db.deletedIdentities ||= [];
  for (const device of db.devices) {
    device.status ||= 'active';
    device.trusted ??= device.enabled !== false;
  }
  for (const cert of db.certificates) {
    cert.id ||= crypto.randomUUID();
    cert.provisioningMethod ||= 'csr';
    cert.brokerTrusted ??= true;
    cert.algorithm ||= 'unknown';
    cert.fingerprint ||= '';
    cert.issuer ||= 'legacy';
    cert.status ||= 'active';
    if (!db.devices.some((d) => d.id === cert.deviceId))
      db.devices.push({
        id: cert.deviceId,
        name: cert.deviceId,
        description: 'Imported device',
        enabled: true,
        createdAt: cert.issuedAt,
      });
  }
  sqlite.prepare('INSERT INTO state VALUES(1,?)').run(JSON.stringify(db));
}
export function loadDb() {
  const db = JSON.parse(sqlite.prepare('SELECT value FROM state WHERE id=1').get().value);
  db.trustedCas ||= [];
  db.deletedIdentities ||= [];
  for (const device of db.devices) {
    device.status ||= 'active';
    device.trusted ??= device.enabled !== false;
  }
  for (const cert of db.certificates) {
    cert.status ||= 'active';
    cert.provisioningMethod ||= 'csr';
    cert.issuer ||= 'legacy';
    cert.brokerTrusted ??= true;
    cert.algorithm ||= 'unknown';
    if (cert.certificate && !cert.fingerprint) {
      try {
        const x509 = new crypto.X509Certificate(cert.certificate);
        cert.fingerprint = crypto.createHash('sha256').update(x509.raw).digest('hex');
        cert.issuerName ||= x509.issuer;
      } catch {}
    }
  }
  return db;
}
export function saveDb(db) {
  sqlite.prepare('UPDATE state SET value=? WHERE id=1').run(JSON.stringify(db));
}
// All writes run through one queue, including OpenSSL operations and async auth.
let tail = Promise.resolve();
export function exclusive(fn) {
  const result = tail.then(fn);
  tail = result.catch(() => {});
  return result;
}
export function audit(actor, action, detail = '') {
  sqlite
    .prepare('INSERT INTO audit(at,actor,action,detail) VALUES(?,?,?,?)')
    .run(new Date().toISOString(), actor, action, String(detail).slice(0, 1000));
  sqlite
    .prepare('DELETE FROM audit WHERE at < ?')
    .run(new Date(Date.now() - env.auditDays * 86400000).toISOString());
}
export function auditLog() {
  return sqlite.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 500').all();
}
export async function fileExists(file) {
  return fs.existsSync(file);
}
