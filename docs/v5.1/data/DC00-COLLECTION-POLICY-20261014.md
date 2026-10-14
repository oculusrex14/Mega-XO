# DC00/R35 — day-one gameplay collection policy (staging canary), 2026-10-14

**Status: DERIVED FROM EXISTING PRIVACY CONTRACTS AND WRITTEN TO STAGING. NOT LEGAL APPROVAL.**

This document derives the collection policy for the already-merged DC00–DC12 gameplay-capture
collector from the privacy/retention contracts that already exist in this repository, records the
exact values written into `learning.policy`, and states precisely which parts are an **owner
authorization** and which parts are still **missing formal sign-off**. It invents no legal basis and
asserts no approval that has not been given.

Every value below is a **proposal for staging, derived from the cited contracts** — the windows and
references are *populated and enforced*, not approved. That distinction is carried through the
release gate: the corresponding receipt categories are deliberately **left out** (see
`docs/v5.1/release/DC00-R35-COLLECTION-EVIDENCE-20261014.md`).

---

## 1. What is being collected, and from where

| Item | Source of truth in this repository |
| --- | --- |
| Collected data class, precise fields, storage/access boundary, deletion+retention decision needed | `docs/legal/DATA-INVENTORY-RETENTION.md` §9 (row "Committed online game capture", "Reconciliation, intent and integrity incidents", "Participant lookup and human/source classification", "Privacy suppression and erasure control", "Export lineage and research dataset", "Encrypted privacy recovery journal and snapshots") |
| Purpose limitation, retention, correction/withdrawal, disclosure and security duties under Indian law | `docs/legal/WEBSITE-POLICY-UPDATE-20261014.md` (IT Rules 2011 Rules 4–8; DPDP Act 2023 commencement note) |
| What the public policy currently says | `public/privacy.html` (line: the gameplay-capture system is **not enabled by that policy** and a specific notice + consent would precede it) |
| Data inventory change-control obligation | `docs/legal/DATA-INVENTORY-RETENTION.md` §8 |
| Enforcement surface (schema that refuses enablement without references) | `packages/migrations/migrations/0044_gameplay_capture.sql:31-45` |
| Runtime projection of the policy | `packages/learning/worker.js` (`learning.configuration()`), `packages/learning/release-gate.js` |
| Account-deletion → capture suppression path | `packages/migrations/migrations/0045_gameplay_capture_lifecycle.sql` (`learning_deletion_requested` trigger, `learning.suppress`) and its production caller `packages/services/accounts.js:1657` (`deleteAccount`) |
| Existing backup prune schedule and its confirmation gate | `scripts/backup-run.js:16-45`, `deploy/R2-BACKUP-RUNBOOK.md` §6 |
| Existing recovery/D-R policy intake (retention explicitly *not* approved) | `scripts/v5/p15/recovery-policy.js` (`privacyDeletionRetentionApproved` in its decision list), `scripts/v5/p15/r2-contract.js:54` (`retentionDeletionApproved:false`) |

---

## 2. Collection purpose (derived, not approved)

**Proposed purpose.** Retain server-authoritative terminal gameplay trajectories of the isolated
staging environment so that the *correctness* of the capture pipeline can be proven end to end:
canonical replay, source binding, retention, deletion propagation and export lineage. This is the
"day-one collection" purpose the owner authorized; it is explicitly **not** a training purpose and
**not** a model-promotion purpose (a released gate still returns `trainingAuthorized:false`).

**Derivation and its limits.** `docs/legal/DATA-INVENTORY-RETENTION.md` §9 already states the
proposed private fields and boundary and marks purpose/notice/retention/processor approval
**PENDING**. `docs/legal/WEBSITE-POLICY-UPDATE-20261014.md` is explicit that it is *not* "consent to
gameplay training" and does not authorize "activation" of the capture behaviour. Therefore:

- **Owner authorization (recorded, this is the reference written to the DB):** the owner's
  2026-10-14 directive authorizes day-one collection and the R35–R38 / DC00–DC12 track. It is
  written verbatim into `learning.policy.approval_ref` as `owner-20261014-dayone-r35`.
- **Still owed (formal sign-off, NOT given):** the privacy-controller determination of the lawful
  basis/purpose, the public-policy notice update that names this specific use, and the processor
  register entry. Until then this purpose statement is an **operator-derived proposal**.

---

## 3. Notice and user choice (derived behaviour, one real gap)

| Element | Where it is implemented | Status |
| --- | --- | --- |
| Notice | `public/privacy.html` (+ `public/privacy-choices.html`) | States the collector is **not enabled** by that policy and that a specific notice would precede it. That specific notice **does not exist yet** — owed. |
| Account-deletion → suppression | `packages/migrations/migrations/0045_gameplay_capture_lifecycle.sql` (`learning.deletion_requested()` trigger on `privacy.requests`, `learning.suppress()`), reached in production code by `packages/services/accounts.js:1657` (`deleteAccount` inserts the `privacy.requests` row) | **Implemented and demonstrated for real** (see the evidence report). Deletion is the only durable choice signal; suppression is synchronous and the erasure sweep follows. |
| Capture-specific opt-out | nowhere | **GAP — does not exist.** No client control lets a player decline capture while continuing to play. `public/privacy-choices.html` does not offer it. |
| Reference written to the DB | `learning.policy.choice_ref = data-inventory-retention-v5.1-s9` | Points at the **data-class definition**, not at a delivered notice. It is deliberately not dressed up as a delivered-control reference. |

**Therefore:** `userChoiceDelivery` in the receipt is claimed **only** on the strength of the real
authenticated deletion path — never on the strength of a notice that has not been published.

---

## 4. Retention periods (populated and enforced; the numbers are unapproved)

Enforcement is real and is what makes the numbers meaningful:

- `packages/migrations/migrations/0044_gameplay_capture.sql` — `enqueue()` sets
  `expires_at = clock_timestamp() + make_interval(days => p.retention_days)`.
- `packages/migrations/migrations/0047_gameplay_intent_integrity.sql` — `learning.limit_retention()`
  bounds that clock by the **source event time** (`COALESCE(receipt_at, last_move_at, started_at,
  created_at)`, and for fixtures the room `created_at` as a conservative upper bound), so retention
  can never be silently extended by a later reconciliation.
- `learning.erase(n)` purges anything past `expires_at`, and `learning.metrics()` surfaces
  `expiredUnpurged`, which the release gate requires to be `0`.

| Window | Value written | Derivation (cited) | Approval status |
| --- | --- | --- | --- |
| `capture_after` | `2026-10-08T00:00:00Z` | The canary cohort cutoff. Chosen so the whole existing terminal-match set on staging is in scope; the oldest eligible terminal source is `2026-10-08T05:14:38Z` and the newest `2026-10-14T00:45:59Z`. | Canary scope decision — **owner-authorized scope, not a legal decision**. |
| `retention_days` | `90` | Bounded to one competitive season-plus-quarter (seasons are calendar quarters, `src/domain.js:31`) so a retained trajectory cannot outlive the competitive context that makes it meaningful. **Derived, not approved.** | **LEGAL/POLICY DECISION REQUIRED** (`DATA-INVENTORY-RETENTION.md` §9: "Approve specific capture retention days, capture start cutoff, backup retention and scope"). |
| `export_retention_days` | `30` | `learning.begin_export` sets `expires_at` from it; exports are intermediate research artifacts whose revocation is immediate and whose file is purged. **Derived.** | **Approve export retention days, access logging, key rotation, publication prohibition and physical deletion after revocation** (§9). |
| `backup_retention_days` | `35` | Matches the retention set the repository's existing Restic prune already implements for V4 (`scripts/backup-run.js:27` — `forget --tag mega-xo-v4 --keep-within 24h --keep-daily 7 --keep-weekly 4`, i.e. 1 within-day + 7 daily + 4 weekly ≈ 35 days). The **V5** production pipeline is not pruned at all (`deploy/R2-BACKUP-RUNBOOK.md:124`, `scripts/v5/p15/r2-contract.js:54` `retentionDeletionApproved:false`), so this value is what a **matching** V5 prune schedule would have to implement before it could be approved. | **LEGAL/POLICY DECISION REQUIRED** (`DATA-INVENTORY-RETENTION.md` §6, `docs/legal/LEGAL-APPROVAL-CHECKLIST.md` section C). |

**Honest statement.** `MEGA_RETENTION_POLICY_VERSION` is empty in `/opt/mega-xo/app.env` on the
staging host `command` (`sudo -n grep` returns `MEGA_RETENTION_POLICY_VERSION=`), and
`docs/legal/DATA-INVENTORY-RETENTION.md` §5 still lists the retained-after-deletion
durations as **LEGAL/POLICY DECISION REQUIRED**. Consequently the receipt's `retention` category is
**left out** rather than asserted from these derived numbers.

---

## 5. Storage, encryption and key custody

| Element | Implementation | Status |
| --- | --- | --- |
| Storage location | Private PostgreSQL `learning.*` schema inside the isolated staging Neon project `lively-shadow-52629967` / database `mega_xo_v5_staging`, endpoint `ep-red-waterfall-b880jir8.c-14.us-east-1.aws.neon.tech` (declared in `docs/v5/environments/staging.json`, `nonserving:true`). | Written to the DB as `learning.policy.environment = staging`. Region/processor approval is **owed**. |
| Table isolation | `learning` tables are reachable only through `SECURITY DEFINER` functions held by `capture_runtime` / `capture_exporter` / `capture_privacy`; zero table ACLs (`0044`, `0045`; re-probed on live staging). | Verified. |
| Encryption at rest (payload) | The sealed payload column is **plaintext JSONB** inside the private database; Postgres TOAST compresses it. Encryption applies to artifacts that leave the database. | Stated plainly — the column itself is not field-encrypted. |
| Encryption for artifacts | `packages/learning/encrypted.js`: `MXOCAP1` container, AES-256-GCM, per-file key derived with HKDF-SHA256 from a 256-bit key, per-record counter nonce, AAD binds the serialized header, authenticated final record commits record count + plaintext digest. | Demonstrated (round trip, tamper-refusing). |
| Key custody | `encryption_ref = keys.sealed.json#mxv5-stg-2026Q4-1-2d (aes-256-gcm+hkdf)`. Key file mode `0600`, never logged, read through `readKey()` which refuses a publicly readable, malformed or symlinked file. Export and journal keys are separate 32-byte files. | Written. **Rotation/expiry, separation of duties and off-host custody are owed.** |
| Recovery journal | `packages/learning/privacy.js` `exportPrivacyJournal` / `replayPrivacyJournal`; replay requires an independently supplied epoch **and** cipher digest, an explicitly isolated target, and refuses a target that still has collection enabled. | Demonstrated (replay into a second collection-disabled database). |

---

## 6. Erasure policy

1. **Trigger.** A verified authenticated deletion writes `privacy.requests(kind='deletion')`
   (`packages/services/accounts.js:1657`); the `learning_deletion_requested` trigger calls
   `learning.suppress(actor,'account-deletion')`, which raises `privacy_epoch`, records the
   suppression, and revokes **all** building/ready exports.
2. **Immediate fencing.** `learning.project()`, `learning.export_page()` and
   `learning.finish_export()` all cross-check suppressions/epoch, so a sealed-but-now-suppressed
   capture cannot be exported and a revoked export cannot be read.
3. **Bounded sweep.** `learning.erase(n)` (scheduled) moves affected or expired rows to
   `suppressed` / `purged`, **nulls `payload`, `payload_sha256`, `source_token`**, deletes
   `capture_subjects` and `rejections`, cancels the dead outbox row, writes an
   `erasure_tombstones` row, and bumps `privacy_epoch` again.
4. **Irreversibility.** `learning.immutable_capture()` raises `CAPTURE_ERASURE_PERMANENT` if anything
   tries to move a suppressed/purged row back.
5. **Backups are never privacy-authoritative.** A restore must replay the newest journal and stays
   collection-disabled until it has.

---

## 7. Exactly what was written into `learning.policy` (staging)

Written by `.artifacts/dc00/enable-policy.cjs`, which refuses any database other than the declared
staging inventory and prints the row before and after:

| Column | Value |
| --- | --- |
| `enabled` | `true` |
| `policy_version` | `mxv5-capture-2026Q4-stage1` |
| `approval_ref` | `owner-20261014-dayone-r35` (owner directive; **not** legal approval) |
| `encryption_ref` | `keys.sealed.json#mxv5-stg-2026Q4-1-2d (aes-256-gcm+hkdf)` |
| `choice_ref` | `data-inventory-retention-v5.1-s9` (the data-class definition) |
| `capture_after` | `2026-10-08T00:00:00Z` |
| `retention_days` | `90` |
| `export_retention_days` | `30` |
| `backup_retention_days` | `35` |
| `source_commit` | `3e51ba0c95d1083fe89e7c6f909e7590cee1a600` (the commit whose bytes are deployed on the staging origin; `deploy-receipt.json`) |
| `rules_hash` | `e6e14c258b4db439eedf28090ebafd0962867bab5e64709d0d4438cb145b31e0` (`sha256(src/game.js)`, recomputed at write time) |
| `environment` | `staging` |
| `privacy_epoch` | `0` (unchanged; no suppression has yet occurred on staging) |

Rollback is one column: `enabled=false`. It was executed for real and is recorded in
`.artifacts/dc00/staging-rollback.json`.

---

## 8. What remains a formal sign-off (unchanged by this work)

Per `docs/legal/LEGAL-APPROVAL-CHECKLIST.md` and `docs/legal/DATA-INVENTORY-RETENTION.md` §5–§9:

1. **Purpose/lawful basis** for capturing gameplay at all (and whether it is genuinely necessary or
   relies on an explicit user choice).
2. **Notice** — the specific public-in-product notice/opt-out the current privacy page promises, and
   a **capture-specific opt-out control** in the clients.
3. **Retention** — approved capture/export/backup durations, and a V5 prune schedule that actually
   implements the approved backup window.
4. **Processor register and region** — the entry authorizing this private store and its keys.
5. **Store declarations** — Apple App Privacy and Google Play Data-safety answers for this data class.
6. **Key custody/rotation** — expiry, rotation, and off-host custody with separation of duties.

None of the above is claimed anywhere in the receipt or the evidence report.
