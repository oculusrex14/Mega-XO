# Final V4 fence reconciliation against the E2 production import (2026-10-15)

The authority transfer requires "import and reconcile … with zero unexplained differences". The E2
import (`docs/v5.1/release/E2-PRODUCTION-IMPORT-RECONCILIATION-20261014.md`) captured V4 at **8549
rows** on 2026-10-14. V4 then kept serving until the fence at 2026-10-15T04:04:52Z. This record closes
that window with a real, per-table, per-key comparison against the **final fenced** database — not an
assumption that nothing changed.

## Artifacts compared

| Item | Value |
| --- | --- |
| E2 source snapshot | `~/MegaXO-private/v5-e2/v4-snapshot.sqlite`, 35 tables, **8549** rows, fingerprint `aa411dee744b0dc5977c653289dde5c9ca370a062fa8c5b7d9e6f07c57797d48` |
| Final fenced snapshot | `/opt/mega-xo/cutover-archive/v4-final-fenced-20261015T040452Z.tar.gz`, sha256 `f6c5fbea57dd0ee3538abd1f70845011809d31568173fef2983041471242e90d`, 35 tables, **8570** rows |
| Off-box copy | same tarball pulled to the owner Mac; **sha256 identical**; `PRAGMA integrity_check` → `ok` |
| Table set | identical (35/35; none added, none removed) |

## Row-count differences (all four accounted)

| Table | E2 | Final | Δ | Explanation |
| --- | --- | --- | --- | --- |
| `v41_support_events` | 5050 | 5069 | +19 | Sanitized support telemetry in a rolling 7-day window with a 5000-row cap (`DELETE … WHERE at < now-7d`, then trim to 5000). Oldest window moved `1791819089216 → 1791908537323`; the table self-pruned and re-grew. Telemetry only. |
| `commands` | 57 | 59 | +2 | Exactly two new rows, both V4's own **maintenance idempotency keys**: `["maintenance","snapshot:2026-10-15"]` and `["maintenance","weekly:2026-10-05:2026-10-15"]`, actor `maintenance`. No player command was added or removed. |
| `account_sessions` | 3 | 4 | +1 | Three anonymous sessions (`actor` NULL, i.e. never signed in) rotated; the one **real** session (`u_40000856…`, created `1791436087591`) was **not touched** in either direction. |
| `v4_outbox` | 4 | 3 | −1 | One **terminal** row (`state` NULL after send) left the outbox. No queued work was lost. |

## Durable state (`state(id=1,json)`) — the authoritative document

Compared field by field. Top-level keys: `accounts, burned, journal, leagueWeek, matches, receipts,
snapshots, weeklyPaid`.

**Every key except `snapshots` is byte-identical between the two snapshots, including `accounts`
(wallets, coins/crowns, ratings, friends, verification).** The only difference is one appended
`["2026-10-15", {}]` entry — an empty daily-snapshot marker created by V4's own maintenance on the
fence day. No balance, rating, purchase, friendship, reservation or profile changed.

```
keys differing (excluding 'snapshots'): []
accounts identical: True
```

## Per-actor check

| Actor | E2 | Final |
| --- | --- | --- |
| `u_e17f44f4…` (mothervader693@gmail.com) | coins 157, crowns 0, rating 600, casual 1016 | **identical** |
| `u_40000856…` (judebelign1647@gmail.com) | present, verified | **identical** |

## Conclusion

The 21-row surface delta between the E2 import and the final fence is **fully explained by V4's own
telemetry window and daily maintenance**; the durable authoritative state is unchanged. The E2 import
is therefore a faithful base for V5 authority, and the four differences the E2 reconciler had already
classified remain the only ones. Nothing is unexplained.

## Honest limits

- This comparison reconciles the V4 side of the window. The production PostgreSQL copy was imported
  from the E2 snapshot; re-importing the 21 telemetry/maintenance rows is **not** required for
  authority (they carry no economic or identity content) but it is also **not** performed, so the V5
  support-telemetry history is ~19 events shorter than V4's final window. That is stated, not hidden.
- The final snapshot was pulled to the owner Mac (off the Oracle host) and re-hashed there; it is not
  yet in R2 or on the DGX.
