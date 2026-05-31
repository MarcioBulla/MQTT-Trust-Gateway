export function signaturesSection() {
  return `<div id="signaturesView" hidden>
    <div class="panel-head">
      <div>
        <h2>Assinaturas</h2>
        <p class="muted">Sign device CSRs with the configured step-ca provisioner.</p>
      </div>
    </div>
    <section class="panel">
      <div class="grid two">
        <label>Device ID<input id="deviceId" placeholder="device-01"></label>
        <label>Provisioner password<input id="provisionerPassword" placeholder="Provisioner password" type="password"></label>
      </div>
      <label>CSR file<input id="csrFile" type="file" accept=".csr,.pem,.txt,application/pkcs10"></label>
      <label>CSR PEM<textarea id="csr" placeholder="Paste CSR PEM here"></textarea></label>
      <button id="signCsrButton" type="button"><span class="nf">&#xf084;</span> Sign CSR</button>
      <pre id="cert"></pre>
      <button id="csrHelpToggle" class="secondary" type="button"><span class="nf">&#xf059;</span> Show CSR help</button>
      <section id="csrHelp" class="panel nested" hidden>
        <h3>Generate a CSR</h3>
        <p class="muted">Use the same device id as the certificate common name.</p>
        <pre>DEVICE_ID="device-01"
mkdir -p "devices/\${DEVICE_ID}"

openssl genrsa -out "devices/\${DEVICE_ID}/\${DEVICE_ID}.key" 2048
openssl req -new \
  -key "devices/\${DEVICE_ID}/\${DEVICE_ID}.key" \
  -out "devices/\${DEVICE_ID}/\${DEVICE_ID}.csr" \
  -subj "/CN=\${DEVICE_ID}" \
  -addext "subjectAltName=DNS:\${DEVICE_ID},URI:urn:mqtt-trust-gateway:device:\${DEVICE_ID}"</pre>
      </section>
    </section>
  </div>`;
}
