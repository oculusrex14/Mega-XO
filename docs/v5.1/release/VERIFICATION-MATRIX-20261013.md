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
