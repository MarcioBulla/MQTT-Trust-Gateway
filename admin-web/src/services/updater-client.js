import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
export const updaterDirectory = () => process.env.GATEWAY_UPDATER_DIR || '';
export const updateMaintenance = () => fs.existsSync('/tmp/gateway-updater-enabling') || Boolean(updaterDirectory() && fs.existsSync(path.join(updaterDirectory(), 'maintenance.json')));
export function updaterRequest(endpoint, method = 'GET', body) {
  if (!['/status', '/install', '/rollback'].includes(endpoint) && !/^\/history\?offset=\d{1,7}$/.test(endpoint)) throw new Error('Invalid updater operation');
  const directory = updaterDirectory();
  if (!directory) return Promise.reject(Object.assign(new Error('Host updater is not enabled'), { status: 503 }));
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({ socketPath: path.join(directory, 'control.sock'), path: endpoint, method, timeout: 5000,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; if (text.length > 256_000) request.destroy(new Error('Updater response too large')); });
      response.on('end', () => {
        try {
          const data = JSON.parse(text);
          if (response.statusCode >= 400) return reject(Object.assign(new Error(data.error || 'Updater operation failed'), { status: response.statusCode }));
          resolve(data);
        } catch { reject(Object.assign(new Error('Invalid updater response'), { status: 503 })); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Updater timeout')));
    request.on('error', () => reject(Object.assign(new Error('Host updater is unavailable; inspect its user service'), { status: 503 })));
    request.end(payload);
  });
}
export async function updaterStatus() {
  try { return await updaterRequest('/status'); }
  catch { return { available: false, operation: null, history: [], canRollback: false, maintenance: updateMaintenance() }; }
}
