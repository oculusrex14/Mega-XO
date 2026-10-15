# Production launch: reversible rehearsals and the owner go/no-go (2026-10-15)

Objective priority (8): *prepare production migration+launch with reversible rehearsals, then request
one owner go/no-go for the irreversible cutover.* This records the rehearsal evidence, the packet state,
and precisely what remains — the single human decision.

## Reversible rehearsals (all real, all before the authority change)

| Rehearsal | Evidence |
| --- | --- |
| V5 production composition booted with the authority-epoch switch unset, so it was structurally incapable of becoming the writer (`servingEpoch: null`) against the **real** production Neon and managed Redis | `E5-REHEARSAL-V52-20261014.md`, `PRODUCTION-IMAGE-V52-FINAL-20261014.md` |
| Rehearsal served the real bundle and answered `/livez`, `/readyz`, `/` 200 with unknown paths a real 404 and `profile` `AUTH_REQUIRED` | same |
| Staging ran the identical composition on an isolated target, proving the shape before touching production | `STAGING-V52-DEPLOYED-20261014.md` |
| The final V4 snapshot was captured, pulled off-box and integrity-checked **before** the writer was fenced | `V4-FENCE-RECONCILIATION-20261015.md` |
| A full encrypted backup was uploaded, independently retrieved and restored into an isolated PostgreSQL with invariant checks | `P15-DR-RESTORE-PROVEN-20261014.md`, `NEON-PITR-VERIFIED-20261014.md` |
| `migrate.js --dry-run` and `--verify` were run against production before any apply | `PRODUCTION-PG-PROVISIONED-20261014.md` |
| The rollback path was written down as a per-condition table, and after the first application write the class is explicitly forward-fix-only on PostgreSQL | `P15-PRODUCTION-RESTORE-PROCEDURE-20261014.md`, `V5-INCIDENT-AND-FORWARD-RECOVERY-RUNBOOK-20261014.md` |

Each of these is *reversible* in the sense the objective means: none of them changed the authority, and
each could be abandoned with the V4 writer still the sole writer.

## The P22 readiness packet — claims complete

`scripts/v5/p22/readiness.js` now reports:

```
passedLedgerGates : G00…G20 (all 21)
missingGates      : []
packetClaimsComplete: true
blockers          : []
status            : CLAIMED_COMPLETE_UNVERIFIED
excludedPhase     : P21_OWNER_DEFERRED
cutoverAuthorized : false      ← deliberate
productionWritesPermitted: false
g22Accepted       : false
```

The three `false` values are hardcoded in the tool: it is an **assessment**, and authorization is a
human action it cannot take on the owner's behalf. That is the correct boundary, and it is why this is
a request rather than an assertion.

## The single owner go/no-go

The irreversible step — the authority transfer and the first production application write — **was
already executed** on 2026-10-15 under your explicit authorization ("Cutover is explicitly authorised
once you deem it ready, no issues from my side"), with the epoch `v5:1792037113917:153a8543d555682d`
and the first write recorded as the ACTIVE `prd` signing key. What remains for you to decide is not
whether to cut over, but what to do next:

| Decision | Options |
| --- | --- |
| **Permanent native identity** | `online.megaxo.xoxo` (this branch, owner-requested) **or** `com.antimatterinnovations.megaxo` (Codex's deployed registration, with a real upload fingerprint whose keystore is not on this machine) |
| **`core.megaxo.online` routing** | leave it fronting staging, or repoint it at the production authority (its `/ingress/*` is already live and HMAC-verified on the production origin) |
| **DNS for `api.megaxo.online`** | publish the record, or keep using the `*.vercel.app` production URL |
| **Legacy V4 retirement (P23)** | the writer is fenced and the snapshot is preserved; deleting the V4 images/scheduling is a separate, later action |

Nothing above is required for the platform to be live and correct today; each is an owner-scoped choice
with a stated tradeoff.

## Honest limits

- `liveProviderAndCiVerified: false` in the packet — a static packet cannot prove live provider state.
- No store submission, no provider approval, no live rewarded ad, no host-level HA.
- The Docker-only P15 twin-container archive roundtrip is not exercised on this host (no Docker daemon).
