# V5.1 backend verification matrix — all suites run (2026-10-13)

Consolidated record of the V5 authority/recovery/security/load suites executed on this machine against
a **disposable** PostgreSQL 16.15 + Redis 7.4 lab (owned loopback, ports 5432/6379), plus the CI lanes.
Every count is a real run. See `P6-BACKEND-VERIFICATION-20261013.md` for commands.

## Executed locally (disposable lab)

| Area | Suites | Result |
| --- | --- | --- |
| Security / session / ticket boundary | `v5-p13-security`, `v5-p11-session-boundary`, `v51-audit-ticket-boundary` | **22/22 pass**, 0 skip |
| Economic authority / idempotency | `v5-p04-services` | **37/37 pass**, 0 skip |
| Durable realtime / timers | `v5-p08-timers` | **8/8 pass** |
| Realtime restart recovery | `v5-p08-restart-recovery` | **6/6 pass** (stalled-client 1008 fixed) |
| Snapshot recovery | `v5-p08-snapshot-recovery` | **5/5 pass** |
| Tournament fencing/recovery/settlement | `v5-p09-fencing`, `v5-p09-recovery`, `v5-p10-worker-hardening` | **pass** |
| Core process failover / drain | `v5-p16-*` | **22/22 pass**, 0 skip |
| Backup / DR / sealed archive | `v5-p15-*` (manifest, backup-cli, data-integrity, drill-readiness, r2-contract, recovery-policy, sealed-archive) | **20/20 pass**, 0 skip |
| Real load (exactly-once at 4 tiers) | `v5-p19-real-services` | **1/1 pass** (evidence `.artifacts/p19-real-disposable.json`) |
| Real chaos | `v5-p19-real-chaos` | **1/1 pass** |
| Cutover readiness / writer-fence / rollback / import-recon / compat | `v5-p22-*` | **30/30 pass** |
| P18 acceptance registry / isolation / topology / public head | `v5-p18-*` | **41 pass / 1 skip** |
| Tutorial / practice / Expert bot | `v51-bot-tutorial`, `v51-p21-bot` | **72/72 pass** |
| Gameplay capture (merged PR #12) | `gameplay-*` | **58 non-PG + 45 PG pass**, 1 skip (container) |

## CI lanes (V5.1, after fixing the branch trigger gap)

`V5 release engineering`, `V5 P15 isolated backup and recovery`, `V5 P16 process failover`,
`V5 P19 disposable load and chaos`, `V5 P18 staging acceptance`, `V5.1 gameplay capture`,
`V5.1 dedicated recovery and chaos gates`, `V5.1 independent audit regression`, `Mega XOXO validation`
— all run on V5.1 and pass on the tip.

## Genuinely open (not a code gap)

- Provider delivery/alerting (monitor IDs, `read:packages`) — needs the provider console (R09).
- Deployed RPO/RTO + provider R2/PITR retrieval — needs the production host + off-host key custody (R08).
- Realistic production-history sizing — measured only on disposable capacity (R19/R32).

## Runtime packaging / deployment reproducibility

- `Dockerfile` pins the base image by immutable digest
  (`node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`), runs as the
  non-root `node` user, has a bounded healthcheck (`/livez`), and copies only `src/ server/ deploy/
  scripts/ packages/` + `package.json`/`index.html` (no secrets, no tests).
- `scripts/image-smoke.sh` is the local/release smoke (read-only rootfs, `cap-drop ALL`,
  `no-new-privileges`, `readyz` probe, root-not-writable assertion, Host/Origin 403, CSP/HttpOnly
  checks) and passes `bash -n`.
- `V5 release engineering` + `V5 CI official service image provenance` CI lanes build/re-verify the
  source candidate and pin service images by digest; both are green on V5.1.
- **Not exercised locally**: this Mac has Docker stopped and ~4.5 GB free, so a local `docker build`
  of the app image was not run here; the image build/smoke is covered by CI and by the Oracle deploy
  path. Deployment reproducibility (same SHA → same image digest) is asserted by the source-candidate
  verify (deterministic content hash) + pinned base digest.

## Observability (P14)

`v5-p14-observability` → **15/15 pass**, 0 skipped: telemetry instrumentation, incident/recovery
event shapes, operator diagnosis routes, and `/opsz` classification verified against real PG.
`deploy/install-monitoring.sh` + `deploy/host-health-monitor.sh` implement the production timers
(`mega-xo-health.timer` active on the host per the live recon). **Delivered** incident/recovery alerts
to a real provider destination, `read:packages` scope and current monitor IDs remain owner/provider
gated (R09).
