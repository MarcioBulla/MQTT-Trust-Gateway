# Dependency licenses

`node scripts/license-report.mjs` reads the installed package manifests and
updates THIRD_PARTY_LICENSES.json with exact package versions and declared
licenses. Bun's lockfile records the installation graph and integrity hashes.
The report includes development tooling; it is not a legal opinion or a full
container operating-system SBOM.

The current JavaScript dependencies declare MIT, ISC, Apache-2.0, BSD-2-Clause,
BSD-3-Clause, 0BSD and MPL-2.0. The MPL-2.0 entries are Lightning CSS build tooling:
this license permits modification, redistribution and commercial use, with
file-level source obligations when covered files are modified/distributed.
The build does not modify those files. Mosquitto offers BSD-3-Clause as an
alternative to EPL-2.0; use its BSD option. Keep upstream license notices when
redistributing images. Base images include operating-system components under
their own licenses, including LGPL/GPL utilities; those tools do not change the
application source license, but their redistribution obligations still apply.

The original repository does not contain an application LICENSE file. This
refactor does not invent or change the owner's application license; the owner
should choose one before advertising redistribution terms for the gateway.
