import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmHealthTransitions } from '../src/services/device-health-transitions.js';

const at = (ms) => new Date(ms).toISOString();
test('replays are ignored and a live online message must remain stable', () => {
  const events = [{ at: at(1000), state: 'online', retainedReplay: true }, { at: at(2000), state: 'online' }];
  assert.equal(confirmHealthTransitions(events, { now: 6999 }).state, 'unknown');
  assert.deepEqual(confirmHealthTransitions(events, { now: 7000 }).confirmed, [{ state: 'online', at: at(7000) }]);
});
test('grace is cancelled by recovery and repeated status does not postpone confirmation', () => {
  const events = [
    { at: at(0), state: 'online' }, { at: at(10000), state: 'offline' },
    { at: at(20000), state: 'online' }, { at: at(30000), state: 'offline' },
    { at: at(35000), state: 'offline' },
  ];
  const result = confirmHealthTransitions(events, { now: 60000 });
  assert.deepEqual(result.confirmed, [{ state: 'online', at: at(5000) }, { state: 'offline', at: at(60000) }]);
});
test('monitor disconnect immediately marks unknown and cancels pending changes', () => {
  const events = [{ at: at(0), state: 'online' }, { at: at(1000), state: 'unknown' }];
  assert.equal(confirmHealthTransitions(events, { now: 10000 }).state, 'unknown');
  assert.deepEqual(confirmHealthTransitions(events, { now: 10000 }).confirmed, []);
});
