import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  checkForGatewayUpdates,
  compareSemVer,
  configureUpdateFetchForTests,
  evaluateReleaseCompatibility,
  parseSemVer,
  selectLatestRelease,
  validateUpdateChannel,
  verifyReleaseManifest,
} from '../src/services/system-updates.js';

test('SemVer comparison handles prerelease ordering and rejects malformed values', () => {
  assert.equal(compareSemVer('1.1.0-beta.2', '1.1.0-beta.10'), -1);
  assert.equal(compareSemVer('1.1.0-rc.1', '1.1.0'), -1);
  assert.equal(compareSemVer('v1.1.0+build.7', '1.1.0'), 0);
  assert.equal(parseSemVer('01.1.0'), null);
  assert.equal(parseSemVer('1.1.0-beta.01'), null);
});

test('update channel accepts only stable or beta', () => {
  assert.equal(validateUpdateChannel('stable'), true);
  assert.equal(validateUpdateChannel('beta'), true);
  for (const value of ['', 'latest', 'Stable', '../stable', null]) assert.equal(validateUpdateChannel(value), false);
});

test('release compatibility checks the running Gateway, schema migrations and host Podman', () => {
  const compatible = {
    schema_version: 1,
    compatibility: { min_gateway_version: '1.0.2' },
  };
  assert.deepEqual(evaluateReleaseCompatibility(compatible, { version: '1.0.2', schemaVersion: 1 }), { compatible: true, reasons: [] });
  assert.equal(evaluateReleaseCompatibility(compatible, { version: '1.0.1', schemaVersion: 1 }).compatible, false);
  const migrating = { ...compatible, schema_version: 2, migrations: { from: 1, to: 2, requires_snapshot: true } };
  assert.equal(evaluateReleaseCompatibility(migrating, { version: '1.0.2', schemaVersion: 1 }).compatible, true);
  assert.match(evaluateReleaseCompatibility({ ...migrating, migrations: { from: 1, to: 2 } }, { version: '1.0.2', schemaVersion: 1 }).reasons[0], /verified snapshot/);
  const hostConstrained = { ...compatible, compatibility: { ...compatible.compatibility, min_podman_version: '5.0.0' } };
  assert.match(evaluateReleaseCompatibility(hostConstrained, { version: '1.0.2', schemaVersion: 1 }).reasons[0], /Podman version/);
});

test('manifest signature binds version, approved image repositories, schema and compatibility', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const manifest = Buffer.from(JSON.stringify({
    version: '1.1.0', channel: 'stable', schema_version: 1,
    images: {
      admin: { reference: `ghcr.io/marciobulla/mqtt-trust-admin@sha256:${'a'.repeat(64)}` },
      broker: { reference: `ghcr.io/marciobulla/mqtt-trust-broker@sha256:${'b'.repeat(64)}` },
    },
    compatibility: { min_gateway_version: '1.0.2' }, migrations: { from: 0, to: 1, requires_snapshot: true },
    health_checks: { admin: true, database: true, broker_tls: true, mqtt_mtls: true },
  }));
  const signatureBytes = crypto.sign(null, manifest, privateKey).toString('base64');
  const verified = verifyReleaseManifest({ manifestBytes: manifest, signatureBytes, expectedVersion: '1.1.0', publicKey });
  assert.equal(verified.version, '1.1.0');
  assert.throws(() => verifyReleaseManifest({ manifestBytes: manifest, signatureBytes, expectedVersion: '1.1.1', publicKey }), /identity/);
  assert.throws(() => verifyReleaseManifest({ manifestBytes: manifest, signatureBytes: Buffer.alloc(64).toString('base64'), expectedVersion: '1.1.0', publicKey }), /signature/);
  const badManifest = Buffer.from(JSON.stringify({ ...JSON.parse(manifest), images: { ...JSON.parse(manifest).images, admin: { reference: `ghcr.io/attacker/mqtt-admin@sha256:${'a'.repeat(64)}` } } }));
  const badSignature = crypto.sign(null, badManifest, privateKey).toString('base64');
  assert.throws(() => verifyReleaseManifest({ manifestBytes: badManifest, signatureBytes: badSignature, expectedVersion: '1.1.0', publicKey }), /official digest-pinned/);
});

test('stable excludes prereleases while beta selects the newest compatible semantic candidate', () => {
  const releases = [
    { tag_name: 'v1.1.0', assets: [] },
    { tag_name: 'v1.2.0-beta.2', prerelease: true, assets: [] },
    { tag_name: 'nightly', assets: [] },
  ];
  assert.equal(selectLatestRelease(releases, '1.0.2', 'stable').version, '1.1.0');
  assert.equal(selectLatestRelease(releases, '1.0.2', 'beta').version, '1.2.0-beta.2');
  assert.equal(selectLatestRelease(releases, '1.2.0-beta.2', 'beta'), null);
});

test('release discovery is explicitly requested, cached and non-installable without signed manifest assets', async () => {
  let calls = 0;
  configureUpdateFetchForTests(async () => {
    calls++;
    return new Response(JSON.stringify([{ tag_name: 'v9.0.0', name: 'Gateway 9.0.0', assets: [], body: 'Changes' }]), {
      status: 200,
      headers: { etag: '"fixture"' },
    });
  });
  const first = await checkForGatewayUpdates({ channel: 'stable', force: true });
  const second = await checkForGatewayUpdates({ channel: 'stable' });
  assert.equal(calls, 1);
  assert.equal(first.latest.version, '9.0.0');
  assert.equal(first.latest.installable, false);
  assert.match(first.latest.installability, /manifest is missing/i);
  assert.equal(second.cached, true);
  configureUpdateFetchForTests();
});

test('release lookup failure returns cached results or a non-blocking error result', async () => {
  configureUpdateFetchForTests(async () => { throw new Error('offline fixture'); });
  const result = await checkForGatewayUpdates({ channel: 'stable', force: true });
  assert.equal(result.latest, null);
  assert.equal(result.error, 'offline fixture');
  assert.equal(result.cached, false);
  configureUpdateFetchForTests();
});

test('cached-only discovery reuses a verified immutable manifest without network requests', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const oldKey=process.env.GATEWAY_UPDATE_PUBLIC_KEY_B64;
  process.env.GATEWAY_UPDATE_PUBLIC_KEY_B64=publicKey.export({format:'der',type:'spki'}).toString('base64');
  const manifest=Buffer.from(JSON.stringify({version:'9.0.0',channel:'stable',schema_version:1,
    images:Object.fromEntries(['admin','broker'].map(name=>[name,{reference:`ghcr.io/marciobulla/mqtt-trust-${name}@sha256:${'a'.repeat(64)}`} ])),
    compatibility:{min_gateway_version:'1.0.2'},health_checks:{admin:true,database:true,broker_tls:true,mqtt_mtls:true}}));
  let calls=0;
  configureUpdateFetchForTests(async url=>{
    calls++;
    if(url.includes('/releases?')) return new Response(JSON.stringify([{tag_name:'v9.0.0',assets:[{name:'update-manifest.json',url:'https://api.github.com/manifest'},{name:'update-manifest.sig',url:'https://api.github.com/signature'}]}]));
    return new Response(url.endsWith('/manifest')?manifest:crypto.sign(null,manifest,privateKey).toString('base64'));
  });
  try {
    const initial=await checkForGatewayUpdates({force:true});
    assert.equal(initial.latest.manifestVerified,true);
    const before=calls;
    const cached=await checkForGatewayUpdates({cachedOnly:true});
    assert.equal(cached.latest.manifestVerified,true);
    assert.equal(calls,before);
  } finally {
    if(oldKey===undefined) delete process.env.GATEWAY_UPDATE_PUBLIC_KEY_B64;else process.env.GATEWAY_UPDATE_PUBLIC_KEY_B64=oldKey;
    configureUpdateFetchForTests();
  }
});
