import { adminClientScript } from './admin-client.js';
import { adminStyles } from './admin-styles.js';

export function renderAdminPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MQTT Trust Gateway</title>
  <style>${adminStyles()}</style>
</head>
<body>
<main>
  <header id="appHeader" hidden>
    <div>
      <strong>MQTT Trust Gateway</strong>
      <div class="muted" id="headerUsername"></div>
    </div>
    <nav>
      <button id="mqttManagerTab" class="secondary" type="button">MQTT Manager</button>
      <button id="signaturesTab" class="secondary" type="button">Assinaturas</button>
      <button id="settingsTab" class="secondary" type="button">Settings</button>
      <button id="logoutButton" class="secondary" type="button">Logout</button>
    </nav>
  </header>
  <h1 id="authTitle">MQTT Trust Gateway</h1>
  <div id="notice"></div>
  <section id="setup" hidden>
    <h2>Register Passkey</h2>
    <input id="setupToken" placeholder="Setup token">
    <input id="username" placeholder="Admin username" value="admin">
    <button id="registerPasskeyButton" type="button">Register passkey</button>
  </section>
  <section id="login" hidden>
    <h2>Login</h2>
    <input id="loginUsername" placeholder="Admin username" value="admin">
    <button id="loginPasskeyButton" type="button">Login with passkey</button>
  </section>
  <section id="app" hidden>
    <div id="mqttManagerView">
      <div class="row"><button id="refreshStatusButton" type="button">Refresh status</button></div>
      <h2>MQTT Manager</h2>
      <pre id="status"></pre>
    </div>
    <div id="signaturesView" hidden>
      <h2>Assinaturas</h2>
      <input id="deviceId" placeholder="device-id">
      <input id="provisionerPassword" placeholder="Provisioner password" type="password">
      <textarea id="csr" placeholder="Paste CSR PEM here"></textarea>
      <button id="signCsrButton" type="button">Sign CSR</button>
      <pre id="cert"></pre>
    </div>
    <div id="settingsView" hidden>
      <h2>Settings</h2>
      <input id="settingsUsername" placeholder="Username">
      <button id="saveUsernameButton" type="button">Save username</button>
      <h3>Passkeys</h3>
      <button id="addPasskeyButton" type="button">Add passkey</button>
      <div id="passkeyList"></div>
    </div>
  </section>
</main>
<script>${adminClientScript()}</script>
</body>
</html>`;
}
