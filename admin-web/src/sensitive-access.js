import { currentUser, parseCookies, sessionKey } from './auth.js';
import { sensitiveGrants, sensitiveScopes } from './sensitive-grants.js';

export const revealCookie = (scope) => `sensitive_${scope}`;
export function revealToken(req, scope) { return parseCookies(req.headers.cookie)[revealCookie(scope)]; }
export function hasSensitiveGrant(req, scope) {
  const user = currentUser(req);
  return Boolean(user && sensitiveGrants.allows(revealToken(req, scope), {
    userId: user.id, sessionId: sessionKey(req), scope,
  }));
}
export function requireSensitive(req, res, scope) {
  res.set('Cache-Control', 'no-store');
  if (!currentUser(req)) { res.status(401).json({ error: 'Authentication required' }); return false; }
  if (!hasSensitiveGrant(req, scope)) {
    res.status(403).json({ error: 'Additional authentication required', stepUpRequired: true, scope });
    return false;
  }
  return true;
}
export function guardSensitiveApi(req, res, next) {
  let scope;
  const ordinaryDeviceOperation = /^\/devices(\/|$)/.test(req.path);
  const ordinaryList = req.method === 'GET' && ['/certificates', '/trusted-cas', '/mqtt/history', '/mqtt/events'].includes(req.path);
  if (ordinaryDeviceOperation || ordinaryList) return next();
  if (/^\/(devices|trusted-cas)(\/|$)/.test(req.path) || (/^\/certificates(\/|$)/.test(req.path) && req.path !== '/certificates/ca')) scope = 'devices';
  if (/^\/mqtt(\/|$)/.test(req.path) && req.method === 'GET') scope = 'mqtt';
  if (/^\/(audit|logs)(\/|$)/.test(req.path)) scope = 'audit';
  if (scope && !requireSensitive(req, res, scope)) return;
  next();
}
export function clearRevealCookies(req, res, scopes = sensitiveScopes) {
  res.setHeader('Set-Cookie', scopes.map((scope) => `${revealCookie(scope)}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${req.secure ? '; Secure' : ''}`));
}
