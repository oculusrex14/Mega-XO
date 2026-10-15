# V5 production image rebuilt from the final V5.2 source (2026-10-14)

The previously provisioned production image predated V5.2 (source SHA `07c9fbab`). It is now rebuilt
from the **final** V5.2 SHA, and the cutover rehearsal re-run on it. V4 remains the sole live writer;
nothing was cut over.

## Image identity

| Field | Value |
| --- | --- |
| Source SHA | `a3dc0c6058757143b3773434ff846a77c5a4b339` (final V5.2 HEAD) |
| Built from | `git archive` of that exact HEAD on host `command`, `Dockerfile`, `--build-arg MEGA_RELEASE=$SHA` |
| Local tag | `mega-xo-v5-candidate:a3dc0c60…` |
| **Digest** | **`sha256:d6a9ab9846d59c47df8334b987806e21d30f3d702d1c2556b49256d39ed0f2f0`** |
| Size | 393 MB |
| Revision label | `org.opencontainers.image.revision = a3dc0c60…` (verified with `docker inspect`) |
| Superseded image | `sha256:8e53d667…` (still present, from V5.2 at `8ebeb0c6`; and `sha256:41b8b7a3…` from `07c9fbab`) |

Deployed by immutable digest, never by tag — as the release runbook requires.

## Web bundle for the rehearsal

Built from the same SHA: `bundle_sha256 17b1d88e423d2aa4727a086b5908c7e8317b7594bcb7f04ec89a7a06c877bfb8`,
160 files, 3 688 654 bytes.

## Rehearsal on the rebuilt image (real production composition)

Started against the real production Neon database and the real managed Redis, with the
authority-epoch switch deliberately unset:

| Check | Result |
| --- | --- |
| Boot | `{"ok":true,"origin":"http://127.0.0.1:8097", …}` |
| Binding state | **`"servingEpoch": null`** — structurally incapable of becoming the writer |
| `GET /livez` | `200` |
| `GET /readyz` | `200` |
| `GET /` (website bundle) | `200` |
| `GET /nope.jsx` | **`404`** — a real 404, not an SPA fallback |
| `GET /api/v1/profile` unauthenticated | `{"error":"AUTH_REQUIRED"}` |
| `GET /api/v1/leaderboard?metric=rating&limit=5` | `[]` — honest empty board, through the **production** pool |

The rehearsal process was then stopped. V4 was not touched at any point.

## Backups and freshness (checked after)

| Item | Value |
| --- | --- |
| `mega-xo-v5-backup.timer` | active, ran 2m38s ago, next in 2m40s (5-minute RPO cadence) |
| `state/freshness-state.json` | `{"state":"fresh","checkedAtUtc":"2026-10-14T20:34:17.581Z","consecutiveUnhealthy":0}` |

## Still true, still not claimed

- **No cutover.** V4.1.2/SQLite remains the sole live writer; no authority epoch exists and no first
  production application write has occurred, so the SQLite rollback option is open.
- `P22 readiness` still returns `BLOCKED: OPERATOR_EVIDENCE_PACKET_MISSING`.
- The production database is at **53** migrations (0053 applied forward-only to the non-serving
  target); the image expects exactly that and would refuse otherwise.

## Update — image rebuilt again at the powered source (2026-10-15)

The image was rebuilt once more after the rewarded powers were made visible, so the frozen artifact
contains the feature build rather than the one whose controls were unreachable:

| Field | Value |
| --- | --- |
| Source SHA | `153a8543d555682d3c94130eda19e3d1ae52a232` |
| **Digest** | **`sha256:866b83cdf41a4188a95b86d95c6ce635a6d6e59f60fd836b38a7e5d4e874377c`** |
| Size | 393 MB |
| Rehearsal | started as a **supervised systemd unit** against the real production Neon + Redis, `servingEpoch: null`, `/livez` 200, `/readyz` 200, `/` 200, unknown path 404, profile `AUTH_REQUIRED`, leaderboard `[]` through the production pool; then stopped |

The earlier rehearsals used a detached `setsid` process that did not reliably survive the SSH session.
Both the staging web server and this rehearsal now run as systemd units with explicit logging, which is
how any reviewer or operator should start them.

## Before the cutover, one thing is still required

The rehearsal's `--web-build` points at a bundle directory that is refreshed by hand. Before the
authority transfer, the web bundle must be built from the **frozen release SHA** and that path pointed
at it, so the served client is provably the released one rather than a stale directory. That is a
one-line change to the unit, and it must be part of the same freeze step as the database snapshot.
