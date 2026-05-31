import { post } from './api.js';
import { setNotice } from './notice.js';

export async function loadCsrFile(file) {
  if (!file) return;
  const csr = await file.text();
  document.getElementById('csr').value = csr;
  setNotice('CSR file loaded.', 'ok');
}

export async function signCsr() {
  const data = await post('/api/certificates/sign', {
    deviceId: document.getElementById('deviceId').value,
    provisionerPassword: document.getElementById('provisionerPassword').value,
    csr: document.getElementById('csr').value,
  });
  document.getElementById('cert').textContent = data.certificate;
}

export function toggleCsrHelp() {
  const help = document.getElementById('csrHelp');
  const button = document.getElementById('csrHelpToggle');
  help.hidden = !help.hidden;
  button.innerHTML = help.hidden
    ? '<span class="nf">&#xf059;</span> Show CSR help'
    : '<span class="nf">&#xf059;</span> Hide CSR help';
}
