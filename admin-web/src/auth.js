import crypto from 'node:crypto';
import { sensitiveGrants } from './sensitive-grants.js';
import { env } from './config.js';
import { loadDb, saveDb } from './db.js';
const attempts = new Map();
export function matchesBootstrapToken(value, expected) {
  if (typeof value !== 'string') return false;
  const supplied = Buffer.from(value.trim());
  const token = Buffer.from(expected.trim());
  return (
    token.length > 0 && supplied.length === token.length && crypto.timingSafeEqual(supplied, token)
  );
}
export function rateLimit(req, res, next) {
  const now = Date.now();
  for (const [key, entry] of attempts) if (entry.until < now) attempts.delete(key);
  const key = `${req.ip}:${req.path}`;
  const entry = attempts.get(key) || { count: 0, until: now + 60000 };
  entry.count++;
  attempts.set(key, entry);
  if (attempts.size > 10000) attempts.delete(attempts.keys().next().value);
  if (entry.count > 10)
    return res.status(429).json({ error: 'Too many attempts. Try again in one minute.' });
  next();
}
export function parseCookies(header = '') {
  const result = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    try {
      result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1));
    } catch {
      /* malformed cookie */
    }
  }
  return result;
}
export const sessionKey = (req) =>
  crypto
    .createHash('sha256')
    .update(parseCookies(req.headers.cookie).admin_session || '')
    .digest('hex');
export function currentUser(req) {
  const db = loadDb(),
    session = db.sessions[sessionKey(req)];
  if (!session || session.expiresAt <= Date.now()) return null;
  return db.users.find((u) => u.id === session.userId) || null;
}
export function createSession(db, user, req, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  for (const [id, s] of Object.entries(db.sessions))
    if (s.expiresAt <= Date.now()) delete db.sessions[id];
  db.sessions[crypto.createHash('sha256').update(token).digest('hex')] = {
    userId: user.id,
    expiresAt: Date.now() + env.sessionHours * 3600000,
  };
  res.setHeader(
    'Set-Cookie',
    `admin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${env.sessionHours * 3600}${req.secure ? '; Secure' : ''}`,
  );
}
export function clearSessionCookie(req, res) {
  res.setHeader(
    'Set-Cookie',
    `admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${req.secure ? '; Secure' : ''}`,
  );
}
export function requireAuth(handler) {
  return async (req, res, next) => {
    try {
      req.user = currentUser(req);
      if (!req.user) return res.status(401).json({ error: 'Authentication required' });
      return await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}
export function logout(req, res) {
  sensitiveGrants.revokeSession(sessionKey(req));
  const db = loadDb();
  delete db.sessions[sessionKey(req)];
  saveDb(db);
  clearSessionCookie(req, res);
  res.json({ ok: true });
}
