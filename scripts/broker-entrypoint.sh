#!/bin/sh
set -eu
umask 077
config=/tmp/gateway-mosquitto.conf
mkdir -p /broker/logs
chmod 700 /broker/logs
touch /broker/logs/mosquitto.log
chmod 600 /broker/logs/mosquitto.log
cat > "$config" <<CONF
persistence true
persistence_location /mosquitto/data/
autosave_interval 30
log_dest stdout
log_dest file /broker/logs/mosquitto.log
log_type error
log_type warning
log_type notice
connection_messages true
allow_anonymous false
acl_file /broker/acl
retain_available ${MQTT_RETAIN_ENABLED:-true}
max_packet_size 131072
message_size_limit 16384
max_queued_messages 1000
max_inflight_messages 20
listener 8883
protocol mqtt
cafile /broker/ca.crt
certfile /broker/server.crt
keyfile /broker/server.key
crlfile /broker/ca.crl
require_certificate true
use_identity_as_username true
tls_version tlsv1.2
listener 8443
protocol websockets
cafile /broker/ca.crt
certfile /broker/server.crt
keyfile /broker/server.key
crlfile /broker/ca.crl
require_certificate true
use_identity_as_username true
tls_version tlsv1.2
CONF
pid=''
stop() { if [ -n "$pid" ]; then kill -TERM "$pid" 2>/dev/null || true; wait "$pid" || true; fi; exit 0; }
trap stop TERM INT
while :; do
  revision=$(cat /broker/revision)
  mosquitto -c "$config" &
  pid=$!
  sleep 1
  kill -0 "$pid" 2>/dev/null || { wait "$pid"; exit 1; }
  printf '%s' "$revision" > /broker/applied-revision.tmp
  mv /broker/applied-revision.tmp /broker/applied-revision
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    if [ "$(wc -c < /broker/logs/mosquitto.log)" -gt 1048576 ]; then
      tail -c 524288 /broker/logs/mosquitto.log > /broker/logs/mosquitto.trim
      cat /broker/logs/mosquitto.trim > /broker/logs/mosquitto.log
      rm -f /broker/logs/mosquitto.trim
    fi
    [ "$(cat /broker/revision)" = "$revision" ] || break
  done
  if ! kill -0 "$pid" 2>/dev/null; then wait "$pid"; exit 1; fi
  kill -TERM "$pid"
  wait "$pid" || true
  pid=''
done
