# Publishing signed Gateway releases

The manual **Verify and publish Gateway release** workflow requires a dedicated
self-hosted runner with labels `linux,mqtt-gateway-release`, running as a
non-root user with a live systemd user manager. Do not register an untrusted or
production Gateway as this runner. Required tools: rootless Podman 5+, Python
3.12+, Node 24+, Bun 1.4.4, OpenSSL, GnuPG (encrypted-export acceptance) and `/bin/chromium`.

Configure the protected `gateway-releases` environment and:

- `GATEWAY_RELEASE_PRIVATE_KEY`: secret Ed25519 private key PEM, used only by
  the signing step. It is separate from all Gateway CA/device credentials.
- `GATEWAY_RELEASE_PUBLIC_KEY_B64`: variable containing base64 SPKI DER of the
  matching public key, independently distributed to operators as their trust pin.
- Environment approval/branch rules appropriate to the repository. Stable
  publication is accepted only from `main`.

The exact SemVer must match `admin-web/package.json`. Add reviewed release notes
at `docs/releases/VERSION.md`. Run with `publish=false` first: unit/browser tests,
frontend build, exact image builds and real isolated rootless update/rollback
acceptance must pass. Test artifacts carry an explicit non-installable marker
and a disposable trust key. They must never be published as official artifacts.

A publishing run builds/tests again, verifies the configured signing identity,
pushes both versioned GHCR images, checks anonymous digest-addressed pulls and
compares them to the tested image identities. It signs the final immutable
manifest, creates the version tag and publishes GitHub release notes/assets.
Private packages must be made publicly pullable before publication can pass.
No personal GitHub credential is required on a Gateway to consume public releases.

The signed manifest binds both image digests, version/channel, schema and
compatibility requirements. A checksum/key downloaded alongside an artifact is
not an independent trust anchor. Signing-key compromise requires an explicit
operator trust-key rotation; automatic trust-on-first-use is not implemented.

Do not publish v1.1.0 until both the local acceptance suite and this protected
publication workflow pass. A branch push or tag alone is not an installable
release and must not be presented as one.

## Release trust key

The public SPKI DER key is [release-signing-public-key.der](release-signing-public-key.der); its base64 form is [release-signing-public-key.base64](release-signing-public-key.base64). Verify its SHA-256 fingerprint through an independently authenticated channel before configuring an installation:

```text
9f86c54f4d2fd27c0ab876e5902698d38468432b3c5d3bfd536f4cdab8d35550
```

A key downloaded with an artifact must never be accepted automatically as a new trust root. The private release key is excluded from the repository and unrelated to the Gateway CA.
