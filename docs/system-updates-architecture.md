# System Updates Architecture

## Existing architecture and reuse

`./gateway` delegates source installation, backup and service management to
`scripts/gateway.py`. Admin and Mosquitto run as two rootless Podman containers
managed by user Quadlets. The updater is an independent Python host process,
not a third container. The Admin API never receives the Podman/systemd socket.

Persistent state consists of SQLite (`admin/gateway.sqlite`, WAL mode), the
local CA key/index/certificates/CRLs under `admin/ca`, broker credentials,
ACLs and revision files under `broker`, and Mosquitto persistence under
`mosquitto`. Environment and managed Quadlets reside outside runtime.
Snapshots reuse the existing archive validator and backup format.

The Express exclusive operation queue, existing password/TOTP and user-verified
WebAuthn reauthentication, SQLite settings, Vuetify lists and contextual Help
are reused. Device certificate issuance and the device CA are not replaced.
Dedicated infrastructure health credentials use the existing issuance helper;
their reserved identity cannot be provisioned as a device.

## Implemented components

| Component | Responsibility |
| --- | --- |
| `scripts/updater/releases.py` | Official release discovery, strict SemVer, pinned Ed25519 manifest verification and compatibility |
| `journal.py` | Atomic/fsynced private state, history and nonblocking cross-process flock |
| `snapshots.py` | Verified offline snapshots and resumable restoration retaining displaced runtime |
| `controller.py` | Installation, automatic recovery, explicit recovery retry and guarded manual rollback |
| `host.py` | Fixed rootless Podman/systemd operations, migration isolation and functional checks |
| `service.py` / `cli.py` | Same-UID bounded Unix socket service and host recovery CLI |
| `src/migrations` / `update-migrate.js` | Transactional versioned SQLite migrations, unknown-schema rejection |
| `src/update-health.js` | API, database, PKI, TLS, mTLS, WSS, delivery and negative ACL checks |
| `UpdateOperations.vue` | Fresh-authenticated review, progress, history, operation details and safe rollback |
| `UpdateIndicator.vue` | Release/operation notification linking to Settings → System Updates |
| `.github/workflows/release.yml` | Dedicated-runner verification, exact-image acceptance, signing and publication |

## Installation transaction

1. Verify the official manifest against an independently pinned Ed25519 key.
   Both image references must belong to the project's GHCR repositories and
   include immutable SHA-256 digests. Check Gateway, Podman and schema versions.
2. Pull both images, verify their digests and release/capability labels, check
   space and capture existing image identities. Download alone changes no data.
3. Persist maintenance state. The Admin API blocks mutations, including queued
   requests, and checks that no one-time private-key delivery is outstanding.
4. Gracefully restart Mosquitto listeners onto its container loopback interface.
   This disconnects external clients without changing ACLs or discarding queues.
   Stop Admin and broker before copying any persistent state.
5. Create a private recovery point. SQLite Backup API incorporates committed
   WAL data into a standalone database. Verify integrity, essential CA/broker
   files, all file hashes/modes and the archive hash before proceeding.
6. Run the candidate migration in a disposable container with no network and
   only a writable database copy. Validate the result before atomically
   installing it. Live CA and runtime paths are not mounted into this container.
7. Change only the existing managed Quadlet image references. Preserve
   documented configuration/customizations and reload the user manager.
8. Start both services while maintenance remains active. An ephemeral health
   helper joins the broker network namespace and uses scoped infrastructure
   credentials. It validates the API, database/schema/version, unchanged CA,
   TLS/CRL/revision, mTLS and WSS publish/receive, invalid-credential rejection,
   and denied subscribe/publish delivery. Container startup is insufficient.
9. Persist COMMITTING before writing installed-version metadata. After this
   boundary recovery only moves forward. Release the gate and record COMPLETED.

## Snapshot and recovery properties

Snapshots include all runtime directories, environment, managed Quadlets and
previous immutable image IDs. Private directories use 0700 and archives use
0600. Hash inventories are corruption checks, not protection against a
compromised host owner. Restores verify the recovery point before mutation,
fsync extracted content and directory renames, retain the displaced runtime,
and resume from an operation-specific restore journal after interruption.

A pre-commit failure restores the previous images/configuration and snapshot,
then runs the same functional checks. Without a completed snapshot it restarts
the unchanged previous installation. Failure to recover enters
RECOVERY_REQUIRED without destructive retry loops. Operator-triggered retries
require the matching operation ID and explicit confirmation. Committed
operations never automatically restore an older snapshot.

Manual post-commit rollback requires an available verified recovery point,
fresh authentication, typed confirmation and an unchanged persistent-state
fingerprint. It rechecks after stopping writers and creates a fresh safety
snapshot. New certificates, revocations, settings, retained messages or session
state invalidate safe rollback. The Mosquitto format-6 fingerprint normalizes
only the allocation counter/clean-shutdown flag and chunk ordering; unknown
formats fall back to a conservative byte hash. Sessions and authentication
challenges are invalidated on restore; matching credential replay counters,
audit entries and aggregate observations are preserved where readable.

## Communication and threats

The updater exposes only status/history and typed install/rollback requests.
No request can supply a shell command, filesystem path, image reference or
arbitrary environment. A read-only bridge mount exposes a 0600 Unix socket;
peer credentials must match the host owner. HTTP workers, body size, response
size and timeouts are bounded. The API adds session/origin protections,
rate limiting, operation-scoped fresh authentication and safe audit events.

The host owner, updater code, pinned signing identity and signed candidate
application are trusted. A compromised Admin container already has access to
its application data and can request a correctly signed official release via
the narrow socket; it gains no general Podman command interface. A compromised
host or release signing key is outside that boundary. Captured subprocess
output and credentials are never copied into public operation history.

## Compatibility and limits

- Existing source installations remain supported. Enabling signed updates
  requires a one-time source bootstrap containing the broker gate and health
  helper; legacy images lacking those capabilities are rejected safely.
- `./gateway update` remains the source installer. It refuses to overwrite an
  enabled release controller's managed installation.
- Automatic installation is disabled. Checks, channel, interval and release
  notifications are configurable; failed network discovery never blocks boot.
- History is retained and paginated. Snapshot retention is configurable (2–100,
  default 5); cleanup after service operations protects current/installed and
  unresolved recovery points. Protected points can exceed the configured count.
  Displaced runtime is retained separately. The host CLI exports a verified
  snapshot using optional GnuPG encryption to an explicitly selected full key
  fingerprint. Local snapshots remain unencrypted: use encrypted storage.
  Hashes alone do not encrypt backups.
- Initial schema is version 1; migration fixtures validate transactional
  failure/recovery. A future schema requires a real candidate migration.
- Linux/kernel/Podman/systemd and host updater source are not automatically
  replaced by container release installation. Internet-free release import is
  not implemented; tests use explicitly injected offline fixtures.
- Production publication requires a dedicated rootless release runner, a
  separately pinned signing public key and protected signing secret. None is
  inferred from the broker/device CA. The pinned release key and protected
  environment are configured separately; an ephemeral runner executes publication
  acceptance. An installable release must not be published until that pipeline passes.

## Validation evidence

`python3 -m unittest scripts.test_gateway scripts.test_updater
scripts.test_snapshots scripts.test_controller scripts.test_mqtt_state
scripts.test_release_manifest scripts.test_snapshot_storage` covers corruption, WAL snapshots, resumable
restore boundaries, permissions, signatures, compatibility, concurrent locks,
failure injection and commit/recovery safety. Node tests cover migrations,
authorization, preferences, issuance regression and browser Help rendering.

`RUN_GATEWAY_UPDATE_INTEGRATION=1 python3 -m unittest
scripts.test_updater_integration` creates synthetic CA/state and uniquely named
rootless Quadlets. It validates signed image activation through the actual
Unix-socket host service, updater survival during Admin replacement, successful
manual rollback, rejection after new persistent writes, failed migration,
failed functional health, abrupt controller process termination/restart, and
preservation of CA bytes, retained messages and queued persistent-session
messages. All temporary services/data are removed. Production is never used.
