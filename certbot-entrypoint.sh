#!/bin/sh
set -eu

: "${CERTBOT_MODE:?CERTBOT_MODE is required}"
: "${MQTT_DOMAIN:?MQTT_DOMAIN is required}"

if [ "${CERTBOT_MODE}" = "init" ]; then
  if [ "${MQTT_USE_PUBLIC_IP:-no}" = "yes" ]; then
    if [ -n "${CERTBOT_EMAIL:-}" ]; then
      exec certbot certonly \
        --standalone \
        --non-interactive \
        --agree-tos \
        --email "${CERTBOT_EMAIL}" \
        --ip-address "${MQTT_DOMAIN}" \
        ${CERTBOT_ARGS:-}
    else
      exec certbot certonly \
        --standalone \
        --non-interactive \
        --agree-tos \
        --register-unsafely-without-email \
        --ip-address "${MQTT_DOMAIN}" \
        ${CERTBOT_ARGS:-}
    fi
  else
    if [ -n "${CERTBOT_EMAIL:-}" ]; then
      exec certbot certonly \
        --standalone \
        --non-interactive \
        --agree-tos \
        --email "${CERTBOT_EMAIL}" \
        -d "${MQTT_DOMAIN}" \
        ${CERTBOT_ARGS:-}
    else
      exec certbot certonly \
        --standalone \
        --non-interactive \
        --agree-tos \
        --register-unsafely-without-email \
        -d "${MQTT_DOMAIN}" \
        ${CERTBOT_ARGS:-}
    fi
  fi
fi

if [ "${CERTBOT_MODE}" = "renew" ]; then
  trap 'exit 0' TERM INT

  # Avoid racing the init container on the first compose startup.
  sleep 300 &
  wait "$!"

  while :; do
    certbot renew --standalone --non-interactive ${CERTBOT_ARGS:-}
    sleep 12h &
    wait "$!"
  done
fi

echo "Unsupported CERTBOT_MODE: ${CERTBOT_MODE}" >&2
exit 1
