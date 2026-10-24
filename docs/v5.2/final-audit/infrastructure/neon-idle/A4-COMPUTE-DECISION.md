# A4 compute gate — owner decision required (2026-10-25)

## Where the engineering landed

The A4 **egress** gate is closed and verified live: migration 0070 tracks game-database
changes transactionally, backups bind their no-change proofs to the archived sequence
values, and idle cycles skip dumps entirely (observed skips at 20:09 and 20:14 UTC on
2026-10-24). Data transfer drops from ~883 MB/day to near zero on an idle system.

The A4 **compute** gate (<=5% wall-clock awake) is **architecturally unreachable** on the
Neon free tier with the current durability contract, for a reason no code change can fix:

1. The backup freshness contract requires a verified probe at least every 15 minutes
   (the RPO). Each SQL burst keeps the compute awake for the 300-second suspend tail.
2. Even a 15-minute probe cadence therefore costs ~33% awake time; the current 5-minute
   timer costs ~100%. Any cadence meeting the RPO exceeds the 5% gate; any cadence
   meeting the gate violates the RPO.
3. Sol 6.1 reviewed four implementation rounds (the last three in detail) and confirmed:
   the write-journal shortcut is unsound (host-file observations and in-database commits
   cannot be made atomic), the SQL-text classifier cannot prove write coverage (mutating
   SELECT functions exist in Core), and idle housekeeping still arms probe wakes. The
   5-minute backup timer must stay enabled; the freshness alarm must stay honest.

All scheduling work is committed on V6 (00038c5) but NOT deployed: the pool onCommit hook
(verified by a real-PG regression), worker/commerce deadline parking, the opsz observation
cache and the installer lib-rollback fix are sound improvements that reduce incidental SQL
but cannot overcome the probe cadence itself. Production remains on 5a524dc with the
5-minute backup timer enabled and healthy.

## The four options

| Option | Effect | Cost / risk |
|---|---|---|
| A. Accept Neon free-plan usage | Compute stays ~24h/day awake (~6 CU-h/day); the self-imposed 5% gate is dropped, the 50 MB/day egress gate still passes | Neon may throttle or bill; the original free-tier sustainability goal is abandoned |
| B. Relax the RPO (e.g. 2h backups when idle) | Compute awake ~2.5-4%/day, gate passes | The data-loss window on a database crash grows to 2h + dump time; requires an explicit owner-approved policy change, freshness/monitoring updates and a fresh Sol review |
| C. Move PostgreSQL to the Oracle VPS (self-hosted) | No Neon compute/egress billing at all; backups become local + R2 as today | A full authority migration (identity binding, downtime, rehearsal); the largest engineering item of the four |
| D. Upgrade to a paid Neon plan | Gate passes with the current contract unchanged | Recurring cost; needs the owner's payment authority |

Recommendation: **B** is the cheapest sound path if a 2-hour idle-window backup is
acceptable (Crash-loss window is bounded by PITR on Neon regardless — point-in-time restore
recovers to any recent LSN — so the sealed-archive RPO is a second, independent layer).
**C** is the permanent fix if Neon costs are to be eliminated entirely. **A** is the
do-nothing baseline. **D** is the simplest if ~$25-70/month is acceptable.

The 48-hour soak currently running still produces an honest egress verdict either way;
the compute verdict awaits this decision.
