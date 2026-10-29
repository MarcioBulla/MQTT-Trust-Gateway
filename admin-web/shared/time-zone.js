export function normalizeTimeZone(value) {
  if (value === 'auto') return value;
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 100 ||
    !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)
  )
    throw new Error('Select a valid IANA time zone or Automatic');
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new Error('Select a valid IANA time zone or Automatic');
  }
}

export function timestampParts(value, timeZone = 'UTC') {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const fields = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  return {
    date: `${fields.day} ${fields.month} ${fields.year}`,
    time: `${fields.hour}:${fields.minute}:${fields.second}`,
    zone: fields.timeZoneName,
    iso: date.toISOString(),
  };
}
