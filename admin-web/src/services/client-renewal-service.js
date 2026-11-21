import fs from 'node:fs';
import path from 'node:path';
import mqtt from 'mqtt';
import { env } from '../config.js';
import { exclusive, loadDb, saveDb, sqlite } from '../db.js';
import { allocateEntityId } from './entity-ids.js';
import { certificateMetadata, signDeviceCsr, syncBroker } from './certificate-service.js';
import { createRenewalCoordinator } from './renewal-coordinator.js';
import { configuredRenewalTopics } from './renewal-protocol.js';
import { createRenewalStore } from './renewal-store.js';
import { renewalAclForDevice } from './renewal-acl.js';
import { updateMaintenance } from './updater-client.js';

let transport;
let coordinator;
let store;
let timer;

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
  const grants = await transport.subscribeAsync([csr, status], { qos: 1, rap: true, rh: 2 });
  if (grants.length !== 2 || grants.some((grant) => grant.qos !== 1))
    throw new Error('Broker did not grant PKI subscriptions');
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
    issueClient(operation, csr) {
      return exclusive(async () => {
        const db = loadDb();
        if (!eligible(db, operation.deviceId, operation.targetId)) throw new Error('Device authorization changed');
        const existing = db.certificates.find((item) => item.renewalOperationId === operation.id);
        if (existing) return existing.certificate;
        const certificate = await signDeviceCsr({ deviceId: operation.deviceId, csr, requireMatchingSubject: true });
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
}

export function stopClientRenewal() {
  clearInterval(timer);
  return transport?.endAsync(true);
}

let startQueue = Promise.resolve();

export function beginClientRenewal(deviceId, targetId, configured) {
  const result = startQueue.then(() => configureAndBegin(deviceId, targetId, configured));
  startQueue = result.catch(() => {});
  return result;
}

async function configureAndBegin(deviceId, targetId, configured) {
  let topics;
  if (!transport?.connected || updateMaintenance())
    throw Object.assign(new Error('Renewal transport unavailable'), { status: 503 });
  await exclusive(async () => {
    const db = loadDb();
    const device = eligible(db, deviceId, targetId);
    if (!device) throw Object.assign(new Error('Select an active local certificate for an authorized device'), { status: 409 });
    if (store.pendingForDevice(deviceId)) throw Object.assign(new Error('Renewal already pending'), { status: 409 });
    try { topics = configuredRenewalTopics(deviceId, configured ?? device.renewal?.mqttTopics); }
    catch (error) { throw Object.assign(error, { status: 400 }); }
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
    saveDb(db);
    try { await syncBroker(); }
    catch (error) {
      device.renewal = previous;
      saveDb(db);
      await syncBroker(true);
      throw error;
    }
  });
  await subscribe({ deviceId, topics });
  return coordinator.begin(deviceId, { type: 'client', targetId, topics });
}

export function clientRenewalStatus(deviceId, id) {
  const operation = store?.get(id);
  if (operation?.deviceId !== deviceId) return null;
  const { pem, ...status } = operation;
  return status;
}
