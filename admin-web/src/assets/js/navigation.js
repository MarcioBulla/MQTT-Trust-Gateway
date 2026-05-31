export function showAuth(mode) {
  document.getElementById('appHeader').hidden = true;
  document.getElementById('app').hidden = true;
  document.getElementById('authTitle').hidden = false;
  document.getElementById('setup').hidden = mode !== 'setup';
  document.getElementById('login').hidden = mode !== 'login';
}

export function showView(view) {
  document.getElementById('appHeader').hidden = false;
  document.getElementById('authTitle').hidden = true;
  document.getElementById('setup').hidden = true;
  document.getElementById('login').hidden = true;
  document.getElementById('app').hidden = false;
  for (const id of ['mqttManagerView', 'signaturesView', 'settingsView']) {
    document.getElementById(id).hidden = id !== view;
  }
}
