export const env = {
  host: process.env.ADMIN_APP_HOST || '127.0.0.1',
  port: Number(process.env.ADMIN_APP_PORT || 8080),
  rpName: process.env.ADMIN_RP_NAME || 'MQTT Trust Gateway',
  rpID: process.env.ADMIN_RP_ID || process.env.MQTT_DOMAIN,
  origin: process.env.ADMIN_ORIGIN || `https://${process.env.MQTT_DOMAIN}`,
  setupToken: process.env.ADMIN_SETUP_TOKEN || '',
  sessionSecret: process.env.ADMIN_SESSION_SECRET || '',
  dataDir: process.env.ADMIN_DATA_DIR || '/data',
  mqttDomain: process.env.MQTT_DOMAIN || '',
  topicPrefix: process.env.MQTT_TOPIC_PREFIX || 'devices',
  mqttTlsPort: Number(process.env.MQTT_TLS_PORT || 8883),
  adminMqttClientId: process.env.ADMIN_MQTT_CLIENT_ID || 'mqtt-trust-admin',
  adminMqttCertFile: process.env.ADMIN_MQTT_CERT_FILE || '/data/mqtt-client.crt',
  adminMqttKeyFile: process.env.ADMIN_MQTT_KEY_FILE || '/data/mqtt-client.key',
  stepCaUrl: process.env.STEP_CA_URL || '',
  stepCaProvisioner: process.env.STEP_CA_PROVISIONER || '',
  stepCaTtl: process.env.STEP_CA_DEVICE_CERT_TTL || '17520h',
  clientCaFile: process.env.ADMIN_CLIENT_CA_FILE || '/broker-pki/step-ca/ca.crt',
  letsencryptDir: process.env.ADMIN_LETSENCRYPT_DIR || '/etc/letsencrypt',
};

if (!env.rpID || !env.sessionSecret) {
  throw new Error('ADMIN_RP_ID/MQTT_DOMAIN and ADMIN_SESSION_SECRET are required');
}
