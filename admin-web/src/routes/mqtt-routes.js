import { hasSensitiveGrant } from '../sensitive-access.js';
import { requireAuth, currentUser } from '../auth.js';
import { audit, loadDb, saveDb } from '../db.js';
import {
  events,
  mqttHistory,
  clearHistory,
  subscribe,
  publishMessage,
} from '../services/mqtt-service.js';
export function messageMetadata(message) {
  const { id, timestamp, qos, retain, bytes } = message;
  return { id, timestamp, qos, retain, bytes };
}
export function registerMqttRoutes(app) {
  app.get(
    '/api/mqtt/history',
    requireAuth((req, res) => {
      const history = mqttHistory();
      res.set('Cache-Control', 'no-store').json(hasSensitiveGrant(req, 'mqtt') ? history : { ...history, messages: history.messages.map(messageMetadata), retained: [], subscriptions: [] });
    }),
  );
  app.get(
    '/api/mqtt/events',
    requireAuth((req, res) => {
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      let blocked = false;
      const listener = (message) => {
        if (!currentUser(req)) return res.end();
        const visible = hasSensitiveGrant(req, 'mqtt') ? message : messageMetadata(message);
        if (!blocked) blocked = !res.write(`data: ${JSON.stringify(visible)}\n\n`);
      };
      res.on('drain', () => {
        blocked = false;
      });
      events.on('message', listener);
      const timer = setInterval(() => {
        if (!currentUser(req)) return res.end();
        res.write(': heartbeat\n\n');
      }, 15000);
      req.on('close', () => {
        events.off('message', listener);
        clearInterval(timer);
      });
    }),
  );
  app.post(
    '/api/mqtt/subscribe',
    requireAuth(async (req, res) => {
      await subscribe(req.body.filter);
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/mqtt/publish',
    requireAuth(async (req, res) => {
      await publishMessage(req.body);
      audit(req.user.username, 'mqtt.publish', req.body.topic);
      res.json({ ok: true });
    }),
  );
  app.delete(
    '/api/mqtt/retained',
    requireAuth(async (req, res) => {
      if (req.body.confirm !== req.body.topic)
        return res.status(400).json({ error: 'Confirm the exact topic' });
      await publishMessage({ topic: req.body.topic, payload: '', retain: true, qos: 1 });
      audit(req.user.username, 'mqtt.retained.deleted', req.body.topic);
      res.json({ ok: true });
    }),
  );
  app.delete(
    '/api/mqtt/history',
    requireAuth((_req, res) => {
      clearHistory();
      res.json({ ok: true });
    }),
  );
  app.patch(
    '/api/mqtt/settings',
    requireAuth((req, res) => {
      const limit = Number(req.body.historyLimit);
      if (!Number.isInteger(limit) || limit < 10 || limit > 2000)
        return res.status(400).json({ error: 'History limit must be 10–2000' });
      const db = loadDb();
      db.settings.historyLimit = limit;
      saveDb(db);
      audit(req.user.username, 'mqtt.settings', limit);
      res.json({ ok: true });
    }),
  );
}
