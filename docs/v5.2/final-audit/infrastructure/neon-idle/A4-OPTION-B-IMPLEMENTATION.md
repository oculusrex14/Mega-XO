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
