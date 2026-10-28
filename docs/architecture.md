# Architecture and migration plan

## Baseline

The previous deployment used Mosquitto, step-ca, Certbot, an Express admin
application and Nginx with host networking and Compose. Express stored users,
WebAuthn credentials, certificates and observed topics in `admin-db.json`.
Device ACLs used certificate CNs and the namespaces `<CN>/#` and `devices/<CN>/#`.
The frontend was server-rendered HTML with imperative JavaScript. There was no
password login. Certificate validity already represented the authorization term.

## Target and preservation

Two rootless containers share `mqtt-gateway`: Mosquitto and Express serving a
compiled Vue/Vuetify application. SQLite replaces JSON; the original JSON is
retained and imported exactly once, including credential public keys and counters.
Sessions and pending challenges are intentionally invalidated on migration.
OpenSSL maintains a local signing CA, issuance index and CRL. The broker only
mounts public trust material, its own server key and generated ACL; it cannot
read the CA key or administrative database. No container mounts a Podman socket.
Certificate validity is the license, with immutable issuance/revocation history.

## Migration gate

Stop and back up the old deployment before installing. Never point a fresh
installation at existing devices without migrating trust. The installer refuses
an old `BASE_DIR` configuration. Import `admin-db.json` into the new admin data
directory before initialization. If imported certificates exist without a signing
CA, initialization refuses to create one. See migration.md for signing-key and
intermediate-CA limits. Files in the old deployment are never deleted.

## Security and operational decisions

Only registered, enabled device CNs receive ACL entries. CSR extensions and CN
are not trusted: the server verifies the CSR signature, requires RSA >=2048 or
EC >=256 bits, overrides CN and signs with clientAuth only. Revocations generate
a CRL and an atomic broker revision. The broker supervisor restarts Mosquitto on
revision changes, dropping existing sessions. CRLs refresh daily; expired
certificates lose ACL authorization, also disconnecting persistent sessions.
The API reports broker-applied revision separately from requested revision.

HTTP is accepted only from loopback for local setup, or through an explicitly
trusted HTTPS proxy. Direct HTTPS is also supported. Cookies are HttpOnly,
SameSite=Strict and Secure over HTTPS. Every mutation requires an allowed Origin
and JSON. Proxy headers are trusted only for configured addresses. Passkeys
require HTTPS or localhost with RP ID and origin verification.

## Workflow

Follow https://example.invalid/trunk-based-development-en.html : short-lived
branches, explicit staging, conventional English commits, tested local `--no-ff`
integration. No push, remote merge or release is implied by local integration.
