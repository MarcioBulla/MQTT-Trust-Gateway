export function visibleLicenseRows(certificates, tab = 'active', statusFilter = 'All') {
  return certificates
    .filter((certificate) => tab === 'deleted'
      ? Boolean(certificate.licenseDeletedAt)
      : tab === 'archived'
        ? Boolean(certificate.licenseArchivedAt) && !certificate.licenseDeletedAt
        : !certificate.licenseArchivedAt && !certificate.licenseDeletedAt)
    .filter((certificate) => statusFilter === 'All'
      || (statusFilter === 'deleted'
        ? Boolean(certificate.licenseDeletedAt)
        : !certificate.licenseDeletedAt && certificate.status === statusFilter));
}

export function licenseStatusLabel(certificate) {
  return certificate.licenseDeletedAt ? 'Deleted' : certificate.status;
}

export function mergeLicenseLabels(deviceLabels = [], licenseLabels = []) {
  const unique = new Map();
  for (const label of [...deviceLabels, ...licenseLabels]) {
    const value = typeof label === 'string' ? { name: label, color: 'primary' } : label;
    const name = String(value?.name || '').trim();
    if (name && !unique.has(name.toLocaleLowerCase())) unique.set(name.toLocaleLowerCase(), { ...value, name });
  }
  return [...unique.values()];
}
