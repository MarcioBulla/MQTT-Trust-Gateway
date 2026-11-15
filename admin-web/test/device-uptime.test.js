import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateDeviceUptime } from '../src/services/device-uptime.js';

test('uptime separates unknown time and splits transitions at UTC day boundaries', () => {
  const result = calculateDeviceUptime([
    { at: '2026-01-01T12:00:00Z', state: 'online' },
    { at: '2026-01-02T06:00:00Z', state: 'offline' },
    { at: '2026-01-02T12:00:00Z', state: 'unknown' },
  ], Date.parse('2026-01-03T00:00:00Z'), 3);
  assert.deepEqual(result.days.map((day) => [day.online, day.offline, day.unknown]), [
    [43200000, 0, 43200000], [21600000, 21600000, 43200000], [0, 0, 0],
  ]);
  assert.equal(result.uptime, 75);
  assert.equal(result.days[0].complete, false);
});

test('a state before the window establishes full coverage and disabled is unknown', () => {
  const result = calculateDeviceUptime([
    { at: '2025-12-31T00:00:00Z', state: 'offline' },
    { at: '2026-01-02T12:00:00Z', state: 'disabled' },
  ], Date.parse('2026-01-02T18:00:00Z'), 2);
  assert.equal(result.days[0].complete, true);
  assert.equal(result.days[0].uptime, 0);
  assert.equal(result.days[1].unknown, 21600000);
});

test('the default 30-day window has 30 UTC bars and excludes time before first observation', () => {
  const now = Date.parse('2026-03-30T18:00:00Z');
  const start = Date.parse('2026-03-01T00:00:00Z');
  const result = calculateDeviceUptime([{ at: new Date(start).toISOString(), state: 'online' }], now);
  assert.equal(result.days.length, 30);
  assert.equal(result.days[0].date, '2026-03-01');
  assert.equal(result.days.at(-1).date, '2026-03-30');
  assert.equal(result.days.slice(0, -1).every((day) => day.complete && day.uptime === 100), true);
  assert.equal(result.days.at(-1).complete, false);
  assert.equal(result.uptime, 100);
});

test('out-of-order transitions are sorted, future events ignored, and invalid windows rejected', () => {
  const result = calculateDeviceUptime([
    { at: '2026-02-01T12:00:00Z', state: 'offline' },
    { at: '2026-02-01T00:00:00Z', state: 'online' },
    { at: '2026-02-02T00:00:00Z', state: 'offline' },
  ], Date.parse('2026-02-01T18:00:00Z'), 1);
  assert.equal(result.days.length, 1);
  assert.equal(result.days[0].online, 43200000);
  assert.equal(result.days[0].offline, 21600000);
  assert.equal(result.uptime, 200 / 3);
  for (const [now, days] of [[NaN, 1], [0, 0], [0, 367], [0, 1.5]])
    assert.throws(() => calculateDeviceUptime([], now, days), /Invalid uptime interval/);
});
