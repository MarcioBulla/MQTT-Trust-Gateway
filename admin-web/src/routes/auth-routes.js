import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import argon2 from 'argon2';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { env } from '../config.js';
import { enrollTotp, verifyTotp } from '../totp.js';
import { currentUser, createSession, logout, rateLimit, requireAuth } from '../auth.js';
import { loadDb, saveDb, audit } from '../db.js';
import {
  publicUser,
  userCredentials,
  findUserCredential,
  credentialIdCandidates,
} from '../passkeys.js';
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
function password(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256)
    throw Object.assign(new Error('Password must contain 12–256 characters'), { status: 400 });
  return value;
}
const hash = (value) =>
  argon2.hash(password(value), {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
function passkeyContext(req, res, next) {
  if (!req.secure && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.origin).hostname))
    return res.status(403).json({ error: 'Passkeys require HTTPS or localhost' });
  next();
}
function challenge(db, key) {
  const c = db.challenges[key];
  delete db.challenges[key];
  saveDb(db); // Consume even when verification fails.
  if (!c || c.expiresAt < Date.now())
    throw Object.assign(new Error('Challenge expired'), { status: 400 });
  return c;
}
function storeChallenge(db, key, value) {
  for (const [id, c] of Object.entries(db.challenges))
    if (c.expiresAt < Date.now()) delete db.challenges[id];
  db.challenges[key] = { challenge: value, expiresAt: Date.now() + 300000 };
  saveDb(db);
}
export function registerAuthRoutes(app) {
  app.get(
    '/api/bootstrap',
    wrap(async (req, res) => {
      const user = currentUser(req);
      const hasAdmin = loadDb().users.length > 0;
      res.json({
        hasAdmin,
        user: user ? publicUser(user) : null,
        origin: env.origin,
        bootstrapHelp: hasAdmin
          ? null
          : {
              command: 'podman exec mqtt-admin cat /data/bootstrap-token',
            },
      });
    }),
  );
  app.post(
    '/api/bootstrap',
    rateLimit,
    wrap(async (req, res) => {
      const db = loadDb();
      if (db.users.length) return res.status(409).json({ error: 'Administrator already exists' });
      const tokenFile = path.join(env.dataDir, 'bootstrap-token');
      const expected = await fs.readFile(tokenFile, 'utf8');
      const supplied = String(req.body.setupToken || '');
      if (
        supplied.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
      )
        return res.status(403).json({ error: 'Invalid bootstrap token' });
      const username = String(req.body.username || '').trim();
      if (!/^[A-Za-z0-9._@-]{1,64}$/.test(username))
        return res.status(400).json({ error: 'Invalid username' });
      const user = {
        id: crypto.randomBytes(16).toString('base64url'),
        username,
        passwordHash: await hash(req.body.password),
        credentials: [],
        createdAt: new Date().toISOString(),
      };
      db.users.push(user);
      createSession(db, user, req, res);
      saveDb(db);
      await fs.unlink(tokenFile);
      audit(username, 'admin.bootstrap');
      res.json({ user: publicUser(user) });
    }),
  );
  app.post(
    '/api/login/password',
    rateLimit,
    wrap(async (req, res) => {
      const db = loadDb(),
        user = db.users.find((u) => u.username === req.body.username);
      // A dummy Argon2 operation makes unknown usernames expensive as well.
      const ok = user?.passwordHash
        ? await argon2
            .verify(user.passwordHash, String(req.body.password || '').slice(0, 256))
            .catch(() => false)
        : (await hash('dummy-password-for-timing'), false);
      if (!ok) {
        audit(String(req.body.username || '').slice(0, 64), 'login.failed', req.ip);
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      if (user.totp && !verifyTotp(user.totp, req.body.totp)) {
        audit(user.username, 'login.totp.failed', req.ip);
        return res.status(401).json({ error: 'A valid unused authenticator code is required' });
      }
      createSession(db, user, req, res);
      saveDb(db);
      audit(user.username, 'login.password');
      res.json({ user: publicUser(user) });
    }),
  );
  app.get(
    '/api/me',
    requireAuth((req, res) => res.json({ user: publicUser(req.user) })),
  );
  app.post(
    '/api/me/password',
    requireAuth(async (req, res) => {
      const db = loadDb(),
        user = db.users.find((u) => u.id === req.user.id);
      if (
        user.passwordHash &&
        !(await argon2
          .verify(user.passwordHash, String(req.body.currentPassword || ''))
          .catch(() => false))
      )
        return res.status(403).json({ error: 'Current password is incorrect' });
      user.passwordHash = await hash(req.body.password);
      db.sessions = Object.fromEntries(
        Object.entries(db.sessions).filter(([, s]) => s.userId !== user.id),
      );
      createSession(db, user, req, res);
      saveDb(db);
      audit(user.username, 'password.changed');
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/me/totp/options',
    requireAuth(async (req, res) => {
      const db = loadDb(),
        user = db.users.find((u) => u.id === req.user.id);
      if (user.totp)
        return res
          .status(409)
          .json({ error: 'Disable the existing authenticator before replacing it' });
      const setup = await enrollTotp(user.username);
      user.pendingTotp = setup.pending;
      saveDb(db);
      res.json({ secret: setup.secret, qr: setup.qr, uri: setup.uri });
    }),
  );
  app.post(
    '/api/me/totp/verify',
    rateLimit,
    requireAuth((req, res) => {
      const db = loadDb(),
        user = db.users.find((u) => u.id === req.user.id);
      if (
        !user.pendingTotp ||
        user.pendingTotp.expiresAt < Date.now() ||
        !verifyTotp(user.pendingTotp, req.body.code)
      )
        return res.status(400).json({ error: 'Invalid or expired authenticator code' });
      user.totp = { encrypted: user.pendingTotp.encrypted, lastStep: user.pendingTotp.lastStep };
      delete user.pendingTotp;
      saveDb(db);
      audit(user.username, 'totp.enabled');
      res.json({ ok: true });
    }),
  );
  app.delete(
    '/api/me/totp',
    rateLimit,
    requireAuth((req, res) => {
      const db = loadDb(),
        user = db.users.find((u) => u.id === req.user.id);
      if (!verifyTotp(user.totp, req.body.code))
        return res.status(400).json({ error: 'A valid unused authenticator code is required' });
      delete user.totp;
      delete user.pendingTotp;
      saveDb(db);
      audit(user.username, 'totp.disabled');
      res.json({ ok: true });
    }),
  );
  app.post('/api/logout', requireAuth(logout));
  app.post(
    '/api/passkeys/options',
    passkeyContext,
    requireAuth(async (req, res) => {
      const db = loadDb(),
        user = db.users.find((u) => u.id === req.user.id);
      const options = await generateRegistrationOptions({
        rpName: env.rpName,
        rpID: env.rpID,
        userID: new Uint8Array(Buffer.from(user.id, 'base64url')),
        userName: user.username,
        attestationType: 'none',
        supportedAlgorithmIDs: [-7, -257],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: userCredentials(user).map((c) => ({ id: c.id, type: 'public-key' })),
      });
      storeChallenge(db, `add:${user.id}`, options.challenge);
      res.json(options);
    }),
  );
  app.post(
    '/api/passkeys/verify',
    passkeyContext,
    requireAuth(async (req, res) => {
      const db = loadDb(),
        user = db.users.find((u) => u.id === req.user.id),
        c = challenge(db, `add:${user.id}`);
      const result = await verifyRegistrationResponse({
        response: req.body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: env.origin,
        expectedRPID: env.rpID,
        requireUserVerification: true,
      });
      if (!result.verified) return res.status(400).json({ error: 'Passkey verification failed' });
      const info = result.registrationInfo,
        id = req.body.credential.id;
      if (db.users.some((u) => userCredentials(u).some((c) => c.id === id)))
        return res.status(409).json({ error: 'Passkey is already registered' });
      userCredentials(user).push({
        id,
        publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
        counter: info.credential.counter,
        name: String(req.body.name || 'Passkey').slice(0, 64),
        createdAt: new Date().toISOString(),
      });
      saveDb(db);
      audit(user.username, 'passkey.added', id);
      res.json({ user: publicUser(user) });
    }),
  );
  app.delete(
    '/api/passkeys/:id',
    requireAuth((req, res) => {
      const db = loadDb(),
        user = db.users.find((u) => u.id === req.user.id);
      if (!user.passwordHash && userCredentials(user).length <= 1)
        return res.status(409).json({ error: 'Set a password before removing the last passkey' });
      user.credentials = userCredentials(user).filter((c) => c.id !== req.params.id);
      delete user.credentialID;
      delete user.credentialPublicKey;
      delete user.counter;
      saveDb(db);
      audit(user.username, 'passkey.removed', req.params.id);
      res.json({ user: publicUser(user) });
    }),
  );
  app.post(
    '/api/login/options',
    rateLimit,
    passkeyContext,
    wrap(async (req, res) => {
      const db = loadDb(),
        user = db.users.find((u) => u.username === req.body.username);
      if (!user || !userCredentials(user).length)
        return res.status(401).json({ error: 'No matching passkey' });
      const options = await generateAuthenticationOptions({
        rpID: env.rpID,
        userVerification: 'required',
        allowCredentials: userCredentials(user).flatMap((c) =>
          credentialIdCandidates(c.id).map((id) => ({ id, type: 'public-key' })),
        ),
      });
      storeChallenge(db, `login:${user.id}`, options.challenge);
      res.json(options);
    }),
  );
  app.post(
    '/api/login/verify',
    rateLimit,
    passkeyContext,
    wrap(async (req, res) => {
      const db = loadDb(),
        user = db.users.find((u) => u.username === req.body.username);
      if (!user) return res.status(401).json({ error: 'Invalid login' });
      const c = challenge(db, `login:${user.id}`),
        credential = findUserCredential(user, req.body.credential?.id);
      if (!credential) return res.status(401).json({ error: 'Invalid credential' });
      const result = await verifyAuthenticationResponse({
        response: req.body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: env.origin,
        expectedRPID: env.rpID,
        requireUserVerification: true,
        credential: {
          id: req.body.credential.id,
          publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')),
          counter: credential.counter || 0,
        },
      });
      if (!result.verified) return res.status(401).json({ error: 'Passkey verification failed' });
      credential.counter = result.authenticationInfo.newCounter;
      createSession(db, user, req, res);
      saveDb(db);
      audit(user.username, 'login.passkey');
      res.json({ user: publicUser(user) });
    }),
  );
}
