/** Offline-controller probe, executed inside Admin with fixed, restricted topics. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import mqtt from 'mqtt';
import { env } from './config.js';

const timeout = 5000;
const clients = [];
let stage = 'ADMIN_API';
let clearProbeRetained;
const file = (name) => fs.readFileSync(path.join(env.dataDir, name));
const ca = fs.readFileSync(path.join(env.caDir, 'ca.crt'));
const expectedSchema = Number(process.argv[2]);
const topic = `gateway:update:health/${crypto.randomUUID()}`;
const denied = `gateway:update:denied/${crypto.randomUUID()}`;
const baseOptions = { ca, rejectUnauthorized: true, reconnectPeriod: 0, connectTimeout: timeout, protocolVersion: 5, clean: true };
const authorized = { ...baseOptions, cert: file('update-health-client.crt'), key: file('update-health-client.key') };
function connect(options, transport = 'mqtts') {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`${transport}://${env.mqttHost}:${transport === 'wss' ? '8443/mqtt' : '8883'}`, options);
    clients.push(client);
    const timer = setTimeout(() => reject(new Error('MQTT timeout')), timeout);
    client.once('error', (error) => { clearTimeout(timer); reject(error); });
    client.once('close', () => { clearTimeout(timer); reject(new Error('MQTT closed before acceptance')); });
    client.once('connect', () => { clearTimeout(timer); resolve(client); });
  });
}
async function rejected(options) {
  try { await connect(options); } catch (error) {
    if (error.message === 'MQTT timeout' || ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH'].includes(error.code)) throw error;
    return;
  }
  throw new Error('Invalid credential was accepted');
}
function apiHealth() {
  return new Promise((resolve, reject) => {
    const secure = Boolean(env.tlsCert && env.tlsKey);
    const request = (secure ? https : http).get({
      hostname: process.env.UPDATE_HEALTH_API_HOST || '127.0.0.1', port: env.port, path: '/healthz', timeout,
      ...(secure ? { servername: new URL(env.origin).hostname, ca: [...tls.rootCertificates, fs.readFileSync(env.tlsCert)], rejectUnauthorized: true } : {}),
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; if (body.length > 4096) request.destroy(new Error('Health response too large')); });
      response.on('end', () => {
        try { if (response.statusCode !== 200 || JSON.parse(body).ok !== true) throw new Error('API health failed'); resolve(JSON.parse(body)); }
        catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('API timeout')));
    request.on('error', reject);
  });
}
try {
  if (process.argv[2] === 'ready') {
    const readiness = await apiHealth();
    if (readiness.updateReady !== true) throw new Error('Confirm or cancel pending one-time credential delivery before updating');
    console.log(JSON.stringify({ ok: true }));
    process.exit(0);
  }
  if (!Number.isSafeInteger(expectedSchema) || expectedSchema < 1) throw new Error('Unknown expected schema');
  await apiHealth();
  const expectedVersion = process.argv[3];
  if (expectedVersion && JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version !== expectedVersion) throw new Error('Installed application does not match release version');
  stage = 'DATABASE';
  const database = new DatabaseSync(path.join(env.dataDir, 'gateway.sqlite'), { readOnly: true });
  try {
    if (database.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Invalid database');
    if (database.prepare('PRAGMA user_version').get().user_version !== expectedSchema) throw new Error('Incompatible schema');
    const state = JSON.parse(database.prepare('SELECT value FROM state WHERE id=1').get().value);
    if (!state.users?.length) throw new Error('Administrative state is not initialized');
  } finally { database.close(); }
  stage = 'BROKER_TLS';
  const serverCertificate = new crypto.X509Certificate(fs.readFileSync(path.join(env.brokerDir, 'server.crt')));
  const serverKey = crypto.createPrivateKey(fs.readFileSync(path.join(env.brokerDir, 'server.key')));
  if (!serverCertificate.checkPrivateKey(serverKey)) throw new Error('Server key mismatch');
  execFileSync('openssl', ['verify', '-CAfile', path.join(env.caDir, 'ca.crt'), '-purpose', 'sslserver', path.join(env.brokerDir, 'server.crt')], { stdio: 'pipe', timeout });
  stage = 'BROKER_CRL';
  execFileSync('openssl', ['crl', '-in', path.join(env.brokerDir, 'ca.crl'), '-verify', '-CAfile', path.join(env.caDir, 'ca.crt'), '-noout'], { stdio: 'pipe', timeout });
  stage = 'BROKER_REVISION';
  if (fs.readFileSync(path.join(env.brokerDir, 'revision'), 'utf8') !== fs.readFileSync(path.join(env.brokerDir, 'applied-revision'), 'utf8')) throw new Error('Broker configuration is not applied');
  stage = 'MQTT_CONNECT';
  const subscriber = await connect(authorized);
  const publisher = await connect(authorized);
  await new Promise((resolve, reject) => subscriber.subscribe(topic, { qos: 1 }, (error, grants) => error || grants?.some(item => item.qos > 2) ? reject(error || new Error('Subscription refused')) : resolve()));
  stage = 'MQTT_DELIVERY';
  const payload = crypto.randomBytes(32);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Delivery timeout')), timeout);
    subscriber.on('message', (receivedTopic, receivedPayload) => {
      if (receivedTopic === topic && receivedPayload.equals(payload)) { clearTimeout(timer); resolve(); }
    });
    publisher.publish(topic, payload, { qos: 1, retain: false, properties: { messageExpiryInterval: 10 } }, (error) => { if (error) { clearTimeout(timer); reject(error); } });
  });
  stage = 'WSS_DELIVERY';
  const websocket = await connect(authorized, 'wss');
  const websocketTopic = topic + '/wss';
  await new Promise((resolve, reject) => websocket.subscribe(websocketTopic, { qos: 1 }, (error, grants) => error || grants?.some(item => item.qos > 2) ? reject(error || new Error('WSS subscription refused')) : resolve()));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WSS delivery timeout')), timeout);
    websocket.on('message', (receivedTopic, receivedPayload) => {
      if (receivedTopic === websocketTopic && receivedPayload.equals(payload)) { clearTimeout(timer); resolve(); }
    });
    websocket.publish(websocketTopic, payload, { qos: 1, retain: false }, error => { if (error) { clearTimeout(timer); reject(error); } });
  });
  stage = 'ACL_SUBSCRIBE';
  const observer = await connect({ ...baseOptions, cert: file('mqtt-client.crt'), key: file('mqtt-client.key') });
  const publishControl = (payload, retain) => new Promise((resolve, reject) => observer.publish(denied, payload, { qos: 1, retain }, (error) => error ? reject(error) : resolve()));
  const sentinel = crypto.randomBytes(32);
  let readLeak = false;
  subscriber.on('message', (receivedTopic, receivedPayload) => {
    if (receivedTopic === denied && receivedPayload.equals(sentinel)) readLeak = true;
  });
  // Mosquitto may accept a subscription filter but enforce read ACLs when
  // delivering messages. Verify non-delivery, rather than assuming SUBACK denial.
  await publishControl(sentinel, true);
  clearProbeRetained = () => publishControl('', true);
  try {
    await new Promise((resolve) => subscriber.subscribe(denied, { qos: 1 }, () => resolve()));
    await new Promise(resolve => setTimeout(resolve, 350));
    if (readLeak) throw new Error('ACL delivered unauthorized retained content');
  } finally { await clearProbeRetained(); clearProbeRetained = null; }
  stage = 'ACL_PUBLISH';
  await new Promise((resolve, reject) => observer.subscribe(denied, { qos: 1 }, (error, grants) => error || grants?.some(item => item.qos > 2) ? reject(error || new Error('Control subscription failed')) : resolve()));
  const forbiddenPayload = crypto.randomBytes(32);
  let writeLeak = false;
  observer.on('message', (receivedTopic, receivedPayload) => {
    if (receivedTopic === denied && receivedPayload.equals(forbiddenPayload)) writeLeak = true;
  });
  await new Promise((resolve, reject) => publisher.publish(denied, forbiddenPayload, { qos: 1, retain: false, properties: { messageExpiryInterval: 10 } }, (error) => {
    if (error && error.code !== 135 && !/not authorized/i.test(error.message)) reject(error);
    else resolve();
  }));
  await new Promise(resolve => setTimeout(resolve, 350));
  if (writeLeak) throw new Error('ACL delivered unauthorized publication');
  stage = 'INVALID_CREDENTIAL';
  await rejected(baseOptions);
  // A serverAuth-only certificate is signed by the trusted CA but must not be
  // accepted as a device client credential. No synthetic private key is stored.
  await rejected({ ...baseOptions, cert: fs.readFileSync(path.join(env.brokerDir, 'server.crt')), key: fs.readFileSync(path.join(env.brokerDir, 'server.key')) });
  console.log(JSON.stringify({ ok: true, admin: true, database: true, brokerTls: true, mqttMtls: true, wss: true, delivery: true, acl: true, invalidCredentialsRejected: true }));
} catch {
  console.error('UPDATE_FUNCTIONAL_HEALTH_FAILED:' + stage);
  process.exitCode = 1;
} finally {
  if (clearProbeRetained) await clearProbeRetained().catch(() => {});
  for (const client of clients) client.end(true);
}
