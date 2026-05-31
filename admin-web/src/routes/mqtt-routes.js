import { requireAuth } from '../auth.js';
import { listTopics, publishMessage, topicMessages } from '../services/mqtt-service.js';

export function registerMqttRoutes(app) {
  app.get('/api/mqtt/topics', requireAuth(async (_req, res) => {
    res.json({ topics: await listTopics() });
  }));

  app.get('/api/mqtt/messages', requireAuth(async (req, res) => {
    const topic = String(req.query.topic || '').trim();
    if (!topic) return res.status(400).json({ error: 'topic is required' });
    res.json({ topic, messages: await topicMessages(topic) });
  }));

  app.post('/api/mqtt/publish', requireAuth(async (req, res) => {
    const topic = String(req.body.topic || '').trim();
    const payload = String(req.body.payload || '');
    const qos = Number(req.body.qos || 0);
    const retain = Boolean(req.body.retain);
    if (!topic || topic.includes('#') || topic.includes('+')) return res.status(400).json({ error: 'publish topic must not contain wildcards' });
    if (![0, 1, 2].includes(qos)) return res.status(400).json({ error: 'invalid qos' });
    await publishMessage({ topic, payload, qos, retain });
    res.json({ ok: true });
  }));
}
