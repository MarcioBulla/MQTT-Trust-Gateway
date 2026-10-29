# Verification record

## Unresolved provisioning integration

On 2026-10-28, reran the isolated rootless Quadlet integration suite: eight
subtests passed, including local certificate archive/restore and revocation over
TCP and WSS; the external CA provisioning subtest failed with a TLS unknown-CA
alert. The enclosing suite consequently failed. The backend suite passed 18
tests, and the frontend build passed with a chunk-size advisory. The test
Quadlets were stopped afterwards.

An isolated rootless Quadlet run passed password and WebAuthn login, MQTT/TLS
and WSS with QoS 0–2, and the MQTT manager. A trusted external CA connection
fails because Mosquitto requires a CRL for that issuer. A fingerprint plugin
experiment failed to enforce CONNECT checks: Mosquitto skips basic authentication
when `use_identity_as_username` is enabled. The experimental configuration was
removed and the isolated services stopped. External CA revocation and blocking
connections from archived or deleted identities still require a working solution
and integration verification. Do not deploy this branch as a finished release.

Executed on 2026-10-28 on Linux with Podman 6.1.4, user systemd, Bun 1.4.4,
Node 26.12.1 on the development host and Node 24 in the admin container.
Mosquitto is pinned to 2.1.2-alpine for native WebSocket TLS/CRL support.

## Executed checks

- `bun run build`: Vue/Vuetify production build passed. Vite reports a bundle
  size advisory (approximately 188 KiB compressed main JavaScript).
- `bun run test`: six unit/integration tests passed: OpenSSL CA lifecycle and
  CSR constraints, serialized SQLite writes, encrypted TOTP with replay
  rejection, legacy JSON credential/inventory import without old sessions, and expiry
  enforcement when another certificate for the same device remains valid, and
  whitespace-tolerant bootstrap validation with malformed-input rejection.
- `bun audit`: no known vulnerabilities in the installed dependency graph.
- Rootless installation through `./gateway install --env /tmp/mqtt-gateway-test.env`
  and `systemctl --user start`: both units started successfully. The existing
  isolated gateway used explicitly configured host ports to avoid conflicts
  with other local services.
- Eight end-to-end tests passed against the installed services, then passed
  again after backup/restore and update: password login/logout, CSRF and proxy
  header checks, device registration, CSR issuance/renewal, mTLS MQTT on TCP and
  WebSocket at QoS 0/1/2, cross-device ACL denial, backend MQTT manager and retained
  removal and live device retained updates/deletions, Chromium virtual WebAuthn registration/login, TOTP QR/manual setup,
  TOTP password enforcement/replay rejection, desktop/mobile rendering, and
  revocation disconnecting active sessions and rejecting both transports.

The opt-in installed-gateway suite requires `GATEWAY_TEST_URL`,
`GATEWAY_TEST_DATA`, `GATEWAY_TEST_MQTT_PORT`, and `GATEWAY_TEST_WS_PORT`. Point
these at an isolated test installation and use the host-published listener ports
configured for that installation. Do not point the suite at a production gateway.
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
reverse-proxy deployment was installed/tested. A real legacy step-ca signing
hierarchy was not available; only JSON migration and backup restoration were
executed. See migration.md before moving a real fleet.

## Password-manager compatibility follow-up

The login form now exposes stable field IDs/names, an explicit login form,
`username` / `current-password` / `one-time-code` autocomplete metadata, and a
separate bootstrap form identity. Tested in isolated Chromium using the field
recognition functions from the installed KeePassXC-Browser 1.10.4.1 extension:
the detector identifies the username/password pair and TOTP input. Simulated
input/change events submit all three dummy values correctly. Test responses were
intercepted; no real credentials or KeePass database entries were accessed.

Passkey requests also prevent duplicate concurrent clicks. KeePassXC's separate
HTTP-localhost passkey policy is documented in the account UI and proxy guide;
the application does not change that desktop setting or relax backend WebAuthn
verification. A real KeePassXC passkey ceremony still requires user verification
in the unlocked desktop database and was not completed by the agent.

## Certificate identity and lifecycle update

After adding the four provisioning methods and device archival lifecycle, ran
`bun run test` again: 18 tests passed. The expanded suite covers ECDSA P-256 and
RSA-2048 generation, CSR inspection and public-key matching, explicit external
CA approval, database exclusion of generated private keys, and broker ACL/CRL
blocking plus archive/restore/expiry idempotence. `bun run build` passed for the Vue/Vuetify frontend; Vite
reports a 619 KiB uncompressed main JS chunk advisory.

The Zephyr MQTT/TLS + secure WebSocket example translation unit compiled for
ESP32-C3 against the available Zephyr 4.4.99 development snapshot. A complete
image build failed in the snapshot's Mbed TLS/TF-PSA implementation before link.
No ESP32-C6 build or hardware connection was performed. See
[Zephyr compatibility](zephyr-compatibility.md) for this distinction.

The installed integration suite was expanded for this feature revision to
exercise all four provisioning methods, one-time key delivery, explicit external
CA approval/removal and live mTLS connections. It has not yet been run. The
only active Quadlet services belong to the user's live gateway, so tests that
register and revoke identities were not pointed at that data set. In particular,
archive/revoke behavior through an actual running Mosquitto process, UI browser
flows for the new certificate page, and fresh rootless Quadlet install/update
remain unverified for this change. Earlier integration evidence above describes
the previous verified revision only.
