export function messagesPerMinute(count, intervalSeconds = 3600) {
  if (count == null) return null;
  if (!Number.isFinite(count) || count < 0 || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return null;
  return count * 60 / intervalSeconds;
}

export function chartMessageRate(count, intervalSeconds = 3600, unit = 'minute') {
  const rate = messagesPerMinute(count, intervalSeconds);
  if (rate === null || !['minute', 'hour'].includes(unit)) return null;
  return unit === 'hour' ? rate * 60 : rate;
}
