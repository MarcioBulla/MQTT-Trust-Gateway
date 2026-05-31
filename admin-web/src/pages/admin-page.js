import { appHeader } from './sections/header.js';
import { authSections } from './sections/auth.js';
import { mqttManagerSection } from './sections/mqtt-manager.js';
import { signaturesSection } from './sections/signatures.js';
import { settingsSection } from './sections/settings.js';

export function renderAdminPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MQTT Trust Gateway</title>
  <link rel="icon" type="image/png" href="/assets/favicon.png">
  <link rel="stylesheet" href="/assets/styles/admin.css">
</head>
<body>
<main>
  ${appHeader()}
  <h1 id="authTitle">MQTT Trust Gateway</h1>
  <div id="notice"></div>
  ${authSections()}
  <section id="app" hidden>
    ${mqttManagerSection()}
    ${signaturesSection()}
    ${settingsSection()}
  </section>
</main>
<script type="module" src="/assets/js/main.js"></script>
</body>
</html>`;
}
