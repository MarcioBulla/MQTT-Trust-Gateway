import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSensitiveGrants } from '../src/sensitive-grants.js';

test('reveal grants expire with a controlled clock and bind user, session and exact scope', () => {
  let clock = 1000;
  const grants = createSensitiveGrants({ now: () => clock });
  const owner = { userId: 'admin', sessionId: 'session', scope: 'infrastructure' };
  const { token, expiresAt } = grants.issue(owner);
  assert.equal(expiresAt, 61000);
  assert.equal(grants.allows(undefined, owner), false);
  assert.equal(grants.allows(token, owner), true);
  for (const key of ['userId', 'sessionId', 'scope'])
    assert.equal(grants.allows(token, { ...owner, [key]: 'other' }), false);
  clock = 60999;
  assert.equal(grants.allows(token, owner), true);
  clock = 61000;
  assert.equal(grants.allows(token, owner), false);
  assert.equal(createSensitiveGrants().allows(token, owner), false);
});

test('manual and session revocation are immediate and do not revoke other sessions', () => {
  const grants = createSensitiveGrants();
  const owner = { userId: 'admin', sessionId: 'one', scope: 'devices' };
  const first = grants.issue(owner);
  grants.revoke(first.token);
  assert.equal(grants.allows(first.token, owner), false);
  const next = grants.issue(owner);
  const other = { ...owner, sessionId: 'two' };
  const unaffected = grants.issue(other);
  grants.revokeSession('one');
  assert.equal(grants.allows(next.token, owner), false);
  assert.equal(grants.allows(unaffected.token, other), true);
  assert.throws(() => createSensitiveGrants({ ttlMs: 600001 }));
});
