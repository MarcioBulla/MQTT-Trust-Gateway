import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '../config.js';

const execFileAsync = promisify(execFile);

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
      '--provisioner', env.stepCaProvisioner,
      '--provisioner-password-file', passwordFile,
      '--not-after', env.stepCaTtl,
      '--force',
    ], { timeout: 30000 });
    return fs.readFile(crtFile, 'utf8');
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
