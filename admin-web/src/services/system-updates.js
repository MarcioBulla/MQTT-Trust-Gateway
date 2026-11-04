import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { updaterStatus } from './updater-client.js';

const repository = 'MarcioBulla/MQTT-Trust-Gateway';
const cacheTtlMs = 10 * 60_000;
const maxChangelogLength = 8_000;
const packageFile = fileURLToPath(new URL('../../package.json', import.meta.url));
let cache = { checkedAt: '', releases: [], etag: '', expiresAt: 0 };
let fetchImpl = globalThis.fetch;
const inFlight = new Map();
const manifestCache = new Map();

export function parseSemVer(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some((part) => !part || (/^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease };
}

export function compareSemVer(left, right) {
  const a = parseSemVer(left), b = parseSemVer(right);
  if (!a || !b) throw new Error('Invalid semantic version');
  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length ? -1 : 1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const av = a.prerelease[i], bv = b.prerelease[i];
    if (av === undefined || bv === undefined) return av === undefined ? -1 : 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av), bn = /^\d+$/.test(bv);
    if (an && bn) return BigInt(av) < BigInt(bv) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function releaseView(release) {
  const version = parseSemVer(release.tag_name);
  if (!version) return null;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const manifestAsset = assets.find((asset) => asset.name === 'update-manifest.json');
  const signatureAsset = assets.find((asset) => asset.name === 'update-manifest.sig');
  const signedManifestPublished = Boolean(manifestAsset && signatureAsset);
  return {
    version: release.tag_name.replace(/^v/, ''),
    name: String(release.name || release.tag_name).slice(0, 200),
    channel: version.prerelease.length ? 'beta' : 'stable',
    publishedAt: release.published_at || null,
    url: typeof release.html_url === 'string' && release.html_url.startsWith('https://github.com/') ? release.html_url : null,
    changelog: String(release.body || '').slice(0, maxChangelogLength),
    signedManifestPublished,
    manifestAsset: manifestAsset?.url || null,
    signatureAsset: signatureAsset?.url || null,
    manifestVerified: false,
    installable: false,
    installability: signedManifestPublished ? 'Manifest verification is unavailable.' : 'Signed release manifest is missing.',
  };
}

function pinnedUpdateKey() {
  const encoded = process.env.GATEWAY_UPDATE_PUBLIC_KEY_B64 || '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch { return null; }
}

export function verifyReleaseManifest({ manifestBytes, signatureBytes, expectedVersion, publicKey }) {
  if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length > 256_000) throw new Error('Release manifest size is invalid.');
  const signature = Buffer.from(String(signatureBytes).trim(), 'base64');
  if (signature.length !== 64) throw new Error('Release signature format is invalid.');
  const key = publicKey || pinnedUpdateKey();
  if (!key || key.asymmetricKeyType !== 'ed25519') throw new Error('Pinned Ed25519 release key is not configured.');
  if (!crypto.verify(null, manifestBytes, key, signature)) throw new Error('Release manifest signature is invalid.');
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
  catch { throw new Error('Release manifest is not valid JSON.'); }
  const tagVersion = parseSemVer(expectedVersion);
  if (!manifest || !tagVersion || manifest.version !== expectedVersion || !validateUpdateChannel(manifest.channel)) throw new Error('Manifest identity does not match the published release.');
  const expectedChannel = tagVersion.prerelease.length ? 'beta' : 'stable';
  if (manifest.channel !== expectedChannel) throw new Error('Manifest channel does not match the release tag.');
  if (!Number.isSafeInteger(manifest.schema_version) || manifest.schema_version < 1) throw new Error('Manifest schema version is invalid.');
  for (const name of ['admin', 'broker']) {
    const reference = manifest.images?.[name]?.reference;
    const expectedRepository = name === 'admin' ? 'ghcr.io/marciobulla/mqtt-trust-admin' : 'ghcr.io/marciobulla/mqtt-trust-broker';
    if (typeof reference !== 'string' || !new RegExp(`^${expectedRepository.replaceAll('.', '\\.')}@sha256:[a-f0-9]{64}$`, 'i').test(reference)) throw new Error(`Manifest ${name} image is not the official digest-pinned image.`);
  }
  const minVersion = manifest.compatibility?.min_gateway_version;
  if (!parseSemVer(minVersion)) throw new Error('Manifest gateway compatibility version is invalid.');
  const minPodman = manifest.compatibility?.min_podman_version;
  if (minPodman !== undefined && !parseSemVer(minPodman)) throw new Error('Manifest Podman compatibility version is invalid.');
  if (manifest.migrations && (!Number.isSafeInteger(manifest.migrations.from) || !Number.isSafeInteger(manifest.migrations.to) || manifest.migrations.from < 0 || manifest.migrations.to < manifest.migrations.from || manifest.migrations.to !== manifest.schema_version || (manifest.migrations.from !== manifest.migrations.to && manifest.migrations.requires_snapshot !== true))) throw new Error('Manifest migration range is invalid.');
  const health = manifest.health_checks;
  if (!health || health.admin !== true || health.database !== true || health.broker_tls !== true || health.mqtt_mtls !== true) throw new Error('Manifest does not require all Gateway functional health checks.');
  return manifest;
}

export function evaluateReleaseCompatibility(manifest, installed) {
  const reasons = [];
  if (compareSemVer(installed.version, manifest.compatibility.min_gateway_version) < 0)
    reasons.push(`Requires Gateway ${manifest.compatibility.min_gateway_version} or newer.`);
  const minPodman = manifest.compatibility.min_podman_version;
  if (minPodman && (!parseSemVer(installed.podmanVersion) || compareSemVer(installed.podmanVersion, minPodman) < 0))
    reasons.push('Host Podman version is not verified as compatible.');
  const schema = Number(installed.schemaVersion);
  if (!Number.isSafeInteger(schema) || schema < 1) reasons.push('Installed database schema version is unknown.');
  else if (manifest.schema_version < schema) reasons.push('Release database schema is older than the installed schema.');
  else if (manifest.schema_version !== schema) {
    if (!manifest.migrations || manifest.migrations.from !== schema || manifest.migrations.to !== manifest.schema_version)
      reasons.push('Release does not provide a migration from the installed schema.');
    else if (manifest.migrations.requires_snapshot !== true) reasons.push('Migration requires a verified snapshot.');
  }
  return { compatible: reasons.length === 0, reasons };
}

async function downloadReleaseAsset(assetUrl) {
  if (typeof assetUrl !== 'string') throw new Error('Release manifest asset is unavailable.');
  const url = new URL(assetUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'api.github.com') throw new Error('Release asset URL is invalid.');
  const response = await fetchImpl(assetUrl, { headers: { accept: 'application/octet-stream', 'user-agent': 'MQTT-Trust-Gateway-Updater' }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Release asset download failed (${response.status}).`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > 256_000) throw new Error('Release asset size is invalid.');
  return data;
}

function applyVerifiedManifest(release, manifest, installed) {
    release.manifestVerified = true;
    release.manifest = {
      version: manifest.version,
      channel: manifest.channel,
      schemaVersion: manifest.schema_version,
      images: manifest.images,
      compatibility: manifest.compatibility,
      migrations: manifest.migrations || null,
    };
    const compatibility = evaluateReleaseCompatibility(manifest, installed);
    release.compatibility = compatibility;
    const controllerReady = installed.updaterAvailable && !installed.updaterBusy && !installed.updaterMaintenance;
    release.installable = compatibility.compatible && Boolean(controllerReady);
    release.installability = [...compatibility.reasons, ...(!installed.updaterAvailable ? ['Independent updater controller is not enabled.'] : installed.updaterBusy || installed.updaterMaintenance ? ['An update or recovery operation is in progress.'] : [])].join(' ');
    return release;
}

async function verifyCandidate(release, installed, allowNetwork = true) {
  if (!release || !release.signedManifestPublished) return release;
  const cached = manifestCache.get(release.version);
  if (cached?.expiresAt > Date.now() && cached.installedKey === JSON.stringify(installed)) return { ...release, ...cached.value };
  if (!allowNetwork && cached?.verifiedManifest) return applyVerifiedManifest(release, cached.verifiedManifest, installed);
  if (!allowNetwork) return { ...release, installable: false, installability: 'Check for updates to refresh release verification.' };
  let verifiedManifest;
  try {
    const [manifestBytes, signatureBytes] = await Promise.all([
      downloadReleaseAsset(release.manifestAsset),
      downloadReleaseAsset(release.signatureAsset),
    ]);
    const manifest = verifyReleaseManifest({ manifestBytes, signatureBytes, expectedVersion: release.version });
    applyVerifiedManifest(release, manifest, installed);
    verifiedManifest = manifest;
  } catch (error) {
    release.installability = error.message || 'Manifest verification failed.';
  }
  const { manifestAsset, signatureAsset, ...value } = release;
  manifestCache.set(release.version, { value, verifiedManifest, installedKey: JSON.stringify(installed), expiresAt: Date.now() + cacheTtlMs });
  return release;
}

export function selectLatestRelease(releases, installedVersion, channel = 'stable') {
  if (!['stable', 'beta'].includes(channel)) throw new Error('Invalid update channel');
  const installed = parseSemVer(installedVersion);
  if (!installed) throw new Error('Installed version is not valid SemVer');
  const candidates = releases
    .map(releaseView)
    .filter((release) => release && (channel === 'beta' || release.channel === 'stable'))
    .filter((release) => compareSemVer(release.version, installedVersion) > 0)
    .sort((a, b) => compareSemVer(b.version, a.version));
  return candidates[0] || null;
}

export async function installedGatewayVersion() {
  const pkg = JSON.parse(await fs.readFile(packageFile, 'utf8'));
  const controller = await updaterStatus();
  const active = controller.operation && !['COMPLETED', 'ROLLED_BACK', 'FAILED'].includes(controller.operation.state);
  return {
    updaterAvailable: controller.available, updaterBusy: Boolean(active), updaterMaintenance: controller.maintenance, podmanVersion: controller.podmanVersion || null,
    version: pkg.version,
    commit: process.env.GATEWAY_COMMIT || 'unknown',
    channel: process.env.GATEWAY_CHANNEL === 'beta' ? 'beta' : 'stable',
    schemaVersion: Number.isSafeInteger(Number(process.env.GATEWAY_SCHEMA_VERSION)) ? Number(process.env.GATEWAY_SCHEMA_VERSION) : 'unknown',
  };
}

export function validateUpdateChannel(value) {
  return value === 'stable' || value === 'beta';
}

export async function checkForGatewayUpdates({ channel = 'stable', force = false, cachedOnly = false } = {}) {
  if (!['stable', 'beta'].includes(channel)) throw new Error('Invalid update channel');
  const installed = await installedGatewayVersion();
  if (cachedOnly || (!force && cache.expiresAt > Date.now())) {
    return { installed, channel, latest: await verifyCandidate(selectLatestRelease(cache.releases, installed.version, channel), installed, !cachedOnly), checkedAt: cache.checkedAt, cached: true, error: '' };
  }
  if (inFlight.has(channel)) return inFlight.get(channel);
  const request = (async () => {
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'MQTT-Trust-Gateway-Updater' };
    if (cache.etag) headers['if-none-match'] = cache.etag;
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases?per_page=100`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      });
      if (response.status === 304 && cache.checkedAt) {
        cache.expiresAt = Date.now() + cacheTtlMs;
      } else {
        if (!response.ok) throw new Error(response.status === 403 ? 'Release lookup is rate limited.' : `Release lookup failed (${response.status}).`);
        const payload = await response.json();
        if (!Array.isArray(payload)) throw new Error('Release service returned an invalid response.');
        cache = {
          releases: payload.filter((release) => release && typeof release === 'object' && !release.draft).map((release) => ({ ...release, assets: Array.isArray(release.assets) ? release.assets : [] })),
          checkedAt: new Date().toISOString(),
          etag: response.headers.get('etag') || '',
          expiresAt: Date.now() + cacheTtlMs,
        };
      }
      return { installed, channel, latest: await verifyCandidate(selectLatestRelease(cache.releases, installed.version, channel), installed), checkedAt: cache.checkedAt, cached: false, error: '' };
    } catch (error) {
      cache.expiresAt = 0;
      return { installed, channel, latest: await verifyCandidate(selectLatestRelease(cache.releases, installed.version, channel), installed), checkedAt: cache.checkedAt, cached: Boolean(cache.checkedAt), error: error.name === 'TimeoutError' ? 'Release lookup timed out.' : error.message || 'Release lookup failed.' };
    } finally {
      inFlight.delete(channel);
    }
  })();
  inFlight.set(channel, request);
  return request;
}

export function configureUpdateFetchForTests(fetcher) {
  fetchImpl = fetcher || globalThis.fetch;
  cache = { checkedAt: '', releases: [], etag: '', expiresAt: 0 };
  manifestCache.clear();
}
