# Option B implementation — owner-approved 2026-10-25

The owner selected Option B: the backup RPO policy is relaxed so that an idle system
probes (and therefore wakes the Neon compute) on the 2-hour idle pulse instead of every
5 minutes, while any committed pool write is still backed up within ~5 minutes by the
commit-bound lane.

## The policy, precisely

1. **Pool writes (HTTP/realtime/Core paths through the guarded pool):** the pool's
   onCommit hook arms the backup lane 300 s after every successful transaction;
   sustained traffic batches dumps at most every 5 minutes, exactly like the retired
   timer. RPO for these writes: ~5 minutes + dump time.
2. **Non-pool writers (manual psql, operator tooling):** detected at the next idle
   pulse (<= 2 h). The runbook rule stands: migrations and manual writes are followed
   by an explicit verified backup checkpoint in the same maintenance window.
3. **Idle system:** the 2-hour pulse probes the 0070 transactional clock; an unchanged
   clock skips the dump and renews the verified-unchanged proof. One SQL wake per
   pulse: 12 wakes x 300 s suspend tail = 60 min/day = 4.17% < the 5% gate.
4. **Freshness:** a verified unchanged proof is accepted up to 2.5 h old
   (idleProofWindowSeconds, backup-policy.json; the pulse cadence plus slop). An archive
   younger than the 900 s RPO is fresh outright. Anything else is stale and alarms as
   before. The alarm message names both limits.
5. **The 5-minute backup timer is retired** (disabled in the deploy window); the unit
   itself stays and is invoked by the commit-bound lane and the pulse. The freshness
   timer (read-only, no SQL) stays on its 5-minute cadence.

## Soundness notes (from the Sol review rounds)

- No host-file journal and no SQL-text classifier: the 0070 transactional clock is the
  only change detector, so mutating SELECT functions and raw leases are covered by the
  same probe as ordinary DML (Sol R3-2 resolved by removal).
- Post-commit signals only: a wake fires after the commit, so the work is always
  visible (Sol C3/R3-3 resolved).
- Pulse-owned commits never arm extra wakes: every lane callback runs inside the lane
  context, and the backup lane is ordered last, after the worker lane whose expiry
  UPDATE was the 8.33% offender (Sol R3-4 resolved).
- The proof is bound to the archive identity, the source fingerprint, and the archived
  sequence values exactly as reviewed in the round-2 GO; the window change alters only
  how old a proof may be, not what it proves.


## Implemented outcome (rounds R4-R7, deployed da888ac 2026-10-26)

- Every successful guarded-pool lease fires onCommit once; the SQL-text classifier is
  deleted, so mutating SELECTs and raw leases are covered by the same signal (R3-2).
- Every maintenance pass runs in the lane context so its own observation/expiry leases
  can never self-wake the lane; the context carries a covered flag: pulse passes (and
  the boot wave) are covered by the backup lane waitFor barrier and arm nothing, while
  bare deadline/wake/latched passes count and arm their own bounded backup (R5-2).
- Autonomous tournament sweeps are re-classified bare at the timer boundary via the
  injected wrapTick runner, so coverage follows the invocation path instead of ALS
  inheritance (R6-1); the pulse-invoked sweep stays covered.
- Readiness observations run in a dedicated observation context: a probe never counts
  itself as activity, wakes lanes, or arms a backup (R5-1); concurrent real commits
  still count, and no blanket post-probe acknowledgment exists.
- The worker deadline mirrors the FULL claim eligibility: serviceable kinds only
  (mail kinds + account.deletion), attempts < the configured attempt budget, exact
  expires_at column bounds, and budget/transport deferral parking (R5-3, R6-2);
  budgetResetAt returns the latest applicable rollover (R6-3).
- Deployed per REVIEW-A4-R7.md with exact-SHA CI 40294645431; the 5-minute backup
  timer is disabled, the freshness timer and the backup unit remain, and the 48h soak
  (snapshot-soak2-baseline-20261026T0858Z.json) is the gate of record.
