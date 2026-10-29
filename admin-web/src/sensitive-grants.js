import crypto from 'node:crypto';
import { env } from './config.js';

// Memory only: restart revokes every grant. No capability is placed in a URL.
export function createSensitiveGrants({ ttlMs = 60000, now = Date.now } = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000)
    throw new Error('Sensitive grant lifetime must be 1–300 seconds');
  const grants = new Map();
  function prune() {
    for (const [key, grant] of grants) if (grant.expiresAt <= now()) grants.delete(key);
  }
  return {
    issue({ userId, sessionId, scope, sessionExpiresAt = Infinity, lifetimeMs = ttlMs }) {
      if (!Number.isInteger(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > 300000) throw new Error('Invalid reveal lifetime');
      prune();
      if (!userId || !sessionId || !scope) throw new Error('Grant identity and scope required');
      if (grants.size >= 10000) throw new Error('Too many active reveal grants');
      const token = crypto.randomBytes(32).toString('base64url');
      const expiresAt = Math.min(now() + lifetimeMs, sessionExpiresAt);
      if (expiresAt <= now()) throw new Error('Session expired');
      grants.set(crypto.createHash('sha256').update(token).digest('hex'), { userId, sessionId, scope, expiresAt });
      return { token, expiresAt };
    },
    allows(token, { userId, sessionId, scope }) {
      prune();
      if (typeof token !== 'string' || token.length > 128) return false;
      const grant = grants.get(crypto.createHash('sha256').update(token).digest('hex'));
      return Boolean(grant && grant.userId === userId && grant.sessionId === sessionId && grant.scope === scope);
    },
    revoke(token) {
      if (typeof token === 'string') grants.delete(crypto.createHash('sha256').update(token).digest('hex'));
    },
    revokeUser(userId) {
      for (const [key, grant] of grants) if (grant.userId === userId) grants.delete(key);
    },
    revokeSession(sessionId) {
      for (const [key, grant] of grants) if (grant.sessionId === sessionId) grants.delete(key);
    },
  };
}

export const sensitiveScopes = ['infrastructure', 'devices', 'mqtt', 'audit'];
export const sensitiveGrants = createSensitiveGrants({ ttlMs: env.sensitiveRevealSeconds * 1000 });
