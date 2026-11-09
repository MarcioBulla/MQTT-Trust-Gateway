#!/bin/sh
set -eu
umask 077
# Keep the generated config on the broker's writable data mount. Some rootless
# systemd/Podman hosts expose the container /tmp tmpfs with permissions that
# Mosquitto cannot read after startup; /broker is already the private runtime
# mount used for the broker's generated files and has restrictive ownership.
config=/broker/mosquitto-runtime.conf
mkdir -p /broker/logs
chmod 700 /broker/logs
touch /broker/logs/mosquitto.log
chmod 600 /broker/logs/mosquitto.log
gate_mode() {
  if [ -n "${GATEWAY_UPDATER_DIR:-}" ] && [ -f "$GATEWAY_UPDATER_DIR/maintenance.json" ]; then printf maintenance; else printf open; fi
}
record_gate() {
  printf '%s' "$1" > /broker/update-gate.tmp
  mv /broker/update-gate.tmp /broker/update-gate
}
write_config() {
  listener_address=''
  [ "$1" != maintenance ] || listener_address='127.0.0.1'
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
listener 8883 ${listener_address}
protocol mqtt
cafile /broker/ca.crt
certfile /broker/server.crt
keyfile /broker/server.key
crlfile /broker/ca.crl
require_certificate true
use_identity_as_username true
# On Mosquitto 2.x this is the minimum: TLS 1.2 and TLS 1.3 remain available.
tls_version tlsv1.2
listener 8443 ${listener_address}
protocol websockets
cafile /broker/ca.crt
certfile /broker/server.crt
keyfile /broker/server.key
crlfile /broker/ca.crl
require_certificate true
use_identity_as_username true
# Keep WSS on the same TLS 1.2 minimum as the native MQTT listener.
tls_version tlsv1.2
CONF
chmod 0644 "$config"
if [ ! -r "$config" ]; then
  echo "Generated Mosquitto config is unreadable; broker mount state follows:" >&2
  id >&2
  ls -ldn /broker "$config" >&2 2>/dev/null || true
  exit 1
fi
}
pid=''
stop() { if [ -n "$pid" ]; then kill -TERM "$pid" 2>/dev/null || true; wait "$pid" || true; fi; exit 0; }
trap stop TERM INT
while :; do
  revision=$(cat /broker/revision)
  gate=$(gate_mode)
  write_config "$gate"
  mosquitto -c "$config" &
  pid=$!
  sleep 1
  kill -0 "$pid" 2>/dev/null || { wait "$pid"; exit 1; }
  printf '%s' "$revision" > /broker/applied-revision.tmp
  mv /broker/applied-revision.tmp /broker/applied-revision
  record_gate "$gate"
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    [ "$(gate_mode)" = "$gate" ] || break
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
