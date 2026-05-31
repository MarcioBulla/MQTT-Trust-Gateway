function b64urlToBuffer(value) {
  const pad = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))).buffer;
}

function bufferToB64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodePublicKeyOptions(options) {
  options.challenge = b64urlToBuffer(options.challenge);
  if (options.user?.id) options.user.id = b64urlToBuffer(options.user.id);
  for (const key of ['allowCredentials', 'excludeCredentials']) {
    if (options[key]) options[key] = options[key].map((credential) => ({ ...credential, id: b64urlToBuffer(credential.id) }));
  }
  return options;
}

export function encodeCredential(credential) {
  const response = {};
  for (const [key, value] of Object.entries(credential.response)) {
    if (value instanceof ArrayBuffer) response[key] = bufferToB64url(value);
  }
  return {
    id: credential.id,
    rawId: bufferToB64url(credential.rawId),
    type: credential.type,
    response,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment,
  };
}
