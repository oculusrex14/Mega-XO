# E4/E5 — cutover automatically postponed: the mandatory gates are blocked (2026-10-14)

## Decision

**The V4→V5 authority cutover is NOT executed and NOT authorized at this time.** Two independent
mandatory gates are blocked, each on an external decision that no agent may fabricate. The owner's
directive states the rule directly:

> "If a **mandatory website/backend/day-one-capture** gate fails, fix it, test again and **postpone
> the cutover automatically until passing**."

Fencing the V4 writer (E4) without a passing gate would stop the only live authority that currently
serves players, so E4 is deferred with E5. This is the directive-compliant outcome, not an omission.

## Gate 1 — P22 production readiness: BLOCKED

`node scripts/v5/p22/readiness.js --sha $(git rev-parse HEAD)`:

| Field | Value |
| --- | --- |
| `passedPhaseGates` | G00–G20 (21 gates accepted) |
| `missingGates` | none |
| `status` | **BLOCKED** |
| `blockers` | `OPERATOR_EVIDENCE_PACKET_MISSING` |
| `cutoverAuthorized` / `productionWritesPermitted` | `false` / `false` |

The packet requires twelve observation classes, and several cannot honestly be `PASS_CLAIMED` today:

| Observation | Why it cannot be claimed now |
| --- | --- |
| `nativeDeviceAcceptance` | the **iOS** device matrix is unsigned and unrun (Apple enrollment pending) |
| `providerInboxAndCallbacks` | no provider-approved store/ad channel exists yet |
| `testedV4WriteFence` | E4 has not been executed (deliberately — see above) |
| `realCoreAndWorkerRecovery` | the production Core/worker have never run as the authority |
| `fullyReconciledFinalSnapshot` | requires the frozen final V4 capture at freeze time |
| `readOnlyStageAndAlertDelivery` | partly demonstrated (alerts proven) but not against a staged V5 production |

What **is** ready and recorded: the immutable production image digest
`sha256:41b8b7a3283647d76cf0929cb809bd072422f722759f1df8484ace06f6b4a792`, the frozen V4 snapshot sha256
`c77632f02cd13a49be13ec6a86332e474aa78effec611f30bc9087ad9ce72554`, 51/51 migrations, and the
reconciled import. Those are the packet's inputs that exist; the rest are the observations above.

## Gate 2 — DC00 day-one gameplay capture: BLOCKED

`node scripts/gameplay-capture.cjs gate` against staging:

```json
{"gate":"day-one-gameplay-capture/v1","result":"BLOCKED",
 "sourceCommit":"3e51ba0c95d1083fe89e7c6f909e7590cee1a600",
 "rulesHash":"e6e14c258b4db439eedf28090ebafd0962867bab5e64709d0d4438cb145b31e0",
 "failures":["MISSING_privacyPurpose","MISSING_retention"],
 "productionAuthorized":false,"trainingAuthorized":false}
```

13 of the 15 evidence classes **are** demonstrated with real runs (schedulers, deletion sweep, export
purge, journal replay, PostgreSQL restart, Redis loss, latency/quota, staging replay, zero-missing
eligible games, rollback). The two that remain are exactly the ones requiring a decision no agent may
make:

| Missing receipt | Exact external requirement |
| --- | --- |
| `privacyPurpose` | a recorded lawful basis / privacy-controller acceptance for observing gameplay. The owner's directive authorizes the *work*; it does not by itself constitute the controller's written acceptance, and inventing that acceptance is forbidden. |
| `retention` | approval of the derived capture/export/backup retention windows (currently 90/30/35 days, `capture_after 2026-10-08`) and a V5 prune schedule that implements them. `docs/legal/DATA-INVENTORY-RETENTION.md` §5 lists these as **LEGAL/POLICY DECISION REQUIRED**. |

## What was completed instead (all reversible)

Everything that does not cross the irreversible boundary is done and evidenced:

| Item | Evidence |
| --- | --- |
| Production database at 51/51 with five least-privilege roles and capture-table isolation | `PRODUCTION-PG-PROVISIONED-20261014.md` |
| Real V4 import + reconciliation, 0 unexplained | `E2-PRODUCTION-IMPORT-RECONCILIATION-20261014.md` |
| Encrypted backup → V5-only R2 → independent retrieve → complete DR restore | `P15-V5-BACKUP-RETRIEVE-MEASURED-20261014.md`, `P15-DR-RESTORE-PROVEN-20261014.md` |
| Neon PITR recovery point | `NEON-PITR-VERIFIED-20261014.md` |
| Incident **and** recovery alerts delivered | `DELIVERED-ALERTS-20261014.md` |
| Automatic supervised backup service with verified upload+readback and freshness alerting | `V5-BACKUP-SERVICE-20261014.md` |
| Production image + secrets + non-crossover namespace | `E3-PRODUCTION-STACK-PROVISIONED-20261014.md` |
| Production stack actually running against production data, refusing to arm an epoch | `E5-PRODUCTION-STACK-REHEARSAL-20261014.md` |
| V4 write surface mapped; fence manifest valid for the current `V4_SERVING` phase | `E4-V4-WRITE-FENCE-INVENTORY-20261014.md`, `v4-serving-manifest.json` |
| Android physical-device pass; iOS build+parity | `DEVICE-ANDROID-EB2101-20261014.md`, `DEVICE-IOS-IPHONE16PRO-20261014.md` |
| DC00 policy derived and 13/15 receipts demonstrated | `DC00-COLLECTION-POLICY-20261014.md`, `DC00-R35-COLLECTION-EVIDENCE-20261014.md` |
| Acceptance reconciled against real evidence (PASS 14 / RUNNING 15 / BLOCKED 11) | `ACCEPTANCE-CASE-RECONCILIATION-20261014.md` |
| Post-cutover incident/rollback/forward-recovery runbook | `V5-INCIDENT-AND-FORWARD-RECOVERY-RUNBOOK-20261014.md` |

## The exact unblocking actions

1. **Apple Developer Program approval** → real iOS App ID, signing identity, provisioning profile,
   associated domains → the iOS device matrix → `nativeDeviceAcceptance`.
2. **Owner/controller acceptance of the capture purpose and the retention windows** → the two DC00
   receipts → the day-one gate returns `RECEIPTS_READY_FOR_MAIN_REVIEW`.
3. **Owner confirmation of live provider channels** (store/ads) or an explicit decision to launch
   without them → `providerInboxAndCallbacks`.
4. **Then** the single irreversible window: E4 fence → first V5 write + authority epoch (E5) →
   `testedV4WriteFence`, `realCoreAndWorkerRecovery`, `fullyReconciledFinalSnapshot` → packet complete
   → cutover.

## Recorded state

- Production authority: **V4.1.2 / SQLite**, live (`play.antimatterinnovations.com` 200), single writer,
  never written by this work.
- V5 production: image built, secrets in place, database imported and reconciled, `nonserving: true`.
- No authority epoch exists and no first production application write has occurred.
