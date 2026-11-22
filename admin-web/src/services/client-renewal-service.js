import fs from 'node:fs';
import path from 'node:path';
import mqtt from 'mqtt';
import { env } from '../config.js';
import { exclusive, loadDb, saveDb, sqlite } from '../db.js';
import { allocateEntityId } from './entity-ids.js';
import { certificateMetadata, inspectCsr, signDeviceCsr, syncBroker } from './certificate-service.js';
import { createRenewalCoordinator } from './renewal-coordinator.js';
import { configuredRenewalTopics } from './renewal-protocol.js';
import { createRenewalStore } from './renewal-store.js';
import { renewalAclForDevice } from './renewal-acl.js';
import { updateMaintenance } from './updater-client.js';

let transport;
let coordinator;
let store;
let timer;
let scheduleTimer;
const dayMs = 86_400_000;

function eligible(db, deviceId, targetId) {
  const device = db.devices.find((item) => item.id === deviceId && item.enabled &&
    item.status === 'active' && item.trusted !== false);
  const certificate = db.certificates.find((item) => item.id === targetId && item.deviceId === deviceId &&
    item.issuer === 'local' && item.status === 'active' && item.brokerTrusted !== false &&
    !item.licenseArchivedAt && !item.licenseDeletedAt && Date.parse(item.validTo) > Date.now());
  return device && certificate ? device : undefined;
}

async function subscribe(operation) {
  const { csr, status } = configuredRenewalTopics(operation.deviceId, operation.topics);
  // MQTT.js skips subscriptions it already tracks unless explicitly asked to resubscribe.
  // Require a fresh broker acknowledgement after applying ACLs.
  const options = { qos: 1, rap: true, rh: 2 };
  const grants = await transport.subscribeAsync({ [csr]: options, [status]: options, resubscribe: true });
  const refused = grants.filter((grant) => grant.qos !== 1).map((grant) => grant.topic);
  if (grants.length !== 2 || refused.length)
    throw new Error(`Broker denied PKI subscription at: ${refused.join(', ') || 'incomplete grant response'}`);
}

export function startClientRenewal() {
  store = createRenewalStore(sqlite);
  transport = mqtt.connect(`mqtts://${env.mqttHost}:8883`, {
    cert: fs.readFileSync(path.join(env.dataDir, 'mqtt-client.crt')),
    key: fs.readFileSync(path.join(env.dataDir, 'mqtt-client.key')),
    ca: fs.readFileSync(path.join(env.caDir, 'ca.crt')),
    rejectUnauthorized: true, protocolVersion: 5, queueQoSZero: false,
  });
  const publish = async (topic, payload, options) => {
    if (!transport.connected || updateMaintenance()) throw new Error('Renewal transport unavailable');
    const ack = await transport.publishAsync(topic, payload, options);
    if (ack?.reasonCode >= 128) throw new Error('Broker rejected renewal publication');
  };
  coordinator = createRenewalCoordinator({
    store,
    publish,
    authorize(deviceId, operation) {
      return !updateMaintenance() && operation.type === 'client' &&
        eligible(loadDb(), deviceId, operation.targetId)?.renewal?.mqttEnabled === true;
    },
    async inspectClient(csr) {
      const { subject } = await inspectCsr(csr, { verifySignature: true });
      const cn = /^subject=CN=([A-Za-z0-9._-]{1,64})$/.exec(subject)?.[1];
      if (!cn) throw new Error('Unsupported renewal CSR subject');
      return cn;
    },
    issueClient(operation, csr, expectedCn) {
      return exclusive(async () => {
        const db = loadDb();
        if (!eligible(db, operation.deviceId, operation.targetId)) throw new Error('Device authorization changed');
        const existing = db.certificates.find((item) => item.renewalOperationId === operation.id);
        if (existing) return existing.certificate;
        const certificate = await signDeviceCsr({ deviceId: operation.deviceId, csr, expectedCn, days: operation.validityDays, requireMatchingSubject: true });
        const dbAfterSigning = loadDb();
        dbAfterSigning.certificates.unshift({
          id: allocateEntityId('certificate'), deviceId: operation.deviceId, ...certificateMetadata(certificate),
          certificate, issuer: 'local', status: 'active', brokerTrusted: true, provisioningMethod: 'mqtt-csr',
          issuedAt: new Date().toISOString(), renewalOperationId: operation.id, renewedFrom: operation.targetId,
        });
        saveDb(dbAfterSigning);
        return certificate;
      });
    },
  });
  transport.on('error', () => {});
  transport.on('connect', async () => {
    if (updateMaintenance()) return;
    try {
      const pending = store.listPending();
      if (pending.length) await exclusive(() => syncBroker());
      for (const operation of pending) await subscribe(operation);
      await coordinator.resume();
    } catch { console.error('Could not resume MQTT certificate renewal'); }
  });
  transport.on('message', (topic, payload, packet) => {
    if (updateMaintenance()) return;
    for (const operation of store.listPending()) {
      const topics = configuredRenewalTopics(operation.deviceId, operation.topics);
      const kind = topic === topics.csr ? 'csr' : topic === topics.status ? 'status' : null;
      if (kind) coordinator.receive(operation.deviceId, kind, payload, packet)
        .catch(() => console.error('Could not process MQTT certificate renewal message'));
    }
  });
  timer = setInterval(() => coordinator.expirePending().catch(() => {}), 5000);
  timer.unref();
  scheduleTimer = setInterval(() => checkScheduledRenewals().catch(() => console.error('Could not check MQTT renewal schedule')), 60_000);
  scheduleTimer.unref();
}

export function stopClientRenewal() {
  clearInterval(timer);
  clearInterval(scheduleTimer);
  return transport?.endAsync(true);
}

let startQueue = Promise.resolve();

export function beginClientRenewal(deviceId, configured, policy, requestedDays, scheduled = false, saveOnly = false, manualApproval = false) {
  const result = startQueue.then(() => configureAndBegin(deviceId, configured, policy, requestedDays, scheduled, saveOnly, manualApproval));
  startQueue = result.catch(() => {});
  return result;
}

async function configureAndBegin(deviceId, configured, policy, requestedDays, scheduled, saveOnly, manualApproval) {
  let topics, cnPolicy, targetId, validityDays;
  if (!transport?.connected || updateMaintenance())
    throw Object.assign(new Error('Renewal transport unavailable'), { status: 503 });
  await exclusive(async () => {
    const db = loadDb();
    const target = db.certificates
      .filter((item) => item.deviceId === deviceId && eligible(db, deviceId, item.id) &&
        (!item.renewalOperationId || store.get(item.renewalOperationId)?.status === 'confirmed'))
      .sort((a, b) => (Date.parse(b.issuedAt ?? b.validFrom) || 0) - (Date.parse(a.issuedAt ?? a.validFrom) || 0))[0];
    targetId = target?.id;
    const device = eligible(db, deviceId, targetId);
    if (!device) throw Object.assign(new Error('Renewal requires an authorized device with an active local certificate'), { status: 409 });
    if (scheduled && (device.renewal?.mqttCnPolicy?.mode !== 'automatic' ||
        device.renewal.mqttCnPolicy.scheduleEnabled === false || !device.renewal.mqttCnPolicy.beforeExpiryDays || store.pendingForDevice(deviceId) ||
        store.hasScheduledAttempt(deviceId, targetId) ||
        Date.parse(target.validTo) - Date.now() > device.renewal.mqttCnPolicy.beforeExpiryDays * dayMs)) return;
    if (store.pendingForDevice(deviceId)) throw Object.assign(new Error('Renewal already pending'), { status: 409 });
    try { topics = configuredRenewalTopics(deviceId, configured ?? device.renewal?.mqttTopics); }
    catch (error) { throw Object.assign(error, { status: 400 }); }
    cnPolicy = (manualApproval ? undefined : policy) ?? device.renewal?.mqttCnPolicy ?? { mode: 'automatic', expectedCn: deviceId };
    if (cnPolicy?.mode === 'manual') cnPolicy = { mode: 'manual' };
    else if (cnPolicy?.mode === 'automatic' && typeof cnPolicy.expectedCn === 'string' &&
             /^[A-Za-z0-9._-]{1,64}$/.test(cnPolicy.expectedCn))
      cnPolicy = { mode: 'automatic', expectedCn: cnPolicy.expectedCn, beforeExpiryDays: cnPolicy.beforeExpiryDays ?? null, scheduleEnabled: cnPolicy.scheduleEnabled ?? (cnPolicy.beforeExpiryDays != null) };
    else throw Object.assign(new Error('Enter a valid expected CSR CN'), { status: 400 });
    validityDays = requestedDays === null ? env.certDays : requestedDays ?? device.renewal?.mqttValidityDays ?? env.certDays;
    if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > env.maxCertDays)
      throw Object.assign(new Error(`Validity must be 1–${env.maxCertDays} days`), { status: 400 });
    const beforeExpiryDays = cnPolicy.beforeExpiryDays;
    if (beforeExpiryDays != null && (!Number.isInteger(beforeExpiryDays) || beforeExpiryDays < 1 || beforeExpiryDays >= validityDays))
      throw Object.assign(new Error('Renewal lead time must be at least one day and shorter than the new certificate validity'), { status: 400 });
    if (cnPolicy.mode === 'automatic' && (typeof cnPolicy.scheduleEnabled !== 'boolean' ||
        (cnPolicy.scheduleEnabled && beforeExpiryDays == null)))
      throw Object.assign(new Error('Set the number of days before expiry to enable scheduled renewal'), { status: 400 });
    const used = new Set(db.devices.filter((item) => item.id !== deviceId && item.renewal?.mqttEnabled)
      .flatMap((item) => Object.values(configuredRenewalTopics(item.id, item.renewal.mqttTopics))));
    if (Object.values(topics).some((topic) => used.has(topic)))
      throw Object.assign(new Error('Topic already reserved by another device'), { status: 409 });
    const healthTopics = db.devices.filter((item) => item.healthCheck?.enabled)
      .map((item) => ({ topic: item.healthCheck.topic }));
    try { renewalAclForDevice(device, [{ id: deviceId, renewal: { mqttTopics: topics } }], healthTopics); }
    catch (error) { throw Object.assign(error, { status: 409 }); }
    device.renewal ||= {};
    const previous = { ...device.renewal };
    device.renewal.mqttEnabled = true;
    device.renewal.mqttTopics = topics;
    device.renewal.mqttCnPolicy = cnPolicy;
    device.renewal.mqttValidityDays = validityDays;
    saveDb(db);
    try { await syncBroker(); }
    catch (error) {
      device.renewal = previous;
      saveDb(db);
      await syncBroker(true);
      throw error;
    }
  });
  if (!topics || saveOnly) return;
  await subscribe({ deviceId, topics });
  return coordinator.begin(deviceId, { type: 'client', targetId, topics, cnPolicy: manualApproval ? { mode: 'manual' } : cnPolicy, validityDays, scheduled });
}

let checkingSchedule = false;
async function checkScheduledRenewals() {
  if (checkingSchedule || !transport?.connected || updateMaintenance()) return;
  checkingSchedule = true;
  try {
    for (const device of loadDb().devices) {
      if (device.renewal?.mqttCnPolicy?.mode !== 'automatic' || device.renewal.mqttCnPolicy.scheduleEnabled === false || !device.renewal.mqttCnPolicy.beforeExpiryDays) continue;
      if (!device.enabled || device.status !== 'active' || device.trusted === false) continue;
      await beginClientRenewal(device.id, undefined, undefined, undefined, true).catch((error) => {
        if (error.status !== 409) console.error('Could not start scheduled MQTT certificate renewal');
      });
    }
  } finally { checkingSchedule = false; }
}

export function clientRenewalStatus(deviceId, id) {
  const operation = id ? store?.get(id) : store?.pendingForDevice(deviceId);
  if (operation?.deviceId !== deviceId) return null;
  const { pem, pendingCsr, ...status } = operation;
  return status;
}

export async function approveClientRenewal(deviceId, id, cn) {
  if (!transport?.connected || updateMaintenance())
    throw Object.assign(new Error('Renewal transport unavailable'), { status: 503 });
  await coordinator.approve(deviceId, id, cn);
  return clientRenewalStatus(deviceId, id);
}
