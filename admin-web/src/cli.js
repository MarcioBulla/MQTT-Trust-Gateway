import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { env } from './config.js';
import {
  prepareGateway,
  brokerCertificateNeedsUpdate,
  updateBrokerCertificate,
} from './services/certificate-service.js';
import { loadDb, exclusive } from './db.js';
const command = process.argv[2];
if (command === 'broker-certificate-check') {
  const needed = await brokerCertificateNeedsUpdate();
  console.log(
    needed
      ? 'Broker certificate update required.'
      : 'Broker certificate already matches; no changes required.',
  );
  process.exit(needed ? 10 : 0);
}
if (command === 'broker-certificate') {
  const changed = await exclusive(updateBrokerCertificate);
  if (changed) {
    const revision = await fs.readFile(path.join(env.brokerDir, 'revision'), 'utf8');
    let applied = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (
        (await fs
          .readFile(path.join(env.brokerDir, 'applied-revision'), 'utf8')
          .catch(() => '')) === revision
      ) {
        applied = true;
        break;
      }
      await setTimeout(500);
    }
    if (!applied)
      throw new Error(
        'Certificate saved but broker did not acknowledge it. Check gateway logs before retrying.',
      );
  }
  console.log(
    changed
      ? 'Broker certificate updated using the existing CA; broker restart acknowledged.'
      : 'Broker certificate already matches; no changes required.',
  );
  process.exit(0);
}
if (command !== 'prepare')
  throw new Error('Usage: node src/cli.js prepare|broker-certificate-check|broker-certificate');
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
