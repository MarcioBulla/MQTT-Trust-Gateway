import test from 'node:test';
import assert from 'node:assert/strict';
import { licenseStatus, licenseSummary } from '../shared/license-summary.js';

test('license summary matches Device Licenses, counts expiring licenses as active, and excludes archived/deleted records', () => {
  const now = Date.parse('2026-11-17T00:00:00Z');
  const summary = licenseSummary([
    { status: 'active', validTo: '2027-01-01T00:00:00Z' },
    { status: 'active', validTo: '2026-11-20T00:00:00Z' },
    { status: 'expired' },
    { status: 'revoked' },
    { status: 'blocked' },
    { status: 'expired', licenseArchivedAt: '2026-01-01T00:00:00Z' },
    { status: 'revoked', licenseDeletedAt: '2026-01-01T00:00:00Z' },
    { status: 'untrusted' },
  ], now);
  assert.deepEqual(summary, { active: 2, expiring: 1, expiredOrRevoked: 3 });
});

test('certificate list and summary share the same effective expiry and trust status', () => {
  const now = Date.parse('2026-11-17T00:00:00Z');
  assert.equal(licenseStatus({ status: 'active', validTo: '2026-11-20T00:00:00Z' }, now), 'expiring');
  assert.equal(licenseStatus({ status: 'active', validTo: '2027-01-01T00:00:00Z', brokerTrusted: false }, now), 'untrusted');
});
