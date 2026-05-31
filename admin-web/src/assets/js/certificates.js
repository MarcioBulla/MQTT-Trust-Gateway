import { post } from './api.js';
import { setNotice } from './notice.js';

let lastCertificate = '';

function downloadText(filename, content) {
  const blob = new Blob([content], { type: 'application/x-pem-file' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

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
  lastCertificate = data.certificate;
  document.getElementById('cert').textContent = lastCertificate;
  document.getElementById('downloadCertButton').disabled = false;
}

export function downloadCertificate() {
  if (!lastCertificate) throw new Error('Sign a CSR before downloading the certificate.');
  const deviceId = document.getElementById('deviceId').value.trim() || 'device';
  downloadText(`${deviceId}.crt`, lastCertificate);
}

export function downloadCaCertificate() {
  window.location.assign('/api/certificates/ca');
}

export function toggleCsrHelp() {
  const help = document.getElementById('csrHelp');
  const button = document.getElementById('csrHelpToggle');
  help.hidden = !help.hidden;
  button.innerHTML = help.hidden
    ? '<span class="nf">&#xf059;</span> Show CSR help'
    : '<span class="nf">&#xf059;</span> Hide CSR help';
}
