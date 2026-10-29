import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config.js';
import { requireAuth, rateLimit, sessionKey } from '../auth.js';
import { loadDb, saveDb, audit } from '../db.js';
import { authenticationOperation, verifyReauthentication } from '../reauth.js';
import { sensitiveGrants, sensitiveScopes } from '../sensitive-grants.js';
import { requireSensitive, revealCookie, revealToken, clearRevealCookies } from '../sensitive-access.js';
import { publicUser } from '../passkeys.js';
import { certificateMetadata } from '../services/certificate-service.js';

export function registerSensitiveRoutes(app) {
  app.patch('/api/me/sensitive-preferences', rateLimit, requireAuth(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { timeoutSeconds, requireAuthentication } = req.body;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300 || typeof requireAuthentication !== 'boolean')
      return res.status(400).json({ error: 'Choose a timeout between 1 and 300 seconds and an authentication policy' });
    const db = loadDb(), user = db.users.find(item => item.id === req.user.id);
    await verifyReauthentication(req, db, user, 'sensitive-settings');
    user.sensitivePreferences = { timeoutSeconds, requireAuthentication };
    sensitiveGrants.revokeSession(sessionKey(req));
    clearRevealCookies(req, res, [...sensitiveScopes, 'reveal-auth']);
    saveDb(db);
    audit(user.username, 'sensitive.preferences.changed');
    res.json({ user: publicUser(user) });
  }));
  app.post('/api/sensitive/reveal', rateLimit, requireAuth(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const scope = req.body?.scope;
    if (!sensitiveScopes.includes(scope)) return res.status(400).json({ error: 'Invalid reveal scope' });
    const db = loadDb(), user = db.users.find((item) => item.id === req.user.id);
    const identity = { userId: user.id, sessionId: sessionKey(req), scope: 'reveal-auth' };
    const previouslyVerified = sensitiveGrants.allows(revealToken(req, 'reveal-auth'), identity);
    try { if (user.sensitivePreferences?.requireAuthentication !== false && !previouslyVerified) await verifyReauthentication(req, db, user, authenticationOperation('reveal', scope), { requireTotp: true }); }
    catch (error) {
      if (error.status !== 403) throw error;
      return res.status(403).json({ error: 'Additional authentication failed' });
    }
    saveDb(db); // Persist TOTP replay protection and WebAuthn counters.
    const lifetimeMs = (user.sensitivePreferences?.timeoutSeconds || env.sensitiveRevealSeconds) * 1000;
    const sessionExpiresAt = db.sessions[sessionKey(req)].expiresAt;
    const cookies = [];
    if (user.sensitivePreferences?.requireAuthentication !== false && !previouslyVerified) {
      const verified = sensitiveGrants.issue({ ...identity, sessionExpiresAt, lifetimeMs });
      cookies.push(`${revealCookie('reveal-auth')}=${verified.token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.ceil((verified.expiresAt - Date.now()) / 1000))}${req.secure ? '; Secure' : ''}`);
    }
    sensitiveGrants.revoke(revealToken(req, scope));
    const { token, expiresAt } = sensitiveGrants.issue({ userId: user.id, sessionId: sessionKey(req), scope, sessionExpiresAt, lifetimeMs });
    cookies.push(`${revealCookie(scope)}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000))}${req.secure ? '; Secure' : ''}`);
    res.setHeader('Set-Cookie', cookies);
    audit(user.username, 'sensitive.revealed', scope);
    res.json({ scope, expiresAt, expiresInMs: Math.max(0, expiresAt - Date.now()) });
  }));
  app.post('/api/sensitive/hide', requireAuth((req, res) => {
    res.set('Cache-Control', 'no-store');
    const scopes = req.body?.scope === 'all' ? sensitiveScopes : [req.body?.scope];
    if (scopes.some((scope) => !sensitiveScopes.includes(scope))) return res.status(400).json({ error: 'Invalid reveal scope' });
    for (const scope of scopes) sensitiveGrants.revoke(revealToken(req, scope));
    clearRevealCookies(req, res, scopes);
    res.json({ ok: true });
  }));
  app.get('/api/sensitive/infrastructure', requireAuth(async (req, res) => {
    if (!requireSensitive(req, res, 'infrastructure')) return;
    const read = async (file) => fs.readFile(path.join(env.brokerDir, file), 'utf8').then(certificateMetadata).catch(() => null);
    const [ca, serverCertificate] = await Promise.all([read('ca.crt'), read('server.crt')]);
    if (!requireSensitive(req, res, 'infrastructure')) return;
    res.json({ hostname: env.hostname, domain: env.domain, publicIP: env.publicIP || null,
      localAddress: env.localAddress, publicUrl: env.origin, mqttTlsPort: env.mqttTlsPort,
      mqttWsPort: env.mqttWsPort, adminPort: env.port, topicPrefix: env.topicPrefix, ca, serverCertificate });
  }));
}
