import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from './config.js';
import { prepareGateway } from './services/certificate-service.js';
import { loadDb, exclusive } from './db.js';
if (process.argv[2] !== 'prepare') throw new Error('Usage: node src/cli.js prepare');
await exclusive(prepareGateway);
if (!loadDb().users.length) {
  const file = path.join(env.dataDir, 'bootstrap-token');
  try {
    await fs.writeFile(file, `${crypto.randomBytes(32).toString('base64url')}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  console.log('Administrator bootstrap token is stored in the private admin/bootstrap-token file.');
}
console.log('CA and broker configuration prepared without replacing existing trust.');
