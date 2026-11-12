import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldHideOnWindowInactive } from '../frontend/sensitive-policy.js';

test('window inactivity hides by default and follows the administrator preference', () => {
  assert.equal(shouldHideOnWindowInactive(undefined), true);
  assert.equal(shouldHideOnWindowInactive({}), true);
  assert.equal(shouldHideOnWindowInactive({ hideOnWindowBlur: true }), true);
  assert.equal(shouldHideOnWindowInactive({ hideOnWindowBlur: false }), false);
});
