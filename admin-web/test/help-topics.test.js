import test from 'node:test';
import assert from 'node:assert/strict';
import { helpTopics, helpTopicById } from '../frontend/help/help-topics.js';

test('Help registry provides requested unique topics', () => {
  const ids = helpTopics.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of [
    'system-updates',
    'register-device',
    'generate-complete-certificate',
    'sign-existing-csr',
    'generate-csr-external-signing',
    'import-certificate',
    'device-health-check',
  ]) assert.ok(helpTopicById[id], `Missing help topic: ${id}`);
});

test('Device Health Check help matches the passive LWT implementation and its limitations', () => {
  const topic = helpTopicById['device-health-check'];
  assert.ok(topic);
  assert.match(topic.overview, /Last Will and Testament \(LWT\)/i);
  assert.match(topic.overview, /disabled by default/i);
  assert.match(topic.overview, /does not poll the device/i);
  assert.match(topic.overview, /reserved for that device/i);
  assert.match(topic.overview, /retain-as-published disabled/i);
  assert.match(topic.overview, /cannot independently verify that a live publication used retain/i);
  assert.match(topic.overview, /status is Unknown until the connection is restored.*fresh live status message is received/i);
  assert.match(topic.overview, /successful SUBACK granting QoS 1/i);
  assert.match(topic.overview, /rejects the subscription or grants only QoS 0/i);
  assert.match(topic.overview, /subscribes again after every broker reconnection/i);
  assert.match(topic.overview, /pending broker changes/i);
  assert.match(topic.prerequisites.join(' '), /custom topic Rules.*publish/i);
  assert.match(topic.steps.join(' '), /Offline Grace Period.*Recovery Stability Period/i);
  assert.match(topic.steps.join(' '), /30 UTC calendar days/i);
  assert.match(topic.steps.join(' '), /Green means the last reliable status.*online, with no offline interval observed/i);
  assert.match(topic.steps.join(' '), /Yellow means the day ended online after an offline interval/i);
  assert.match(topic.steps.join(' '), /Red means the last reliable status.*offline/i);
  assert.match(topic.steps.join(' '), /Gray means no reliable online\/offline state was observed/i);
  assert.match(topic.steps.join(' '), /do not imply full-day coverage/i);
  assert.match(topic.steps.join(' '), /tooltip shows the date, Ended state.*durations in HH:MM/i);
  assert.match(topic.steps.join(' '), /does not show coverage or an uptime percentage/i);
  assert.match(topic.overview, /Allow other identities to read this status topic/i);
  assert.match(topic.overview, /active, enabled, and trusted/i);
  assert.match(topic.overview, /matching Subscribe Rule.*do not add a matching Publish Rule/i);
  assert.match(topic.overview, /broker deny ACL prevents other identities from publishing/i);
  assert.match(topic.steps.join(' '), /apply the pending broker changes/i);
  assert.match(topic.artifacts.join(' '), /exact UTF-8 values online and offline/i);
  assert.match(topic.artifacts.join(' '), /cannot verify the retain flag for live messages/i);
  assert.match(topic.caution, /complete firmware health/i);
  assert.match(topic.caution, /simultaneous sessions/i);
  assert.match(topic.mermaid, /retained replay or broker\/monitor unavailable/i);
  assert.match(topic.mermaid, /live retain flags cannot be verified/i);
  assert.match(topic.mermaid, /SUBSCRIBE # at QoS 1 after connect or reconnect/i);
  assert.match(topic.mermaid, /SUBACK grants QoS 1/i);
  assert.match(topic.mermaid, /Keep device status Unknown/i);
  assert.deepEqual(topic.relatedTopicIds, ['device-topic-rules', 'register-device', 'mqtt-manager']);
});

test('System Updates help describes signed installation, safe rollback, and recovery limits', () => {
  const topic = helpTopicById['system-updates'];
  assert.ok(topic);
  assert.match(topic.overview, /signed release manifests/i);
  assert.match(topic.overview, /independently from the Admin container/i);
  assert.doesNotMatch(topic.overview, /does not install releases/i);
  assert.match(topic.prerequisites.join(' '), /GATEWAY_UPDATE_PUBLIC_KEY_B64/);
  assert.match(topic.steps.join(' '), /type the exact INSTALL version confirmation/i);
  assert.match(topic.steps.join(' '), /1, 6, 12, or 24 hour interval/i);
  assert.match(topic.steps.join(' '), /retain 2–100 recovery snapshots/i);
  assert.match(topic.steps.join(' '), /updater-status/);
  assert.match(topic.hostCommands.map((item) => item.code).join(' '), /updater-enable/);
  assert.match(topic.hostCommands.map((item) => item.code).join(' '), /release-rollback/);
  assert.match(topic.artifacts.join(' '), /SQLite Backup API/i);
  assert.match(topic.artifacts.join(' '), /CA private key/i);
  assert.match(topic.artifacts.join(' '), /Local snapshots.*remain unencrypted/i);
  assert.match(topic.artifacts.join(' '), /pruning runs after host updater operations/i);
  assert.match(topic.hostCommands.map((item) => item.code).join(' '), /export-snapshot.*--recipient/);
  assert.match(topic.artifacts.join(' '), /mode-0600 file without overwriting/i);
  assert.match(topic.hostCommands.map((item) => item.code).join(' '), /RECOVER <operation-id>/);
  assert.match(topic.workflowMermaid, /flowchart LR/);
  assert.match(topic.workflowMermaid, /Health checks pass\?/);
  assert.match(topic.workflowMermaid, /Create fresh safety snapshot/);
  assert.match(topic.lifecycle, /pre-commit failure attempts an automatic rollback/i);
  assert.match(topic.lifecycle, /persistent-state fingerprint still matches/i);
  assert.match(topic.lifecycle, /RECOVERY_REQUIRED/i);
  assert.match(topic.lifecycle, /separate operator action/i);
  assert.match(topic.lifecycle, /automatic installation is not provided/i);
  assert.equal(topic.relatedTopicIds.length, 0);
});

test('every article has a textual sequence and resolvable related links', () => {
  for (const topic of helpTopics) {
    assert.ok(topic.sequence.length, `${topic.id} has no readable sequence fallback`);
    assert.ok(topic.workflowMermaid.trim(), `${topic.id} has no workflow diagram`);
    assert.ok(topic.mermaid.trim(), `${topic.id} has no Mermaid source`);
    for (const relatedId of topic.relatedTopicIds) assert.ok(helpTopicById[relatedId], `${topic.id} links to missing ${relatedId}`);
  }
});

test('certificate articles explain key ownership and preserve the trust and authorization distinction', () => {
  const generated = helpTopicById['generate-complete-certificate'];
  const csr = helpTopicById['sign-existing-csr'];
  const external = helpTopicById['generate-csr-external-signing'];
  const imported = helpTopicById['import-certificate'];
  assert.match(generated.artifacts.join(' '), /retains the public certificate and metadata, not device\.key/i);
  assert.match(csr.artifacts.join(' '), /stays on the device\/host/i);
  assert.match(external.artifacts.join(' '), /temporary memory-only state/i);
  assert.match(imported.overview, /discarded/i);
  assert.match(imported.overview, /not.*stored/i);
  assert.match(imported.steps.join(' '), /explicitly approve its CA/i);
  assert.match(imported.steps.join(' '), /authorize the identity/i);
});
