export function b64urlToBuffer(value) {
  return Buffer.from(value, 'base64url');
}

export function bufferToB64url(value) {
  if (typeof value === 'string') return value;
  return Buffer.from(value).toString('base64url');
}

function looksLikeCredentialId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,}$/.test(value);
}

export function credentialIdCandidates(value) {
  const candidates = new Set();
  if (looksLikeCredentialId(value)) candidates.add(value);

  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (decoded !== value && looksLikeCredentialId(decoded)) candidates.add(decoded);
  } catch {
    // Ignore malformed legacy values.
  }

  return [...candidates];
}

export function userCredentials(user) {
  if (!Array.isArray(user.credentials)) user.credentials = [];
  if (user.credentialID && user.credentialPublicKey && !user.credentials.some((credential) => credential.id === user.credentialID)) {
    user.credentials.push({
      id: user.credentialID,
      publicKey: user.credentialPublicKey,
      counter: user.counter || 0,
      name: 'Primary passkey',
      createdAt: user.createdAt || new Date().toISOString(),
    });
  }
  return user.credentials;
}

export function findUserCredential(user, credentialId) {
  return userCredentials(user).find((credential) => credentialIdCandidates(credential.id).includes(credentialId));
}

export function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    passkeys: userCredentials(user).map((credential) => ({
      id: credential.id,
      name: credential.name || 'Passkey',
      createdAt: credential.createdAt || null,
    })),
  };
}

export function credentialIdFromClientOrInfo(clientCredential, registrationInfo) {
  return clientCredential.rawId || clientCredential.id || bufferToB64url(registrationInfo.credentialID);
}
