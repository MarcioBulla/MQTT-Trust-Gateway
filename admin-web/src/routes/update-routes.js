import { updatePreferences, applyUpdatePreferences } from '../services/update-preferences.js';
import { rateLimit, requireAuth } from '../auth.js';
import { audit, loadDb, saveDb } from '../db.js';
import { checkForGatewayUpdates, validateUpdateChannel } from '../services/system-updates.js';
import { updaterRequest, updaterStatus } from '../services/updater-client.js';
import { authenticationOperation, verifyReauthentication } from '../reauth.js';

export function registerUpdateRoutes(app) {
  app.get('/api/system-updates/progress', requireAuth(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await updaterStatus());
  }));
  app.get('/api/system-updates/history', requireAuth(async (req, res) => {
    const offset = Number(req.query.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) return res.status(400).json({ error: 'Invalid history offset' });
    res.set('Cache-Control', 'no-store');
    res.json(await updaterRequest('/history?offset=' + offset));
  }));
  for (const action of ['install', 'rollback']) {
    app.post(`/api/system-updates/${action}`, rateLimit, requireAuth(async (req, res) => {
      const db = loadDb(), user = db.users.find(item => item.id === req.user.id);
      const target = action === 'install' ? req.body.version : req.body.operationId;
      const operation = authenticationOperation(action === 'install' ? 'install-update' : 'rollback-update', target);
      if (action === 'install' && req.body.confirmation !== `INSTALL ${target}`)
        return res.status(400).json({ error: 'Explicit release installation confirmation is required' });
      await verifyReauthentication(req, db, user, operation);
      saveDb(db);
      audit(user.username, `system-updates.${action}.requested`, target);
      const result = await updaterRequest('/' + action, 'POST', action === 'install'
        ? { version: target } : { operationId: target, confirmation: req.body.confirmation });
      res.set('Cache-Control', 'no-store');
      res.status(202).json(result);
    }));
  }

  app.get('/api/system-updates/status', requireAuth(async (req, res) => {
    const channel = req.query.channel || 'stable';
    if (!validateUpdateChannel(channel)) return res.status(400).json({ error: 'Channel must be stable or beta' });
    res.set('Cache-Control', 'no-store');
    res.json({ ...await checkForGatewayUpdates({ channel, cachedOnly: req.query.cached === '1' || !updatePreferences(loadDb().settings).automaticChecks }), controller: await updaterStatus() });
  }));
  app.post('/api/system-updates/check', rateLimit, requireAuth(async (req, res) => {
    const channel = req.body.channel || 'stable';
    if (!validateUpdateChannel(channel)) return res.status(400).json({ error: 'Channel must be stable or beta' });
    res.set('Cache-Control', 'no-store');
    res.json(await checkForGatewayUpdates({ channel, force: true }));
  }));
  app.get('/api/system-updates/config', requireAuth((_req, res) => {
    const db = loadDb();
    res.set('Cache-Control', 'no-store');
    res.json(updatePreferences(db.settings));
  }));
  app.patch('/api/system-updates/config', requireAuth((req, res) => {
    const db = loadDb();
    const preferences = applyUpdatePreferences(db.settings, req.body);
    saveDb(db);
    audit(req.user.username, 'system-updates.preferences.changed', preferences.channel);
    res.set('Cache-Control', 'no-store');
    res.json(preferences);
  }));
}
