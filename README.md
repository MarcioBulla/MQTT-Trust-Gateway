# MQTT Trust Gateway

A small MQTT gateway with individual device certificates, a local CA, and a
Vue 3 / Vuetify 3 administrative console. Two rootless containers run the entire
gateway: **Eclipse Mosquitto** and **Node/Express + compiled Vue frontend**.
SQLite persists identities, credentials, certificate history, settings and audit
records. OpenSSL handles signing and CRLs. There is no step-ca, integrated proxy,
Certbot, Docker, Compose, Redis or external database dependency.

> Existing installation? Read [migration](docs/migration.md) first. The installer
> never replaces an existing device CA automatically. Legacy step-ca hierarchy
> conversion requires offline review; it is not an automatic migration.

## Install

Requirements: Linux, rootless Podman with Quadlet support (5+ recommended),
a working user systemd manager, Python 3.12+, subordinate UID/GID ranges and a
rootless network backend. Bun is needed only for development; image builds use
Bun internally. Run everything as your normal user.

```sh
cp gateway.env.example gateway.env
# Optional: edit gateway.env. Defaults require no domain or external proxy.
./gateway install
./gateway status
./gateway logs
```

The installer validates configuration, builds the two local images, initializes
the CA only when safe, prepares persistent directories, installs Quadlets in
`~/.config/containers/systemd/`, reloads the user manager and starts services.
It is idempotent and parses the environment file without executing shell code.
The admin interface binds to loopback by default. Open http://localhost:8080 .
Read the one-time token locally from `runtime/admin/bootstrap-token`, then create
your username and password in the browser. There are no default credentials.
The token is deleted after bootstrap. Do not paste it into issue reports/logs.

For access from another computer, use an SSH local port forward or configure
native HTTPS or your own proxy as described in [proxy integration](docs/proxy.md).
Remote HTTP administration is rejected. HTTPS can use a locally trusted CA and
a LAN hostname; no public domain is mandatory. Passkeys require HTTPS or localhost.

```sh
systemctl --user start mqtt-broker.service mqtt-admin.service
systemctl --user restart mqtt-broker.service mqtt-admin.service
journalctl --user -u mqtt-admin.service -u mqtt-broker.service -f
# Optional, subject to your host's policy:
loginctl enable-linger "$USER"
```

Quadlets include WantedBy=default.target; the generator handles boot activation.
Do not `systemctl enable` the generated transient services. Linger permits the
user manager to start at boot without a login. No privileged container, rootful
Podman, Podman socket mount or sudo is used.

## Configuration and storage

`gateway.env.example` documents every supported setting. Copy it to `gateway.env`
and keep it private (`chmod 600 gateway.env`). No environment file is sourced as
shell code. `DATA_DIR` defaults to `runtime` in the checkout; set an absolute path
for durable deployments independent of the checkout. Paths must not contain
whitespace or systemd specifier characters. Changes take effect after update.

| Host port (default) | Purpose |
|---|---|
| 8080, loopback only | Admin HTTP (or native HTTPS when TLS files configured) |
| 8883 | MQTT TLS with mandatory mTLS |
| 8443 | MQTT WebSocket TLS with mandatory mTLS |

The broker's internal ports stay 8883/8443. Change host ports in gateway.env.
`ADMIN_APP_PORT` configures both the admin listener and published port.
Device authentication is always mTLS; no anonymous/password device listener is
provided. `MQTT_RETAIN_ENABLED=false` disables retained publishing in the broker
and backend. Message history is bounded in memory and intentionally not durable;
the history limit is configurable in the console and persisted in SQLite.

Persistent data:

- `admin/gateway.sqlite` and its WAL: administrative state and audit records.
- `admin/ca/`: signing key (0600), CA certificate, OpenSSL index, issued certs, CRL.
- `admin/mqtt-client.*`: private backend MQTT identity.
- `admin/totp-encryption.key`: key encrypting authenticator seeds in SQLite.
- `broker/`: server certificate/key, CA certificate, CRL, ACL and applied revision.
- `mosquitto/`: broker persistence, including retained messages and sessions.

Directories are private to the user. The broker cannot mount the CA key or admin
state. The running CA key is unencrypted for unattended issuance, protected by
filesystem permissions and container isolation; protect the host and encrypt
backups. Device-generated CSR keys remain on their devices. When the administrator
chooses Gateway-generated credentials, the device key is returned once in a
no-store authenticated response and is not written to SQLite or persistent files.
For external-CA CSR enrollment, the key is held in process memory temporarily and
delivered once; a service restart clears any undelivered key.

## Administration

Password hashes use Argon2id. Sessions expire, logout invalidates the server-side
session, and changing a password invalidates other sessions. Mutations require
an allowed Origin and JSON. Authentication attempts are rate limited per source.
Passkeys use verified RP ID, origin, challenge, signature, counter and required
user verification. Manage them in Account. Existing legacy credentials are
preserved when importing the JSON database.

Account also supports TOTP (Google Authenticator, KeePassXC and compatible apps).
Click **Set up authenticator**, scan the QR code or enter the manual secret shown
under it, then verify a six-digit code. Setup expires after ten minutes. Enabled
TOTP is required with password login; passkeys remain independently usable.
Seeds are encrypted with AES-256-GCM. Used time steps cannot be replayed. Keep a
passkey fallback; there is no insecure web bypass if all factors are lost.

Overview shows real backend/broker connection state, certificate counts, CA and
server expiry, configured endpoints and a copyable quick-start guide. Public IP
is displayed only if explicitly configured; no discovery service is contacted.
Individual device online status and last activity are **unavailable** without a
verified connection feed. They are never inferred from certificate validity.

## Devices, certificates and licenses

The **Certificates and identities** page offers four enrollment methods:

- Sign a device-generated CSR (the preferred method when firmware can create keys).
- Generate a CSR and key in the Gateway for signing by an external CA.
- Generate and sign a complete device certificate in one operation, with an
  optional Zephyr-ready ZIP bundle.
- Import an existing client certificate and chain. External issuers remain
  unauthorized until explicitly added to Trusted external CAs.

The four methods use the same identity and certificate history. See the
[provisioning guide](docs/identity-provisioning.md) for validations, one-time key
delivery, broker trust and limitations. Zephyr firmware guidance and a C example
are in [Zephyr compatibility](docs/zephyr-compatibility.md).

1. Register `sensor-01` in Devices.
2. Generate a private key and CSR on that device:

```sh
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout sensor-01.key -out sensor-01.csr -subj /CN=sensor-01
chmod 600 sensor-01.key
```

3. Choose **Sign an existing CSR**, paste or upload the CSR, inspect the public
   key and select validity (default 90, maximum 365 days).
4. Download the public device certificate and client CA from Certificates.
5. Connect using the configured hostname (it must match the broker certificate):

```sh
mosquitto_sub -h localhost -p 8883 --cafile gateway-ca.crt \
  --cert sensor-01.crt --key sensor-01.key -t 'devices/sensor-01/#' -q 2
mosquitto_pub -h localhost -p 8883 --cafile gateway-ca.crt \
  --cert sensor-01.crt --key sensor-01.key -t devices/sensor-01/hello -m hello -q 1
```

ACLs allow only `<device-id>/#` and `<MQTT_TOPIC_PREFIX>/<device-id>/#` for
registered/enabled devices with valid certificates. The backend MQTT identity
can manage all topics; its private credentials never reach the browser.
CSR signatures/key strength are verified and the requested CN/extensions are
overridden. Device certificates cannot acquire CA or serverAuth capabilities.

Certificate validity is the **license**, enforced during TLS authentication;
there is no duplicate licensing token. Renewing issues a new serial and preserves
history. Supply a new CSR for key rotation, or reuse the original CSR. Renewal
does not revoke the old serial: revoke it explicitly when the rollout is complete.
Revoking a certificate disables the whole device identity, removes topic
authorization and requests a broker restart. Local certificates are also added
to the internal CA CRL. External issuers cannot be revoked by this Gateway; their
certificates are blocked locally. Re-enabling a device does not undo certificate
revocation.

Trusted Devices supports **Archive**, **Restore**, and **Delete now**. Archiving
immediately removes authorization and schedules permanent removal after 30 days.
Restore cancels that deadline but leaves the identity disabled and untrusted until
an administrator explicitly approves it. Permanent deletion stores a minimal
fingerprint/serial tombstone so old certificates cannot be reimported as trusted.

Revocations update the CRL and request a broker restart. The broker supervisor
checks the revision every second and restarts Mosquitto, disconnecting existing
sessions. Overview reports pending/applied revisions. If the broker is down,
enforcement remains pending until restart; do not treat an API response alone as
proof of enforcement. Expired authorization ACLs are reconciled every 30 seconds.
CRLs are refreshed daily with seven-day validity; prolonged admin outage causes
fail-closed certificate validation when the CRL expires. Service certificates
renew automatically within 30 days of expiry. CA rotation is an explicit
maintenance task; it never happens silently.

## MQTT Manager

The console receives messages through authenticated SSE, with timestamps, topic
filters, QoS, retain indicators and text/JSON/base64 views. Add wildcard
subscriptions, pause the display and clear bounded history without deleting broker
messages. Publish text or base64 payloads at QoS 0/1/2 and optional retain. Delete
retained values only by confirming the exact topic. The backend uses MQTT 5 with retain-as-published to track live retained changes
and rebuilds the snapshot on reconnect (maximum 1,000 topics). Payloads are capped at 16 KiB.

Native MQTT clients may use `wss://HOST:8443/mqtt` with the same device CA,
certificate and key. Browser JavaScript cannot select TLS client certificates;
browser/OS certificate provisioning is required if supported. The console avoids
this limitation by using its protected backend MQTT bridge.

## Shared rootless network

`mqtt-gateway.network` creates the persistent network named `mqtt-gateway`.
Other rootless Quadlets belonging to the **same user** can join it:

```ini
[Container]
Network=mqtt-gateway
```

For a managed dependency use `Network=mqtt-gateway.network` when that Quadlet is
available in the same user search path. The broker resolves as `mqtt-broker` and
the console as `mqtt-admin`. Use `mqtt-broker:8883`, not the host-published port.
Joining the network grants no MQTT authorization: clients still need individual
certificates and trusted CA material. Do not share the CA signing key.

## Update, backup, restore and uninstall

```sh
./gateway update              # rebuild, prepare safely, restart; preserves all data
./gateway restart
./gateway stop
./gateway backup --file /safe/path/gateway-backup.tar.gz
./gateway uninstall           # removes only managed units; preserves data/images/network
```

Backups stop both services for a consistent copy, include all private state and
gateway.env, and restart services afterward. Encrypt archives before off-host
storage. Restore into an empty DATA_DIR (never over live existing data):

```sh
./gateway restore --file /safe/path/gateway-backup.tar.gz
# Review gateway.restored.env, merge configuration, then:
./gateway install
```

Restore validates archive paths and rejects links/special files. It keeps the
services stopped for review. Store the CA key, index, SQLite and TOTP encryption
key together; losing the TOTP encryption key makes enrolled seeds unusable.
Installer updates never delete identities or certificates. Take a backup before
upgrades. Removing old CA/proxy/Compose services is a deliberate legacy operator
step after migration; the new installer never manages those services.

## Roadmap

- Add device health checks with explicit heartbeat or status reporting, configurable
  stale thresholds, and clear online, offline, and unknown states. Do not infer
  device health from certificate validity alone.

## Development and verification

```sh
cd admin-web
bun install --frozen-lockfile
bun run build
bun run test
bun audit
# After installing an isolated test gateway:
GATEWAY_TEST_URL=http://localhost:8080 \
GATEWAY_TEST_DATA=../runtime/test bun run test:integration
```

Node 24 is the backend runtime (built-in SQLite). Bun handles dependency locking,
frontend builds and test command execution. See [test evidence](docs/testing.md),
[architecture](docs/architecture.md), [migration limits](docs/migration.md), and
[optional Nginx/external proxy examples](docs/proxy.md). Dependencies and their licenses
are recorded in [THIRD_PARTY_LICENSES.json](THIRD_PARTY_LICENSES.json).
