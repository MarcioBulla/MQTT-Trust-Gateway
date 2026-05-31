import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import helmet from 'helmet';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

const execFileAsync = promisify(execFile);

const env = {
  host: process.env.ADMIN_APP_HOST || '127.0.0.1',
  port: Number(process.env.ADMIN_APP_PORT || 8080),
  rpName: process.env.ADMIN_RP_NAME || 'MQTT Trust Gateway',
  rpID: process.env.ADMIN_RP_ID || process.env.MQTT_DOMAIN,
  origin: process.env.ADMIN_ORIGIN || `https://${process.env.MQTT_DOMAIN}`,
  setupToken: process.env.ADMIN_SETUP_TOKEN || '',
  sessionSecret: process.env.ADMIN_SESSION_SECRET || '',
  dataDir: process.env.ADMIN_DATA_DIR || '/data',
  mqttDomain: process.env.MQTT_DOMAIN || '',
  topicPrefix: process.env.MQTT_TOPIC_PREFIX || 'devices',
  stepCaUrl: process.env.STEP_CA_URL || '',
  stepCaProvisioner: process.env.STEP_CA_PROVISIONER || '',
  stepCaTtl: process.env.STEP_CA_DEVICE_CERT_TTL || '17520h',
  clientCaFile: process.env.ADMIN_CLIENT_CA_FILE || '/broker-pki/step-ca/ca.crt',
  letsencryptDir: process.env.ADMIN_LETSENCRYPT_DIR || '/etc/letsencrypt',
};

if (!env.rpID || !env.sessionSecret) {
  throw new Error('ADMIN_RP_ID/MQTT_DOMAIN and ADMIN_SESSION_SECRET are required');
}

const dbFile = path.join(env.dataDir, 'admin-db.json');
const app = express();
const authAttempts = new Map();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
    },
  },
}));
app.use(express.json({ limit: '256kb' }));

function rateLimit(req, res, next) {
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
  if (entry.count > maxAttempts) {
    return res.status(429).json({ error: 'too many attempts' });
  }
  return next();
}

function b64urlToBuffer(value) {
  return Buffer.from(value, 'base64url');
}

function bufferToB64url(value) {
  return Buffer.from(value).toString('base64url');
}

async function loadDb() {
  await fs.mkdir(env.dataDir, { recursive: true, mode: 0o700 });
  try {
    return JSON.parse(await fs.readFile(dbFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { users: [], sessions: {}, challenges: {}, certificates: [] };
  }
}

async function saveDb(db) {
  const tmpFile = `${dbFile}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(db, null, 2), { mode: 0o600 });
  await fs.rename(tmpFile, dbFile);
}

function signSession(sessionId) {
  return crypto.createHmac('sha256', env.sessionSecret).update(sessionId).digest('base64url');
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index === -1) return ['', ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }).filter(([key]) => key));
}

async function currentUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const [sessionId, signature] = (cookies.admin_session || '').split('.');
  if (!sessionId || signature !== signSession(sessionId)) return null;

  const db = await loadDb();
  const session = db.sessions[sessionId];
  if (!session || session.expiresAt < Date.now()) return null;
  return db.users.find((user) => user.id === session.userId) || null;
}

function requireAuth(handler) {
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

function setSessionCookie(res, sessionId) {
  const value = `${sessionId}.${signSession(sessionId)}`;
  res.setHeader('Set-Cookie', [
    `admin_session=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
  ]);
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

app.get('/', async (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MQTT Trust Gateway</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #101318; color: #eef2f7; }
    main { max-width: 980px; margin: 0 auto; padding: 32px 20px; }
    section { border: 1px solid #2d3440; border-radius: 8px; padding: 18px; margin: 16px 0; background: #171b22; }
    input, textarea, button { font: inherit; border-radius: 6px; border: 1px solid #3a4452; padding: 10px; }
    input, textarea { width: 100%; box-sizing: border-box; background: #0f1319; color: #eef2f7; margin: 6px 0 12px; }
    textarea { min-height: 160px; }
    button { background: #3f7cff; color: white; cursor: pointer; }
    pre { overflow: auto; background: #0b0e13; padding: 12px; border-radius: 6px; }
    .row { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
    #notice { min-height: 24px; margin: 12px 0; color: #f7c873; }
    #notice.ok { color: #7ee787; }
    #notice.error { color: #ff8a8a; }
  </style>
</head>
<body>
<main>
  <h1>MQTT Trust Gateway</h1>
  <div id="notice"></div>
  <section id="setup">
    <h2>Register Passkey</h2>
    <input id="setupToken" placeholder="Setup token">
    <input id="username" placeholder="Admin username" value="admin">
    <button id="registerPasskeyButton" type="button">Register passkey</button>
  </section>
  <section id="login">
    <h2>Login</h2>
    <input id="loginUsername" placeholder="Admin username" value="admin">
    <button id="loginPasskeyButton" type="button">Login with passkey</button>
  </section>
  <section id="app" hidden>
    <div class="row">
      <button id="refreshStatusButton" type="button">Refresh status</button>
      <button id="logoutButton" type="button">Logout</button>
    </div>
    <h2>Status</h2>
    <pre id="status"></pre>
    <h2>Sign CSR</h2>
    <input id="deviceId" placeholder="device-id">
    <input id="provisionerPassword" placeholder="Provisioner password" type="password">
    <textarea id="csr" placeholder="Paste CSR PEM here"></textarea>
    <button id="signCsrButton" type="button">Sign CSR</button>
    <pre id="cert"></pre>
  </section>
</main>
<script>
function b64urlToBuffer(value) {
  const pad = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))).buffer;
}
function bufferToB64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
}
function decodePublicKeyOptions(options) {
  options.challenge = b64urlToBuffer(options.challenge);
  if (options.user?.id) options.user.id = b64urlToBuffer(options.user.id);
  if (options.allowCredentials) {
    options.allowCredentials = options.allowCredentials.map((credential) => ({
      ...credential,
      id: b64urlToBuffer(credential.id),
    }));
  }
  if (options.excludeCredentials) {
    options.excludeCredentials = options.excludeCredentials.map((credential) => ({
      ...credential,
      id: b64urlToBuffer(credential.id),
    }));
  }
  return options;
}
function encodeCredential(credential) {
  const response = {};
  for (const [key, value] of Object.entries(credential.response)) {
    if (value instanceof ArrayBuffer) response[key] = bufferToB64url(value);
  }
  return {
    id: credential.id,
    rawId: bufferToB64url(credential.rawId),
    type: credential.type,
    response,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment,
  };
}
function setNotice(message, type = '') {
  const notice = document.getElementById('notice');
  notice.className = type;
  notice.textContent = message;
}
async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}
async function registerPasskey() {
  try {
    setNotice('Starting passkey registration...');
    if (!window.PublicKeyCredential) throw new Error('This browser does not support passkeys/WebAuthn.');
    const username = document.getElementById('username').value;
    const options = await post('/api/register/options', {
      setupToken: document.getElementById('setupToken').value,
      username,
    });
    setNotice('Waiting for the browser passkey prompt...');
    const credential = await navigator.credentials.create({ publicKey: decodePublicKeyOptions(options) });
    if (!credential) throw new Error('Passkey registration was cancelled.');
    await post('/api/register/verify', { username, credential: encodeCredential(credential) });
    setNotice('Passkey registered. Logging in...', 'ok');
    await loginPasskey(username);
  } catch (error) {
    setNotice(error.message || String(error), 'error');
  }
}
async function loginPasskey(username = document.getElementById('loginUsername').value) {
  try {
    setNotice('Starting passkey login...');
    if (!window.PublicKeyCredential) throw new Error('This browser does not support passkeys/WebAuthn.');
    const options = await post('/api/login/options', { username });
    setNotice('Waiting for the browser passkey prompt...');
    const credential = await navigator.credentials.get({ publicKey: decodePublicKeyOptions(options) });
    if (!credential) throw new Error('Passkey login was cancelled.');
    await post('/api/login/verify', { username, credential: encodeCredential(credential) });
    document.getElementById('app').hidden = false;
    setNotice('Logged in.', 'ok');
    await loadStatus();
  } catch (error) {
    setNotice(error.message || String(error), 'error');
  }
}
async function loadStatus() {
  const res = await fetch('/api/status');
  document.getElementById('status').textContent = JSON.stringify(await res.json(), null, 2);
}
async function signCsr() {
  const data = await post('/api/certificates/sign', {
    deviceId: document.getElementById('deviceId').value,
    provisionerPassword: document.getElementById('provisionerPassword').value,
    csr: document.getElementById('csr').value,
  });
  document.getElementById('cert').textContent = data.certificate;
}
async function logout() {
  await post('/api/logout', {});
  location.reload();
}
window.addEventListener('error', (event) => {
  setNotice(event.message || 'Browser script error.', 'error');
});
window.addEventListener('unhandledrejection', (event) => {
  setNotice(event.reason?.message || String(event.reason || 'Unhandled browser error.'), 'error');
});
document.getElementById('registerPasskeyButton').addEventListener('click', registerPasskey);
document.getElementById('loginPasskeyButton').addEventListener('click', () => loginPasskey());
document.getElementById('refreshStatusButton').addEventListener('click', loadStatus);
document.getElementById('logoutButton').addEventListener('click', logout);
document.getElementById('signCsrButton').addEventListener('click', signCsr);
</script>
</body>
</html>`);
});

app.post('/api/register/options', rateLimit, async (req, res) => {
  const db = await loadDb();
  if (db.users.length > 0) return res.status(403).json({ error: 'admin already registered' });
  if (!env.setupToken || req.body.setupToken !== env.setupToken) {
    return res.status(403).json({ error: 'invalid setup token' });
  }

  const username = String(req.body.username || '').trim();
  if (!username) return res.status(400).json({ error: 'username is required' });

  const userId = crypto.randomBytes(16);
  const options = await generateRegistrationOptions({
    rpName: env.rpName,
    rpID: env.rpID,
    userID: userId,
    userName: username,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
    },
    supportedAlgorithmIDs: [-7, -257],
  });

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
  const info = verification.registrationInfo;
  db.users.push({
    id: challenge.userId,
    username,
    credentialID: bufferToB64url(info.credentialID),
    credentialPublicKey: bufferToB64url(info.credentialPublicKey),
    counter: info.counter,
  });
  delete db.challenges[`register:${username}`];
  await saveDb(db);
  res.json({ ok: true });
});

app.post('/api/login/options', rateLimit, async (req, res) => {
  const db = await loadDb();
  const username = String(req.body.username || '').trim();
  const user = db.users.find((item) => item.username === username);
  if (!user) return res.status(404).json({ error: 'unknown user' });

  const options = await generateAuthenticationOptions({
    rpID: env.rpID,
    userVerification: 'required',
    allowCredentials: [{ id: b64urlToBuffer(user.credentialID), type: 'public-key' }],
  });

  db.challenges[`login:${username}`] = {
    challenge: options.challenge,
    expiresAt: Date.now() + 300000,
  };
  await saveDb(db);
  res.json(options);
});

app.post('/api/login/verify', rateLimit, async (req, res) => {
  const db = await loadDb();
  const username = String(req.body.username || '').trim();
  const user = db.users.find((item) => item.username === username);
  const challenge = db.challenges[`login:${username}`];
  if (!user || !challenge || challenge.expiresAt < Date.now()) return res.status(400).json({ error: 'login challenge expired' });

  const verification = await verifyAuthenticationResponse({
    response: req.body.credential,
    expectedChallenge: challenge.challenge,
    expectedOrigin: env.origin,
    expectedRPID: env.rpID,
    authenticator: {
      credentialID: b64urlToBuffer(user.credentialID),
      credentialPublicKey: b64urlToBuffer(user.credentialPublicKey),
      counter: user.counter,
    },
  });

  if (!verification.verified) return res.status(400).json({ error: 'passkey verification failed' });
  user.counter = verification.authenticationInfo.newCounter;
  delete db.challenges[`login:${username}`];
  const sessionId = crypto.randomBytes(32).toString('base64url');
  db.sessions[sessionId] = { userId: user.id, expiresAt: Date.now() + 43200000 };
  await saveDb(db);
  setSessionCookie(res, sessionId);
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
  res.setHeader('Set-Cookie', 'admin_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/status', requireAuth(async (_req, res) => {
  const certDir = path.join(env.letsencryptDir, 'live', env.mqttDomain);
  res.json({
    mqttDomain: env.mqttDomain,
    stepCaUrl: env.stepCaUrl,
    topicPrefix: env.topicPrefix,
    files: {
      letsencryptFullchain: await fileExists(path.join(certDir, 'fullchain.pem')),
      letsencryptPrivateKey: await fileExists(path.join(certDir, 'privkey.pem')),
      mqttClientCa: await fileExists(env.clientCaFile),
    },
  });
}));

app.post('/api/certificates/sign', requireAuth(async (req, res) => {
  const deviceId = String(req.body.deviceId || '').trim();
  const csr = String(req.body.csr || '').trim();
  const provisionerPassword = String(req.body.provisionerPassword || '');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(deviceId)) return res.status(400).json({ error: 'invalid device id' });
  if (!csr.includes('BEGIN CERTIFICATE REQUEST')) return res.status(400).json({ error: 'CSR PEM is required' });
  if (!provisionerPassword) return res.status(400).json({ error: 'provisioner password is required' });

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mqtt-trust-csr-'));
  const csrFile = path.join(workDir, `${deviceId}.csr`);
  const crtFile = path.join(workDir, `${deviceId}.crt`);
  const passwordFile = path.join(workDir, 'password');

  try {
    await fs.writeFile(csrFile, `${csr}\n`, { mode: 0o600 });
    await fs.writeFile(passwordFile, `${provisionerPassword}\n`, { mode: 0o600 });
    await execFileAsync('step', [
      'ca', 'sign',
      csrFile,
      crtFile,
      '--ca-url', env.stepCaUrl,
      '--root', env.clientCaFile,
      '--provisioner', env.stepCaProvisioner,
      '--provisioner-password-file', passwordFile,
      '--not-after', env.stepCaTtl,
      '--force',
    ], { timeout: 30000 });

    const certificate = await fs.readFile(crtFile, 'utf8');
    const db = await loadDb();
    db.certificates.push({
      deviceId,
      issuedAt: new Date().toISOString(),
      issuedBy: req.user.username,
    });
    await saveDb(db);
    res.json({ certificate });
  } catch (error) {
    res.status(500).json({ error: error.stderr || error.message });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}));

app.use((error, _req, res, _next) => {
  res.status(500).json({ error: error.message });
});

app.listen(env.port, env.host, () => {
  console.log(`MQTT Trust Gateway admin listening on ${env.host}:${env.port}`);
});
