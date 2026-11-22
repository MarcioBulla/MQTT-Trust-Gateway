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
