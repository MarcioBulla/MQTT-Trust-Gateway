import { isIP } from 'node:net';

function isPrivateAddress(address = '') {
  let value = String(address).toLowerCase().split('%')[0];
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);
  const version = isIP(value);
  if (version === 4) {
    const octets = value.split('.').map(Number);
    const [a, b] = octets;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (version !== 6) return false;
  return value === '::1' || value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value);
}

function hasForwardedHeaders(req) {
  return Boolean(
    req.headers['forwarded'] ||
      req.headers['x-forwarded-for'] ||
      req.headers['x-forwarded-host'] ||
      req.headers['x-forwarded-proto'],
  );
}

export function isTrustedMonitorRequest(req) {
  // Readiness is an internal probe. Forwarded traffic must be rejected even
  // when a proxy reports a private address; only the direct peer is trusted.
  if (hasForwardedHeaders(req)) return false;
  return isPrivateAddress(req.socket.remoteAddress);
}

function noStore(res) {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

export function registerHealthRoutes(app, { sqlite, updateReady = () => true, enqueue = (check) => check() }) {
  app.get('/health', (_req, res) => {
    noStore(res);
    res.status(200).json({ status: 'healthy' });
  });

  let pendingReadiness;
  app.get('/ready', async (req, res) => {
    noStore(res);
    if (!isTrustedMonitorRequest(req))
      return res.status(404).json({ status: 'unavailable' });
    try {
      // Exercise the same queue as the authenticated API and coalesce probes
      // so a stalled operation cannot leave an unbounded queue of checks.
      pendingReadiness ||= Promise.resolve()
        .then(() => enqueue(() => sqlite.prepare('SELECT id FROM state WHERE id = 1').get()))
        .finally(() => { pendingReadiness = undefined; });
      const row = await pendingReadiness;
      if (res.destroyed) return;
      if (!row) return res.status(503).json({ status: 'unavailable' });
      return res.status(200).json({ status: 'ready' });
    } catch {
      return res.status(503).json({ status: 'unavailable' });
    }
  });

  // Kept for the host updater's existing readiness gate.
  app.get('/healthz', (req, res) => {
    noStore(res);
    if (!isTrustedMonitorRequest(req))
      return res.status(404).json({ status: 'unavailable' });
    try {
      return res.status(200).json({ ok: true, updateReady: Boolean(updateReady()) });
    } catch {
      return res.status(503).json({ status: 'unavailable' });
    }
  });
}
