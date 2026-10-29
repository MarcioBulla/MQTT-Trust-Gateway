import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messagesPerMinute, chartMessageRate } from '../shared/traffic-rate.js';
test('chart rate converts real interval counts into messages per minute without converting gaps into zeros', () => {
  assert.equal(messagesPerMinute(120, 3600), 2);
  assert.equal(messagesPerMinute(30, 60), 30);
  assert.equal(messagesPerMinute(1, 3600), 1/60);
  assert.equal(messagesPerMinute(0), 0);
  assert.equal(messagesPerMinute(null), null);
  assert.equal(messagesPerMinute(10, 0), null);
});

test('chart unit preferences convert counts consistently and preserve gaps', () => {
 assert.equal(chartMessageRate(120,3600,'minute'),2);
 assert.equal(chartMessageRate(120,3600,'hour'),120);
 assert.equal(chartMessageRate(null,3600,'hour'),null);
 assert.equal(chartMessageRate(120,3600,'invalid'),null);
});
