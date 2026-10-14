# Stage A — Neon production point-in-time recovery verified (2026-10-14)

Independent verification of the production database's point-in-time recovery, performed by actually
restoring a recovery point rather than reading the dashboard's advertised history.

## Recovery point

| Field | Value |
| --- | --- |
| Project | `blue-sun-85454968` (`mega-xo-v5-production`, aws-us-east-1, PG 16) |
| History retention | **6 hours** (the achievable PITR window; sets the production RPO floor) |
| Requested recovery point | `2026-10-14T01:19:21Z` (25 minutes before the run) |
| Recovery branch | `v5-pitr-drill-01` / `br-hidden-mountain-b8va0b1o`, parent `br-dawn-dawn-b8f9n7zq` |
| Compute | `ep-royal-glade-b8m5dtiv`, state `ready` |

## Independent query of the recovered state

Connected directly to the recovery branch's own compute endpoint as `migration_owner`:

| Measure | Value at recovery point |
| --- | --- |
| `identity.actors` | 2 |
| `economy.wallets` | 2 |
| `match.matches` | 2 |
| total coins | 307 |
| `meta.migrations` | **49** |

The 49 (not 51) is exactly right and is the proof: the recovery point predates migrations 0050 and
0051 that this session applied, while the imported V4 data (2 actors / 2 wallets / 2 matches /
307 coins) is present and correct. A recovery point genuinely reconstructs the historical database
state — not a copy of "now".

## Current production for contrast

| Measure | Value now |
| --- | --- |
| `identity.actors` | 2 |
| `meta.migrations` | 51 |
| `v5_migration.run` rows | 1 |

## Cleanup

The drill branch was deleted; the project is back to a single branch (`main`). No production branch
was modified and no production data changed by this drill.

## Not claimed

- 6 hours is the provider's configured window, so the **Neon-native RPO floor is 6 h**; the logical
  backup path (36.1 s measured, separate evidence file) is what supports a 15-minute-class RPO.
- No alert delivery, no scheduling and no owner sign-off of the operating limits are implied here.
