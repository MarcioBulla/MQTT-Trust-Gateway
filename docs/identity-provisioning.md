# Certificate and identity provisioning

## Existing implementation and migration baseline

The gateway already had a local OpenSSL CA, CSR signature verification, individual
client certificates, certificate renewal/revocation, a generated CRL, and a
Mosquitto ACL derived from enabled device identities. The broker supervisor
restarts Mosquitto when the administrative service changes its policy revision;
this closes current connections. The old UI split enrollment across Trusted
Devices and Licenses. Device state and certificate records were stored in the
administrative JSON state imported into SQLite. This change keeps that import
path and adds normalized metadata to the existing records rather than creating a
second identity store.

`certificate-routes.js` owns the authenticated API. `certificate-service.js`
validates CSR and X.509 material, signs with the local CA, maintains its OpenSSL
index/CRL, builds the broker trust bundle and reconciles ACLs. The broker entry
point applies the CRL on both MQTT/TLS and MQTT/WSS listeners. `identity-service.js`
implements archive, restore, deletion and scheduled purge.

Existing `admin-db.json` records acquire defaults during import; their IDs,
certificates and device associations remain. A new CA is never created when
existing identities exist without matching CA files. A step-ca intermediate
hierarchy is not silently converted: see [migration.md](migration.md) for the
required offline review and the case where the signing key is unavailable.

## Four enrollment methods

All flows use the same device identity and certificate collection.

1. **Sign a device CSR.** The administrator uploads or pastes PEM. The API can
   inspect the subject and public-key fingerprint before signing. OpenSSL checks
   the CSR signature. The server-selected MQTT identity replaces the CSR CN and
   requested extensions are ignored. Only RSA-2048+ and approved NIST EC curves
   are accepted. The device private key never enters the Gateway.
2. **Generate a CSR for an external CA.** The Gateway makes an ECDSA P-256 or
   RSA-2048 key and CSR. The private key lives in process memory for up to 15
   minutes and is downloadable once. The pending registry record stores the
   CSR/public-key association, not its private key. After external signing, the
   imported certificate must match the pending public key. A restart before key
   delivery discards the key; start a new CSR workflow.
3. **Generate a complete certificate.** The Gateway generates the device key,
   signs a client certificate with its local CA, records the public certificate,
   and returns a ZIP or one-time no-store API response. The private key is not
   persisted in SQLite or the issuance directory. Protect the download and put
   the key directly into device-protected storage. The ZIP contains
   `device.crt`, `device.key`, `client-ca.crt`, `server-ca.crt` and a Zephyr
   README. The current Gateway uses its local CA for both client issuance and
   broker server certificates, so the two CA files currently match.
4. **Import an existing certificate.** The API validates PEM X.509 encoding,
   current validity, client-auth purpose, public-key strength, optional private
   key match, issuer chain and duplicate fingerprint. The subject CN must match
   the MQTT identity. A pending CSR requires its matching public key. Providing a
   chain establishes its cryptographic path; it does not approve the issuer for
   Mosquitto. External CAs require a separate explicit typed approval in Trusted
   external CAs. Imported certificates with an unapproved CA stay registered
   with an untrusted state and have no MQTT authorization.

The gateway does not expose its CA private key. The optional private key in an
import form is used only for pair matching and is not stored. Public export,
certificate downloads and the CA trust list omit private material.

## Identity states and broker trust

Device identity, certificate state, broker trust and topic authorization are
separate fields. The broker receives a CA bundle, CRL and generated ACL. An
identity gets its topic ACL only when it is active, enabled, trusted, and has an
unexpired active certificate that the broker trusts. Namespaces remain
`<device-id>/#` and `<MQTT_TOPIC_PREFIX>/<device-id>/#`.

Local-CA revocation marks the serial in the CA index and refreshes the CRL.
Mosquitto consumes that CRL for both listeners. The broker revision supervisor
restarts Mosquitto and terminates existing sessions after trust/ACL changes.
Revoking any certificate disables the complete device identity; restoring a
device does not reactivate a revoked credential. The API response reports the
requested restart; check the applied revision/status before assuming it has
completed. If local CRL update fails, the identity-wide ACL is still removed and
the broker restart is requested. External CA revocation cannot be performed by
this Gateway; local identity authorization is blocked instead.

## Archive, restore and permanent deletion

Archive sets `status=archived`, clears authorization, stores UTC
`archivedAt`/`scheduledDeletionAt` timestamps (30 days apart), and requests a
broker restart. The active device listing excludes it; the Archived tab displays
the persistent deadline. The admin service purges expired records at startup and
every minute, so the schedule survives restarts without an external worker.

Restore before the deadline clears the scheduled deletion and returns the
identity to Active with `enabled=false` and `trusted=false`. An administrator
must explicitly approve it. Revoked or expired certificates remain so.

Manual or scheduled permanent deletion removes operational device/certificate
records and associations, attempts local-CA CRL revocation, and preserves a
minimal audit tombstone with the identity, certificate serials and fingerprints.
Deleted identifiers remain reserved; old imported certificates cannot recreate
or trust the identity. Deletion never recursively removes CA material or records
for another identity.

## Operational boundaries

- Certificate validity acts as the device authorization term; there is no second
  license token. Renewals add new certificate records and retain old history.
- Device online/last-activity are shown as unavailable because Mosquitto does
  not currently provide a verified connection feed to the admin application.
- Current client certificates use `clientAuth`, `CA:FALSE`, digital-signature
  Key Usage, and a server-controlled CN. Arbitrary CSR SANs are not copied.
- Generated private-key delivery is one response per generated key. The admin
  must protect downloads and backups; the Gateway cannot recover a key after the
  response or process restart.
- See [Zephyr compatibility](zephyr-compatibility.md) for embedded TLS and WSS
  configuration and its experimental verification status.
