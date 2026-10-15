# P21 website bundle on staging + two-account online acceptance re-verified (2026-10-15)

Objective priorities (1) and (2), re-run against the live, isolated Oracle staging origin at the end of
this session rather than relying on the earlier record.

## (1) The deployed P21 bundle, byte-verified

| Check | Result |
| --- | --- |
| Staging origin | `https://command.tail95c48c.ts.net` → `200` |
| Service | `mega-xo-v51-staging-web.service` **active** |
| Served manifest | `source_commit 2b60ed88`, `bundle_sha256 d4b4c3e73e46c43914513cebb179e40377bdb275556db95b625768ac2ebac4ed`, 160 files |
| Bundle identity vs a fresh local build of the same tree | **equal** (`d4b4c3e7…`) |
| Served bytes | 6 files sampled from the manifest and re-hashed from the origin: **0 mismatches** |
| Sessions | `GET /api/account/session` → `200 {"linked":false,…}` (a real PostgreSQL-backed session) |
| `/livez` `/readyz` `/health` | `200` each |
| `/opsz` | `404` on staging — the operations probe exists only on the **production** entry (`c172aa5`). Noting this rather than implying parity. |

A bare `wss://…/realtime/v1/snapshot` with no credentials closes with an error, which is correct: the
handshake requires an authenticated session. The real WebSocket proof is step `P2_05` below.

## (2) Two-account online multiplayer acceptance — 31/31 PASSED, re-run live

```
node scripts/v51/p21-online-acceptance.cjs \
  --origin https://command.tail95c48c.ts.net \
  --otp-sink /opt/mega-xo-v51-staging/staging-otp.jsonl --ssh command
```

| Field | Value |
| --- | --- |
| Result | **`ok: true`, total 31, passed 31, observed 0, failed 0** (`durationMs 74912`) |
| Evidence | `docs/v5.2/evidence/p21-online-acceptance-20261015.json` (stored raw harness output) |
| Realtime | `P2_05_realtime_ticket_subscribe` **PASSED**, `P2_06_http_snapshot_fallback` **PASSED**, `P2_06_snapshot_anon_401` **PASSED** |
| Economy/progression | `P2_04_economy_and_progression_durable` PASSED — both wallets 150 coins, casualGames 1, history 1 |
| Terminal delivery | `P2_07_resign_terminal_delivery` PASSED (`reason: resign`) |
| Session teardown | `P2_08_logout` PASSED, cookie revoked (`401`), the other actor unaffected (`200`) |

This uses two genuinely independent accounts through the real email/OTP flow (codes read from the
staging sink, so verification is part of the path), real HTTPS, a real RFC6455 WebSocket upgrade, and
the deployed bundle.

## (7) The gameplay-collection collector is deployed

The capture work (PR 12, "day-one authoritative gameplay capture, privacy fencing and offline
exports") is merged, and the collector runs on the host:

| Timer | State |
| --- | --- |
| `mega-xo-v51-capture-worker.timer` | active, running ~2-minute cadence, last fired seconds before this check |
| `mega-xo-v51-capture-maintenance.timer` | active |
| `mega-xo-v52-retention@{captures,exports,spool,backups}.timer` | enabled, next fire in ~3 days |

## Honest limits

- Staging has no `/opsz`; only production carries the operations probe.
- The staging bundle's `source_commit` is `2b60ed88` (the powers-visibility fix), which is an ancestor
  of the current HEAD; the bundle is byte-identical to a fresh build of the same tree, so this is a
  provenance label on the manifest, not a content drift.
