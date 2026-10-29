import path from 'node:path';
import { parseBrokerExtraSans } from './broker-sans.js';
function integer(name, fallback, min = 1, max = 65535) {
  const n = Number(process.env[name] || fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
}
const dataDir = process.env.ADMIN_DATA_DIR || '/data';
const origin = process.env.PUBLIC_URL || 'http://localhost:8080';
const url = new URL(origin);
if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
  throw new Error('PUBLIC_URL must be an HTTP(S) origin without a trailing slash');
export const env = {
  host: process.env.ADMIN_APP_HOST || '0.0.0.0',
  port: integer('ADMIN_APP_PORT', 8080),
  dataDir,
  caDir: process.env.CA_DIR || path.join(dataDir, 'ca'),
  brokerDir: process.env.BROKER_CONFIG_DIR || '/broker',
  rpName: 'MQTT Trust Gateway',
  rpID: url.hostname,
  origin,
  allowedOrigins: [
    ...new Set([origin, ...(process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean)]),
  ],
  trustedProxies: (process.env.TRUSTED_PROXIES || '').split(',').filter(Boolean),
  tlsCert: process.env.ADMIN_TLS_CERT || '',
  tlsKey: process.env.ADMIN_TLS_KEY || '',
  mqttHost: process.env.MQTT_HOST || 'mqtt-broker',
  brokerExtraSans: parseBrokerExtraSans(process.env.MQTT_BROKER_EXTRA_SANS),
  hostname: process.env.GATEWAY_HOSTNAME || 'localhost',
  domain: process.env.GATEWAY_DOMAIN || '',
  localAddress: process.env.LOCAL_ADDRESS || 'localhost',
  publicIP: process.env.PUBLIC_IP || '',
  mqttTlsPort: integer('MQTT_TLS_PORT', 8883),
  mqttWsPort: integer('MQTT_WS_PORT', 8443),
  topicPrefix: process.env.MQTT_TOPIC_PREFIX || 'devices',
  adminMqttClientId: 'mqtt-trust-admin',
  certDays: integer('CERT_DEFAULT_DAYS', 90, 1, 3650),
  maxCertDays: integer('CERT_MAX_DAYS', 365, 1, 3650),
  caName: process.env.CA_COMMON_NAME || 'MQTT Trust Gateway CA',
  caDays: integer('CA_VALIDITY_DAYS', 3650, 2, 7300),
  sessionHours: integer('SESSION_HOURS', 12, 1, 168),
  sensitiveRevealSeconds: integer('SENSITIVE_REVEAL_SECONDS', 60, 1, 300),
  historyLimit: integer('MQTT_HISTORY_LIMIT', 200, 10, 2000),
  retainedEnabled: process.env.MQTT_RETAIN_ENABLED !== 'false',
  auditDays: integer('AUDIT_RETENTION_DAYS', 90, 1, 3650),
};
if (!/^[A-Za-z0-9._-]+$/.test(env.topicPrefix)) throw new Error('Invalid MQTT_TOPIC_PREFIX');
if (!/^[A-Za-z0-9 ._-]{1,100}$/.test(env.caName)) throw new Error('Invalid CA_COMMON_NAME');
if (env.certDays > env.maxCertDays) throw new Error('Default certificate validity exceeds maximum');
