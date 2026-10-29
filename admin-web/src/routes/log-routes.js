import { hasSensitiveGrant } from '../sensitive-access.js';
import { requireAuth, currentUser } from '../auth.js';
import { logSnapshot } from '../services/runtime-logs.js';

const connections = new Map();
export function registerLogRoutes(app) {
  app.get('/api/logs/events', requireAuth(async (req, res) => {
    const source = String(req.query.source || 'admin');
    if (!['admin', 'broker'].includes(source)) return res.status(400).json({ error: 'Unknown log source' });
    const key = req.user.id;
    if ((connections.get(key) || 0) >= 4) return res.status(429).json({ error: 'Too many log streams' });
    connections.set(key, (connections.get(key) || 0) + 1);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    let closed = false, busy = false, previous = null;
    const timer = setInterval(poll, 1000);
    function close() {
      if (closed) return;
      closed = true; clearInterval(timer);
      const count = (connections.get(key) || 1) - 1;
      if (count) connections.set(key, count); else connections.delete(key);
    }
    req.on('close', close);
    res.on('close', close);
    async function poll() {
      if (closed || busy) return;
      busy = true;
      try {
        if (!currentUser(req) || !hasSensitiveGrant(req, 'audit') || res.writableLength > 128 * 1024) return res.end();
        const snapshot = await logSnapshot(source);
        if (closed || !hasSensitiveGrant(req, 'audit')) return res.end();
        if (snapshot.version !== previous) {
          res.write(`event: logs\ndata: ${JSON.stringify(snapshot)}\n\n`);
          previous = snapshot.version;
        } else res.write(': heartbeat\n\n');
      } catch {
        if (!closed) { res.write('event: log-error\ndata: {"error":"Log source is unavailable"}\n\n'); res.end(); }
      } finally { busy = false; }
    }
    await poll();
  }));
}
