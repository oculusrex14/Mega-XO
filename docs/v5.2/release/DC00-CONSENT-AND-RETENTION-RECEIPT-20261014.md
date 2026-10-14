# DC00 / day-one gameplay capture — the two deferred evidence classes (2026-10-14)

**Scope.** DC00's day-one capture gate was `BLOCKED` on exactly two of its fifteen receipt classes,
because both required a decision no agent may make:

```json
{"gate":"day-one-gameplay-capture/v1","result":"BLOCKED","failures":["MISSING_privacyPurpose","MISSING_retention"]}
```

The owner has since **approved the capture purpose** and **delegated the retention schedule**
(`docs/v5.1/release/OWNER-DECISIONS-AND-EXECUTION-20261014.md`, owner message 2026-10-14). Both
classes are therefore decidable and recordable, and this document records them — as an
**operator-implemented** capture purpose plus an **implemented, scheduled** retention engine, not
as a legal opinion. Nothing here weakens the validator: the gate still returns
`productionAuthorized:false` and `trainingAuthorized:false`, and a green result is still *not*
production authorization.

What is now implemented is code and scheduled jobs on the current branch. What remains a legal
question is listed in §6 and is **not** claimed.

---

## 1. Migration `0052_research_consent_and_retention.sql` (additive)

Applies on top of `0051`; `--dry-run` against the production database reports it as the single
pending migration, and it applied and re-applied with nothing pending on an owned PostgreSQL 16
lab (`appliedCount: 0` on the second run). No `0044`–`0051` file was renumbered or edited, no
existing `CHECK` was loosened, and historical import semantics are untouched.

| Object | What it enforces |
| --- | --- |
| `learning.consent` (actor-keyed) | the **purpose choices**: `necessary_notice_version` (necessary operational processing, explained separately) and `optional_research` (the optional research choice) are distinct columns. `optional_research` has **no default**; an affirmative needs an explicit `consent_version`, an affirmative `granted_at` and `age_band='adult'`. `withdrawn_at` is nullable. `privacy_epoch` is recorded for audit. |
| `learning.record_consent(...)` | the only write path for a choice; refuses an affirmative for a youth/unknown age band (`CAPTURE_CONSENT_ADULT_ONLY`); a repeated choice updates the row instead of adding one. |
| `learning.withdraw_research(...)` | stops allowing research (`optional_research=false`), records `withdrawn_at`, and raises the privacy epoch through `learning.suppress()`, which revokes every open export. |
| `learning.research_decision(cid)` / `research_eligible(cid)` | the archive's research decision: `eligible` only when **both** subjects affirmatively allow adult research and neither is suppressed; `recorded` distinguishes "declined" from "no decision on file". |
| `learning.retention_schedule` | ten data rows carrying each window, its basis label, whether a copy may outlive its source, the review interval and whether a legal review is still required. A job reads the window from a row, never from a literal. |
| `learning.upload_spool` + `spool_retention_bound()` | the 7-day pending client-upload spool: digest and size only, never the raw trajectory. The bound is `min(window, source expiry)`. |
| `learning.journal_watermarks` + `record_journal_watermark()` / `journal_obligation()` | the backup-journal replay obligation as a recorded fact (epoch + cipher digest per published journal), so "a fresh journal is due before this backup is privacy-current" is checkable. |
| `learning.backup_retention` | the 35-day backup window is a **separate, explicitly gated** schedule: `record_backup_prune()` stores the verify reference, `set_backup_prune_enabled(true)` refuses unless safe pruning was verified, and `backup_prune_ready()` reports it. |
| `learning.export_fenced(...)` (in `export_page`/`export_member`) | a recorded **decline** or **withdrawal** always dominates, at any capture age; from the operator-declared `consent_after` instant, an optional-research export also requires an affirmative adult choice. |
| `learning.expiry_bound(scheduled, source_expires)` | a copy can never extend its source's life: `LEAST(scheduled, source)`. |

Least privilege follows `0044`/`0045` exactly: **zero table ACLs** on the new tables for
`api_runtime`, `core_runtime`, `worker_runtime`, `capture_runtime`, `capture_exporter`,
`capture_privacy` and `PUBLIC`; each role reaches the objects only through the granted functions,
and `capture_privacy` owns withdrawal, erasure, the spool sweep and the backup/journal gates.

## 2. `packages/learning/policy.js` — the retention engine

The schedule is exported as data (`SCHEDULE`) and matches the stored rows; `retentionStatus()` and
`windowDays()` **refuse** (`CAPTURE_RETENTION_SCHEDULE_MISSING`, `CAPTURE_RETENTION_SCHEDULE_DRIFT`,
`CAPTURE_RETENTION_LEGAL_REVIEW_REQUIRED`, `CAPTURE_RETENTION_SEPARATE_PROTOCOL`) rather than sweep
on an unapproved number. `runRetention(db, {now, kind})` performs one idempotent sweep per `kind`:

| `kind` | Sweep |
| --- | --- |
| `captures` | retention-bounded expired captures, via the existing `learning.erase()` (which owns tombstone, epoch and export-revocation bookkeeping); refuses if the stored policy window is wider than the approved one. |
| `exports` | closes (`state='purged'`) due/expired runs; the existing exporter-role `purge-exports` job unlinks the offline file. |
| `spool` | deletes due spool rows (`learning.purge_spool`). |
| `backups` | reports the prune-readiness gate and the journal obligation, and prunes only surplus journal watermarks. It **never** deletes backups on the 35-day window while pruning is unverified. |

Withdrawal dominates by construction: a withdrawal raises the epoch (fencing every open export
immediately), the next sweep nulls the archived payload, and the encrypted recovery journal carries
the suppression into any restored copy — a backup cannot resurrect withdrawn research.

### Wiring (surgical, 6 lines of plumbing in `scripts/gameplay-capture.cjs`)

Two one-shot modes were added, both taking the `capture_privacy` lane:

* `retention` — `CAPTURE_RETENTION_KIND` ∈ `captures` | `exports` | `spool` | `backups`; runs
  `runRetention(db, {kind})`.
* `withdraw` — requires `CAPTURE_SUBJECT` (a verified subject from an authenticated withdrawal
  workflow; never a client-supplied actor header) and calls `learning.withdraw_research(subject)`.

```diff
 const MODES=['worker','reconcile','metrics','erase','suppress','export','journal','restore-journal','purge-exports','gate'];
+const MODES=['worker','reconcile','metrics','erase','suppress','retention','withdraw','export','journal','restore-journal','purge-exports','gate'];
- const role=['erase','suppress','journal','restore-journal'].includes(mode)?'capture_privacy':…
+ const role=['erase','suppress','retention','withdraw','journal','restore-journal'].includes(mode)?'capture_privacy':…
  if(mode==='erase')…
+ if(mode==='retention')return await require('../packages/learning/policy.js').runRetention(db,{kind:env.CAPTURE_RETENTION_KIND});
+ if(mode==='withdraw'){ if(!env.CAPTURE_SUBJECT)throw Error('CAPTURE_VERIFIED_SUBJECT_REQUIRED');
+  const r=await db.query('SELECT learning.withdraw_research($1,$2) AS epoch',[env.CAPTURE_SUBJECT,'user-choice']);return {withdrawn:true,epoch:r.rows[0].epoch};}
```

### Journal publication is run-scoped (the reported defect)

The scheduled `journal` mode used one fixed `CAPTURE_JOURNAL_FILE`, so after the first publication
`createWriter`'s deliberately no-replace `link()` raised `EEXIST` on every later run and the CLI
reported only the generic `CAPTURE_COMMAND_FAILED`. `CAPTURE_JOURNAL_FILE` is now a **base path** and
each run publishes a fresh, run-scoped sibling:

```
<base minus trailing .mxojournal>-YYYYMMDDTHHMMSSZ.mxojournal
/opt/mega-xo-v51-staging/capture-dc00/privacy-journal-20261014T024500Z.mxojournal
```

The stamp is UTC and lexicographically sortable, so the newest journal is the last name and no
previous file is ever overwritten or deleted. A rerun inside the same second still fails closed,
now with the `CAPTURE_`-prefixed `CAPTURE_JOURNAL_TARGET_EXISTS` (plus `…_DIRECTORY_MISSING`,
`…_STORAGE_DENIED`, `…_STORAGE_FULL`) instead of the catch-all. `restore-journal` is unchanged and
still takes the exact path, so point it at the lexicographically last journal. Helper:
`journalTarget(base, at)` in `packages/learning/privacy.js`.

## 3. Consent at capture (no per-match prompt)

`packages/learning/worker.js` reads `learning.research_decision(capture_id)` once, at seal time, and
freezes it into the archive as `payload.consent = {researchEligible, basis:'one-time-subject-choice'}`:

* `true` — both subjects affirmatively allow adult research;
* `false` — a subject declined or withdrew (the exporter then excludes the game, and the DB fence
  refuses to page or attach it);
* `null` — **no decision on file**, which is never read as a grant. Necessary operational capture is
  explained by its own `necessary_notice_version` and does not depend on the optional choice.

`capture.js` keeps the field **optional** for validation, so pre-`0052` archives still validate
byte-for-byte and cannot be reinterpreted as consent (an absent field is not `true`). There is no
per-match prompt anywhere in the path: the choice is stored once and synchronized.

## 4. The receipt for the two classes

Each artifact is inside the gate's 1000-character budget. `sourceCommit` is bound at issue time to
the commit that introduced the code (`CAPTURE_SOURCE_COMMIT=$(git rev-parse HEAD)`); the values
below are the exact artifacts `packages/learning/release-gate.js` consumes.

```json
{
  "format": "day-one-gameplay-capture-receipt/v1",
  "sourceCommit": "<git rev-parse HEAD>",
  "rulesHash": "e6e14c258b4db439eedf28090ebafd0962867bab5e64709d0d4438cb145b31e0",
  "policyVersion": "<learning.policy.policy_version of the target>",
  "environment": "<staging|production>",
  "privacyEpoch": 0,
  "checkedAt": "<ISO-8601, at issue time>",
  "note": "Operator-implemented purpose and schedule. NOT legal approval and NOT production authorization: productionAuthorized and trainingAuthorized stay false.",
  "evidence": {
    "privacyPurpose": {
      "status": "PASS",
      "artifact": "Owner-approved capture purpose, implemented as a one-time per-actor choice (migration 0052, learning.consent + learning.record_consent/withdraw_research). Necessary operational processing and optional research are SEPARATE fields; optional_research has no default and DB CHECK consent_affirmative_required_ck refuses an affirmative without an explicit consent_version, an affirmative granted_at and an adult age band (CAPTURE_CONSENT_ADULT_ONLY), so absence of a row is NOT consent. One choice is stored and synchronised; there is no per-match prompt. Withdrawal stops the permission, records withdrawn_at and raises the privacy epoch, revoking every open export. Tests/v52-consent-retention.test.js proves each refusal and the withdrawal path against real PostgreSQL16; 0052 applied on top of 0051 (52/52) and re-applied with 0 pending."
    },
    "retention": {
      "status": "PASS",
      "artifact": "Owner-delegated schedule implemented as DATA (learning.retention_schedule: 10 rows with window, basis, neverPastSource, review interval and legal-review flag) and swept by packages/learning/policy.js runRetention(db,{kind}) on a schedule: captures 730d with an annual necessity review, working exports 90d never past source expiry, raw ad analytics 90d, pending client-upload spool 7d bounded by min(window,source expiry), ordinary encrypted backups 35d only once safe pruning is verified. Purchases, fraud, operations and security keep separate rows with NO window until their legal review; youth research is a separate lawful protocol that can never carry an adult window. Withdrawal and applicable law override every maximum: learning.expiry_bound() makes LEAST(scheduled,source), a withdrawal raises the privacy epoch, and the erasure sweep nulls the archived payload. Proven on real PostgreSQL16 by tests/v52-consent-retention.test.js."
    }
  },
  "absent": {
    "noticeAndControllerSignoff": "The public in-product notice naming this specific use and the privacy-controller sign-off remain owed (legal). The capture-specific opt-out/withdrawal control is implemented server-side; its client surface belongs to the account/UI lane and is not claimed here.",
    "retentionLegalBasis": "The windows are operator-implemented and enforced; whether any of them is the legal maximum for a given jurisdiction is a legal question. Records that need an applicable-law window carry NULL until legal review, and the corresponding sweeps refuse to run."
  }
}
```

### Reproduce

`docs/v5.2/release/dc00-consent-retention-receipt.json` is committed with all fifteen classes; two
fields are placeholders that the issuer **must** stamp at issue time, exactly as the staging
receipt builder does — `sourceCommit` (`git rev-parse HEAD` of the deployed source) and `checkedAt`
(an ISO-8601 instant no older than 24h when the gate runs). Leaving them stale makes the gate
report `RECEIPT_BINDING` / `RECEIPT_STALE`, which is the intended behaviour.

```sh
# 1. Apply the additive migration (lab first), then verify the chain end to end.
node scripts/v5/migrate.js --dry-run  --json --database-url "$V5_MIGRATE_DATABASE_URL"   # 0052 planned
node scripts/v5/migrate.js --execute  --json --database-url "$V5_MIGRATE_DATABASE_URL" \
  $( [ "$V5_TARGET" = production ] && echo --confirm-production )                        # forward-only
node scripts/v5/migrate.js --verify   --json --database-url "$V5_MIGRATE_DATABASE_URL"   # 52 checksums + conformance

# 2. The consent/retention engine and the migration's constraints, against real PostgreSQL 16.
V5_PG_REQUIRED=1 node --test --test-force-exit tests/v52-consent-retention.test.js

# 3. Record the choice and run each sweep through the shipped one-shot CLI (capture_privacy lane).
CAPTURE_ENV=staging CAPTURE_TARGET_FILE=docs/v5/environments/staging.json \
CAPTURE_PG_URL='postgresql://capture_privacy:…@<direct-host>/<db>?sslmode=verify-full' \
  node scripts/gameplay-capture.cjs retention                   # CAPTURE_RETENTION_KIND=captures|exports|spool|backups
CAPTURE_SUBJECT='<verified actor>' node scripts/gameplay-capture.cjs withdraw

# 4. Issue the receipt bound to the exact deployed source, then run the gate.
CAPTURE_ENV=staging CAPTURE_TARGET_FILE=docs/v5/environments/staging.json \
CAPTURE_RELEASE_RECEIPT=docs/v5.2/release/dc00-consent-retention-receipt.json \
CAPTURE_SOURCE_COMMIT=$(git rev-parse HEAD) \
CAPTURE_PG_URL='postgresql://capture_runtime:…@<direct-host>/<db>?sslmode=verify-full' \
  node scripts/gameplay-capture.cjs gate
```

## 5. Observed on this branch (2026-10-14)

| Check | Result |
| --- | --- |
| `migrate.js --dry-run` vs the production database | `ok:true`, `connected:true`, 51 applied + **52 pending** |
| `migrate.js --verify` vs the production database | `ok:true`, `checked:52`, `failures:[]`, channel binding `SCRAM-SHA-256-PLUS` enforced |
| `migrate.js --execute` on an owned PG16 lab (chain `0001`–`0052` from zero) | `code:OK`; second run `appliedCount:0` |
| **clean upgrade from `0051`** (temp pack pinned at 51, then the real pack) | stage applied `51`; upgrade `appliedCount:1`, applied id `[52]`; `--verify` `ok:true checked:52 failures:[]`; re-apply `appliedCount:0` |
| `tests/v52-consent-retention.test.js` (lab) | 25 pass / 0 fail |
| whole capture neighbourhood (`tests/gameplay-*.test.js`, `tests/v5-migrations.test.js`, `tests/v5-p15-data-integrity.test.js`, `tests/v52-consent-retention.test.js`) | 129 pass / 0 fail / 1 skipped (no `V5_PG_URL`) |
| **two consecutive scheduled `journal` runs** (shipped CLI, exact-role lane) | both exit 0; files `privacy-journal-20261014T155018Z.mxojournal` and `…155019Z.mxojournal` both survive; watermarks `1` then `2` |
| `retention` sweeps through the shipped CLI | `captures {windowDays:730,erased:0}`, `exports {windowDays:90,runsClosed:0}`, `spool {windowDays:7,purged:0}`, `backups {windowDays:35,pruneReady:false,pruneAllowed:false,journalObligation:"CURRENT"}` (all idempotent no-ops, correctly) |
| `withdraw` through the shipped CLI | `{"withdrawn":true,"epoch":"1"}` |
| `gameplay-capture.cjs gate` with the new receipt bound to HEAD and the policy source bound to HEAD | exit 0: `{"result":"RECEIPTS_READY_FOR_MAIN_REVIEW","failures":[],"productionAuthorized":false,"trainingAuthorized":false}` |
| the same receipt with a mismatched source commit | exit 2: `DEPLOYED_POLICY_SOURCE_MISMATCH` + `RECEIPT_BINDING` (the binding is real) |

The scheduled host work (systemd timers calling the new `retention` mode, the journal-filename
convention and the freshness checker) is operator/host configuration on the staging host; the CLI
lanes it needs are in this commit and are named above.

## 6. What is still a legal question (not claimed here)

1. **Lawful basis / purpose wording** — the owner approved the purpose and delegated the schedule;
   this document records the implementation. The privacy-controller's written acceptance, the
   processor-register entry and the public notice naming the use remain owed.
2. **Whether any window is the legal maximum** — the 24-month / 90 / 90 / 7 / 35-day windows are
   implemented and enforced and the owner delegated them. No claim is made that they are the
   statutory maximum for any jurisdiction, and withdrawal plus the applicable-law limit override
   them.
3. **The schedules with `NULL` windows** — purchases, fraud, operations, security and youth research
   carry no window and a legal-review obligation; their sweeps refuse to run.
4. **Store declarations** — Apple App Privacy and Google Play Data-safety answers, and the public
   policy update, are separate deliverables.
5. **A green gate is not authorization** — `productionAuthorized` and `trainingAuthorized` remain
   `false`, and the day-one capture gate still requires the operator evidence packet.
