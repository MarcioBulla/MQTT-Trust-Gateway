# System Updates validation

Local release-candidate validation, 2026-11-04:

- Node/Admin suite: **65 tests passed**, zero failures/skips. Includes migrations,
  signed release discovery/cache, authorization, preferences, installation review
  in Chromium, and all Help diagrams across light/dark/OLED/mobile layouts.
- Python suite: **28 tests passed**. Includes snapshot/WAL integrity, interrupted
  restore boundaries, controller failure injection, locking, explicit recovery,
  post-commit safety, immutable signatures, retention and isolated real GPG
  encryption/decryption of exported snapshots.
- Vue production build: passed. Mermaid generates existing large-chunk warnings;
  these do not indicate a failed build.
- Shell syntax, workflow YAML and Python compilation checks: passed.
- Actual rootless Podman/systemd acceptance: **one multi-scenario integration
  test passed in 93.695 seconds**, using the 1.1.0 candidate images. Scenarios:
  Unix-socket service requests, updater survival during Admin replacement,
  coordinated installation, successful guarded manual rollback, refusal after
  new persistent writes, migration/health failures, abrupt controller process
  termination and journal-based recovery, retained messages and offline session
  queues, unchanged CA key, isolated maintenance listeners, and actual updater
  service enablement/status through the systemd user manager.

All cryptographic identities and MQTT data used by these tests are synthetic.
Only uniquely named temporary test units, containers, networks and data are
created. Acceptance does not use a production Gateway or replace its CA.

The publication workflow repeats unit/browser, build and real integration
checks on the exact images before signing and publishing their immutable
references. Local success alone does not authorize an installable release when
pipeline verification, anonymous registry access or signing fails.
