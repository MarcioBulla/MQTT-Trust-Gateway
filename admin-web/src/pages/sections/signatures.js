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
      <div class="inline download-actions">
        <button id="downloadCertButton" class="secondary" type="button" disabled><span class="nf">&#xf019;</span> Download certificate</button>
        <button id="downloadCaButton" class="secondary" type="button"><span class="nf">&#xf019;</span> Download CA</button>
      </div>
      <pre id="cert"></pre>
      <button id="csrHelpToggle" class="secondary" type="button"><span class="nf">&#xf059;</span> Show CSR help</button>
      <section id="csrHelp" class="panel nested" hidden>
        <div class="help-head">
          <div>
            <h3>Generate a CSR</h3>
            <p class="muted">Run these commands on the machine where the device private key should live.</p>
          </div>
          <span class="nf help-icon">&#xf084;</span>
        </div>
        <div class="help-grid">
          <article class="help-step">
            <strong>1. Choose the device id</strong>
            <p class="muted">This becomes the certificate common name.</p>
            <pre>DEVICE_ID="device-01"
mkdir -p "devices/\${DEVICE_ID}"</pre>
          </article>
          <article class="help-step">
            <strong>2. Generate the private key</strong>
            <p class="muted">Keep this file on the device. Do not upload it here.</p>
            <pre>openssl genrsa \
  -out "devices/\${DEVICE_ID}/\${DEVICE_ID}.key" \
  2048</pre>
          </article>
          <article class="help-step">
            <strong>3. Generate the CSR</strong>
            <p class="muted">Upload the generated .csr file or paste its PEM content.</p>
            <pre>openssl req -new \
  -key "devices/\${DEVICE_ID}/\${DEVICE_ID}.key" \
  -out "devices/\${DEVICE_ID}/\${DEVICE_ID}.csr" \
  -subj "/CN=\${DEVICE_ID}" \
  -addext "subjectAltName=DNS:\${DEVICE_ID},URI:urn:mqtt-trust-gateway:device:\${DEVICE_ID}"</pre>
          </article>
        </div>
      </section>
    </section>
  </div>`;
}
