// Derive confirmed status without altering the original MQTT observations.
// Retained replays are not evidence that a device is currently connected.
export function confirmHealthTransitions(observations, { now = Date.now(), offlineGraceMs = 30000, recoveryStabilityMs = 5000 } = {}) {
  if (![now, offlineGraceMs, recoveryStabilityMs].every(Number.isFinite) || offlineGraceMs < 0 || recoveryStabilityMs < 0)
    throw new Error('Invalid health timing');
  const events = observations.map((event, order) => ({ ...event, time: Date.parse(event.at), order }))
    .filter((event) => Number.isFinite(event.time) && event.time <= now)
    .sort((a, b) => a.time - b.time || a.order - b.order);
  let state = 'unknown';
  let pending = null;
  const confirmed = [];
  const commit = (newState, time) => {
    if (newState !== state) {
      state = newState;
      confirmed.push({ state, at: new Date(time).toISOString() });
    }
  };
  const advance = (time) => {
    if (pending && pending.until <= time) {
      commit(pending.state, pending.until);
      pending = null;
    }
  };
  for (const event of events) {
    advance(event.time);
    if (event.retainedReplay) continue;
    if (event.state === 'unknown' || event.state === 'disabled') {
      pending = null;
      commit(event.state, event.time);
      continue;
    }
    if (event.state !== 'online' && event.state !== 'offline') continue;
    if (event.state === state) { pending = null; continue; }
    if (pending?.state === event.state) continue;
    pending = { state: event.state, until: event.time + (event.state === 'online' ? recoveryStabilityMs : offlineGraceMs) };
    advance(event.time);
  }
  advance(now);
  return { state, pending, confirmed };
}
