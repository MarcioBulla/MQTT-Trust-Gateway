import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import { env } from '../config.js';

const execFileAsync = promisify(execFile);

function passwordFileArgs(passwordFile) {
  return [
    '--provisioner',
    env.stepCaProvisioner,
    '--provisioner-password-file',
    passwordFile,
  ];
}

export function certificateMetadata(certificatePem) {
  const certificate = new crypto.X509Certificate(certificatePem);
  return {
    serial: certificate.serialNumber,
    subject: certificate.subject,
    validFrom: new Date(certificate.validFrom).toISOString(),
    validTo: new Date(certificate.validTo).toISOString(),
  };
}

export async function signDeviceCsr({ deviceId, csr, provisionerPassword }) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mqtt-trust-csr-'));
  const csrFile = path.join(workDir, `${deviceId}.csr`);
  const crtFile = path.join(workDir, `${deviceId}.crt`);
  const passwordFile = path.join(workDir, 'password');

  try {
    await fs.writeFile(csrFile, `${csr}\n`, { mode: 0o600 });
    await fs.writeFile(passwordFile, `${provisionerPassword}\n`, { mode: 0o600 });
    await execFileAsync('step', [
      'ca', 'sign', csrFile, crtFile,
      '--ca-url', env.stepCaUrl,
      '--root', env.clientCaFile,
      ...passwordFileArgs(passwordFile),
      '--not-after', env.stepCaTtl,
      '--force',
    ], { timeout: 30000 });
    return fs.readFile(crtFile, 'utf8');
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

export async function revokeCertificate({ serial, provisionerPassword, reason = 'keyCompromise' }) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mqtt-trust-revoke-'));
  const passwordFile = path.join(workDir, 'password');

  try {
    await fs.writeFile(passwordFile, `${provisionerPassword}\n`, { mode: 0o600 });
    const { stdout: token } = await execFileAsync('step', [
      'ca', 'token', serial,
      '--revoke',
      '--ca-url', env.stepCaUrl,
      '--root', env.clientCaFile,
      ...passwordFileArgs(passwordFile),
    ], { timeout: 30000 });
    await execFileAsync('step', [
      'ca', 'revoke', serial,
      '--ca-url', env.stepCaUrl,
      '--root', env.clientCaFile,
      '--token', token.trim(),
      '--reason', reason,
    ], { timeout: 30000 });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
