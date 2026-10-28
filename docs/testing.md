# Verification record

Executed on 2026-10-28 on Linux with Podman 6.1.4, user systemd, Bun 1.4.4,
Node 26.12.1 on the development host and Node 24 in the admin container.
Mosquitto is pinned to 2.1.2-alpine for native WebSocket TLS/CRL support.

## Executed checks

- `bun run build`: Vue/Vuetify production build passed. Vite reports a bundle
  size advisory (approximately 188 KiB compressed main JavaScript).
- `bun run test`: five unit/integration tests passed: OpenSSL CA lifecycle and
  CSR constraints, serialized SQLite writes, encrypted TOTP with replay
  rejection, legacy JSON credential/inventory import without old sessions, and expiry
  enforcement when another certificate for the same device remains valid.
- `bun audit`: no known vulnerabilities in the installed dependency graph.
- Rootless installation through `./gateway install --env /tmp/mqtt-gateway-test.env`
  and `systemctl --user start`: both units started successfully. The existing
  unrelated node-red service was preserved. Test host ports: 8080/8883/8443.
- Eight end-to-end tests passed against the installed services, then passed
  again after backup/restore and update: password login/logout, CSRF and proxy
  header checks, device registration, CSR issuance/renewal, mTLS MQTT on TCP and
  WebSocket at QoS 0/1/2, cross-device ACL denial, backend MQTT manager and retained
  removal and live device retained updates/deletions, Chromium virtual WebAuthn registration/login, TOTP QR/manual setup,
  TOTP password enforcement/replay rejection, desktop/mobile rendering, and
  revocation disconnecting active sessions and rejecting both transports.
- Native HTTPS without a proxy passed trusted-local-CA login, Secure cookie and
  HSTS checks.
- A separate temporary rootless container joined mqtt-gateway and verified
  mqtt-broker DNS resolution, mTLS connection and QoS 2 publication.
- The backup command stopped/restarted the services and created a private
  archive. Restore into a separate empty data directory passed. CA/key hashes,
  identity/password hashes, devices, certificate histories, TOTP encryption key
  and settings matched the baseline after restore and update. Uninstall also
  preserved the entire baseline while removing only managed units.

## Failure found and fixed

The initial Mosquitto 2.0.22 test showed that its legacy WebSocket TLS path
accepted a revoked certificate even though TCP rejected it. The final broker
uses 2.1.2 native WebSockets. Both transports now reject revoked certificates.
The tests also caught incorrect test assumptions about MQTT.js authorization
errors and post-login routing; these assertions were corrected and rerun.

## Scope and limits

Chromium tests use a virtual CTAP2 authenticator with user verification; no
physical hardware key, phone authenticator or platform-specific passkey sync was
tested. TOTP uses interoperable SHA-1/six-digit/30-second parameters; actual Google
Authenticator and KeePassXC applications were not controlled in this session.
No real host reboot was performed and linger was not changed. No external
Nginx or external proxy deployment was installed/tested. A real legacy step-ca signing
hierarchy was not available; only JSON migration and backup restoration were
executed. See migration.md before moving a real fleet.
