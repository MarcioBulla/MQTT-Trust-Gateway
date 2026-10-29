import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '../config.js';
import { loadDb, saveDb, sqlite } from '../db.js';
const run = promisify(execFile);
const ca = (name) => path.join(env.caDir, name);
const broker = (name) => path.join(env.brokerDir, name);
const pendingPrivateKeys = new Map();
const deliveredPrivateKeys = new Set();
const pendingKeyCleanup = setInterval(() => {
  for (const [id, pending] of pendingPrivateKeys) {
    if (pending.expires <= Date.now()) pendingPrivateKeys.delete(id);
  }
}, 60_000);
pendingKeyCleanup.unref();
const pemCertificates = (value) =>
  String(value || '').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
export const openssl = (args) => run('openssl', args, { timeout: 30000, maxBuffer: 1024 * 1024 });
export async function atomic(file, data, mode = 0o600) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, data, { mode });
  await fs.rename(tmp, file);
}
const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );
export function certificateMetadata(pem) {
  const c = new crypto.X509Certificate(pem);
  const pub = c.publicKey.asymmetricKeyDetails;
  return {
    serial: c.serialNumber,
    subject: c.subject,
    issuerName: c.issuer,
    fingerprint: crypto.createHash('sha256').update(c.raw).digest('hex'),
    algorithm:
      c.publicKey.asymmetricKeyType === 'ec'
        ? `ECDSA-${pub.namedCurve}`
        : `${c.publicKey.asymmetricKeyType.toUpperCase()}-${pub.modulusLength || ''}`,
    san: c.subjectAltName || '',
    validFrom: new Date(c.validFrom).toISOString(),
    validTo: new Date(c.validTo).toISOString(),
  };
}
async function config() {
  // Paths are generated internally. Never interpolate request data here.
  if (/[\n\r]/.test(env.caDir)) throw new Error('Invalid CA directory');
  await fs.writeFile(
    ca('openssl.cnf'),
    `[ca]\ndefault_ca=local\n[local]\ndir=${env.caDir}\ndatabase=$dir/index.txt\nnew_certs_dir=$dir/issued\ncertificate=$dir/ca.crt\nprivate_key=$dir/ca.key\nserial=$dir/serial\ncrlnumber=$dir/crlnumber\ndefault_md=sha256\ndefault_days=${env.certDays}\ndefault_crl_days=7\npolicy=identity\nunique_subject=no\ncopy_extensions=none\n[identity]\ncommonName=supplied\n[client]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n`,
    { mode: 0o600 },
  );
}
async function generateCRL() {
  await openssl(['ca', '-config', ca('openssl.cnf'), '-gencrl', '-out', ca('ca.crl')]);
  await atomic(broker('ca.crl'), await fs.readFile(ca('ca.crl')), 0o644);
}
export async function initializeCa() {
  await fs.mkdir(env.caDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(env.brokerDir, { recursive: true, mode: 0o700 });
  const hasCert = await exists(ca('ca.crt')),
    hasKey = await exists(ca('ca.key'));
  if (hasCert !== hasKey)
    throw new Error(
      'Incomplete CA: restore matching ca.crt and ca.key; automatic replacement is forbidden',
    );
  if (!hasCert) {
    if (loadDb().certificates.length || loadDb().devices.length)
      throw new Error(
        'Existing devices detected without a CA. Restore/import the original CA before initialization.',
      );
    await openssl([
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      ca('ca.key'),
      '-out',
      ca('ca.crt'),
      '-days',
      String(env.caDays),
      '-subj',
      `/CN=${env.caName}`,
      '-addext',
      'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ]);
    await fs.chmod(ca('ca.key'), 0o600);
  }
  const cert = new crypto.X509Certificate(await fs.readFile(ca('ca.crt')));
  const key = crypto.createPrivateKey(await fs.readFile(ca('ca.key')));
  if (!cert.ca || !cert.checkPrivateKey(key)) throw new Error('CA certificate/key mismatch');
  await fs.chmod(ca('ca.key'), 0o600);
  await fs.mkdir(ca('issued'), { recursive: true, mode: 0o700 });
  if (!(await exists(ca('index.txt')))) {
    // Never silently reconstruct an imported CA index; revoked records must be restored.
    if (loadDb().certificates.length)
      throw new Error('Restore the CA OpenSSL index or run the documented legacy import first');
    await fs.writeFile(ca('index.txt'), '', { mode: 0o600 });
  }
  if (!(await exists(ca('serial'))))
    await fs.writeFile(ca('serial'), `${crypto.randomBytes(16).toString('hex')}\n`, {
      mode: 0o600,
    });
  if (!(await exists(ca('crlnumber'))))
    await fs.writeFile(ca('crlnumber'), '1000\n', { mode: 0o600 });
  await config();
  const trusted = loadDb().trustedCas || [];
  const trustBundle = [
    await fs.readFile(ca('ca.crt'), 'utf8'),
    ...trusted.filter((item) => item.enabled !== false).map((item) => item.certificate),
  ].join('\n');
  await atomic(broker('ca.crt'), trustBundle, 0o644);
  await generateCRL();
}
async function work(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-pki-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
export async function signDeviceCsr({ deviceId, csr, days = env.certDays }) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(deviceId) || deviceId === env.adminMqttClientId)
    throw new Error('Invalid or reserved device identifier');
  days = Number(days);
  if (!Number.isInteger(days) || days < 1 || days > env.maxCertDays)
    throw new Error(`Validity must be 1–${env.maxCertDays} days`);
  const signer = new crypto.X509Certificate(await fs.readFile(ca('ca.crt')));
  if (Date.now() + days * 86400000 >= Date.parse(signer.validTo))
    throw new Error('Requested validity exceeds CA validity');
  return work(async (dir) => {
    const input = path.join(dir, 'request.csr'),
      output = path.join(dir, 'certificate.crt');
    await fs.writeFile(input, csr, { mode: 0o600 });
    await openssl(['req', '-in', input, '-verify', '-noout']);
    const { stdout } = await openssl(['req', '-in', input, '-pubkey', '-noout']);
    const publicKey = crypto.createPublicKey(stdout);
    const bits = publicKey.asymmetricKeyDetails;
    if (
      !(publicKey.asymmetricKeyType === 'rsa' && bits.modulusLength >= 2048) &&
      !(
        publicKey.asymmetricKeyType === 'ec' &&
        ['prime256v1', 'secp384r1', 'secp521r1'].includes(bits.namedCurve)
      )
    )
      throw new Error('CSR requires RSA >=2048 or an approved EC curve');
    await openssl([
      'ca',
      '-batch',
      '-notext',
      '-config',
      ca('openssl.cnf'),
      '-extensions',
      'client',
      '-days',
      String(days),
      '-subj',
      `/CN=${deviceId}`,
      '-in',
      input,
      '-out',
      output,
    ]);
    return fs.readFile(output, 'utf8');
  });
}

function generateKeyPair(algorithm) {
  if (algorithm === 'ecdsa-p256')
    return crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
  if (algorithm === 'rsa-2048')
    return crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicExponent: 0x10001,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
  throw new Error('Select ECDSA P-256 or RSA-2048');
}

async function createCsr(deviceId, privateKey) {
  return work(async (dir) => {
    const key = path.join(dir, 'ephemeral.key'), csr = path.join(dir, 'request.csr');
    await fs.writeFile(key, privateKey, { mode: 0o600, flag: 'wx' });
    await openssl(['req', '-new', '-sha256', '-key', key, '-subj', `/CN=${deviceId}`, '-out', csr]);
    return fs.readFile(csr, 'utf8');
  });
}

export async function inspectCsr(csr) {
  return work(async (dir) => {
    const file = path.join(dir, 'request.csr');
    await fs.writeFile(file, csr, { mode: 0o600 });
    await openssl(['req', '-in', file, '-verify', '-noout']);
    const { stdout: keyPem } = await openssl(['req', '-in', file, '-pubkey', '-noout']);
    const key = crypto.createPublicKey(keyPem);
    const details = key.asymmetricKeyDetails;
    if (!(key.asymmetricKeyType === 'rsa' && details.modulusLength >= 2048) && !(key.asymmetricKeyType === 'ec' && ['prime256v1', 'secp384r1', 'secp521r1'].includes(details.namedCurve)))
      throw new Error('CSR requires RSA >=2048 or an approved EC curve');
    return {
      subject: (await openssl(['req', '-in', file, '-subject', '-nameopt', 'RFC2253', '-noout'])).stdout.trim(),
      algorithm: key.asymmetricKeyType === 'ec'
        ? `ECDSA-${key.asymmetricKeyDetails.namedCurve}`
        : `${key.asymmetricKeyType.toUpperCase()}-${key.asymmetricKeyDetails.modulusLength || ''}`,
      publicKeyFingerprint: crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex'),
    };
  });
}

export async function generateExternalCsr({ deviceId, algorithm, pendingId }) {
  const pair = generateKeyPair(algorithm), csr = await createCsr(deviceId, pair.privateKey);
  const preview = await inspectCsr(csr);
  pendingPrivateKeys.set(pendingId, { deviceId, privateKey: pair.privateKey, expires: Date.now() + 15 * 60_000 });
  return { csr, publicKey: pair.publicKey, algorithm, preview };
}

export async function takePendingPrivateKey(pendingId, deviceId) {
  const pending = pendingPrivateKeys.get(pendingId);
  if (!pending || pending.deviceId !== deviceId) return null;
  if (pending.expires < Date.now()) { pendingPrivateKeys.delete(pendingId); return null; }
  pendingPrivateKeys.delete(pendingId);
  deliveredPrivateKeys.add(pendingId);
  return pending.privateKey;
}

export function confirmPendingPrivateKey(pendingId) {
  if (!deliveredPrivateKeys.delete(pendingId)) return false;
  return true;
}

export async function issueGeneratedCertificate({ deviceId, algorithm, days }) {
  const pair = generateKeyPair(algorithm);
  const csr = await createCsr(deviceId, pair.privateKey);
  const certificate = await signDeviceCsr({ deviceId, csr, days });
  return { certificate, privateKey: pair.privateKey };
}

export async function importClientCertificate({ certificate: value, chain = '', privateKey = '', expectedPublicKey = '' }) {
  const certPem = pemCertificates(value)[0];
  if (!certPem) throw new Error('A PEM X.509 client certificate is required');
  const cert = new crypto.X509Certificate(certPem);
  if (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) throw new Error('Certificate is not currently valid');
  const suppliedChain = pemCertificates(chain);
  const publicDetails = cert.publicKey.asymmetricKeyDetails;
  if (!(cert.publicKey.asymmetricKeyType === 'rsa' && publicDetails.modulusLength >= 2048) && !(cert.publicKey.asymmetricKeyType === 'ec' && ['prime256v1', 'secp384r1', 'secp521r1'].includes(publicDetails.namedCurve)))
    throw new Error('Certificate requires RSA >=2048 or an approved EC curve');
  const match = cert.publicKey.export({ type: 'spki', format: 'der' });
  if (expectedPublicKey && !match.equals(crypto.createPublicKey(expectedPublicKey).export({ type: 'spki', format: 'der' })))
    throw new Error('Certificate public key does not match the pending CSR');
  if (privateKey) {
    const key = crypto.createPrivateKey(privateKey);
    if (!cert.checkPrivateKey(key)) throw new Error('Certificate and private key do not match');
  }
  return work(async (dir) => {
    const file = path.join(dir, 'client.crt');
    await fs.writeFile(file, certPem, { mode: 0o600 });
    const purpose = await openssl(['x509', '-in', file, '-purpose', '-noout']);
    if (!/SSL client\s*:\s*Yes/i.test(purpose.stdout)) throw new Error('Certificate is not valid for TLS client authentication');
    let trusted = false, issuerFingerprint = '';
    const db = loadDb();
    const anchors = [
      { certificate: await fs.readFile(ca('ca.crt'), 'utf8'), fingerprint: certificateMetadata(await fs.readFile(ca('ca.crt'))).fingerprint, internal: true },
      ...(db.trustedCas || []).filter((item) => item.enabled !== false).map((item) => ({ ...item, internal: false })),
    ];
    const roots = suppliedChain.map((certificate) => new crypto.X509Certificate(certificate)).filter((item) => item.ca && item.verify(item.publicKey));
    const candidates = [...anchors, ...roots.map((root) => ({ certificate: root.toString(), fingerprint: certificateMetadata(root.toString()).fingerprint, internal: false }))];
    const untrusted = path.join(dir, 'untrusted.pem');
    const intermediateCertificates = suppliedChain.filter((pem) => !roots.some((root) => root.fingerprint256 === new crypto.X509Certificate(pem).fingerprint256));
    if (intermediateCertificates.length) await fs.writeFile(untrusted, intermediateCertificates.join('\n'), { mode: 0o600 });
    const seen = new Set();
    for (const anchor of candidates) {
      if (seen.has(anchor.fingerprint)) continue; seen.add(anchor.fingerprint);
      const anchorFile = path.join(dir, `anchor-${seen.size}.pem`);
      await fs.writeFile(anchorFile, anchor.certificate, { mode: 0o600 });
      try {
        const args = ['verify', '-purpose', 'sslclient', '-CAfile', anchorFile];
        if (intermediateCertificates.length) args.push('-untrusted', untrusted);
        args.push(file); await openssl(args);
        if (anchors.some((item) => item.fingerprint === anchor.fingerprint)) trusted = true;
        if (!issuerFingerprint || anchors.some((item) => item.fingerprint === anchor.fingerprint)) issuerFingerprint = anchor.fingerprint;
      } catch {}
    }
    if (!issuerFingerprint) throw new Error('A complete, cryptographically valid issuer chain is required');
    const internalCa = anchors.find((item) => item.internal && item.fingerprint === issuerFingerprint);
    return { certificate: certPem, chain: suppliedChain.join('\n'), metadata: certificateMetadata(certPem), commonName: cert.subject.match(/(?:^|\n)CN=([^\n]+)/)?.[1] || '', trusted, issuerFingerprint, internal: Boolean(internalCa) };
  });
}

export async function addTrustedCa(certificate) {
  const pem = pemCertificates(certificate)[0];
  if (!pem) throw new Error('A PEM CA certificate is required');
  const caCert = new crypto.X509Certificate(pem);
  if (!caCert.ca || Date.parse(caCert.validFrom) > Date.now() || Date.parse(caCert.validTo) <= Date.now())
    throw new Error('The certificate must be a currently valid CA certificate');
  const metadata = certificateMetadata(pem);
  const db = loadDb();
  if (db.trustedCas.some((item) => item.fingerprint === metadata.fingerprint)) throw new Error('CA is already trusted');
  db.trustedCas.push({ id: crypto.randomUUID(), certificate: pem, enabled: true, addedAt: new Date().toISOString(), ...metadata });
  saveDb(db);
  await initializeCa();
  return { id: db.trustedCas.at(-1).id, ...metadata };
}
export async function revokeCertificate({ certificate }) {
  return work(async (dir) => {
    const file = path.join(dir, 'certificate.crt');
    await fs.writeFile(file, certificate, { mode: 0o600 });
    await openssl([
      'ca',
      '-batch',
      '-config',
      ca('openssl.cnf'),
      '-revoke',
      file,
      '-crl_reason',
      'cessationOfOperation',
    ]);
    await generateCRL();
  });
}
export async function certificateIsInCrl(serial) {
  try {
    const { stdout } = await openssl(['crl', '-in', ca('ca.crl'), '-text', '-noout']);
    const normalize = (value) => String(value).replace(/^0+/, '').toUpperCase();
    return [...stdout.matchAll(/Serial Number:\s*([0-9A-F]+)/gi)].some((match) => normalize(match[1]) === normalize(serial));
  } catch { return false; }
}
function servicePaths(server) {
  return {
    certFile: server ? broker('server.crt') : path.join(env.dataDir, 'mqtt-client.crt'),
    keyFile: server ? broker('server.key') : path.join(env.dataDir, 'mqtt-client.key'),
  };
}
function brokerHosts() {
  const hosts = [
    ...new Set(
      [
        'mqtt-broker',
        'localhost',
        env.hostname,
        env.domain,
        env.localAddress,
        ...env.brokerExtraSans,
      ]
        .filter(Boolean)
        .map((h) => h.toLowerCase()),
    ),
  ];
  if (hosts.some((h) => !/^[a-z0-9.:-]+$/.test(h)))
    throw new Error('Invalid broker hostname/address');
  return hosts;
}
async function serviceCertificateCurrent(server, matchSans = false) {
  const { certFile, keyFile } = servicePaths(server);
  if (!(await exists(certFile)) || !(await exists(keyFile))) return false;
  const current = new crypto.X509Certificate(await fs.readFile(certFile));
  const key = crypto.createPrivateKey(await fs.readFile(keyFile));
  const signer = new crypto.X509Certificate(await fs.readFile(ca('ca.crt')));
  const expected = brokerHosts()
    .filter((h) => !isIP(h))
    .map((h) => `DNS:${h}`)
    .sort();
  // Compare exact SANs as well as hostname checks so removing a configured name works.
  const actual = (current.subjectAltName || '').split(/,\s*/).sort();
  const namesMatch =
    !server ||
    !matchSans ||
    (JSON.stringify(expected) === JSON.stringify(actual.filter((h) => h.startsWith('DNS:'))) &&
      actual.length === brokerHosts().length &&
      brokerHosts().every((h) => (isIP(h) ? current.checkIP(h) : current.checkHost(h))));
  return (
    namesMatch &&
    current.checkPrivateKey(key) &&
    current.verify(signer.publicKey) &&
    Date.parse(current.validFrom) <= Date.now() &&
    Date.parse(current.validTo) - Date.now() > 30 * 86400000
  );
}
async function serviceCertificate(name, server = false, matchSans = false) {
  const { certFile, keyFile } = servicePaths(server);
  const hosts = brokerHosts();
  // Configuration edits alone never replace a healthy certificate during maintenance.
  if (await serviceCertificateCurrent(server, matchSans)) return false;
  await work(async (dir) => {
    const csr = path.join(dir, 'request.csr'),
      ext = path.join(dir, 'extensions.cnf');
    const temporaryKey = path.join(dir, 'service.key'),
      temporaryCert = path.join(dir, 'service.crt');
    const existingKey = await exists(keyFile);
    if (existingKey) await fs.copyFile(keyFile, temporaryKey);
    else
      await openssl([
        'genpkey',
        '-algorithm',
        'EC',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-out',
        temporaryKey,
      ]);
    await fs.chmod(temporaryKey, 0o600);
    await openssl(['req', '-new', '-key', temporaryKey, '-out', csr, '-subj', `/CN=${name}`]);
    const san = hosts.map((h) => `${isIP(h) ? 'IP' : 'DNS'}:${h}`).join(',');
    await fs.writeFile(
      ext,
      `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${server ? 'serverAuth' : 'clientAuth'}\n${server ? `subjectAltName=${san}\n` : ''}`,
    );
    const signer = new crypto.X509Certificate(await fs.readFile(ca('ca.crt')));
    const days = Math.min(365, Math.floor((Date.parse(signer.validTo) - Date.now()) / 86400000));
    if (days < 1) throw new Error('CA expires too soon to issue a service certificate');
    await openssl([
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      ca('ca.crt'),
      '-CAkey',
      ca('ca.key'),
      '-set_serial',
      `0x${crypto.randomBytes(16).toString('hex')}`,
      '-days',
      String(days),
      '-sha256',
      '-extfile',
      ext,
      '-out',
      temporaryCert,
    ]);
    await openssl([
      'verify',
      '-CAfile',
      ca('ca.crt'),
      '-purpose',
      server ? 'sslserver' : 'sslclient',
      temporaryCert,
    ]);
    // Retain the service key on renewal and publish the certificate atomically.
    if (!existingKey) await atomic(keyFile, await fs.readFile(temporaryKey));
    await atomic(certFile, await fs.readFile(temporaryCert), 0o644);
  });
  return true;
}
export async function brokerCertificateNeedsUpdate() {
  // This command must never initialize or replace a missing CA.
  if (!(await exists(ca('ca.crt'))) || !(await exists(ca('ca.key'))))
    throw new Error('Existing CA is required. Run gateway install first.');
  return !(await serviceCertificateCurrent(true, true));
}
export async function updateBrokerCertificate() {
  if (!(await brokerCertificateNeedsUpdate())) return false;
  if (await exists(broker('pending-revision')))
    throw new Error(
      'Apply pending broker changes in the console before updating the server certificate.',
    );
  const changed = await serviceCertificate('mqtt-broker', true, true);
  if (changed) await submitBrokerRevision(crypto.randomUUID());
  return changed;
}
async function submitBrokerRevision(revision) {
  const auditId = sqlite.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit').get().id;
  await atomic(broker('audit-cursor'), JSON.stringify({ revision, auditId }));
  await atomic(broker('revision'), revision, 0o644);
}
export async function syncBroker(force = false, { defer = false } = {}) {
  const db = loadDb();
  let acl = `user ${env.adminMqttClientId}\ntopic readwrite #\ntopic read $SYS/#\n`;
  const now = Date.now();
  for (const device of db.devices) {
    if (
      !device.enabled ||
      device.status === 'archived' ||
      device.status === 'deleted' ||
      device.trusted === false ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(device.id) ||
      device.id === env.adminMqttClientId
    )
      continue;
    if (
      !db.certificates.some(
        (c) => c.deviceId === device.id && c.status === 'active' && c.brokerTrusted !== false && Date.parse(c.validTo) > now,
      )
    )
      continue;
    acl += `\nuser ${device.id}\ntopic readwrite ${device.id}/#\ntopic readwrite ${env.topicPrefix}/${device.id}/#\n`;
  }
  const policy = JSON.stringify(
    db.certificates
      .filter((c) => c.status === 'active' && c.brokerTrusted !== false && Date.parse(c.validTo) > now)
      .map((c) => c.serial)
      .sort(),
  );
  const previousPolicy = await fs.readFile(broker('policy-state'), 'utf8').catch(() => '');
  const previous = await fs.readFile(broker('acl'), 'utf8').catch(() => '');
  if (force || acl !== previous || policy !== previousPolicy) {
    await atomic(broker('acl'), acl, 0o600);
    await atomic(broker('policy-state'), policy, 0o600);
    const revision = crypto.randomUUID();
    if (defer) await atomic(broker('pending-revision'), revision, 0o644);
    else await submitBrokerRevision(revision);
    if (!defer) await fs.rm(broker('pending-revision'), { force: true });
  }
}
export function stageBroker(force = false) { return syncBroker(force, { defer: true }); }
export async function applyBrokerChanges() {
  const pending = await fs.readFile(broker('pending-revision'), 'utf8').catch(() => null);
  if (!pending) return false;
  await submitBrokerRevision(pending);
  await fs.rm(broker('pending-revision'), { force: true });
  return true;
}
export async function prepareGateway() {
  await initializeCa();
  await serviceCertificate('mqtt-broker', true);
  await serviceCertificate(env.adminMqttClientId);
  await syncBroker(true);
}
export async function refreshPki() {
  await initializeCa();
  await serviceCertificate('mqtt-broker', true);
  await serviceCertificate(env.adminMqttClientId);
  await syncBroker(true);
}
