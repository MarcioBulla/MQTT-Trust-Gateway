import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '../config.js';
import { loadDb } from '../db.js';
const run = promisify(execFile);
const ca = (name) => path.join(env.caDir, name);
const broker = (name) => path.join(env.brokerDir, name);
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
  return {
    serial: c.serialNumber,
    subject: c.subject,
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
  await atomic(broker('ca.crt'), await fs.readFile(ca('ca.crt')), 0o644);
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
async function serviceCertificate(name, server = false) {
  const certFile = server ? broker('server.crt') : path.join(env.dataDir, 'mqtt-client.crt');
  const keyFile = server ? broker('server.key') : path.join(env.dataDir, 'mqtt-client.key');
  const hosts = [
    ...new Set(
      ['mqtt-broker', 'localhost', env.hostname, env.domain, env.localAddress].filter(Boolean),
    ),
  ];
  if (hosts.some((h) => !/^[A-Za-z0-9.:-]+$/.test(h)))
    throw new Error('Invalid broker hostname/address');
  if ((await exists(certFile)) && (await exists(keyFile))) {
    const current = new crypto.X509Certificate(await fs.readFile(certFile));
    const key = crypto.createPrivateKey(await fs.readFile(keyFile));
    const signer = new crypto.X509Certificate(await fs.readFile(ca('ca.crt')));
    const namesMatch =
      !server || hosts.every((h) => (isIP(h) ? current.checkIP(h) : current.checkHost(h)));
    if (
      namesMatch &&
      current.checkPrivateKey(key) &&
      current.verify(signer.publicKey) &&
      Date.parse(current.validTo) - Date.now() > 30 * 86400000
    )
      return;
  }
  await work(async (dir) => {
    const csr = path.join(dir, 'request.csr'),
      ext = path.join(dir, 'extensions.cnf');
    await openssl([
      'req',
      '-new',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      csr,
      '-subj',
      `/CN=${name}`,
    ]);
    await fs.chmod(keyFile, 0o600);
    const san = hosts.map((h) => `${isIP(h) ? 'IP' : 'DNS'}:${h}`).join(',');
    await fs.writeFile(
      ext,
      `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${server ? 'serverAuth' : 'clientAuth'}\n${server ? `subjectAltName=${san}\n` : ''}`,
    );
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
      '365',
      '-sha256',
      '-extfile',
      ext,
      '-out',
      certFile,
    ]);
  });
}
export async function syncBroker(force = false) {
  const db = loadDb();
  let acl = `user ${env.adminMqttClientId}\ntopic readwrite #\ntopic read $SYS/#\n`;
  const now = Date.now();
  for (const device of db.devices) {
    if (
      !device.enabled ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(device.id) ||
      device.id === env.adminMqttClientId
    )
      continue;
    if (
      !db.certificates.some(
        (c) => c.deviceId === device.id && c.status !== 'revoked' && Date.parse(c.validTo) > now,
      )
    )
      continue;
    acl += `\nuser ${device.id}\ntopic readwrite ${device.id}/#\ntopic readwrite ${env.topicPrefix}/${device.id}/#\n`;
  }
  const policy = JSON.stringify(
    db.certificates
      .filter((c) => c.status !== 'revoked' && Date.parse(c.validTo) > now)
      .map((c) => c.serial)
      .sort(),
  );
  const previousPolicy = await fs.readFile(broker('policy-state'), 'utf8').catch(() => '');
  const previous = await fs.readFile(broker('acl'), 'utf8').catch(() => '');
  if (force || acl !== previous || policy !== previousPolicy) {
    await atomic(broker('acl'), acl, 0o600);
    await atomic(broker('policy-state'), policy, 0o600);
    await atomic(broker('revision'), crypto.randomUUID(), 0o644);
  }
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
