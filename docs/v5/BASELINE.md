# V5 baseline and provenance

## Selected integration base

| Item | Value | Evidence |
|---|---|---|
| Repository | `oculusrex14/Mega-XO` | Authenticated `gh repo view` |
| Checkout and remote V4.1 head | `455b8ec9ea4070b4410d78f9eea2aaa06d32c0b2` | Entry Git inspection and GitHub branch API |
| Exact-head validation | Run `37658524961`, completed/success | [Actions](https://github.com/oculusrex14/Mega-XO/actions/runs/37658524961) |
| Shipped version | `v4.1.2` | Owner report, committed EXT-17 and GitHub release |
| Auth fix | `79e56d6896ec372ddd585499475a045b3595f458` | Entry log and commit resolution |
| Release application SHA | `f1e5577d42809fc3da889ba76b87ca6c87e68575` | Peeled local release tag and GitHub release body |
| Release validation | Run `37656024767`, completed/success | GitHub run listing |
| Ledger SHA | `455b8ec9ea4070b4410d78f9eea2aaa06d32c0b2` | Entry log |
| Integration branch | `V5-platform`, created from selected SHA after live recovery checks | `git switch -c V5-platform 455b8ec9ea4070b4410d78f9eea2aaa06d32c0b2`; successful branch creation |
| Pack's historical baseline | `8a77d3f4eb95e363fb967efe9b01f814a703dbae` | Original pack, retained unchanged |

Release image from [GitHub release](https://github.com/oculusrex14/Mega-XO/releases/tag/v4.1.2):

`ghcr.io/oculusrex14/mega-xo@sha256:71d33a1a9893a303c5ffcbdb090caefde22d9e7e054a8c2d6c494a44919b58e4`

The release API's `targetCommitish` is `main`, but the peeled tag and explicit release Git SHA resolve to `f1e5577d42809fc3da889ba76b87ca6c87e68575`; do not treat that API metadata as the integration base. An annotated tag object is not an application commit.

## Owner-reported shipped evidence

- Guest online `LINK_ACCOUNT_REQUIRED` now maps to auth state and **Sign in to play online** action copy instead of a temporary-online-outage message. Auth state clears the online poller, stopping the 401 re-poll loop.
- Failing-first coverage in `tests/static-ui.test.js`, then a two-line fix; reported suite 340/342. The named `opsz` backup-freshness failure was present on the clean tree and is unrelated. Setup did not rerun it or infer other test outcomes from the count.
- CI green; release gate `approved:true`; `v4.1.2` tag; multi-arch GHCR image; `verify-release.sh` PASS; digest-based `/opt/mega-xo` release with pre-deploy snapshot; `/`, `/livez`, `/opsz` each 200; production strings verified; ledger updated.

These observations are accepted as owner-reported ground truth, corroborated where applicable by EXT-17. They are not claimed as fresh local execution, live SSH inspection or a new restore drill.

## Production safety boundary

Current durable authority remains V4 Node/SQLite; no V5 import, cutover epoch or first PostgreSQL application write. V5-platform was created without altering V4.1/main/tags, production services, DNS, credentials or ingress.

Direct runtime/recovery evidence now supplements the historical release report: app digest/revision matches v4.1.2; livez/opsz healthy; exactly one edge owns 80/443; timers/co-hosted services preserved. The backup process still uses immutable v4.1.1, successfully checked/retrieved/restored. Snapshot `f884e43b` (471,040 bytes) restored byte-identically with integrity/schema verification to an isolated target, then only that owned temporary target was removed. Installed deployment path `/tmp/mega-release-f1e5577/deploy` was resolved from Compose labels; four deployed files match local hashes. [Live evidence](evidence/phase00-live-operations.json). Provider monitor/package visibility and native evidence remain separately scoped inventory work, not an asserted outage.

## Carried local work

Entry status contained only untracked additions: `.agents/`, `AGENT-GOAL.md`, `Mega-XO-V5-Implementation-Pack/`, `docs/Handoff/`, `skills-lock.json`. None were reset, cleaned, stashed, moved, rewritten or blanket-staged. V5 adds `AGENTS.md` and `docs/v5/`. Only explicitly identified approved source/goal/pack/progress/CI files enter V5 checkpoints; unrelated local skills remain carried until deliberately reviewed.

## Local execution/storage observation

`node --version`: `v26.8.2`; `python3 --version`: `3.14.4`. These are observed tools, not final V5 toolchain pins. Root package has no dependency lockfile at setup; do not assume `npm ci` is the baseline command.

`df -h / /Volumes /Volumes/T9`: Mac data volume 22 GiB available, 90% used; T9 mounted at `/Volumes/T9`, 858 GiB available. T9 is an owner-authorized overflow candidate, not yet a configured build location. DGX Spark access/storage was authorized but not inspected; no guessed host/path or capacity claim.

Structured observations and exact commands: [evidence/setup.json](evidence/setup.json). Program status: [progress.json](progress.json).
