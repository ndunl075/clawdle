# Maintained dependency notices

`inventory.json` enumerates every registry dependency from both lockfiles,
including optional platforms and development tools. It records original package
integrities, license declarations, retained full-notice source URLs and SHA-256
checksums. Shared notice text is deduplicated in `notice-<sha256>.txt` files.
`DEPENDENCIES.md` renders all of those texts for redistribution with the app.

Run `node scripts/licenses-generate.mjs --check` to verify the inventory,
lockfile hashes, notice hashes and generated document entirely offline. The
check does not depend on the host platform, installed npm packages or Cargo.
Lockfile line endings are canonicalized so Windows and Linux agree.

After a dependency update, install/fetch the pinned packages and run
`node scripts/licenses-generate.mjs --refresh`. Generation also stays offline.
Missing full notices fail explicitly. Retrieve any omitted upstream notice as a
separate maintainer action, retain its text and checksum, and add a versioned
`overrides.json` entry with an exact source URL and an explanation of its actual
location. Re-run generation and review the inventory diff. Package updates never
inherit an old version's override automatically.

Most overrides identify license files in an exact-commit monorepo root or a
pinned companion package. Full original notices are retained, including Windows
clipboard and WebView2 dependencies. The selectors MPL-2.0 entry includes the
complete Mozilla license, original notices, and a link to corresponding source.
The r-efi entry selects the full MIT alternative supplied in its AUTHORS file.

Two development-only packages, stackback and the optional Linux LZMA binary,
declare MIT but publish no complete license file in their source repositories.
Their explicit overrides retain the original package attribution and separately
identify full standard MIT terms from SPDX license-list-data v3.27.0. They do not
invent an upstream copyright notice. The Keyv 4.5.4 override documents its
missing gitHead and retains the historical project-root MIT notice with both
original authors. These exceptions are visible in the generated document.

The ESDB dictionary Copyright is separate and remains byte-preserved. All
notice snapshots and overrides are reviewed source assets; ordinary gameplay
and normal builds never fetch license text from the network.
