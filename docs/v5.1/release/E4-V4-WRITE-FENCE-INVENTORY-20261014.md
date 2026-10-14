# E4 — V4 write-surface inventory and fence plan (2026-10-14)

Read-only survey of every path that can mutate the live V4 authority, mapped to the declarative
classes in `scripts/v5/p22/writer-fence.js`. This is the ground truth the cutover fence must control;
it asserts no fence has yet been applied.

## The authoritative artifact

| Field | Value |
| --- | --- |
| Database | `/opt/mega-xo/data/mega.sqlite` (WAL) on host `command` |
| Only read-write mount | **`mega-xo-production-app-1`** (`/opt/mega-xo/data → /data`, `rw=true`) |
| Backup container | `mega-xo-production-backup-1` mounts the same path **`rw=false`** — it can read a WAL-safe snapshot but cannot write the authority |
| Edge container | `mega-xo-production-edge-1` mounts only `/config`, `/data` (its own Caddy data), and the proxy secrets — **no product database** |
| Writer process | the single Node/`server/production/main.js` inside the app container, guarded by `run.sh`'s `flock` coordinator lock |

## Listener survey (host)

| Listener | Owner | Product? |
| --- | --- | --- |
| `*:80`, `*:443` | `docker-proxy` → Caddy edge | yes (ingress) |
| `127.0.0.1:9091` | `docker-proxy` → app container ops port | yes (internal only) |
| `172.18.0.1:8096` | `core-edge-proxy` (staging Core bridge) | no (staging) |
| `127.0.0.1:8085` | `p21-staging-server` | no (staging) |
| `[tailscale]:8095` | `tailscaled` | host management |

No other product listener exists, and no non-product process holds the database path.

## Scheduled writers

`crontab` for the product account contains **no** mega-xo entry (`/etc/cron.d` has only system
entries: `e2scrub_all`, `sysstat`). Product timers that touch the authority:

| Unit | Effect on authority |
| --- | --- |
| `mega-xo-health.timer` / `.service` | read-only health + integrity; **can send mail** but writes nothing to the database |
| `mega-xo-db-integrity.timer` / `.service` | read-only SQLite integrity check |

There is no product cron that writes the database, and no auto-restart policy that would resurrect a
fenced writer by itself.

## Mapping to the fence classes

| Fence class | Real path in V4 | Reached by |
| --- | --- | --- |
| `session-bootstrap` | `POST /api/account/*` inside `server/production/main.js` | app container |
| `session-refresh` | refresh/session routes in the same process | app container |
| `profile-and-save` | profile + save routes | app container |
| `friends-and-privacy` | social routes | app container |
| `matchmaking-and-offers` | queue/offer routes | app container |
| `direct-challenges` | challenge routes | app container |
| `ranked-and-casual-moves` | move commands | app container |
| `tournament-entry-and-payout` | tournament routes | app container |
| `wallet-and-currency` | economy commands | app container |
| `game-clock-and-deadlines` | `server/jobs.js` timer loop inside the app container | app container |
| `season-and-scheduled-awards` | scheduled jobs inside the app container | app container |
| `outbox-and-delivery` | mail/outbox workers inside the app container | app container |
| `email-and-ad-rewards` | email + AdMob SSV callbacks → Caddy → app container | ingress + app |
| `store-purchase-and-refund` | Play/StoreKit notifications → Caddy → app container | ingress + app |
| `provider-callback-and-inbox` | provider callbacks → Caddy → app container | ingress + app |
| `operator-mutations` | internal ops port `127.0.0.1:9091` | host-local only |

**Single-point result:** because every mutation path runs inside the one app container that holds
the only read-write mount, fencing the authority reduces to stopping that container (and keeping it
stopped) plus denying the ingress routes that would enqueue work for it. The backup role is already
structurally read-only. The `flock` coordinator lock is the second, independent guard against a
second writer ever starting.

## What is NOT done

- No writer was stopped, no route denied and no authority epoch written. This document is the
  inventory and plan; the executed fence belongs to E4 under the owner's cutover window.
- The route-level detail (exact handler list per class) is the existing frozen manifest in
  `docs/v5/ROUTE-AND-DATA-INVENTORY.md`; this page records the *process and mount* topology that
  makes the fence tractable.
