import crypto from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { env } from '../config.js';
import { clearSessionCookie, currentUser, parseCookies, rateLimit, requireAuth, setSessionCookie } from '../auth.js';
import { loadDb, saveDb } from '../db.js';
import {
  b64urlToBuffer,
  bufferToB64url,
  credentialIdCandidates,
  credentialIdFromClientOrInfo,
  findUserCredential,
  publicUser,
  userCredentials,
} from '../passkeys.js';

function registrationOptions({ username, userId, excludeCredentials = [] }) {
  return generateRegistrationOptions({
    rpName: env.rpName,
    rpID: env.rpID,
    userID: userId,
    userName: username,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    excludeCredentials,
    supportedAlgorithmIDs: [-7, -257],
  });
}

function storeCredential(user, clientCredential, registrationInfo, name = 'Passkey') {
  const credentialID = credentialIdFromClientOrInfo(clientCredential, registrationInfo);
  const credential = {
    id: credentialID,
    publicKey: bufferToB64url(registrationInfo.credentialPublicKey),
    counter: registrationInfo.counter,
    name,
    createdAt: new Date().toISOString(),
  };
  const credentials = userCredentials(user);
  const existing = credentials.findIndex((item) => item.id === credential.id);
  if (existing >= 0) credentials[existing] = credential;
  else credentials.push(credential);
  user.credentialID = credential.id;
  user.credentialPublicKey = credential.publicKey;
  user.counter = credential.counter;
}

function createSession(db, user, res) {
  const sessionId = crypto.randomBytes(32).toString('base64url');
  db.sessions[sessionId] = { userId: user.id, expiresAt: Date.now() + 43200000 };
  setSessionCookie(res, sessionId);
}

export function registerAuthRoutes(app) {
  app.get('/api/bootstrap', async (req, res) => {
    const db = await loadDb();
    const user = await currentUser(req);
    res.json({ hasAdmin: db.users.length > 0, user: user ? publicUser(user) : null });
  });

  app.get('/api/me', requireAuth(async (req, res) => {
    res.json({ user: publicUser(req.user) });
  }));

  app.patch('/api/me', requireAuth(async (req, res) => {
    const username = String(req.body.username || '').trim();
    if (!username) return res.status(400).json({ error: 'username is required' });
    const db = await loadDb();
    const user = db.users.find((item) => item.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'unknown user' });
    if (db.users.some((item) => item.id !== user.id && item.username === username)) {
      return res.status(409).json({ error: 'username already exists' });
    }
    user.username = username;
    await saveDb(db);
    res.json({ user: publicUser(user) });
  }));

  app.post('/api/register/options', rateLimit, async (req, res) => {
    const db = await loadDb();
    if (db.users.length > 0) return res.status(403).json({ error: 'admin already registered' });
    if (!env.setupToken || req.body.setupToken !== env.setupToken) return res.status(403).json({ error: 'invalid setup token' });
    const username = String(req.body.username || '').trim();
    if (!username) return res.status(400).json({ error: 'username is required' });

    const userId = crypto.randomBytes(16);
    const options = await registrationOptions({ username, userId });
    db.challenges[`register:${username}`] = {
      challenge: options.challenge,
      userId: bufferToB64url(userId),
      expiresAt: Date.now() + 300000,
    };
    await saveDb(db);
    res.json(options);
  });

  app.post('/api/register/verify', rateLimit, async (req, res) => {
    const db = await loadDb();
    const username = String(req.body.username || '').trim();
    const challenge = db.challenges[`register:${username}`];
    if (!challenge || challenge.expiresAt < Date.now()) return res.status(400).json({ error: 'registration challenge expired' });

    const verification = await verifyRegistrationResponse({
      response: req.body.credential,
      expectedChallenge: challenge.challenge,
      expectedOrigin: env.origin,
      expectedRPID: env.rpID,
    });
    if (!verification.verified) return res.status(400).json({ error: 'passkey verification failed' });

    const user = { id: challenge.userId, username, createdAt: new Date().toISOString(), credentials: [] };
    storeCredential(user, req.body.credential, verification.registrationInfo, 'Primary passkey');
    db.users.push(user);
    delete db.challenges[`register:${username}`];
    createSession(db, user, res);
    await saveDb(db);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/passkeys/options', requireAuth(async (req, res) => {
    const db = await loadDb();
    const user = db.users.find((item) => item.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'unknown user' });
    const userId = b64urlToBuffer(user.id);
    const options = await registrationOptions({ username: user.username, userId });
    db.challenges[`add-passkey:${user.id}`] = {
      challenge: options.challenge,
      expiresAt: Date.now() + 300000,
    };
    await saveDb(db);
    res.json(options);
  }));

  app.post('/api/passkeys/verify', requireAuth(async (req, res) => {
    const db = await loadDb();
    const user = db.users.find((item) => item.id === req.user.id);
    const challenge = db.challenges[`add-passkey:${req.user.id}`];
    if (!user || !challenge || challenge.expiresAt < Date.now()) return res.status(400).json({ error: 'passkey challenge expired' });
    const verification = await verifyRegistrationResponse({
      response: req.body.credential,
      expectedChallenge: challenge.challenge,
      expectedOrigin: env.origin,
      expectedRPID: env.rpID,
    });
    if (!verification.verified) return res.status(400).json({ error: 'passkey verification failed' });
    storeCredential(user, req.body.credential, verification.registrationInfo, 'Passkey');
    delete db.challenges[`add-passkey:${req.user.id}`];
    await saveDb(db);
    res.json({ user: publicUser(user) });
  }));

  app.delete('/api/passkeys/:id', requireAuth(async (req, res) => {
    const db = await loadDb();
    const user = db.users.find((item) => item.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'unknown user' });
    const credentials = userCredentials(user);
    if (credentials.length <= 1) return res.status(400).json({ error: 'cannot remove the last passkey' });
    user.credentials = credentials.filter((credential) => credential.id !== req.params.id);
    const primary = user.credentials[0];
    user.credentialID = primary.id;
    user.credentialPublicKey = primary.publicKey;
    user.counter = primary.counter || 0;
    await saveDb(db);
    res.json({ user: publicUser(user) });
  }));

  app.post('/api/login/options', rateLimit, async (req, res) => {
    try {
      const db = await loadDb();
      const username = String(req.body.username || '').trim();
      const user = db.users.find((item) => item.username === username);
      if (!user) return res.status(404).json({ error: 'unknown user' });
      const options = await generateAuthenticationOptions({
        rpID: env.rpID,
        userVerification: 'preferred',
        allowCredentials: userCredentials(user).flatMap((credential) => (
          credentialIdCandidates(credential.id).map((id) => ({ id, type: 'public-key' }))
        )),
      });
      db.challenges[`login:${username}`] = { challenge: options.challenge, expiresAt: Date.now() + 300000 };
      await saveDb(db);
      res.json(options);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'failed to generate login options' });
    }
  });

  app.post('/api/login/verify', rateLimit, async (req, res) => {
    const db = await loadDb();
    const username = String(req.body.username || '').trim();
    const user = db.users.find((item) => item.username === username);
    const challenge = db.challenges[`login:${username}`];
    if (!user || !challenge || challenge.expiresAt < Date.now()) return res.status(400).json({ error: 'login challenge expired' });
    const credentialID = req.body.credential?.rawId || req.body.credential?.id || '';
    const storedCredential = findUserCredential(user, credentialID);
    if (!storedCredential) return res.status(400).json({ error: 'credential id does not match this user' });
    const verification = await verifyAuthenticationResponse({
      response: req.body.credential,
      expectedChallenge: challenge.challenge,
      expectedOrigin: env.origin,
      expectedRPID: env.rpID,
      authenticator: {
        credentialID: b64urlToBuffer(credentialID),
        credentialPublicKey: b64urlToBuffer(storedCredential.publicKey),
        counter: storedCredential.counter || 0,
      },
    });
    if (!verification.verified) return res.status(400).json({ error: 'passkey verification failed' });
    storedCredential.id = credentialID;
    storedCredential.counter = verification.authenticationInfo.newCounter;
    user.credentialID = storedCredential.id;
    user.credentialPublicKey = storedCredential.publicKey;
    user.counter = storedCredential.counter;
    delete db.challenges[`login:${username}`];
    createSession(db, user, res);
    await saveDb(db);
    res.json({ ok: true });
  });

  app.post('/api/logout', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const [sessionId] = (cookies.admin_session || '').split('.');
    if (sessionId) {
      const db = await loadDb();
      delete db.sessions[sessionId];
      await saveDb(db);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });
}
