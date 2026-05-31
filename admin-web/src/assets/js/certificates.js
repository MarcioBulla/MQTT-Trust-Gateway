import { post } from './api.js';

export async function signCsr() {
  const data = await post('/api/certificates/sign', {
    deviceId: document.getElementById('deviceId').value,
    provisionerPassword: document.getElementById('provisionerPassword').value,
    csr: document.getElementById('csr').value,
  });
  document.getElementById('cert').textContent = data.certificate;
}
