import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeRenewalMessage, newRenewalId } from '../src/services/renewal-protocol.js';

test('MQTT renewal accepts the firmware CSR field and the legacy PEM field', () => {
  const request_id = newRenewalId();
  const csr = '-----BEGIN CERTIFICATE REQUEST-----\nexample\n-----END CERTIFICATE REQUEST-----\n';
  const decode = (fields) => decodeRenewalMessage(
    Buffer.from(JSON.stringify({ request_id, ...fields })), { qos: 1, retain: false }, 'csr',
  );
  assert.deepEqual(decode({ csr }), { request_id, pem: csr });
  assert.deepEqual(decode({ pem: csr }), { request_id, pem: csr });
  assert.equal(decode({ csr, pem: 'different' }), null);
  assert.equal(decode({ csr: 'x'.repeat(4097) }), null);
});

test('manual CSR approval binds the request to the reviewed CN', async () => {
  const { createRenewalCoordinator } = await import('../src/services/renewal-coordinator.js');
  const operations = new Map();
  const sent = [];
  const coordinator = createRenewalCoordinator({
    store: { save: (op) => operations.set(op.id, op), get: (id) => operations.get(id), pendingForDevice: () => null },
    authorize: () => true,
    inspectClient: async () => 'AutoBoot_Test',
    issueClient: async (op, csr, cn) => {
      assert.equal(op.deviceId, 'device-id');
      assert.equal(cn, 'AutoBoot_Test');
      return 'signed certificate';
    },
    publish: async (topic) => sent.push(topic),
  });
  const id = await coordinator.begin('device-id', { type: 'client', cnPolicy: { mode: 'manual' } });
  await coordinator.receive('device-id', 'csr', Buffer.from(JSON.stringify({request_id: id, csr: 'signed request'})), { qos: 1, retain: false });
  assert.deepEqual(sent, ['device-id/pki/request']);
  await assert.rejects(coordinator.approve('device-id', id, 'different'), { status: 409 });
  await coordinator.approve('device-id', id, 'AutoBoot_Test');
  assert.deepEqual(sent, ['device-id/pki/request', 'device-id/pki/install']);
  assert.equal(operations.get(id).pendingCsr, undefined);
});
