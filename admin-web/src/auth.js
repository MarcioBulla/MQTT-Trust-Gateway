import crypto from 'node:crypto';
import { env } from './config.js';
import { loadDb } from './db.js';

const authAttempts = new Map();

export function rateLimit(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 60000;
  const maxAttempts = 20;
  const entry = authAttempts.get(key) || { count: 0, resetAt: now + windowMs };
  if (entry.resetAt < now) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count += 1;
  authAttempts.set(key, entry);
  if (entry.count > maxAttempts) return res.status(429).json({ error: 'too many attempts' });
  return next();
}

export function signSession(sessionId) {
  return crypto.createHmac('sha256', env.sessionSecret).update(sessionId).digest('base64url');
}

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index === -1) return ['', ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }).filter(([key]) => key));
}

export async function currentUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const [sessionId, signature] = (cookies.admin_session || '').split('.');
  if (!sessionId || signature !== signSession(sessionId)) return null;

  const db = await loadDb();
  const session = db.sessions[sessionId];
  if (!session || session.expiresAt < Date.now()) return null;
  return db.users.find((user) => user.id === session.userId) || null;
}

export function requireAuth(handler) {
  return async (req, res, next) => {
    try {
      const user = await currentUser(req);
      if (!user) return res.status(401).json({ error: 'authentication required' });
      req.user = user;
      return handler(req, res, next);
    } catch (error) {
      return next(error);
    }
  };
}

export function setSessionCookie(res, sessionId) {
  const value = `${sessionId}.${signSession(sessionId)}`;
  res.setHeader('Set-Cookie', [
    `admin_session=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
  ]);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'admin_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
}
