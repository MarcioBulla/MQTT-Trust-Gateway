import { post } from './api.js';
import { loadStatus } from './mqtt-manager.js';
import { setNotice } from './notice.js';
import { showView } from './navigation.js';
import { setCurrentUser } from './state.js';
import { renderUser, loadMe } from './user.js';
import { decodePublicKeyOptions, encodeCredential } from './webauthn.js';

export async function registerPasskey() {
  setNotice('Starting passkey registration...');
  if (!window.PublicKeyCredential) throw new Error('This browser does not support passkeys/WebAuthn.');
  const username = document.getElementById('username').value;
  const options = await post('/api/register/options', { setupToken: document.getElementById('setupToken').value, username });
  setNotice('Waiting for the browser passkey prompt...');
  const credential = await navigator.credentials.create({ publicKey: decodePublicKeyOptions(options) });
  if (!credential) throw new Error('Passkey registration was cancelled.');
  const data = await post('/api/register/verify', { username, credential: encodeCredential(credential) });
  renderUser(data.user);
  setNotice('Passkey registered.', 'ok');
  showView('mqttManagerView');
  await loadStatus();
}

export async function loginPasskey(username = document.getElementById('loginUsername').value) {
  setNotice('Starting passkey login...');
  if (!window.PublicKeyCredential) throw new Error('This browser does not support passkeys/WebAuthn.');
  const options = await post('/api/login/options', { username });
  setNotice('Waiting for the browser passkey prompt...');
  const credential = await navigator.credentials.get({ publicKey: decodePublicKeyOptions(options) });
  if (!credential) throw new Error('Passkey login was cancelled.');
  await post('/api/login/verify', { username, credential: encodeCredential(credential) });
  await loadMe();
  setNotice('Logged in.', 'ok');
  showView('mqttManagerView');
  await loadStatus();
}

export async function logout() {
  setNotice('Logging out...');
  await post('/api/logout', {});
  setCurrentUser(null);
  window.location.replace('/');
}
