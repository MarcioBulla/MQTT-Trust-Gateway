import { customAlphabet } from 'nanoid';
import { sqlite } from '../db.js';

const randomPart = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16);
const prefixes = { device: 'dev_', certificate: 'cert_' };

function reserve(kind, id) {
  try {
    sqlite.prepare('INSERT INTO entity_ids(kind,id,created_at) VALUES(?,?,?)')
      .run(kind, id, new Date().toISOString());
    return true;
  } catch (error) {
    if (/constraint|unique/i.test(`${error.code || ''} ${error.message || ''}`)) return false;
    throw error;
  }
}

export function createEntityIdAllocator(reserveId, makeRandomPart = randomPart, maxAttempts = 16) {
  return (kind) => {
    const prefix = prefixes[kind];
    if (!prefix) throw new Error('Unknown entity ID type');
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const id = `${prefix}${makeRandomPart()}`;
      if (reserveId(kind, id)) return id;
    }
    throw new Error(`Could not allocate a unique ${kind} ID after ${maxAttempts} attempts`);
  };
}

export function reserveEntityId(kind, id) {
  if (!prefixes[kind] || typeof id !== 'string' || !id) throw new Error('Invalid entity ID');
  return reserve(kind, id);
}

export const allocateEntityId = createEntityIdAllocator(reserve);
