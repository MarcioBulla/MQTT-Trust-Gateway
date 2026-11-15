// Events describe confirmed states. Time without an observed state is unknown.
export function calculateDeviceUptime(events, now = Date.now(), days = 30) {
  const dayMs = 86400000;
  const end = Number(now);
  if (!Number.isFinite(end) || !Number.isInteger(days) || days < 1 || days > 366)
    throw new Error('Invalid uptime interval');
  const startOfToday = Math.floor(end / dayMs) * dayMs;
  const start = startOfToday - (days - 1) * dayMs;
  const transitions = events.map((event) => ({ at: Date.parse(event.at), state: String(event.state).toLowerCase() }))
    .filter((event) => Number.isFinite(event.at) && ['online', 'offline', 'unknown', 'disabled'].includes(event.state) && event.at <= end)
    .sort((a, b) => a.at - b.at);
  let state = 'unknown';
  let index = 0;
  while (index < transitions.length && transitions[index].at <= start) state = transitions[index++].state;
  const result = [];
  let totalOnline = 0;
  let totalOffline = 0;
  let totalUnknown = 0;
  for (let day = start; day <= startOfToday; day += dayMs) {
    const dayEnd = Math.min(day + dayMs, end);
    const totals = { online: 0, offline: 0, unknown: 0 };
    let cursor = day;
    while (index < transitions.length && transitions[index].at < dayEnd) {
      const event = transitions[index++];
      totals[state === 'online' || state === 'offline' ? state : 'unknown'] += Math.max(0, event.at - cursor);
      cursor = Math.max(cursor, event.at);
      state = event.state;
    }
    totals[state === 'online' || state === 'offline' ? state : 'unknown'] += Math.max(0, dayEnd - cursor);
    const known = totals.online + totals.offline;
    totalOnline += totals.online;
    totalOffline += totals.offline;
    totalUnknown += totals.unknown;
    result.push({ date: new Date(day).toISOString().slice(0, 10), ...totals, uptime: known ? 100 * totals.online / known : null, complete: dayEnd - day === dayMs && totals.unknown === 0 });
  }
  const observed = totalOnline + totalOffline;
  return { days: result, online: totalOnline, offline: totalOffline, unknown: totalUnknown, uptime: observed ? 100 * totalOnline / observed : null };
}
