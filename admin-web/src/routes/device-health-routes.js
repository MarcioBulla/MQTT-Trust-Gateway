import { requireAuth } from '../auth.js';
import { requireSensitive } from '../sensitive-access.js';
import { loadDb, saveDb, audit } from '../db.js';
import { stageBroker } from '../services/certificate-service.js';
import { validateDeviceHealthConfig } from '../services/device-health-config.js';
import { getDeviceHealthStore, resetDeviceHealth, suspendDeviceHealth, resumeDeviceHealth } from '../services/device-health-monitor.js';
import { calculateDeviceUptime } from '../services/device-uptime.js';

const defaultConfig = (device) => ({ enabled: false, topic: `gateway/health/${device.id}/status`, onlinePayload: 'online', offlinePayload: 'offline', readers: [], offlineGrace: 30, recoveryStability: 5 });
const configFor = (device) => ({ ...defaultConfig(device), ...(device.healthCheck || {}) });
const readerCandidates = (db, ownerId) => db.devices.filter((device) => device.id !== ownerId && device.status === 'active' && device.enabled && device.trusted !== false)
  .map((device) => ({ id: device.id, label: `${device.name || device.id} (${device.id})` })).sort((a, b) => a.label.localeCompare(b.label));
function summary(device, now) {
  if (!device.healthCheck?.enabled) return { status: 'disabled', uptime: null, days: [] };
  const store = getDeviceHealthStore(), from = Math.floor(now / 86400000) * 86400000 - 29 * 86400000;
  const timeline = store.read(device.id, 'confirmed', from, now);
  const totals = calculateDeviceUptime(timeline, now);
  return { status: store.last(device.id, 'confirmed')?.state || 'unknown', ...totals };
}
export function registerDeviceHealthRoutes(app) {
  app.get('/api/device-health/summary', requireAuth((_req, res) => {
    const now = Date.now();
    res.json({ devices: Object.fromEntries(loadDb().devices.map((d) => [d.id, summary(d, now)])) });
  }));
  app.get('/api/devices/:id/health', requireAuth((req, res) => {
    if (!requireSensitive(req, res, 'devices')) return;
    const device = loadDb().devices.find((d) => d.id === req.params.id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    res.json({ config: configFor(device), readerCandidates: readerCandidates(loadDb(), device.id), ...summary(device, Date.now()) });
  }));
  app.put('/api/devices/:id/health', requireAuth(async (req, res) => {
    if (!requireSensitive(req, res, 'devices')) return;
    const db = loadDb(), device = db.devices.find((d) => d.id === req.params.id);
    if (!device || device.status !== 'active') return res.status(404).json({ error: 'Active device not found' });
    let config;
    try { config = validateDeviceHealthConfig(req.body, device, db.devices); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const previous = device.healthCheck;
    suspendDeviceHealth({ ...device, healthCheck: previous || config });
    device.healthCheck = config;
    saveDb(db);
    try { await stageBroker(); }
    catch (error) { device.healthCheck = previous; saveDb(db); resumeDeviceHealth(device.id); throw error; }
    resetDeviceHealth(device, config.enabled);
    resumeDeviceHealth(device.id);
    audit(req.user.username, 'device.health_updated', device.id);
    res.json({ config, readerCandidates: readerCandidates(db, device.id), ...summary(device, Date.now()), message: 'Apply pending broker changes before monitoring.' });
  }));
}
