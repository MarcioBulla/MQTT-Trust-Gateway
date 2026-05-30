#!/bin/sh
set -eu

: "${MQTT_DOMAIN:?MQTT_DOMAIN is required}"
: "${ADMIN_HTTPS_PORT:=443}"
: "${ADMIN_APP_PORT:=8080}"

envsubst '${MQTT_DOMAIN} ${ADMIN_HTTPS_PORT} ${ADMIN_APP_PORT}' \
  < /etc/nginx/templates/mqtt-trust-gateway.conf.template \
  > /etc/nginx/nginx.conf

exec nginx -g 'daemon off;'
