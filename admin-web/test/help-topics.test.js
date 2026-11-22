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

test('device renewal Help concisely documents controls, approval modes, and timing', () => {
  const topic = helpTopicById['device-renewal-planning'];
  assert.ok(topic);
  assert.match(topic.shortSummary, /Request a renewal CSR/i);
  assert.match(topic.overview, /Request CSR always starts a manual-review request, even when automatic acceptance is saved/i);
  assert.match(topic.overview, /Force automatic renewal starts an automatic request/i);
  assert.match(topic.overview, /Save MQTT topics changes only the topic settings/i);
  assert.match(topic.overview, /keeps its private key local/i);
  assert.match(topic.steps.join(' '), /positive lead time shorter than the new certificate validity/i);
  assert.match(topic.steps.join(' '), /scheduler checks every minute/i);
  assert.match(topic.steps.join(' '), /initial exchange must finish within 10 minutes.*confirmation after testing must finish within 2 minutes/i);
  assert.match(topic.workflowMermaid, /Request CSR is always visible and forces manual review/);
  assert.match(topic.workflowMermaid, /Save MQTT topics only, no CSR and no policy change/);
  assert.match(topic.mermaid, /legacy clients may send the CSR in pem instead of csr/i);
  assert.match(topic.mermaid, /private key local/i);
  assert.match(topic.mermaid, /Approve CSR and issue certificate in manual mode/);
  assert.match(topic.prerequisites.join(' '), /Custom Rules/i);
  assert.deepEqual(topic.relatedTopicIds, ['certificate-renewal', 'sign-existing-csr']);
});

test('certificate renewal Help documents the per-device Copy certificate PEM dialog', () => {
  const topic = helpTopicById['certificate-renewal'];
  assert.ok(topic);
  assert.match(topic.shortSummary, /Copy certificate/i);
  assert.match(topic.overview, /Devices & certificates → edit the device → Licenses/i);
  assert.match(topic.overview, /Copy certificate next to Download certificate/i);
  assert.match(topic.overview, /same Devices and certificates reveal grant/i);
  assert.match(topic.overview, /read-only Certificate \(PEM\) dialog/i);
  assert.match(topic.overview, /Click Copy in the dialog/i);
  assert.match(topic.artifacts.join(' '), /copies only this certificate text.*does not reveal or export the private key/i);
});

test('Settings Help explains log timestamp formatting and copied visible text', () => {
  const topic = helpTopicById['sensitive-information-visibility'];
  assert.ok(topic);
  assert.match(topic.overview, /Settings → Logs.*timestamps are displayed in the account’s configured Display time zone/i);
  assert.match(topic.overview, /Copy visible logs copies the displayed text, including those formatted timestamps/i);
  assert.match(topic.steps.join(' '), /Settings → Logs.*Copy visible logs copies the displayed log text/i);
  assert.match(topic.steps.join(' '), /timestamps in the display and copied text use the account’s Display time zone from Settings → General/i);
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

test('Help does not describe Gateway-managed device firmware or OTA', () => {
  const plannedFirmwareTopics = helpTopics.filter((topic) => /firmware|\bota\b|mcuboot/i.test(`${topic.id} ${topic.title}`));
  assert.deepEqual(plannedFirmwareTopics, []);

  const helpText = helpTopics.map((topic) => [
    topic.shortSummary, topic.caution, topic.overview, topic.when,
    ...(topic.prerequisites ?? []), ...(topic.steps ?? []), ...(topic.artifacts ?? []),
    ...(topic.zephyr ? [topic.zephyr] : []), ...(topic.sequence ?? []),
    topic.workflowMermaid, topic.mermaid,
  ].filter(Boolean).join(' ')).join('\n');
  assert.doesNotMatch(helpText, /Gateway.{0,60}(?:upload|manage|deliver|distribute|install|update).{0,60}(?:firmware|OTA)/i);
  assert.doesNotMatch(helpText, /(?:firmware|OTA).{0,60}(?:uploaded|managed|delivered|distributed|installed|updated).{0,60}by the Gateway/i);

  const health = helpTopicById['device-health-check'];
  assert.match(health.overview, /firmware must publish/i);
  for (const id of ['generate-complete-certificate', 'sign-existing-csr', 'generate-csr-external-signing', 'import-certificate']) {
    assert.ok(helpTopicById[id]?.zephyr, `${id} should retain its Zephyr certificate guidance`);
  }
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

test('certificate revocation Help matches per-certificate CRL enforcement and fail-closed blocking', () => {
  const ids = ['generate-complete-certificate', 'sign-existing-csr', 'generate-csr-external-signing', 'import-certificate'];
  for (const id of ids) {
    const topic = helpTopicById[id];
    assert.match(topic.lifecycle, /successful CRL update preserves the identity authorization when another active, trusted, unexpired certificate remains/i, id);
    assert.match(topic.lifecycle, /otherwise the Gateway disables the identity/i, id);
    assert.match(topic.lifecycle, /CRL update fails.*external issuer.*fails closed and disables the identity/i, id);
    assert.match(topic.lifecycle, /CA-level and device-wide actions are unchanged/i, id);
    assert.doesNotMatch(topic.lifecycle, /revok(?:ing|e) (?:one|any one|a) certificate (?:also )?disables the (?:whole|entire|associated) identity/i, id);
  }
  const renewal = helpTopicById['certificate-renewal'];
  assert.match(renewal.steps.join(' '), /successful CRL update preserves authorization when another active, trusted, unexpired certificate remains/i);
  assert.match(renewal.steps.join(' '), /if CRL enforcement fails or the issuer is external, the Gateway disables the identity/i);
});
