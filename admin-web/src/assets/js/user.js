import { post, requestJson } from './api.js';
import { setNotice } from './notice.js';
import { setCurrentUser } from './state.js';
import { decodePublicKeyOptions, encodeCredential } from './webauthn.js';

export function renderUser(user) {
  setCurrentUser(user);
  document.getElementById('headerUsername').textContent = user.username;
  document.getElementById('settingsUsername').value = user.username;
  document.getElementById('passkeyList').innerHTML = user.passkeys.map((passkey) => (
    '<div class="passkey">' +
      '<div><strong>' + passkey.name + '</strong><br><span class="muted">' + passkey.id + '</span></div>' +
      '<button class="secondary" type="button" data-passkey-id="' + passkey.id + '">Remove</button>' +
    '</div>'
  )).join('');
  document.querySelectorAll('[data-passkey-id]').forEach((button) => button.addEventListener('click', () => removePasskey(button.dataset.passkeyId)));
}

export async function loadMe() {
  const data = await requestJson('/api/me');
  renderUser(data.user);
  return data.user;
}

export async function addPasskey() {
  const options = await post('/api/passkeys/options', {});
  const credential = await navigator.credentials.create({ publicKey: decodePublicKeyOptions(options) });
  if (!credential) throw new Error('Passkey registration was cancelled.');
  const data = await post('/api/passkeys/verify', { credential: encodeCredential(credential) });
  renderUser(data.user);
  setNotice('Passkey added.', 'ok');
}

export async function removePasskey(id) {
  const data = await requestJson('/api/passkeys/' + encodeURIComponent(id), { method: 'DELETE' });
  renderUser(data.user);
  setNotice('Passkey removed.', 'ok');
}

export async function saveUsername() {
  const data = await requestJson('/api/me', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: document.getElementById('settingsUsername').value }),
  });
  renderUser(data.user);
  setNotice('Username updated.', 'ok');
}
