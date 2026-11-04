import test from 'node:test';
import assert from 'node:assert/strict';
import { updatePreferences, applyUpdatePreferences } from '../src/services/update-preferences.js';
test('update preferences preserve existing settings, reject invalid intervals, and never enable automatic installation', () => {
  const settings = { unrelated: 'preserved' };
  assert.equal(updatePreferences(settings).checkIntervalHours, 6);
  assert.throws(() => applyUpdatePreferences(settings, { channel:'stable', checkIntervalHours:0 }));
  assert.throws(() => applyUpdatePreferences(settings, { channel:'stable', notifications:'true' }));
  const result = applyUpdatePreferences(settings, { channel:'beta', automaticChecks:false, notifications:false, checkIntervalHours:24, automaticInstallation:true });
  assert.deepEqual(result, { channel:'beta', automaticChecks:false, notifications:false, checkIntervalHours:24, snapshotRetention:5, automaticInstallation:false });
  assert.equal(settings.unrelated, 'preserved');
});
