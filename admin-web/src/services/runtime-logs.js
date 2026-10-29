import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { format } from 'node:util';
import { env } from '../config.js';

export const LOG_LIMIT = 1024 * 1024;
export const LOG_TAIL_BYTES = 64 * 1024;
const files = {
  admin: path.join(env.dataDir, 'logs', 'admin.log'),
  broker: path.join(env.brokerDir, 'logs', 'mosquitto.log'),
};
function sanitize(value) {
  return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/((?:authorization|cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/((?:password|secret|token|authorization|cookie|privateKey)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 8192);
}
export function appendAdminLog(level, ...args) {
  const file = files.admin;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${sanitize(format(...args))}\n`;
  if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > LOG_LIMIT) {
    fs.renameSync(file, `${file}.1`);
  }
  fs.appendFileSync(file, line, { mode: 0o600 });
}
let installed = false;
export function captureAdminLogs() {
  if (installed) return;
  installed = true;
  process.on('warning', (warning) => { try { appendAdminLog('warn', warning.message); } catch { /* stdout still receives Node warnings. */ } });
  process.on('uncaughtExceptionMonitor', (error) => { try { appendAdminLog('error', error.stack || error.message); } catch { /* Preserve default fatal error reporting. */ } });
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      try { appendAdminLog(level, ...args); } catch { /* Keep stdout available if storage fails. */ }
      original(...args);
    };
  }
}
export async function logSnapshot(source) {
  if (!Object.hasOwn(files, source)) throw Object.assign(new Error('Unknown log source'), { status: 400 });
  let handle;
  try {
    handle = await fsp.open(files[source], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Log source is not a regular file');
    const size = Math.min(stat.size, LOG_TAIL_BYTES), offset = stat.size - size;
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, offset);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (offset) text = text.slice(text.indexOf('\n') + 1);
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return { source, available: true, text: lines.slice(-500).join('\n'), version: `${stat.ino}:${stat.size}:${stat.mtimeMs}` };
  } catch (error) {
    if (error.code === 'ENOENT') return { source, available: false, text: '', version: 'missing' };
    throw error;
  } finally { await handle?.close(); }
}
