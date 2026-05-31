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
      <label>CSR PEM<textarea id="csr" placeholder="Paste CSR PEM here"></textarea></label>
      <button id="signCsrButton" type="button"><span class="nf">&#xf084;</span> Sign CSR</button>
      <pre id="cert"></pre>
    </section>
  </div>`;
}
