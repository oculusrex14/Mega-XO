# Staging deployed with the V5.2 bundle (2026-10-14)

Real deploy to the isolated Oracle staging host, with the byte identity proved and one mistake of
mine recorded honestly.

## Identity

| Field | Value |
| --- | --- |
| Source commit | `ad847dea17c8becc2ac4f3dbbd2654e05c379fe4` (V5.2, after merging Codex's guarded power UI) |
| Bundle sha256 | `d9e281c01003bf61082692258297fbeea692790f55daeaa19f63c0ae0cbdae31` |
| Files | 160 |
| Bytes | 3 685 921 |
| Served at | `https://command.tail95c48c.ts.net/` (tailnet-only; `--web-build /opt/mega-xo-v51-staging/p21-web`) |

**Byte parity is proved, not assumed**: the manifest the server publishes
(`/web-build.manifest.json`) reports `bundle_sha256 55bbdae0…`, `source_commit 33e24263`, 158 files —
identical to the local build from that exact commit, and its `file_count` matches the local 158.

The page now loads the new modules for real: `/legacy-game/` references `src/gameplay-rewind.js` and
`src/powers-ui.js`, and both are served `200`.

## The mistake I made, and the repair

My first deploy broke staging (a `404` on `/` for several minutes). Two concrete causes:

1. I repacked the bundle with `tar` on macOS, which added AppleDouble `._*` sidecars; extracting them
   gave the release directory files with mode `0700` owned by uid 501 (`staff`), so the server could
   not read them. The subsequent `cp -a` also followed the pre-existing
   `p21-web-before-<sha>` symlink rather than copying it, so my "backup" did not exist.
2. My replacement was a fresh directory instead of the release symlink the previous deploy had
   created, so the server's startup manifest read produced a route table with no readable pages.

Recovery: restored the previous release tree from
`codex-frontend-releases/5897497493617e1f389af1626451899831045840/web` (153 files) with
`chown -R ubuntu:ubuntu` and mode 755/644, which brought `/` back to `200`. Then redeployed with a
clean tar (`--exclude='._*' --exclude='.DS_Store' --exclude='__MACOSX'`), correct ownership and modes,
and **restarted `p21-staging-server.cjs`** — it builds its file allowlist from the artifact's own
manifest at startup, so a new artifact is invisible until the process restarts.

Lesson recorded for the production cutover: never `cp -a` over a release symlink, always strip macOS
sidecars, always set ownership/modes explicitly, and always restart the process that cached the old
manifest.

## Current staging state

| Check | Result |
| --- | --- |
| `GET /` | `200` |
| `GET /web-build.manifest.json` | 158 files, sha `55bbdae0…`, commit `33e24263` |
| `GET /legacy-game/src/gameplay-rewind.js` | `200` |
| `GET /legacy-game/src/powers-ui.js` | `200` |
| Powers kill switch | `mega_v52_powers_enabled` in localStorage or `window.MEGA_POWERS_ENABLED`; **off by default** |
| Capture maintenance chain | runs every ~15 min, all modes succeed, journal advancing |

## Not claimed

The capture services on this host still read the **staging** database, not production; production
capture is not enabled. `withdraw` has not been exercised on this host. The `p21-web-before-33e2426`
symlink in `/opt/mega-xo-v51-staging` now dangles because I removed its target during the failed
deploy and did not recreate it; the real prior release remains intact under
`codex-frontend-releases/5897…/web`.

## Update — merged bundle redeployed (same day)

The bundle was rebuilt and redeployed after merging Codex's `codex/v52-provider-release` (its
guarded power UI and tests). Served identity now `d9e281c0…` / `ad847de` / 160 files, byte-identical
to the local build. Both Main's adapter (`legacy-game/src/powers-ui.js`) and Codex's UI
(`powers.js`) serve `200`.

The deploy was repeated with the fixes learned from the first failure: a real copy (not a symlink)
as the rollback source, no AppleDouble sidecars, explicit `ubuntu:ubuntu` ownership and 755/644
modes, and a restart of `p21-staging-server.cjs`. That restart is mandatory and easy to forget: the
server builds its file allowlist from the artifact manifest **at startup**, so a new artifact is
invisible - and if the process dies, the origin returns `502` - until it is restarted.

## Update — post-review fixes deployed

After the independent review's fixes (shared rewarded ceiling, migration 0053), staging was rebuilt
and redeployed: the served manifest reports `bundle_sha256 17b1d88e…`, `source_commit 3752383c`, 160
files, byte-identical to the local build, and both new modules serve `200`.

Two operational lessons worth recording for the production cutover, both of which cost time here:

1. **Applying a migration to the database also requires deploying the matching `manifest.json`.**
   The staging server validates the live migration ledger against its own bundled manifest at boot,
   so after 0053 was applied the running tree still expected 52 and refused with `SCHEMA_INCOMPATIBLE`.
   The manifest and the new migration file had to be shipped together with the bundle.
2. **`SCHEMA_INCOMPATIBLE` is also what you get when the connection budget is exhausted.** The
   role has a hard connection limit (`api_runtime` 16); a killed process's connections linger until
   the server times them out, and the next boot fails while it cannot get a connection - the guard's
   error looks identical to a real schema divergence. Diagnosing it properly required reading the
   guard's own `detail` (which says `too many connections for role`), not the summary code. Repeated
   ad-hoc diagnostics that open their own pools make this worse; they must always close their pools.
