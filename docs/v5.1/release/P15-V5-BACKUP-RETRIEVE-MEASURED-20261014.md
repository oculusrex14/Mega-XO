# Stage A — V5 backup / independent R2 retrieve / measured RPO-RTO (2026-10-14)

Executed by Main under the owner's 2026-10-14 authorization. All numbers below are from real runs
against the **production** Neon database and the **V5-only** Cloudflare R2 bucket.

## 1. Isolated V5 R2 target (new, separate from V4)

| Field | Value |
| --- | --- |
| Cloudflare account | `2f05f9d1ae66c7ebbd02349ba5b5c0ec` (OAuth `oculusrexai@gmail.com`, CLI-verified) |
| V4 repository (untouched) | bucket `mega-xo-backups`, prefix `mega-xo-v4-production` |
| **V5 bucket (new)** | `mega-xo-v5-dr-archives`, created `2026-10-14T01:11:35Z`, location ENAM, jurisdiction default |
| V5 prefix | `megaxo/v5/pg16-encrypted/v1/` (the P15 contract's fixed prefix) |
| Writer credential | bucket-scoped R2 API token `53582a59…`, permission groups *Workers R2 Storage Bucket Item Write + Read*, resource `com.…edge.r2.bucket.<acct>_default_mega-xo-v5-dr-archives` |
| Independent reader credential | bucket-scoped token `d2641a06…`, *Bucket Item Read* only |
| Secret derivation | Access Key ID = token `id`; Secret Access Key = `sha256(token value)` — per the Cloudflare R2 token documentation |

Credentials are stored privately at `~/MegaXO-private/v5-r2/credentials.json` (0600, outside Git);
never printed, never committed.

**Verified separation:** the writer performed a real authenticated write (PUT 200); the reader read
it back (GET 200) and its own write attempt failed (`Access Denied`), confirming read-only scope.
The V4 repository/bucket was never written, initialised, pruned or deleted.

## 2. Real production PostgreSQL backup

`scripts/v5/p15/backup-cli.js` as `backup_reader` over a direct TLS connection to production Neon:

```
{"realSourceDump":true,"ciphertextBytes":224362,
 "ciphertextSha256":"9fc3fa9a0b80044b241736ea3c5a435cf5028824c4f2c1af7ab4b2ed804b9cd6"}
```

- Format `mega-v5-p15-backup-manifest/v1`; `pgMajor 16`; `backupRunClass REAL_DIRECT_PG16_DUMP`.
- `plaintextTemporaryFileCreated:false` — `pg_dump` stdout streams straight into the AES-256-GCM
  sealer; no plaintext dump file is ever written.
- `includesClusterGlobalRolesOrSecrets:false`.
- **Measured backup wall time: 36.1 s** (source `424923af…`, archive 224 362 B).

## 3. Authenticated decryption and restore into an isolated cluster

- `authenticateArchive` (full AES-GCM tag pass) → `AUTH_OK`, sourceSha `424923af…`.
- `decryptToWritable` → 223 320 B that `pg_restore --list` confirms as a real PostgreSQL 16 custom
  archive (405 TOC entries, 78 `TABLE DATA` entries).
- Restored into a **separate disposable** PostgreSQL 16 cluster on loopback (`initdb`, own port),
  never into a serving database and never over the production database.

## 4. Independent R2 retrieve

| Step | Result |
| --- | --- |
| Writer PUT `…d356be745e93677.mxb` + `.manifest.json` | **200**, 224 362 B uploaded |
| Independent reader GET (separate credential) | **200**, 224 362 B |
| Retrieved sha256 | `9fc3fa9a0b80044b241736ea3c5a435cf5028824c4f2c1af7ab4b2ed804b9cd6` — **exactly equals the archive's** |

## 5. Real defects found and fixed on this path

1. **`backup_reader` could not run a stock `pg_dump` at all** — two independent gaps:
   - the `v5_migration` ledger schema was missing from 0026's enumerated grant list →
     `permission denied for schema v5_migration` (fixed by migration **0050**);
   - the `learning` capture schema is referenced by CONSTRAINT TRIGGERs on
     `match.matches`/`tournament.*`/`privacy.requests`, but backup_reader had no reachability →
     `permission denied for schema learning` (fixed by migration **0051**, which grants **schema
     USAGE only** — `SELECT` on every capture table still fails).
   - Both were applied to production (ledger now at **51/51**) and exercised on a disposable lab
     first.
2. **The production target could not reach any TLS root certificate** — `buildPgEnv` never passed a
   CA, so `verify-full` aborted with `root certificate file does not exist`. Fixed by requiring
   `P15_PGSSLROOTCERT` (absolute, 0600, regular file) for any `verify-full` target.

## 6. Measured availability targets

| Measure | Value | Target | Status |
| --- | --- | --- | --- |
| Backup wall time (RPO-class, full logical dump + seal) | **36.1 s** | 15 min RPO | **within** |
| Restore of the archive into an isolated PG16 | **< 1 s** for this dataset | 60 min RTO | **within** |
| Archive size | 224 362 B ciphertext (223 320 B plaintext) | — | — |

Caveat stated plainly: the current production dataset is 2 actors / 2 matches / 307 coins, so both
figures are small-data measurements. RPO/RTO must be re-measured against a realistic history before
the operations limits are signed off; the mechanism (bounded `pg_dump` → streaming seal → upload →
independent retrieve → isolated restore) is proven.

## 7. Key custody

The recovery keypair is RSA-3072 (`openssl genrsa 3072`). The **public** key is the only material a
backup runner may hold; the **private** key is retained off-host at
`~/MegaXO-private/v5-recovery-key/` (0600) and is required for every decrypt. Losing it makes the
archives unrecoverable by design.

## 8. Not claimed

- `nonserving` remains true; no API/Core/worker points at the production database.
- Automatic scheduling, freshness alerting and recurring drills are separate Stage-A items.
- Neon PITR (branch-level point-in-time recovery) is a separate item from this logical-dump path.
