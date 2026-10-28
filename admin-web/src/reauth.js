import crypto from 'node:crypto';
import argon2 from 'argon2';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { env } from './config.js';
import { sessionKey, createSession } from './auth.js';
import { saveDb, audit } from './db.js';
import { userCredentials, credentialIdCandidates, findUserCredential } from './passkeys.js';
import { verifyTotp } from './totp.js';

export function removalOperation(action, target = '') {
  if (action === 'disable-totp' && target === '') return 'disable-totp';
  if (
    action === 'remove-passkey' &&
    typeof target === 'string' &&
    target.length > 0 &&
    target.length <= 1024
  )
    return `remove-passkey:${target}`;
  throw Object.assign(new Error('Invalid authentication change'), { status: 400 });
}
function challengeKey(req, user, operation) {
  const action = crypto.createHash('sha256').update(operation).digest('hex');
  return `reauth:${user.id}:${sessionKey(req)}:${action}`;
}
export async function reauthenticationOptions(req, db, user, operation) {
  if (!userCredentials(user).length)
    throw Object.assign(new Error('No passkey is available for verification'), { status: 409 });
  const options = await generateAuthenticationOptions({
    rpID: env.rpID,
    userVerification: 'required',
    allowCredentials: userCredentials(user).flatMap((c) =>
      credentialIdCandidates(c.id).map((id) => ({ id, type: 'public-key' })),
    ),
  });
  for (const [key, value] of Object.entries(db.challenges))
    if (value.expiresAt < Date.now()) delete db.challenges[key];
  db.challenges[challengeKey(req, user, operation)] = {
    challenge: options.challenge,
    expiresAt: Date.now() + 120000,
  };
  saveDb(db);
  return options;
}
export async function verifyReauthentication(req, db, user, operation) {
  const proof = req.body?.reauth;
  try {
    if (proof?.method === 'password') {
      if (
        !user.passwordHash ||
        typeof proof.password !== 'string' ||
        proof.password.length > 256 ||
        !(await argon2.verify(user.passwordHash, proof.password))
      )
        throw new Error('Invalid password');
      if (user.totp && !verifyTotp(user.totp, proof.totp))
        throw new Error('A fresh authenticator code is required');
    } else if (proof?.method === 'passkey') {
      const key = challengeKey(req, user, operation),
        pending = db.challenges[key];
      delete db.challenges[key];
      saveDb(db); // Consume before signature verification, including failed attempts.
      if (!pending || pending.expiresAt <= Date.now())
        throw new Error('Verification challenge expired');
      const credential = findUserCredential(user, proof.credential?.id);
      if (!credential) throw new Error('Unknown passkey');
      const result = await verifyAuthenticationResponse({
        response: proof.credential,
        expectedChallenge: pending.challenge,
        expectedOrigin: env.origin,
        expectedRPID: env.rpID,
        requireUserVerification: true,
        credential: {
          id: proof.credential.id,
          publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')),
          counter: credential.counter || 0,
        },
      });
      if (!result.verified) throw new Error('Passkey verification failed');
      credential.counter = result.authenticationInfo.newCounter;
    } else {
      throw new Error('Fresh authentication required');
    }
  } catch {
    audit(user.username, 'reauth.failed', operation);
    throw Object.assign(
      new Error(
        'Fresh authentication failed. Verify your password and a fresh TOTP code if enabled, or use a passkey.',
      ),
      { status: 403 },
    );
  }
  audit(user.username, 'reauth.verified', operation);
}
export function rotateAfterAuthenticationChange(req, res, db, user) {
  db.sessions = Object.fromEntries(
    Object.entries(db.sessions).filter(([, s]) => s.userId !== user.id),
  );
  for (const key of Object.keys(db.challenges)) {
    if (
      key.startsWith(`reauth:${user.id}:`) ||
      key === `add:${user.id}` ||
      key === `login:${user.id}`
    )
      delete db.challenges[key];
  }
  createSession(db, user, req, res);
  saveDb(db);
}
