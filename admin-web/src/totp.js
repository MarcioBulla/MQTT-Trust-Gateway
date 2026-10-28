import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { env } from './config.js';
const keyFile = path.join(env.dataDir, 'totp-encryption.key');
function encryptionKey() {
  try {
    return fs.readFileSync(keyFile);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, key, { flag: 'wx', mode: 0o600 });
    return key;
  }
}
function seal(secret) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}
function unseal(value) {
  const b = Buffer.from(value, 'base64'),
    cipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), b.subarray(0, 12));
  cipher.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString('utf8');
}
const otp = (secret) =>
  new OTPAuth.TOTP({
    issuer: 'MQTT Trust Gateway',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
export async function enrollTotp(username) {
  const totp = new OTPAuth.TOTP({
    issuer: 'MQTT Trust Gateway',
    label: username,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: 20 }),
  });
  const secret = totp.secret.base32;
  return {
    pending: { encrypted: seal(secret), expiresAt: Date.now() + 600000 },
    secret,
    qr: await QRCode.toDataURL(totp.toString(), { width: 280, margin: 2 }),
    uri: totp.toString(),
  };
}
export function verifyTotp(record, token, now = Date.now()) {
  if (!record || !/^\d{6}$/.test(String(token))) return false;
  const delta = otp(unseal(record.encrypted)).validate({
    token: String(token),
    window: 1,
    timestamp: now,
  });
  if (delta === null) return false;
  const step = Math.floor(now / 30000) + delta;
  if (step <= (record.lastStep ?? -1)) return false;
  record.lastStep = step;
  return true;
}
