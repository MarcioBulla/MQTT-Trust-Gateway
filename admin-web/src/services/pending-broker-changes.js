import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config.js';
import { sqlite } from '../db.js';

const descriptions = {
  'certificate.issued': 'Certificate issued',
  'certificate.renewed': 'Certificate renewed',
  'certificate.generated': 'Certificate generated',
  'certificate.imported': 'Certificate imported',
  'certificate.revoked': 'Certificate revoked',
  'license.archived': 'License archived',
  'license.deleted': 'License deleted',
  'ca.trusted': 'CA trust approved',
  'ca.untrusted': 'CA trust removed',
  'device.updated': 'Device settings updated', // Legacy authorization audit entries.
  'device.authorization_enabled': 'Device authorization enabled',
  'device.authorization_disabled': 'Device authorization disabled',
  'device.approved': 'Device authorization approved',
  'device.archived': 'Device archived',
  'device.restored_pending_approval': 'Device restored; approval required',
  'device.deleted': 'Device permanently deleted',
};

export async function pendingBrokerChanges(revision) {
  const cursor = await fs
    .readFile(path.join(env.brokerDir, 'audit-cursor'), 'utf8')
    .then(JSON.parse)
    .catch(() => null);
  const actions = Object.keys(descriptions);
  const matchedCursor =
    cursor?.revision === revision && Number.isSafeInteger(cursor.auditId) && cursor.auditId >= 0;
  // Existing deployments have no cursor yet. Recover their pending operations
  // from audit events after the last submitted broker revision.
  const since = await fs
    .stat(path.join(env.brokerDir, 'revision'))
    .then((stat) => new Date(stat.mtimeMs).toISOString())
    .catch(() => new Date(0).toISOString());
  const entries = sqlite
    .prepare(
      `SELECT id, at, actor, action, detail FROM audit
    WHERE ${matchedCursor ? 'id > ?' : 'at >= ?'} AND action IN (${actions.map(() => '?').join(',')}) ORDER BY id`,
    )
    .all(matchedCursor ? cursor.auditId : since, ...actions);
  return entries.map((entry) => ({ ...entry, summary: descriptions[entry.action] }));
}
