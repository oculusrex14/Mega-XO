# Staging deployed with the V5.2 bundle (2026-10-14)

Real deploy to the isolated Oracle staging host, with the byte identity proved and one mistake of
mine recorded honestly.

## Identity

| Field | Value |
| --- | --- |
| Source commit | `33e2426316c0df248789c8f5e7fa4ead2f661e6e` (V5.2) |
| Bundle sha256 | `55bbdae0aa4d97bf7bd3d4d38de2b32b348120f9b33b3603c18b096bdf0e4af8` |
| Files | 158 |
| Bytes | 3 660 319 |
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
