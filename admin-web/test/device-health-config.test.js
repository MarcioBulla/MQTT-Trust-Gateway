import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthTopicMatches, validateDeviceHealthConfig } from '../src/services/device-health-config.js';

test('health topic matching handles literal, single-level and multi-level Rules filters', () => {
  assert.equal(healthTopicMatches('gateway/health/device-a/status', 'gateway/health/device-a/status'), true);
  assert.equal(healthTopicMatches('gateway/health/+/status', 'gateway/health/device-a/status'), true);
  assert.equal(healthTopicMatches('gateway/health/#', 'gateway/health/device-a/status'), true);
  assert.equal(healthTopicMatches('gateway/health/device-a', 'gateway/health/device-a/status'), false);
  assert.equal(healthTopicMatches('gateway/health/device-b/#', 'gateway/health/device-a/status'), false);
});

test('health config supplies defaults and requires enabled topics to pass publish Rules', () => {
  const device = { id: 'device-a', topicRules: { mode: 'custom', publish: ['gateway/health/+/status'], subscribe: [] } };
  assert.deepEqual(validateDeviceHealthConfig({ enabled: false }, device, [device]), {
    enabled: false, topic: 'gateway/health/device-a/status', onlinePayload: 'online', offlinePayload: 'offline', offlineGrace: 30, recoveryStability: 5,
  });
  assert.deepEqual(validateDeviceHealthConfig({ enabled: true }, device, [device]), {
    enabled: true, topic: 'gateway/health/device-a/status', onlinePayload: 'online', offlinePayload: 'offline', offlineGrace: 30, recoveryStability: 5,
  });
  assert.deepEqual(validateDeviceHealthConfig({ enabled: true, topic: 'AutoBoot/availability' }, { ...device, topicRules: { mode: 'custom', publish: ['AutoBoot/#'], subscribe: [] } }, [device]), {
    enabled: true, topic: 'AutoBoot/availability', onlinePayload: 'online', offlinePayload: 'offline', offlineGrace: 30, recoveryStability: 5,
  });
  assert.deepEqual(validateDeviceHealthConfig({ enabled: true, topic: 'machine/connectivity', onlinePayload: 'connected', offlinePayload: 'disconnected' }, { ...device, topicRules: { mode: 'all' } }, [device]), {
    enabled: true, topic: 'machine/connectivity', onlinePayload: 'connected', offlinePayload: 'disconnected', offlineGrace: 30, recoveryStability: 5,
  });
  assert.throws(() => validateDeviceHealthConfig({ enabled: true, topic: 'outside/rules' }, device, [device]), /publish Rules/);
  assert.deepEqual(validateDeviceHealthConfig({ enabled: true, topic: 'outside/rules' }, { ...device, topicRules: { mode: 'all' } }, [device]), {
    enabled: true, topic: 'outside/rules', onlinePayload: 'online', offlinePayload: 'offline', offlineGrace: 30, recoveryStability: 5,
  });
});

test('health config rejects duplicate, malformed and out-of-range settings', () => {
  const device = { id: 'device-a', topicRules: { mode: 'all' } };
  const other = { id: 'device-b', healthCheck: { enabled: true, topic: 'used/status' } };
  for (const topic of ['$SYS/health', 'wild/+', 'wild/#', 'bad topic', 'line\nbreak'])
    assert.throws(() => validateDeviceHealthConfig({ enabled: true, topic }, device, [device]), /valid literal MQTT topic/);
  assert.throws(() => validateDeviceHealthConfig({ enabled: true, topic: 'used/status' }, device, [device, other]), /already used/);
  for (const [field, value] of [['offlineGrace', -1], ['offlineGrace', 3601], ['recoveryStability', 2.5]])
    assert.throws(() => validateDeviceHealthConfig({ enabled: true, [field]: value }, device, [device]), /between 0 and 3600/);
  for (const [onlinePayload, offlinePayload] of [['', 'offline'], ['online', 'online'], ['bad\nvalue', 'offline'], ['x'.repeat(129), 'offline']])
    assert.throws(() => validateDeviceHealthConfig({ enabled: true, onlinePayload, offlinePayload }, device, [device]), /payload/);
  assert.throws(() => validateDeviceHealthConfig({ enabled: 'true' }, device, [device]), /boolean/);
  assert.throws(() => validateDeviceHealthConfig({ enabled: true, topic: '' }, device, [device]), /valid literal MQTT topic/);
});
