# Production PostgreSQL provisioned (V5.1) — 2026-10-14

Reversible, non-serving preparation of the **production** Neon database. No V4 change, no API/Core
cutover, no traffic switch. Executed by Main after the owner's 2026-10-14 authorization.

## Target (exact)

| Field | Value |
| --- | --- |
| Neon project | `blue-sun-85454968` (`mega-xo-v5-production`, aws-us-east-1) |
| Branch | `br-dawn-dawn-b8f9n7zq` (main) |
| Database | `mega_xo_v5_production` |
| Endpoint | `ep-mute-surf-b8v94ksa.c-14.us-east-1` (direct), PG 16, `nonserving:true` |
| History retention | **21600 s (6 h)** — the PITR window; sets the achievable RPO floor |
| `nonserving` | still `true` (unchanged here) |

## 1. Migrations applied — 49/49, channel-binding enforced

`node scripts/v5/migrate.js --dry-run` reported `plan: 49 pending` (empty database).

`--execute --confirm-production` (`V5_TARGET=production`, `MIGRATE_CONFIRM=mega_xo_v5_production`):

```
ok: true  code: OK  applied: 49
 0001_roles_bootstrap … 0049_gameplay_release_source_binding   (all applied)
```

`--verify`: `ok:true, code:OK, failures:[]`. TLS `verify-full` with the Neon CA; the negotiated
SASL mechanism was **SCRAM-SHA-256-PLUS** (channel binding) on every run.

## 2. Runtime roles provisioned — five LOGIN principals, least privilege

`node scripts/v5/provision-pg-roles.js --confirm-production --execute` → `status:"active"`:

| Role | Connection limit | LOGIN |
| --- | --- | --- |
| `api_runtime` | 16 | yes |
| `core_runtime` | 8 | yes |
| `worker_runtime` | 4 | yes |
| `backup_reader` | 2 | yes |
| `audit_runtime` | 2 | yes |

Credentials persisted privately (0600) outside Git at
`~/Downloads/Mega-XO-private-evidence/v5-neon-production/runtime-roles.json`
(role → password/directUrl/pooledUrl; never printed, never committed).

## 3. Independent least-privilege probe (real production logins)

Each role connected with its own credentials and attempted `SELECT 1` on representative relations.
Evidence: `.artifacts/p3-core-edge/prod-role-probe.json`.

| Role | Can read | Cannot read |
| --- | --- | --- |
| `api_runtime` | `identity.actors`, `identity.sessions`, `identity.email_credentials`, `social.friendships`, `ops.outbox`, `privacy.requests` | `economy.*`, `match.*`, learning capture tables, `audit.operator_audit` |
| `core_runtime` | `identity.actors`, `economy.wallets`, `economy.ledger`, `match.matches`, `social.friendships`, `ops.outbox` | `identity.sessions`, `identity.email_credentials`, learning capture tables, `audit.operator_audit` |
| `worker_runtime` | `ops.outbox`, `privacy.requests` | economy, match, identity, learning capture tables, audit |
| `backup_reader` | every data relation incl. `audit.operator_audit` (stock `pg_dump` contract) | `learning.*` capture tables |
| `audit_runtime` | `audit.operator_audit` only | everything else |

**No general-purpose runtime role can read the private learning/capture tables** — the boundary the
gameplay-capture design requires. This matches migrations 0020–0023 + 0026 (explicit read grants) and
0025 (hardened privileges).

## Not done / gated

- `nonserving` was **not** flipped; no production traffic is served by this database.
- No V4 import, no reconciliation, no authoritative-writer start (E2–E5).
- No secret was printed or committed; only paths and non-secret identifiers appear above.
