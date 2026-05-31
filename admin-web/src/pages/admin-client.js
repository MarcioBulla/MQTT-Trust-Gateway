export function adminClientScript() {
  return String.raw`
let currentUser = null;
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
function decodePublicKeyOptions(options) {
  options.challenge = b64urlToBuffer(options.challenge);
  if (options.user?.id) options.user.id = b64urlToBuffer(options.user.id);
  for (const key of ['allowCredentials', 'excludeCredentials']) {
    if (options[key]) options[key] = options[key].map((credential) => ({ ...credential, id: b64urlToBuffer(credential.id) }));
  }
  return options;
}
function encodeCredential(credential) {
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
function setNotice(message, type = '') {
  const notice = document.getElementById('notice');
  notice.className = type;
  notice.textContent = message;
}
async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}
async function post(url, body) {
  return requestJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
function showAuth(mode) {
  document.getElementById('appHeader').hidden = true;
  document.getElementById('app').hidden = true;
  document.getElementById('authTitle').hidden = false;
  document.getElementById('setup').hidden = mode !== 'setup';
  document.getElementById('login').hidden = mode !== 'login';
}
function showView(view) {
  document.getElementById('appHeader').hidden = false;
  document.getElementById('authTitle').hidden = true;
  document.getElementById('setup').hidden = true;
  document.getElementById('login').hidden = true;
  document.getElementById('app').hidden = false;
  for (const id of ['mqttManagerView', 'signaturesView', 'settingsView']) document.getElementById(id).hidden = id !== view;
}
function renderUser(user) {
  currentUser = user;
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
async function loadMe() {
  const data = await requestJson('/api/me');
  renderUser(data.user);
  return data.user;
}
async function registerPasskey() {
  try {
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
  } catch (error) {
    setNotice(error.message || String(error), 'error');
  }
}
async function loginPasskey(username = document.getElementById('loginUsername').value) {
  try {
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
  } catch (error) {
    setNotice(error.message || String(error), 'error');
  }
}
async function addPasskey() {
  try {
    const options = await post('/api/passkeys/options', {});
    const credential = await navigator.credentials.create({ publicKey: decodePublicKeyOptions(options) });
    if (!credential) throw new Error('Passkey registration was cancelled.');
    const data = await post('/api/passkeys/verify', { credential: encodeCredential(credential) });
    renderUser(data.user);
    setNotice('Passkey added.', 'ok');
  } catch (error) {
    setNotice(error.message || String(error), 'error');
  }
}
async function removePasskey(id) {
  try {
    const data = await requestJson('/api/passkeys/' + encodeURIComponent(id), { method: 'DELETE' });
    renderUser(data.user);
    setNotice('Passkey removed.', 'ok');
  } catch (error) {
    setNotice(error.message || String(error), 'error');
  }
}
async function saveUsername() {
  try {
    const data = await requestJson('/api/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: document.getElementById('settingsUsername').value }),
    });
    renderUser(data.user);
    setNotice('Username updated.', 'ok');
  } catch (error) {
    setNotice(error.message || String(error), 'error');
  }
}
async function loadStatus() {
  const res = await fetch('/api/status');
  document.getElementById('status').textContent = JSON.stringify(await res.json(), null, 2);
}
async function signCsr() {
  const data = await post('/api/certificates/sign', {
    deviceId: document.getElementById('deviceId').value,
    provisionerPassword: document.getElementById('provisionerPassword').value,
    csr: document.getElementById('csr').value,
  });
  document.getElementById('cert').textContent = data.certificate;
}
async function logout() {
  await post('/api/logout', {});
  location.reload();
}
async function init() {
  try {
    const data = await requestJson('/api/bootstrap');
    if (data.user) {
      renderUser(data.user);
      showView('mqttManagerView');
      await loadStatus();
    } else {
      showAuth(data.hasAdmin ? 'login' : 'setup');
    }
  } catch (error) {
    showAuth('login');
    setNotice(error.message || String(error), 'error');
  }
}
window.addEventListener('error', (event) => setNotice(event.message || 'Browser script error.', 'error'));
window.addEventListener('unhandledrejection', (event) => setNotice(event.reason?.message || String(event.reason || 'Unhandled browser error.'), 'error'));
document.getElementById('registerPasskeyButton').addEventListener('click', registerPasskey);
document.getElementById('loginPasskeyButton').addEventListener('click', () => loginPasskey());
document.getElementById('mqttManagerTab').addEventListener('click', () => showView('mqttManagerView'));
document.getElementById('signaturesTab').addEventListener('click', () => showView('signaturesView'));
document.getElementById('settingsTab').addEventListener('click', () => { showView('settingsView'); if (currentUser) renderUser(currentUser); });
document.getElementById('refreshStatusButton').addEventListener('click', loadStatus);
document.getElementById('logoutButton').addEventListener('click', logout);
document.getElementById('signCsrButton').addEventListener('click', signCsr);
document.getElementById('saveUsernameButton').addEventListener('click', saveUsername);
document.getElementById('addPasskeyButton').addEventListener('click', addPasskey);
init();
  `;
}
