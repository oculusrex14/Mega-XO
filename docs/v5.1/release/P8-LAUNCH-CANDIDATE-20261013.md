# P8 launch-candidate preparation (reversible) — 2026-10-13

Reversible, no-production-write preparation for the eventual P22 cutover. Everything here is
**preparation**; no production write, no authority transfer, no V4 change occurred.

## Launch candidate source freeze (created + verified)

`node scripts/v5/release-source-candidate.js create --sha <HEAD> --output .artifacts/v5-launch-candidate.json`
produces a deterministic, re-verifiable source candidate:

| Field | Value |
| --- | --- |
| Git SHA | `8f8219c5533ab85c29b96360585eb02d9666447d` |
| Candidate content hash | `fe2839fae899c64655ba189159cc8577a7287cd7ee66f5013bb017bcca077f1b` |
| Verify | `release-source-candidate verify --sha <HEAD> --file …` → `V5_SOURCE_CANDIDATE_OK … (NOT DEPLOYABLE)` |

The candidate is intentionally `NOT DEPLOYABLE`: it records the frozen source + schema/protocol
evidence, and it does not authorize a deployment. Re-running `create` at the same SHA reproduces the
same content hash (deterministic).

## Cutover readiness tooling (static, all deny live deployment)

The committed P22 tools are **declarative validators that always deny live cutover** (`P22-CUTOVER-READINESS.md`):
`readiness.js` (requires accepted G00–G20 + exact SHAs/immutable images + 12 evidence classes),
`writer-fence.js` (16 mutation classes + frozen-V4 restart fence + prewrite V5 denial),
`import-reconciliation.js`, `rollback-policy.js`, `compatibility-map.js`. All 30 `v5-p22-*` tests pass on
V5.1, and the `V5 P22 cutover readiness safeguards` CI lane is green.

## Production authority recon (read-only, done)

`PRODUCTION-AUTHORITY-RECON-20261013.md`: live authority is V4.1.2/SQLite, image
`ghcr.io/oculusrex14/mega-xo@sha256:71d33a1a…`, one caddy ingress on host 80/443, three product
containers, staging isolated on loopback. Reconfirmed this session; no write.

## What the owner go/no-go decision covers (not done — needs authorization)

1. **Final source/image freeze**: pin the V5 application image by immutable digest at the approved SHA.
2. **V4 backup + restore validation + export snapshot**: take the frozen V4 SQLite snapshot, restore it
   into an isolated target, and export the migration source — on the production host, in a maintenance
   window the owner approves.
3. **Per-actor import + reconciliation**: run the tested importer against the non-serving production
   PostgreSQL target and prove zero unexplained per-actor/asset/relationship/reservation differences.
4. **PostgreSQL sole-authority + single-writer fence**: enable the V5 writer, fence every V4 writer, and
   log the authority epoch + first V5 application write (the irreversible boundary).
5. **Worker/callback readiness + monitoring**; **readiness/rollback-class/recovery rehearsal**.
6. **Execute the tested cutover runbook**, verify production, then retire V4 authority (P23) while
   retaining the approved recovery artifacts.

## Requested decision

One concise owner **go/no-go** for the irreversible production cutover, once the candidate above passes
its mandatory gates (P8 items 1–5). Until then, V5 stays non-serving and V4 remains the sole writer.
