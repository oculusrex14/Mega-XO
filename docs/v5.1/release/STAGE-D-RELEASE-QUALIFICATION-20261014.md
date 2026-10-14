# Stage D — release qualification status at integration HEAD (2026-10-14)

Reconciliation of the acceptance contract against what is **actually proven** at this moment. This
page distinguishes demonstrated evidence from missing evidence; it does not rewrite any gate to make
launch possible.

## Immutable launch candidate

| Field | Value |
| --- | --- |
| Source SHA | `4c1c16819ecf44254b994951d4d20f2613610d3f` |
| Candidate content hash | `640ed89a9a04e760d46981d1e54d888f15d407351d1b114c3084e4c1636a35d5` |
| Verified by | `scripts/v5/release-source-candidate.js verify` → `V5_SOURCE_CANDIDATE_OK … (NOT DEPLOYABLE)` |
| Candidate file | `.artifacts/v5-launch-candidate-4c1c1681….json` |

Later commits in this session are evidence and tooling on top of that candidate; the cutover image is
pinned by digest at cutover time, not by this hash.

## Gate status (from the real validator)

`node scripts/v5/p22/readiness.js --sha <HEAD>`:

| Field | Value |
| --- | --- |
| `passedPhaseGates` | **G00–G20 accepted** (21 gates) |
| `missingGates` | none |
| `excludedPhase` | `P21_OWNER_DEFERRED` |
| `status` | `BLOCKED` |
| `blockers` | `OPERATOR_EVIDENCE_PACKET_MISSING` |
| `cutoverAuthorized` / `productionWritesPermitted` | `false` / `false` |

The single blocker is the operator evidence packet, which requires the **production V5 core and
worker image digests** — a value that can only exist after the production images are built and
frozen, i.e. during E3/E5. It is not a documentation gap.

## Demonstrated in this session

| Requirement | Evidence |
| --- | --- |
| Real V4 → PostgreSQL import with zero unexplained differences | `E2-PRODUCTION-IMPORT-RECONCILIATION-20261014.md` — gate `pass`, 0 unexplained, 0 unclassified, C1–C9 all pass over per-actor/per-currency data |
| Permanent actor / identity preservation | live production query: 2 actors, 2 identities (1 provider family), 2 email credentials, 2 profiles, 2 saves, wallets summing **307 coins**, 0 ledger/outbox rows |
| Least-privilege roles, capture isolation | `PRODUCTION-PG-PROVISIONED-20261014.md` — independent probe shows **no runtime role can read the learning capture tables** |
| Real encrypted backup → R2 → independent retrieve | `P15-V5-BACKUP-RETRIEVE-MEASURED-20261014.md` — writer PUT 200, reader GET 200, sha256 equal, backup 36.1 s |
| Complete DR restore | `P15-DR-RESTORE-PROVEN-20261014.md` — every relation count equals production |
| Point-in-time recovery | `NEON-PITR-VERIFIED-20261014.md` — recovery point reconstructs the historical database (49 migrations, before 0050/0051) |
| Delivered alerts (incident **and** recovery) | `DELIVERED-ALERTS-20261014.md` — real `healthy→unhealthy→healthy` transition through the live send path |
| V4 write-fence tractability | `E4-V4-WRITE-FENCE-INVENTORY-20261014.md` — one read-write mount, no product cron writer |
| Website/browser acceptance | 261 P21 assertions → **256 pass / 5 skip / 0 fail**; live staging `/livez`, index, manifest, legal, robots all 200; served payload hash-identical to the build of its source |
| Real browser+server online journey | `R05-ONLINE-ACCEPTANCE-20261013.md` — real two-account `ok:true`, 31/31 over the deployed HTTPS/WSS origin |
| Android physical device | `DEVICE-ANDROID-EB2101-20261014.md` — installed, launched, four themes, real bot match with the forced-board rule, offline banner; cleanup verified |
| Cross-platform client parity | Android and iOS embed the identical bundle `e0381428…` (97 files) |
| CI | green on the tip; every DB-backed lane (P15/P16/P18/P19/P22/P23/P24, PostgreSQL integration, gameplay capture, audit) runs for `V5.1` |

## Missing / not claimed

| Item | State |
| --- | --- |
| Operator evidence packet (production V5 image digests + 12 observation classes) | **blocked on E3** — cannot exist before the production images are built |
| iOS physical-device matrix | **blocked**: 0 signing identities, 0 provisioning profiles (Apple enrollment pending) |
| Native online target (transport, shared identity, sessions on device) | implemented bridges + offline boundary only; the online target is an open work item |
| Store billing / ads live | provider-approved state absent; only test/sandbox code paths exist |
| Day-one capture gate (15 receipts) | owner-authorized; the evidence track is being completed and is reported separately, never faked |
| Realistic-history backup timings | current dataset is 2 actors, so RPO/RTO figures are small-data measurements |
| Production cutover (E5) | not executed; the authority is still V4 on SQLite |

## Honest conclusion

The **reversible** half of the launch is demonstrably complete: schema, import, reconciliation,
roles, backup, restore, PITR, alerts, website acceptance, online journey and an Android device pass.
The **irreversible** half (E3 image freeze → E4 fence → E5 first write) is engineering work that is
now unblocked and remains to be executed, and two acceptance classes (iOS device, provider-approved
commerce) are externally gated. Nothing here is reported as passing that was not observed.
