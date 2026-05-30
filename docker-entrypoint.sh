#!/bin/sh
set -eu

: "${MQTT_DOMAIN:?MQTT_DOMAIN is required}"
: "${MQTT_TOPIC_PREFIX:=devices}"
: "${MQTT_TLS_PORT:=8883}"
: "${MQTT_WS_TLS_PORT:=8443}"

CERT_DIR="/etc/letsencrypt/live/${MQTT_DOMAIN}"
CONFIG_FILE="/mosquitto/config/mosquitto.conf"
ACL_FILE="/mosquitto/config/mosquitto.acl"
MOSQUITTO_CERT_DIR="/mosquitto/config/certs"
FULLCHAIN_FILE="${MOSQUITTO_CERT_DIR}/fullchain.pem"
PRIVKEY_FILE="${MOSQUITTO_CERT_DIR}/privkey.pem"
CLIENT_CA_SOURCE="/broker-pki/step-ca/ca.crt"
CLIENT_CA_FILE="${MOSQUITTO_CERT_DIR}/client-ca.crt"

if [ ! -f "${CERT_DIR}/fullchain.pem" ] || [ ! -f "${CERT_DIR}/privkey.pem" ]; then
  echo "Missing certificate files in ${CERT_DIR}" >&2
  exit 1
fi

if [ ! -f "${CLIENT_CA_SOURCE}" ]; then
  echo "Missing client CA certificate in ${CLIENT_CA_SOURCE}" >&2
  echo "Run setup-wizard.sh with step-ca bootstrap before starting the broker" >&2
  exit 1
fi

mkdir -p /mosquitto/config /mosquitto/data "${MOSQUITTO_CERT_DIR}"

cp "${CERT_DIR}/fullchain.pem" "${FULLCHAIN_FILE}"
cp "${CERT_DIR}/privkey.pem" "${PRIVKEY_FILE}"
cp "${CLIENT_CA_SOURCE}" "${CLIENT_CA_FILE}"
chown -R mosquitto:mosquitto "${MOSQUITTO_CERT_DIR}"
chmod 640 "${FULLCHAIN_FILE}" "${PRIVKEY_FILE}" "${CLIENT_CA_FILE}"

cat > "${ACL_FILE}" <<EOF
pattern readwrite %u/#
pattern readwrite ${MQTT_TOPIC_PREFIX}/%u/#
EOF

chown mosquitto:mosquitto "${ACL_FILE}"
chmod 0700 "${ACL_FILE}"
chown mosquitto:mosquitto /mosquitto/data

cat > "${CONFIG_FILE}" <<EOF
persistence true
persistence_location /mosquitto/data/

log_dest stdout
log_type error
log_type warning
log_type notice
log_type information
connection_messages true
user mosquitto
allow_anonymous false
acl_file ${ACL_FILE}

listener ${MQTT_TLS_PORT}
protocol mqtt
cafile ${CLIENT_CA_FILE}
certfile ${FULLCHAIN_FILE}
keyfile ${PRIVKEY_FILE}
require_certificate true
use_identity_as_username true

listener ${MQTT_WS_TLS_PORT}
protocol websockets
cafile ${CLIENT_CA_FILE}
certfile ${FULLCHAIN_FILE}
keyfile ${PRIVKEY_FILE}
require_certificate true
use_identity_as_username true
EOF

chown root:root "${CONFIG_FILE}"
chmod 644 "${CONFIG_FILE}"

exec su-exec mosquitto mosquitto -c "${CONFIG_FILE}"
