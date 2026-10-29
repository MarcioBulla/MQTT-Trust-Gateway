import { loadDb, saveDb, audit } from '../db.js';
import { revokeCertificate, syncBroker } from './certificate-service.js';

export const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function archiveDeviceRecord(device, now = Date.now()) {
  if (device.status === 'archived') return false;
  if (device.status === 'deleted') throw new Error('Deleted identities cannot be archived');
  device.status = 'archived';
  device.enabled = false;
  device.trusted = false;
  device.archivedAt = new Date(now).toISOString();
  device.scheduledDeletionAt = new Date(now + ARCHIVE_RETENTION_MS).toISOString();
  return true;
}

export function restoreDeviceRecord(device) {
  if (device.status !== 'archived') throw new Error('Only archived devices can be restored');
  device.status = 'active';
  device.enabled = false;
  device.trusted = false;
  device.archivedAt = null;
  device.scheduledDeletionAt = null;
  return device;
}

export async function permanentlyDeleteDevice(db, id, actor = 'system', now = Date.now(), defer = false) {
  const index = db.devices.findIndex((device) => device.id === id);
  if (index < 0) return false;
  const device = db.devices[index];
  device.status = 'deleted'; device.enabled = false; device.trusted = false;
  const related = db.certificates.filter((cert) => cert.deviceId === id);
  for (const cert of related) {
    if (cert.status === 'active' && (cert.issuer === 'local' || cert.issuer === 'legacy')) {
      try { await revokeCertificate(cert); } catch { /* ACL removal is still enforced below. */ }
    }
    cert.status = cert.status === 'revoked' ? 'revoked' : 'blocked';
    cert.revokedAt ||= new Date(now).toISOString();
    cert.blockReason = 'identity-deleted';
    delete cert.certificate; delete cert.chain; delete cert.csr; delete cert.publicKey;
  }
  const tombstone = {
    id,
    deletedAt: new Date(now).toISOString(),
    deletedBy: actor,
    fingerprints: related.map((cert) => cert.fingerprint).filter(Boolean),
    certificates: related.map(({ serial, fingerprint, issuer, status }) => ({ serial, fingerprint, issuer, status })),
  };
  db.deletedIdentities ||= [];
  if (!db.deletedIdentities.some((item) => item.id === id)) db.deletedIdentities.push(tombstone);
  db.devices.splice(index, 1);
  db.certificates = db.certificates.filter((cert) => cert.deviceId !== id);
  saveDb(db);
  await syncBroker(true, { defer });
  audit(actor, 'device.deleted', id);
  return true;
}

export async function purgeExpiredArchives(now = Date.now()) {
  const db = loadDb();
  const expired = db.devices
    .filter((device) => device.status === 'archived' && Date.parse(device.scheduledDeletionAt) <= now)
    .map((device) => device.id);
  for (const id of expired) await permanentlyDeleteDevice(db, id, 'system:archive-expiry', now);
  return expired;
}
