import { test } from 'node:test';
import assert from 'node:assert/strict';
import { licenseStatusLabel, visibleLicenseRows, mergeLicenseLabels } from '../frontend/license-rows.js';

test('deleted licenses remain visible in their own tab and have a Deleted label', () => {
  const certificates = [
    { id: 'active', status: 'active' },
    { id: 'archived', status: 'revoked', licenseArchivedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'deleted', status: 'revoked', licenseArchivedAt: '2026-01-02T00:00:00.000Z', licenseDeletedAt: '2026-01-03T00:00:00.000Z' },
  ];
  assert.deepEqual(visibleLicenseRows(certificates, 'active').map((row) => row.id), ['active']);
  assert.deepEqual(visibleLicenseRows(certificates, 'archived').map((row) => row.id), ['archived']);
  const deleted = visibleLicenseRows(certificates, 'deleted');
  assert.deepEqual(deleted.map((row) => row.id), ['deleted']);
  assert.equal(licenseStatusLabel(deleted[0]), 'Deleted');
  assert.deepEqual(visibleLicenseRows(certificates, 'deleted', 'deleted'), deleted);
});

test('Trusted device labels are inherited by licenses but license labels remain independent', () => {
  const identity = [{ name: 'Field', color: 'teal' }];
  const license = [{ name: 'Calibration', color: 'purple' }];
  assert.deepEqual(mergeLicenseLabels(identity, license), [...identity, ...license]);
  assert.deepEqual(identity, [{ name: 'Field', color: 'teal' }]);
  assert.deepEqual(mergeLicenseLabels(identity, [{ name: 'field', color: 'red' }]), identity);
});
