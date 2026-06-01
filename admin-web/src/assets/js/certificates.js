import { get, post } from './api.js';
import { setNotice } from './notice.js';

let lastCertificate = '';
let cachedCertificates = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function formatDate(value) {
  if (!value) return 'not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function dateValue(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function textValue(value) {
  return String(value || '').toLowerCase();
}

function provisionerPassword() {
  return document.getElementById('provisionerPassword').value;
}

function currentDeviceId() {
  const value = document.getElementById('deviceId').value.trim();
  return value || 'device-01';
}

export function updateCsrHelpCommands() {
  const deviceId = currentDeviceId();
  document.getElementById('csrHelpDeviceCommand').textContent = `DEVICE_ID="${deviceId}"
mkdir -p "devices/\${DEVICE_ID}"`;
  document.getElementById('csrHelpKeyCommand').textContent = `openssl genrsa \\
  -out "devices/\${DEVICE_ID}/\${DEVICE_ID}.key" \\
  2048`;
  document.getElementById('csrHelpCsrCommand').textContent = `openssl req -new \\
  -key "devices/\${DEVICE_ID}/\${DEVICE_ID}.key" \\
  -out "devices/\${DEVICE_ID}/\${DEVICE_ID}.csr" \\
  -subj "/CN=\${DEVICE_ID}" \\
  -addext "subjectAltName=DNS:\${DEVICE_ID},URI:urn:mqtt-trust-gateway:device:\${DEVICE_ID}"`;
}

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
    provisionerPassword: provisionerPassword(),
    csr: document.getElementById('csr').value,
  });
  lastCertificate = data.certificate;
  document.getElementById('cert').textContent = lastCertificate;
  document.getElementById('downloadCertButton').disabled = false;
  await loadCertificates();
}

export function downloadCertificate() {
  if (!lastCertificate) throw new Error('Sign a CSR before downloading the certificate.');
  const deviceId = document.getElementById('deviceId').value.trim() || 'device';
  downloadText(`${deviceId}.crt`, lastCertificate);
}

export function downloadCaCertificate() {
  window.location.assign('/api/certificates/ca');
}

function certificateActions(certificate) {
  const disabledDownload = certificate.canDownload ? '' : ' disabled';
  const disabledRenew = certificate.canRenew ? '' : ' disabled';
  const disabledRevoke = certificate.canRevoke ? '' : ' disabled';
  return '<div class="certificate-actions">' +
    `<button class="secondary" type="button" data-download-certificate="${escapeHtml(certificate.id)}"${disabledDownload}><span class="nf">&#xf019;</span> Download</button>` +
    `<button class="secondary" type="button" data-renew-certificate="${escapeHtml(certificate.id)}"${disabledRenew}><span class="nf">&#xf021;</span> Renew</button>` +
    `<button class="danger" type="button" data-revoke-certificate="${escapeHtml(certificate.id)}"${disabledRevoke}><span class="nf">&#xf1f8;</span> Revoke</button>` +
    '</div>';
}

function renderCertificate(certificate) {
  const status = certificate.status || 'active';
  const renewed = certificate.renewedFrom ? `<div class="certificate-meta">Renewed from: ${escapeHtml(certificate.renewedFrom)}</div>` : '';
  const revoked = certificate.revokedAt ? `<div class="certificate-meta">Revoked: ${escapeHtml(formatDate(certificate.revokedAt))}</div>` : '';
  return '<div class="certificate-row">' +
    '<div>' +
      `<div class="certificate-title">${escapeHtml(certificate.deviceId || 'Unknown device')}</div>` +
      `<div class="certificate-meta">Serial: ${escapeHtml(certificate.serial || 'not available')}</div>` +
      `<div class="certificate-meta">Valid from: ${escapeHtml(formatDate(certificate.validFrom))}</div>` +
      `<div class="certificate-meta">Valid to: ${escapeHtml(formatDate(certificate.validTo))}</div>` +
      `<div class="certificate-meta">Issued: ${escapeHtml(formatDate(certificate.issuedAt))} by ${escapeHtml(certificate.issuedBy || 'unknown')}</div>` +
      renewed +
      revoked +
      `<span class="certificate-status ${escapeHtml(status)}">${escapeHtml(status)}</span>` +
    '</div>' +
    certificateActions(certificate) +
  '</div>';
}

function certificateSearchText(certificate) {
  return [
    certificate.deviceId,
    certificate.serial,
    certificate.subject,
    certificate.status,
    certificate.issuedBy,
    certificate.validFrom,
    certificate.validTo,
  ].map((value) => String(value || '')).join(' ').toLowerCase();
}

function sortedCertificates(certificates) {
  const sort = document.getElementById('certificateSort').value;
  return [...certificates].sort((a, b) => {
    if (sort === 'issuedAsc') return dateValue(a.issuedAt) - dateValue(b.issuedAt);
    if (sort === 'validToAsc') return dateValue(a.validTo) - dateValue(b.validTo);
    if (sort === 'validToDesc') return dateValue(b.validTo) - dateValue(a.validTo);
    if (sort === 'deviceAsc') return textValue(a.deviceId).localeCompare(textValue(b.deviceId));
    if (sort === 'deviceDesc') return textValue(b.deviceId).localeCompare(textValue(a.deviceId));
    if (sort === 'statusAsc') return textValue(a.status).localeCompare(textValue(b.status));
    if (sort === 'statusDesc') return textValue(b.status).localeCompare(textValue(a.status));
    return dateValue(b.issuedAt) - dateValue(a.issuedAt);
  });
}

export function renderCertificates() {
  const target = document.getElementById('certificateList');
  const search = document.getElementById('certificateSearch').value.trim().toLowerCase();
  const filtered = cachedCertificates.filter((certificate) => certificateSearchText(certificate).includes(search));
  if (!filtered.length) {
    target.innerHTML = '<p class="muted">No certificates issued yet.</p>';
    return;
  }
  target.innerHTML = sortedCertificates(filtered).map(renderCertificate).join('');
}

export async function loadCertificates() {
  const data = await get('/api/certificates');
  cachedCertificates = data.certificates;
  renderCertificates();
}

export function downloadIssuedCertificate(id) {
  window.location.assign('/api/certificates/' + encodeURIComponent(id) + '/download');
}

export async function revokeIssuedCertificate(id) {
  if (!provisionerPassword()) throw new Error('Provisioner password is required to revoke a certificate.');
  if (!window.confirm('Revoke this certificate? This cannot be undone.')) return;
  await post('/api/certificates/' + encodeURIComponent(id) + '/revoke', {
    provisionerPassword: provisionerPassword(),
  });
  setNotice('Certificate revoked.', 'ok');
  await loadCertificates();
}

export async function renewIssuedCertificate(id) {
  if (!provisionerPassword()) throw new Error('Provisioner password is required to renew a certificate.');
  const data = await post('/api/certificates/' + encodeURIComponent(id) + '/renew', {
    provisionerPassword: provisionerPassword(),
  });
  lastCertificate = data.certificate;
  document.getElementById('cert').textContent = lastCertificate;
  document.getElementById('downloadCertButton').disabled = false;
  setNotice('Certificate renewed.', 'ok');
  await loadCertificates();
}

export function bindCertificateList() {
  document.getElementById('certificateList').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.downloadCertificate) downloadIssuedCertificate(button.dataset.downloadCertificate);
    if (button.dataset.revokeCertificate) revokeIssuedCertificate(button.dataset.revokeCertificate).catch((error) => setNotice(error.message || String(error), 'error'));
    if (button.dataset.renewCertificate) renewIssuedCertificate(button.dataset.renewCertificate).catch((error) => setNotice(error.message || String(error), 'error'));
  });
  document.getElementById('certificateSearch').addEventListener('input', renderCertificates);
  document.getElementById('certificateSort').addEventListener('input', renderCertificates);
  document.getElementById('certificateSort').addEventListener('change', renderCertificates);
}

export function toggleCsrHelp() {
  updateCsrHelpCommands();
  const help = document.getElementById('csrHelp');
  const button = document.getElementById('csrHelpToggle');
  help.hidden = !help.hidden;
  button.innerHTML = help.hidden
    ? '<span class="nf">&#xf059;</span> Show CSR help'
    : '<span class="nf">&#xf059;</span> Hide CSR help';
}
