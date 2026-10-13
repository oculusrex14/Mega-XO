# Gameplay-capture collector — isolated staging deploy + real capture acceptance (2026-10-13)

Scope: deploy the merged DC00–DC12 collector (PR #12 → `V5.1`) to the **isolated Oracle staging
Neon** project and run the real capture acceptance (Priority 7 steps 5–8). Every number below is
from a real run against **either** the staging database **or** a disposable owned PG16 lab that
this deploy provisioned and states explicitly. **Live collection was NOT enabled on staging** and
**no production resource was touched**. DC00 remains an owner approval gate.

| Fact | Value |
| --- | --- |
| Repo / branch | `Test XO` @ `V5.1`, HEAD `8569100e46d72bb00e7dcf197ce787ec74da7945` (pre-existing; deploy changed no committed source except the migration defect fix below) |
| Staging Neon project | `lively-shadow-52629967` / branch `br-falling-resonance-b87qm6iz` / DB `mega_xo_v5_staging` |
| Staging endpoint | `ep-red-waterfall-b880jir8.c-14.us-east-1.aws.neon.tech` (direct), `nonserving:true`, PG16, 0.25 CU fixed |
| Target inventory | `docs/v5/environments/staging.json` (unchanged) |
| Migration runner | `scripts/v5/migrate.js` (`--dry-run`/`--execute`/`--verify`) |
| Capture CLI | `scripts/gameplay-capture.cjs` (`worker|reconcile|metrics|erase|suppress|export|journal|restore-journal|purge-exports|gate`) |
| Evidence retained (private, 0600) | `~/Downloads/Mega-XO-private-evidence/v5-neon-staging/run/capture-20261013/` |

---

## 0. One real defect found and fixed before migrations could apply

`node scripts/v5/migrate.js --execute` against staging failed on the **first** migration at file 44:

```
{"id":44,"name":"0044_gameplay_capture","status":"failed","pgCode":"0LP01",
 "message":"ADMIN option cannot be granted back to your own grantor"}
```

Root cause (reproduced identically on a local PG16 cluster with a `migration_owner` LOGIN
`CREATEROLE` owner, the Neon pattern): migration `0044` ran `GRANT <capture_role> TO migration_owner
WITH ADMIN OPTION` **unconditionally**, but PostgreSQL 16 already auto-grants ADMIN OPTION on a role
to the `CREATEROLE` principal that *created* it — and the runner session **is** `migration_owner`.
Re-granting ADMIN back to your own grantor is SQLSTATE `0LP01`. Migration `0001` already guards this
exact grant with an `IF NOT EXISTS(... admin_option)` check; `0044` did not.

Fix (only committed source change in this deploy): `packages/migrations/migrations/0044_gameplay_capture.sql`
now mirrors `0001`'s idempotent guard, and `packages/migrations/manifest.json` records the new
checksum `62c8eac536c6cf8798a3f54737250663a10732dda1f7c65fcffe1ce1c651d226`. This is a pure
forward fix: the failed `0044` transaction rolled back atomically, so the staging ledger stayed at
43 and the new checksum applied cleanly. Verified on the local sim (49/49 apply) **before**
re-running staging.

---

## 1. Migrations 0044–0049 on real staging — applied cleanly

`--verify` **before** apply (`verify-before.json`): `ok:true, checked:49, code:"OK", failures:[]`
(43 applied checksums valid, 0044–0049 reported pending by `--dry-run`).

`--execute` result:

```
code: OK   appliedCount: 6   channelBinding.observedMechanism: SCRAM-SHA-256-PLUS
44 0044_gameplay_capture               applied 1943ms
45 0045_gameplay_capture_lifecycle     applied 1748ms
46 0046_gameplay_source_fidelity       applied 1639ms
47 0047_gameplay_intent_integrity      applied 1834ms
48 0048_gameplay_unstarted_void_exclusion applied 1583ms
49 0049_gameplay_release_source_binding applied 1572ms
```

`--verify` **after** apply (`verify-after.json`): `ok:true, checked:49, code:"OK", failures:[]`
(`49 checksums + catalog conformance`, SCRAM-SHA-256-PLUS, channel binding enforced).

Re-running `--execute` is an idempotent no-op: `appliedCount:0, plan:[]` (`migrate-idempotent.json`).

**Ledger before/after (real):** `meta.migrations` rows **43 → 49**; max id **43 → 49**. Exact applied
checksums (from the staging ledger, not the files):

| id | name | sha256 |
| --- | --- | --- |
| 44 | `0044_gameplay_capture` | `62c8eac536c6cf8798a3f54737250663a10732dda1f7c65fcffe1ce1c651d226` |
| 45 | `0045_gameplay_capture_lifecycle` | `0c38cb0e4b6b0955b2b99a0a68c3e3f24e3d6405881a4d0ef1d7c26a7397d924` |
| 46 | `0046_gameplay_source_fidelity` | `0212edd3ee8f243a99971f81148c6b1c1cf7b14b9947229c338d44f14d3a0091` |
| 47 | `0047_gameplay_intent_integrity` | `796fd94be5fad8a1f83a731c096633c0918da0d0be18efa1f7795d8d5f479977` |
| 48 | `0048_gameplay_unstarted_void_exclusion` | `ccd253c94651fdc59f3c45006fe2143681194b11c675fafb7225caf7daeb3de3` |
| 49 | `0049_gameplay_release_source_binding` | `82cb1fe57bad526b4b0b468ffe5b14c6763eef80cc041d4f802a4558e0e574db` |

Both `--verify` runs were channel-binding-enforced (`SCRAM-SHA-256-PLUS`); both `--execute` runs too.

---

## 2. Capture roles on staging — exact least-privilege grants, 0 table privileges

The migrations create `capture_runtime`, `capture_exporter`, `capture_privacy` as
`NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`. `migration_owner` holds
ADMIN OPTION on each (management only; confirmed `pg_has_role(...,'MEMBER')=t`
but `pg_has_role(...,'USAGE')=f` → no privilege inheritance). Staging had **no** capture roles
before; the migration created them. This deploy turned the three into exact LOGIN principals with
generated 256-bit secrets using the migration's own role DDL + a private operator step
(`provision-capture-roles.cjs`, 0600) — the same pattern `scripts/v5/provision-pg-roles.js` uses,
which is hard-wired to the five runtime roles and does not cover capture roles. Secret envelope:
`capture-roles.json` (0600, outside Git; never printed).

### Catalog probe — functions each role can EXECUTE (real staging)

| Role | Executable functions in `learning` |
| --- | --- |
| `capture_runtime` | `configuration()`, `claim(w,n,lease_ms)`, `finish(cid,w,f,body,expected_source)`, `reject(cid,w,f,err,retry)`, `reconcile(k,after_key,n,audit)`, `metrics()`, `project(cid)` — **7** |
| `capture_exporter` | `configuration()`, `begin_export(run,key_name,seed,required_epoch)`, `export_page(run,after_id,n)`, `export_member(run,cid)`, `finish_export(run,receipt)`, `export_status(run)`, `revoke_export(run)` — **7** |
| `capture_privacy` | `configuration()`, `suppress(actor,why)`, `erase(n)`, `privacy_page(after_id,n)`, `erasure_page(after_id,n)`, `replay_erasure(cid)`, `restore_watermark(required_epoch)` — **7** |

`learning.project_unfenced` and `learning.finish_validated` are explicitly `REVOKE`d from
`capture_runtime` (0047). `learning.capture_id`, `learning.ms`, `learning.immutable_capture`,
`learning.enqueue`, `learning.source`, `learning.prune_guard`, trigger functions etc. are **not**
executable by any capture role.

### Catalog probe — table/schema privileges (real staging)

- `learning` tables+sequences: **9**. ACL grants in `learning` to `capture_runtime`,
  `capture_exporter`, `capture_privacy`: **0**. To `api_runtime`, `core_runtime`,
  `worker_runtime`, `backup_reader`, `audit_runtime`: **0**. The only `learning` ACL grantee is the
  schema owner `v5_owner` (63 grants). No runtime role is the table owner.
- Schema USAGE on `learning`: only the three capture roles.
- All capture functions are `SECURITY DEFINER` with `search_path=pg_catalog, learning, pg_temp`.

### Live exact-role login probe (real staging sessions)

Each role was connected with its own credentials against staging:

| Role | `learning.captures` | `learning.capture_subjects` | `economy.wallets` | `learning.configuration()` |
| --- | --- | --- | --- | --- |
| `capture_runtime` | **42501** | **42501** | **42501** | **ALLOWED** |
| `capture_exporter` | **42501** | **42501** | **42501** | **ALLOWED** |
| `capture_privacy` | **42501** | **42501** | **42501** | **ALLOWED** |
| `api_runtime` | 42501 | 42501 | 42501 | 42501 |
| `core_runtime` | 42501 | 42501 | ALLOWED (economy is Core-owned) | 42501 |
| `worker_runtime` | 42501 | 42501 | 42501 | 42501 |
| `backup_reader` | 42501 | 42501 | ALLOWED (read-all contract) | 42501 |
| `audit_runtime` | 42501 | 42501 | 42501 | 42501 |

No capture role can read the private archive tables directly, invoke a capture function outside its
lane, or touch economy. No general-purpose runtime role gained any private-capture read. This is the
least-privilege surface the merged collector intends.

---

## 3. Real capture acceptance — shipped CLI against real terminal games

Staging cannot yet carry a real cohort (its `Core` is the isolated P21 origin with two synthetic
actors; **no DC00 approval exists**, so collection is disabled and no genuine player games exist).
Per the ticket, the populated acceptance therefore runs against a **disposable owned PG16 lab**
(`v5_test_p05lab_capacc_*`, loopback `127.0.0.1:55461`) that this deploy provisioned: the **real
checksummed chain 0001–0049**, the **real Core service** (`packages/services/core.js`) playing real
terminal matches, and the **shipped `scripts/gameplay-capture.cjs`** invoked as a one-shot binary for
every mode through the exact-role connection lane. Full report:
`run/capture-20261013/disposable-lab-acceptance.json`.

### 3a. Real staging CLI first (disabled policy — fail-closed proof)

Against **real staging**, with `CAPTURE_ENV=staging`, `CAPTURE_TARGET_FILE=docs/v5/environments/staging.json`,
pinned CA, `CAPTURE_POOL_MAX=2`, exact role connection:

- `worker` → `{"disabled":true,"claimed":0,"sealed":0,...}` (no claim attempted).
- `metrics` → all zeros.
- `reconcile` → exit 1, `CAPTURE_DISABLED` (the reconciler also refuses while disabled).
- `gate` → `BLOCKED`, `productionAuthorized:false`, `trainingAuthorized:false` (see §7).

### 3b. Real gameplay produced (disposable lab)

Real Core queue/direct/ranked matches: **6 terminal matches enqueued** covering full-board line
(FINISHED), full-board draw (FINISHED), resignation, timeout, an **offered void** (never started →
excluded), a direct-rated match — plus 1 match mutated after settlement (drift → quarantine), and a
**tournament** with 2 fixture attempts (draw then resign). Result:
`intentsEnqueued = 9`, `captureOutboxRows = 9` (1 committed intent per terminal source, 0 after
rollback). The 25 paired latency games added `totalIntentsAfterLatency = 47`.

### 3c. Shipped CLI results on that real data

| Mode | Real output |
| --- | --- |
| `worker` (tick 1) | `claimed:8, sealed:6, quarantined:1, excluded:1, errors:{CAPTURE_INTENT_SOURCE_CHANGED:1}` |
| `metrics` | `sealed:6, pending:39, excluded:1, quarantined:1, expiredUnpurged:0, oldestPendingSeconds:17.34` |
| `reconcile` | `scanned:85, repaired:39` |
| `worker` (tick 2) | `claimed:8, sealed:8` (idempotent; no duplicate) |
| `metrics` | `sealed:14, pending:70, excluded:1, quarantined:1` |
| bounded drain (`worker` × 8) | `claimed [8,8,8,8,8,8,7,0]` (55 total); backlog driven to **pending:0, sealed:85** |
| `export` | 116 records; 3 games; 112 positions; `plainSha256 c2dad0d3…`, `cipherSha256 e7195041…` |
| `export` read-back | 116 records authenticated; 3 `train` games; **no** `startedAt` leak in any game record |

Counts reconcile exactly: `pending + sealed + quarantined + excluded + suppressed = total intents`
at every snapshot; after drain `pending=0`, `oldestPendingSeconds=0`. `oldestPendingSeconds` was real
(≈15–17 s) while the backlog was drained by repeated one-shot ticks — the external-supervisor
cadence, not an in-process loop.

### 3d. Real export contents and lineage (shipped `export`)

`export` scanned 85 sealed games; `accepted:84` (1 excluded as `SOURCE_RISK_FLAGGED` via the mutated
drift match), `qualificationWithheld:81` (the D4 opening-6 family split reserves these), `duplicates:1`,
`bySplit {qualification:81, train:3}`, `byReason {draw:2, line:1}`. No actor id, source id or UTC
timestamp appears in the archive; the pseudonymous game key is an HMAC; the qualification split is
counted but never emitted.

---

## 4. Outbox retry / outage / deletion / reconciliation — what was exercised

All against the shipped CLI:

| Behaviour | How it was exercised | Real result |
| --- | --- | --- |
| **Lost queue/notification** (Redis-loss equivalent) | Deleted a committed `ops.outbox` intent for a pending capture | `capture` intent deleted; source row can no longer be pruned (`CAPTURE_SOURCE_STILL_REQUIRED`) |
| **Reconciliation repair** | `reconcile` then `worker` after the delete | `reconcile {scanned:85, repaired:1}`; `worker sealed:8` — the missing intent was rebuilt from the durable source and sealed |
| **Outage / lease steal** | Claimed with a 1 s lease under `killed-worker`, let it expire, then shipped `worker` | reclaimed and `sealed:1`; no duplicate `(source_kind,source_id,attempt)` row |
| **Stale-lease fencing** | Second worker tick after seal | `claimed:0`; sealed row cannot be re-finished |
| **Source drift after settlement** | Mutated `match.matches.revision` post-commit | quarantined once with `CAPTURE_INTENT_SOURCE_CHANGED` (never a fabricated game) |
| **Never-started void** | Offered-then-voided match | `excluded:1` (explicit exclusion, not `CAPTURE_SYMBOLS`) |
| **Deletion (user choice)** | shipped `suppress` (`user-choice`) | `{suppressed:true, epoch:"1"}` → privacy epoch 1 |
| **Erasure sweep** | shipped `erase` | `{erased:87}` → `payload`/`source_token` cleared, subjects deleted, tombstones written |
| **Export revocation + purge** | shrink then `purge-exports` | prior export file purged (`{purged:1}`) |
| **Encrypted privacy journal** | shipped `journal` (after suppression + erasure) | 89 records, epoch 2, `suppressions:1, erasures:87`; `cipherSha256 1708c909…` |

**Not exercised here (stated, not skipped silently):**

- **Account-deletion via the real `privacy.requests` trigger** — the lab has no HTTP identity
  service; the trigger path is covered by the collector's own PG suite, not re-run here. The shipped
  `suppress`/`erase` CLI paths *were* run.
- **Real PG restart / real Redis outage** — no Redis is a dependency of the capture path in the lab
  (intents are Postgres-authoritative), and a real restart needs the owned service-container hook
  that is CI-only (`CAPTURE_TEST_PG_CONTAINER`). Not run in this deploy.
- **Isolated restore + journal replay** (`restore-journal`) — needs a second isolated
  collection-disabled target; the collector's suite covers it. Not run here.

---

## 5. Storage usage — real bytes and a cost projection

Measured on the 85 sealed real games (lab), and on the real encrypted archive the exporter wrote:

- Per sealed game, raw canonical payload (UTF-8 text): mean **1,664 B**, p50 **1,539 B**,
  p95 **1,540 B**, min 1,421 B, max 5,561 B (the max is the long full-board game).
- Per sealed game, gzip level-6 of that payload: mean **635 B**, p50 **615 B**, p95 **617 B**,
  min 595 B, max 1,260 B → **≈2.6× compression**.
- Postgres storage of the payload column is smaller than the raw text (`pg_column_size` sum
  75,839 B vs `octet_length` 141,480 B) because Postgres TOAST-compresses large payloads.
- The real encrypted archive: **54,227 B for 116 records ≈ 467 B/record** (AES-256-GCM + gzip).

**Projection** (linear from measured means; stated as a projection, not a measured SLA):

| Games/day | Raw PG payload | Encrypted+gzip archive |
| --- | --- | --- |
| 1,000 | ≈0.61 GB/yr | ≈0.23 GB/yr |
| 10,000 | ≈6.1 GB/yr | ≈2.3 GB/yr |
| 100,000 | ≈61 GB/yr | ≈23 GB/yr |

Caveats (honest limits): real games skew longer than the lab's short games, so per-game bytes will
be **larger**; total cost also includes WAL, the `ops.outbox` intent rows, `capture_subjects` reverse
lookups, and **backups** — none of which are fully measured here. At the staging policy's fixed
0.25 CU this is dominated by compute, not by these object sizes. This is a real-bytes projection,
**not** a provider quote or a production storage SLA.

---

## 6. Performance — capture ON vs OFF latency

Paired-order real-Core measurement on the lab (backlog growing, worker not running during gameplay),
25 alternating blocks, warmup excluded:

| Metric | Capture ON | Capture OFF | Δ (ON−OFF) |
| --- | --- | --- | --- |
| move p50 | 25.588 ms | 25.870 ms | −0.282 ms |
| move p95 | 32.116 ms | 32.211 ms | **−0.095 ms** |
| move n | 152 | 156 | |
| settlement p50 | 27.603 ms | 25.701 ms | +1.902 ms |
| settlement p95 | 40.682 ms | 33.002 ms | +7.680 ms |
| settlement n | 38 | 39 | |

The ON/OFF p95 deltas are **dominated by run-to-run noise** at this sample size and the sign flips
between runs: across repeated runs move Δp95 ranged from −2.5 ms to +4.8 ms and settlement Δp95 from
−1.6 ms to +7.7 ms, with no consistent direction. The honest conclusion is: **the capture trigger is
not deterministically adding a p95 slowdown beyond loopback noise on a 0.25-CU-class path**, but this
lab cannot resolve a sub-millisecond effect, and it is **not** a staging SLA. The settlement path
opens a Core transaction that commits the deferred trigger, so any real overhead would appear there;
here it is inside noise. The latency budget must be measured on a real staging cohort with a real
player load before any quota sign-off. (Prior synthetic CI pairing reported move p95 +1.094 ms /
settlement p95 +2.306 ms on a noisy shared runner; the estimates are not directly comparable.)

---

## 7. The exact DC00 owner gate (what must be true before collection is enabled)

Collection is DISABLED on staging (`learning.policy.enabled=false`), and it **cannot** be enabled
without real owner-supplied references — the DB `CHECK` refuses `enabled=true` unless
`policy_version`, `approval_ref`, `encryption_ref`, `choice_ref`, `capture_after`, all three
retention windows, `source_commit`, `rules_hash` and `environment` are non-null. The shipped `gate`
against staging returns **`BLOCKED`** (`productionAuthorized:false`, `trainingAuthorized:false`) with
failures `COLLECTION_DISABLED`, `DEPLOYED_POLICY_SOURCE_MISMATCH`, `RULES_HASH_MISMATCH`,
`POLICY_VERSION_REQUIRED`, `REAL_TARGET_REQUIRED`, `SEALED_CANARY_REQUIRED`, `RECEIPT_BINDING` and
all 15 `MISSING_*` evidence keys.

**DC00 is an OWNER decision. This deploy did not fabricate an approval and must not be read as one.**
The owner must, on the record, approve (see `docs/legal/LEGAL-APPROVAL-CHECKLIST.md` and
`docs/legal/DATA-INVENTORY-RETENTION.md` §7/§9):

1. **Lawful basis / purpose** — that observing gameplay is necessary (or rests on an explicit user
   choice) at all.
2. **Notice + choice** — public Privacy Policy, in-app notice/opt-out, and the user-choice/account-
   deletion control that routes to `learning.suppress` with an **authenticated** actor identity
   (never a client-asserted field).
3. **Retention windows** — specific positive `retention_days`, `export_retention_days`,
   `backup_retention_days`, and a `capture_after` cutoff for the canary cohort.
4. **Storage + key custody** — approved region/processor, encrypted storage reference, dedicated
   32-byte AES journal/export keys and HMAC pseudonym keys with rotation/expiry and no public bucket.
5. **Store disclosures** — Apple App Privacy and Google Play Data-safety answers updated.
6. **Operator references** — real, non-synthetic `approval_ref`, `encryption_ref`, `choice_ref`,
   the exact deployed `source_commit`, the verified canonical `rules_hash`
   (`e6e14c258b4db439eedf28090ebafd0962867bab5e64709d0d4438cb145b31e0`), and the environment.

Until then, only a **canary on isolated staging** may be enabled, bound to that exact source SHA and
rules hash, with a sealed canary game and a fully evidenced day-one receipt — and even a green
receipt yields `productionAuthorized:false` / `trainingAuthorized:false` and requires separate human
go/no-go. **No training or model promotion is authorized.**

---

## 8. Reproduce

```sh
# 1) migrations (staging; requires MIGRATE_CONFIRM = exact db name)
V5_TARGET=staging node scripts/v5/migrate.js --verify  --json --database-url "$MIGRATION_URL"
V5_TARGET=staging MIGRATE_CONFIRM=mega_xo_v5_staging \
  node scripts/v5/migrate.js --execute --json --database-url "$MIGRATION_URL"

# 2) provision capture LOGIN roles (private operator step; never committed)
node <private>/provision-capture-roles.cjs --execute

# 3) staging CLI fail-closed proof (collection stays disabled)
CAPTURE_ENV=staging CAPTURE_TARGET_FILE=docs/v5/environments/staging.json \
CAPTURE_PG_ROOTCERT=<ca.pem> CAPTURE_POOL_MAX=2 \
CAPTURE_PG_URL='postgresql://capture_runtime:<pw>@<direct-host>/mega_xo_v5_staging?sslmode=verify-full' \
  node scripts/gameplay-capture.cjs worker   # -> {"disabled":true,...}

# 4) populated acceptance on the disposable lab (real Core games + shipped CLI)
node .artifacts/gameplay-capture-acceptance/driver.cjs '{"file":".artifacts/gameplay-capture-acceptance/acceptance.json"}'
```

## Rollback

Disable `learning.policy.enabled` (one row). Existing gameplay, balances and match finalization are
served by the unmodified Core paths and never depended on capture. Disabling does not erase already
retained data or privacy tombstones. The capture schema is additive and was never dropped. The
`0044` fix is forward-only and changes no previously-applied migration.

## What remains owner/Main-owned (not done here)

- A **real staging cohort** and a real staging latency/backlog measurement (needs DC00 approval plus
  a real Core with real actors on the isolated staging DB).
- Real PG-restart / real Redis-outage drills and isolated-restore journal replay (CI service hook).
- Installing the supervised recurring one-shot schedules (worker/reconcile/metrics/erase/
  purge-exports/journal) and alerting thresholds on the staging host.
