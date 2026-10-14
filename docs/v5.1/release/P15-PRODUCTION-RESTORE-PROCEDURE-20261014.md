# P15 production disaster-recovery restore procedure (V5.1) — 2026-10-14

Exact operator sequence for restoring a **sealed, non-serving production** P15 archive
(`sourceKind: nonserving-production-source`) into the quarantined loopback PG16 lab. This is the
procedure implemented and enforced by `scripts/v5/p15/restore-cli.js`; the CLI verifies every
precondition below and refuses with a precise `P15_RESTORE_REFUSED:` code when one does not hold.

Nothing here makes a restore live authority. There is no permission to enable jobs, deliver mail,
replay payments or route customers.

## Why the production archive cannot be restored whole

The production capture is taken with `--exclude-schema=learning`
(`scripts/v5/p15/backup-cli.js`, production source only) because migration 0051 grants
`backup_reader` USAGE on schema `learning` but never table access to it, and the capture contents
are governed by the DC00 privacy/choice contract rather than by the disaster-recovery archive.

Migration 0044 nevertheless installs four `learning.*`-calling objects:

| Object | Table | Calls |
| --- | --- | --- |
| `learning_match_terminal` / `learning_match_prune` | `match.matches` | `learning.match_intent()` / `learning.prune_guard()` |
| `learning_fixture_terminal` / `learning_fixture_prune` | `tournament.fixtures` | `learning.fixture_intent()` / `learning.prune_guard()` |
| `learning_room_void` | `tournament.rooms` | `learning.room_void_intent()` |
| `learning_deletion_requested` | `privacy.requests` | `learning.*` |

So neither whole-archive strategy works:

* **Whole-archive restore into an empty DB** fails: the archived schema section has no `learning`
  schema (it was excluded), so `pg_restore` aborts on those `CREATE CONSTRAINT TRIGGER` statements
  with `ERROR: schema "learning" does not exist`.
* **Pre-applying the migration chain, then whole-archive restore** fails differently: every
  `CREATE` in the archive's schema section now collides with the object the chain already made.

Hence the frozen design: **schema from the immutable migration chain + data from the archive.**

## Operator sequence

`$ARCHIVE`, `$MANIFEST` and `$PRIVATE_PEM` are the sealed archive, its private manifest and the
off-host recovery private key. `$TARGET_JSON` is the `nonproduction-restore` target file.

1. **Pick the sealed pair and check it in the immutable manifest.** Confirm `sourceKind` is
   `nonserving-production-source`, `sourceEnvironment` is `production`,
   `backupRunClass` is `REAL_DIRECT_PG16_DUMP`, and `pgMajor` is `16`. The archive and manifest must
   live in the same private directory, both mode `0600`, and the archive's basename must equal the
   manifest's `ciphertextFile`.

2. **Provision a fresh, empty, loopback PG16 database** and write the target file
   (`format: mega-v5-p15-direct-pg-target/v1`, `kind: nonproduction-restore`,
   `host: 127.0.0.1`, `port: 5432`, `database: v5_p15_restore_<6..48 chars>`,
   `user: postgres`, `sslMode: disable`, `pgMajor: 16`). No other restore host is accepted.

3. **Bring the target to the sealed schema head with the trusted migration runner** — this step is
   the runner's job, never `restore-cli`'s:

   ```
   V5_TARGET=test MIGRATE_CONFIRM=<database> V5_MIGRATE_ALLOW_INSECURE_LOOPBACK=1 \
     node scripts/v5/migrate.js --execute \
       --database-url "postgres://postgres@127.0.0.1:5432/<database>" --json
   ```

   This recreates every schema *including* `learning`, and leaves exactly four chain-minted
   bootstrap rows (`meta.migrations`, `economy.system_burns`, `season.league_week`,
   `runtime.controls`).

4. **Run the restore.** The caller supplies the two quarantine confirmations
   (`P15_RESTORE_JOBS_DISABLED=1`, `P15_RESTORE_PROVIDER_CALLBACKS_DISABLED=1`),
   `V5_P15_DISPOSABLE=1`, `V5_P15_QUARANTINE=1` and `P15_SOURCE_SHA` equal to the checked-out
   commit:

   ```
   P15_SOURCE_SHA=<40-hex> V5_P15_DISPOSABLE=1 V5_P15_QUARANTINE=1 \
   P15_RESTORE_JOBS_DISABLED=1 P15_RESTORE_PROVIDER_CALLBACKS_DISABLED=1 \
     node scripts/v5/p15/restore-cli.js \
       --target "$TARGET_JSON" --manifest "$MANIFEST" --archive "$ARCHIVE" \
       --private-key "$PRIVATE_PEM" --confirm-quarantined-disposable-restore
   ```

## What `restore-cli` does, in order

1. `inspectPair` reads the private manifest, requires the exact checked-out `sourceSha`, checks the
   archive's permissions/size/digest against the immutable manifest, and compares the authenticated
   envelope header against it.
2. `requireRestore` binds the manifest identity to the target kind: only
   `nonserving-production-source` -> `nonproduction-restore` is permitted, and both quarantine
   confirmations plus a `REAL_DIRECT_PG16_DUMP` run class are required.
3. `versionCheck('pg_restore')` must be PostgreSQL 16, and the checked-out
   `packages/migrations/manifest.json` sha256 must equal the sealed `migrationManifestSha256`.
4. **`authenticateArchive` verifies the FULL AES-GCM tag before anything is spawned.** No plaintext
   file is ever written; the second pass streams decryption straight into `pg_restore`'s stdin.
5. `prepareProductionTarget` **verifies (never performs)** the pre-state: `meta.migrations` must
   match the pinned pack row-for-row at the sealed head (id 51) and schema `learning` must exist.
   It then clears exactly the four chain bootstrap rows — the archive carries the authoritative
   production copies of all four — and refuses if any *other* application table already holds rows.
   `learning.*` is chain-owned and is neither required empty nor touched.
6. `pg_restore` runs, reading decrypted bytes from stdin:

   ```
   pg_restore --dbname=<db> --format=custom --no-owner --no-acl --no-tablespaces \
              --data-only --disable-triggers --single-transaction --exit-on-error
   ```

   * `--data-only` loads data only; the schema (including `learning` and its capture functions) is
     the chain's.
   * `--disable-triggers` emits `ALTER TABLE ... DISABLE TRIGGER ALL` around each table's COPY.
     Without it the load fails: the archive's COPY order is the TOC order and it loads
     `economy.daily_progress` before `identity.actors`, so the immediate foreign keys abort. It
     equally keeps the deferred capture CONSTRAINT TRIGGERs from firing mid-load. It is permitted
     only on this loopback superuser lab target.
   * `--single-transaction` keeps the load atomic (a failure leaves nothing behind), so the
     temporarily disabled trigger state can never outlive the load.
   * `--clean`, `--create` and `--drop` are never emitted.
7. The restore result reports `dataOnlyProductionRestore: true`, the verified
   `productionSchemaHeadVerified: 51`, `productionLearningSchemaVerified: true`, the replaced
   `productionChainBootstrapRowsReplaced` counts, and the post-restore table/row counts and
   canonical data digest.

## What this does NOT claim

* `actualSourceAndTargetDataComparisonPerformed`, `roleGrantsAndGlobalSecretsReconstructed`,
  `providerPitrObserved`, `encryptedR2DownloadObserved`, `outboundReenablementAuthorized`,
  `remoteProductionRestore` and `g15Accepted` are all reported `false`.
* The private `learning` capture tables are never restored — they are structurally absent from the
  production archive and are recreated empty by the migration chain.
* An incomplete or refused restore leaves the target quarantined for caller-specific cleanup. There
  is no automated `DROP`/`TRUNCATE` and no automatic reactivation.

## Recorded drill evidence (2026-10-14)

The real sealed archive `v5-p15-2026-10-14T01-33-19-119Z-2d356be745e93677.mxb` (224362 bytes,
sha256 `9fc3fa9a0b80044b241736ea3c5a435cf5028824c4f2c1af7ab4b2ed804b9cd6`) was restored through this
exact sequence into a fresh loopback PG16 database migrated to head 51. The implemented
`restore()` returned `dataOnlyProductionRestore: true`, `productionSchemaHeadVerified: 51`,
`productionLearningSchemaVerified: true` and `applicationTables: 87` / `applicationRows: 389`; the
durable V4-derived data was present (`identity.actors` 2, `identity.profiles` 2,
`economy.wallets` 2, `match.matches` 2, `tournament.rooms` 1, `meta.migrations` 51) and every
`learning` capture table was empty (`learning.captures` 0, `learning.capture_subjects` 0, and 0
captures carrying a payload). Re-running the restore against the now-populated target was refused
(`already holds application rows`), as designed.
