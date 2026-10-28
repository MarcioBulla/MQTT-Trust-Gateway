# Migrating existing installations

Do not run the new installer over the old configuration. Stop issuance and the
old deployment, then back up its entire persistent base directory, environment
file and device inventory. The new installer rejects old `BASE_DIR`/`STEP_CA_*`
configuration. It never deletes the old deployment or its containers.

Copy the old `admin-web/admin-db.json` to `<DATA_DIR>/admin/admin-db.json` before
the first initialization. SQLite imports users, credential IDs/public keys and
counters, certificates, device IDs and old topic metadata once. The JSON remains
untouched. Existing sessions/challenges expire intentionally. Historical topic
metadata remains in the imported state; the new live message buffer is bounded
and starts empty. Preserve PUBLIC_URL and RP hostname to keep passkeys usable.
Existing passkey-only administrators can sign in and set a password in Account.

The installer refuses to generate a new CA when imported devices/certificates
exist. Restoring the original trust is an explicit prerequisite.

## CA key available

Restore a previous **gateway** backup with `./gateway restore --file ...`.
This preserves the complete CA directory, index, serials, CRL and administrative
SQLite database together. Restoring only the CA certificate is insufficient.

For a legacy step-ca deployment, export the actual device signing CA certificate,
its private key, its parent chain, complete issuance inventory and revocations
before shutting down step-ca. The provisioner password is not necessarily the
signing-key password. Decrypt an encrypted signing key offline using OpenSSL;
never send it to the web API. Compare certificate and key public keys locally.

The automated legacy importer intentionally does **not** convert a step-ca CA
hierarchy or reconstruct a revocation index. Typical step-ca installations use
an intermediate signing CA and a separate root. They require an audited offline
conversion: retain both certificates, configure a complete broker trust chain,
produce CRLs for every relevant issuer, import all serials (including revoked
serials not present in admin JSON) into the OpenSSL index, and test existing
devices on both listeners. The current initializer supports one signing CA and
its index; it does not claim automatic step-ca hierarchy compatibility.
Do not copy only a root key when devices were signed by an intermediate.

## Signing key unavailable

Existing public certificates and device inventory can be archived/imported,
but the gateway cannot issue compatible renewals or sign a valid CRL for the
old issuer. Do not replace the CA under existing devices. Plan a staged device
reprovisioning and trust update, retain the old deployment during the transition,
and initialize the new gateway in a separate empty DATA_DIR. Register and issue
new certificates after each device trusts the new CA. The gateway never silently
invalidates the old device fleet.

## Limits

ACL namespaces remain `<device-id>/#` and `<MQTT_TOPIC_PREFIX>/<device-id>/#`.
Custom legacy ACLs require explicit review. Device online status is unknown,
not inferred from certificates. Retained MQTT messages live in Mosquitto's
persistence database; copy/migrate that database only while both brokers are
stopped and after checking version compatibility. The installer does not move it
automatically. Back up the entire old data directory first.
