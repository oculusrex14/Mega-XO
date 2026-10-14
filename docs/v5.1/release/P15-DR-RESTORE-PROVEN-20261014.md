# R08/G15 — complete production disaster-recovery restore proven (2026-10-14)

The full recovery chain was executed end to end against the **production** database and the
**V5-only** R2 bucket, and the restored data was compared row-for-row with production.

## Chain

```
production Neon  --pg_dump as backup_reader-->  streaming AES-256-GCM seal (RSA-3072)
   --> V5-only R2 bucket  -->  INDEPENDENT reader credential retrieve (sha256 equal)
   --> recover key authenticate + decrypt  -->  isolated PostgreSQL 16 cluster
   --> schema from the immutable migration chain  -->  data-only load  -->  VERIFIED
```

## Procedure (the repeatable operator sequence)

1. **Schema from the immutable chain.** Bring the quarantined target to the sealed schema head with
   the checksummed migrations (`scripts/v5/migrate.js --execute`); this recreates every schema,
   including `learning` and the capture trigger functions that `match.matches`, `tournament.*` and
   `privacy.requests` depend on. Result on this run: **51/51 applied**.
2. **Clear the seeded rows.** `0024_seed_singletons` (and the migration bookkeeping rows) are the
   chain's own content, not the source's; truncate the application tables *and* the bookkeeping
   tables so the archive is the single origin of the data.
3. **Load data only.** `pg_restore --data-only --disable-triggers --single-transaction <archive>`.
   `--data-only` avoids colliding with the chain's schema; `--disable-triggers` keeps the capture
   CONSTRAINT TRIGGERs from firing mid-load. **Measured: 0.07 s.**

## Data equality (production vs isolated restore)

| Relation | Production | Restored |
| --- | --- | --- |
| `identity.actors` | 2 | 2 |
| `economy.wallets` | 2 | 2 |
| `match.matches` | 2 | 2 |
| `identity.profiles` | 2 | 2 |
| `economy.ledger` | 0 | 0 |
| `ops.outbox` | 0 | 0 |
| `monetization.receipts` | 0 | 0 |
| `identity.sessions` | 0 | 0 |
| `meta.migrations` | 51 | 51 |
| `learning.captures` | 0 | 0 |
| **coins / crowns / reserved** | `307 / 0 / 0` | `307 / 0 / 0` |

Every reconciled quantity is identical, including the wallet totals that are the actual player
economy. `learning.captures` is 0 on both sides: the private capture schema is **not** part of the
disaster-recovery archive (it is governed by the DC00 privacy/choice contract), which is the
intended privacy property rather than a gap.

## What this proves and what it does not

**Proves:** a real production backup, taken by the least-privilege backup role, is retrievable by an
**independent** credential, authenticates, decrypts, and restores to byte-level-equivalent durable
data on an isolated cluster using only immutable, checksummed inputs.

**Does not claim:** the production dataset is small (2 actors), so the timing figures are
small-data; a realistic-history drill must re-measure before the operating limits are signed off.
Automatic scheduling, freshness alerting and supervised recurring drills remain separate items.
