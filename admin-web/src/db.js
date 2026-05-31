import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from './config.js';

const dbFile = path.join(env.dataDir, 'admin-db.json');

export async function loadDb() {
  await fs.mkdir(env.dataDir, { recursive: true, mode: 0o700 });
  try {
    const db = JSON.parse(await fs.readFile(dbFile, 'utf8'));
    db.users ||= [];
    db.sessions ||= {};
    db.challenges ||= {};
    db.certificates ||= [];
    return db;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { users: [], sessions: {}, challenges: {}, certificates: [] };
  }
}

export async function saveDb(db) {
  await fs.mkdir(env.dataDir, { recursive: true, mode: 0o700 });
  const tmpFile = `${dbFile}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(db, null, 2), { mode: 0o600 });
  await fs.rename(tmpFile, dbFile);
}

export async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
