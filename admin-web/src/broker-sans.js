import { isIP } from 'node:net';

// DNS names only: no OpenSSL extension syntax, URLs, wildcards, ports or IPs.
export function parseBrokerExtraSans(value = '') {
  if (!String(value).trim()) return [];
  const names = String(value)
    .split(',')
    .map((name) => name.trim().toLowerCase().replace(/\.$/, ''));
  for (const name of names) {
    if (
      !name ||
      name.length > 253 ||
      isIP(name) ||
      !name.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ) {
      throw new Error(
        'Invalid MQTT_BROKER_EXTRA_SANS: use comma-separated DNS names (ASCII or punycode)',
      );
    }
  }
  return [...new Set(names)];
}
