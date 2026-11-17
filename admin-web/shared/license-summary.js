/** Effective status presented in Device Licenses. */
export function licenseStatus(certificate, now = Date.now()) {
  if (certificate.status !== 'active') return certificate.status;
  if (certificate.brokerTrusted === false) return 'untrusted';
  if (Date.parse(certificate.validTo) <= now) return 'expired';
  if (Date.parse(certificate.validTo) < now + 30 * 86400000) return 'expiring';
  return 'active';
}

/** Counts visible license records using the same effective statuses as Device Licenses. */
export function licenseSummary(certificates = [], now = Date.now()) {
  const visible = certificates.filter((certificate) => !certificate.licenseArchivedAt && !certificate.licenseDeletedAt);
  const statuses = visible.map((certificate) => licenseStatus(certificate, now));
  return {
    // A certificate remains active until its validity ends; Expiring is a subset.
    active: statuses.filter((status) => ['active', 'expiring'].includes(status)).length,
    expiring: statuses.filter((status) => status === 'expiring').length,
    expiredOrRevoked: statuses.filter((status) => ['expired', 'revoked', 'blocked'].includes(status)).length,
  };
}
