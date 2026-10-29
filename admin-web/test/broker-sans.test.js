import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseBrokerExtraSans } from '../src/broker-sans.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-sans-'));
process.env.ADMIN_DATA_DIR = path.join(dir, 'admin');
process.env.CA_DIR = path.join(dir, 'ca');
process.env.BROKER_CONFIG_DIR = path.join(dir, 'broker');
process.env.GATEWAY_HOSTNAME = 'localhost';
process.env.GATEWAY_DOMAIN = '';
process.env.LOCAL_ADDRESS = 'localhost';
delete process.env.MQTT_BROKER_EXTRA_SANS;
const { env } = await import('../src/config.js');
const {
  prepareGateway,
  refreshPki,
  brokerCertificateNeedsUpdate,
  updateBrokerCertificate,
  openssl,
  signDeviceCsr,
} = await import('../src/services/certificate-service.js');
const { sqlite } = await import('../src/db.js');
test('extra DNS SANs are optional, canonical, deduplicated and reject extension injection', () => {
  assert.deepEqual(parseBrokerExtraSans(), []);
  assert.deepEqual(parseBrokerExtraSans('  '), []);
  assert.deepEqual(parseBrokerExtraSans(' MQTT.Example.com.,mqtt.example.com,localhost'), [
    'mqtt.example.com',
    'localhost',
  ]);
  assert.deepEqual(parseBrokerExtraSans('xn--bcher-kva.example'), ['xn--bcher-kva.example']);
  for (const value of [
    'https://mqtt.example.com',
    '*.example.com',
    '127.0.0.1',
    '::1',
    'a,,b',
    ',a',
    'a,',
    'mqtt:8883',
    'a\nDNS:evil',
    'a b',
    'bad..name',
    '-a.test',
    'a-.test',
    'mqtt/path',
    'a;CA:TRUE',
    'bücher.example',
    'a'.repeat(64) + '.test',
    Array(5).fill('a'.repeat(63)).join('.'),
  ]) {
    assert.throws(() => parseBrokerExtraSans(value), /MQTT_BROKER_EXTRA_SANS/);
  }
});
test('broker SAN updates are explicit, idempotent and preserve CA, devices and renewal', async () => {
  try {
    await assert.rejects(brokerCertificateNeedsUpdate(), /Existing CA/);
    await prepareGateway();
    const read = (file) => fs.readFile(path.join(dir, file));
    const originalCert = await read('broker/server.crt');
    assert.equal(
      new crypto.X509Certificate(originalCert).subjectAltName,
      'DNS:mqtt-broker, DNS:localhost',
    );
    assert.equal(await brokerCertificateNeedsUpdate(), false);
    const files = [
      'ca/ca.crt',
      'ca/ca.key',
      'admin/mqtt-client.crt',
      'admin/mqtt-client.key',
      'broker/server.key',
    ];
    const snapshots = await Promise.all(files.map(read));
    await openssl([
      'req',
      '-new',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      path.join(dir, 'device.key'),
      '-out',
      path.join(dir, 'device.csr'),
      '-subj',
      '/CN=sensor',
    ]);
    const device = await signDeviceCsr({
      deviceId: 'sensor',
      csr: await fs.readFile(path.join(dir, 'device.csr'), 'utf8'),
    });
    env.brokerExtraSans = parseBrokerExtraSans(
      'mqtt.example.com,LOCALHOST,mqtt.example.com',
    );
    await refreshPki();
    assert.deepEqual(
      await read('broker/server.crt'),
      originalCert,
      'daily maintenance must not apply changed SANs',
    );
    assert.equal(await brokerCertificateNeedsUpdate(), true);
    await fs.writeFile(path.join(dir, 'broker/pending-revision'), 'staged-policy');
    await assert.rejects(updateBrokerCertificate(), /pending broker changes/);
    assert.deepEqual(await read('broker/server.crt'), originalCert);
    await fs.rm(path.join(dir, 'broker/pending-revision'));
    assert.equal(await updateBrokerCertificate(), true);
    const updatedCert = await read('broker/server.crt');
    const updated = new crypto.X509Certificate(updatedCert);
    for (const hostname of ['mqtt-broker', 'localhost', 'mqtt.example.com'])
      assert.ok(updated.checkHost(hostname));
    assert.equal(updated.checkHost('wrong.example.com'), undefined);
    assert.equal(updated.subjectAltName.match(/DNS:localhost/g).length, 1);
    await openssl([
      'verify',
      '-CAfile',
      path.join(dir, 'ca/ca.crt'),
      '-purpose',
      'sslserver',
      '-verify_hostname',
      'mqtt.example.com',
      path.join(dir, 'broker/server.crt'),
    ]);
    assert.ok(
      new crypto.X509Certificate(device).verify(
        new crypto.X509Certificate(await read('ca/ca.crt')).publicKey,
      ),
    );
    for (const [i, file] of files.entries())
      assert.deepEqual(await read(file), snapshots[i], `${file} must remain unchanged`);
    const revision = await read('broker/revision');
    assert.equal(await updateBrokerCertificate(), false);
    assert.deepEqual(await read('broker/revision'), revision, 'no unnecessary broker restart');
    assert.deepEqual(await read('broker/server.crt'), updatedCert);
    // Signing failure must leave the active certificate, key and restart marker intact.
    env.brokerExtraSans = ['unapplied.example.com'];
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = '';
      await assert.rejects(updateBrokerCertificate(), /ENOENT/);
    } finally {
      process.env.PATH = previousPath;
    }
    assert.deepEqual(await read('broker/server.crt'), updatedCert);
    assert.deepEqual(await read('broker/server.key'), snapshots[4]);
    assert.deepEqual(await read('broker/revision'), revision);
    env.brokerExtraSans = [];
    assert.equal(await updateBrokerCertificate(), true);
    assert.equal(
      new crypto.X509Certificate(await read('broker/server.crt')).checkHost(
        'mqtt.example.com',
      ),
      undefined,
    );
    await openssl([
      'x509',
      '-in',
      path.join(dir, 'broker/server.crt'),
      '-signkey',
      path.join(dir, 'broker/server.key'),
      '-days',
      '1',
      '-out',
      path.join(dir, 'broker/server.crt'),
    ]);
    env.brokerExtraSans = ['renewed.example.com'];
    await refreshPki();
    const renewed = new crypto.X509Certificate(await read('broker/server.crt'));
    assert.ok(renewed.checkHost('renewed.example.com'));
    assert.ok(renewed.verify(new crypto.X509Certificate(await read('ca/ca.crt')).publicKey));
    assert.deepEqual(await read('ca/ca.key'), snapshots[1]);
  } finally {
    sqlite.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
