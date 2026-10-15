# Mega XO V5.2 — final report (2026-10-15)

This is the delivery report for the cutover and native work in this session. Every row states what was
**actually observed**, with the evidence location. Anything not directly proven is labelled. Nothing
here claims the deferred website/browser product was built.

## 1. Headline

Mega XO's production authority has moved from the legacy V4 SQLite writer to V5 on Neon PostgreSQL.
`https://play.antimatterinnovations.com` serves the generated V5 client and a PostgreSQL-backed API,
the legacy writer is fenced, encrypted backups run every five minutes with independent readback, and
the rewarded powers are visible and device-verified on both native apps. Several external,
owner/provider-scoped items remain open and are listed in section 7 rather than papered over.

## 2. Release identity

| Item | Value |
| --- | --- |
| Branch | `V5.2` |
| Cutover source SHA | `c172aa57f49688c74bbb8761f785fc383a919b2b` (web bundle is built from exactly this) |
| Web bundle sha256 | `d4b4c3e73e46c43914513cebb179e40377bdb275556db95b625768ac2ebac4ed`, 160 files, 3 706 158 bytes |
| Deployed server file | `976c4b57af2fe1a3e322b088c7c41b9e6dbc6278404f0760d47d4103845c47df` — matches local HEAD byte-for-byte |
| Authority epoch | `v5:1792037113917:153a8543d555682d` |
| Service | `mega-xo-v5-production.service` (active/running) behind Caddy, bound `172.18.0.1:8080` |
| Database | Neon `blue-sun-85454968` / `mega_xo_v5_production`, 55 migrations, PG16 |
| Redis | Aiven managed, namespace `mx:prd:prdb4781:` |
| V4 fence snapshot | `v4-final-fenced-20261015T040452Z.tar.gz`, sha256 `f6c5fbea57dd0ee3538abd1f70845011809d31568173fef2983041471242e90d` |

## 3. Cutover — executed and verified

| Step | State | Evidence |
| --- | --- | --- |
| Release frozen | **done** | bundle built from `c172aa57`; deployed bundle byte-identical (0 per-file mismatches); deployed server hash == HEAD |
| V4 frozen | **done** | writer stopped `ExitCode=0`, `RestartPolicy=no`; database file mtime frozen at `2026-10-15T04:04:52.600305021Z`; no `-wal` |
| Snapshot verified off-box | **done** | pulled to the owner Mac, sha256 identical, `PRAGMA integrity_check=ok`, 35 tables / 8570 rows |
| Import reconciled | **done** | E2 (8549 rows) → fence (8570 rows): +19 telemetry, +2 maintenance keys, ±1 session, −1 terminal outbox; every durable `state(id=1,json)` key byte-identical except one empty daily-snapshot marker |
| All V4 writers fenced | **done** | app container down; no host process holds the file; backup container's database bind is `ro` and `touch` is refused; ingress repointed |
| V5 armed + first write | **done** | epoch recorded; one ACTIVE `prd` signing key `mxv5-prd-2026Q4-1-79` (the deliberate first production write) |
| Production smoke | **done** | `/`, `/livez`, `/readyz`, `/health`, `/opsz`, `/api/account/session`, leaderboard, both `.well-known` = 200; `/nope.jsx` = **404** |
| Backup + alert checks | **done** | 5-minute R2 cycle with `readbackCheckedAtUtc`; forced-failure alert delivered and recovery alert delivered |

Rollback class after the first application write: **forward-fix only on PostgreSQL** (SQLite rollback
eligibility ended). Records: `CUTOVER-EVENT-20261015.*`, `V4-FENCE-RECONCILIATION-20261015.md`,
`SINGLE-AUTHORITY-FENCE-20261015.md`, `V5-AUTHORITY-ARMED-20261015.md`.

## 4. Native applications — device state

| Artifact | Reference | Device state |
| --- | --- | --- |
| Android online debug APK | sha256 `549baff9c65b9e3afff904392f091e22f414a533fc90b7fcf00e9eff65377554`, from `c172aa57`, 102-file client bundle | **device-verified** on the owner's OnePlus EB2101 (Android 13): installed, launched, real Bot match driven through the engine |
| Android signed AAB | `app-online-release-online.megaxo.xoxo-v1.aab`, 10 200 224 bytes, sha256 `8c53c5e440aba75f0d5de41e9bc5e2c70d365581da7c0517853274d36b0604b8`, held off-tree | built + signed; **not submitted** |
| iOS app | signed `Apple Development: oculusrexai@gmail.com (HTG9867RG9)`, team `D5TQJ76T44`, bundle `online.megaxo.prototype`, from `c172aa57` | **launched and running** on the owner's iPhone 16 Pro (iOS 27.0.1), PID observed, no crash in a 57 340-line syslog |

**The rewarded powers are visible.** On the physical phone, in a real Bot match, the control row shows
`Undo with a rewarded ad`, `Tactical Power (rewarded)` and `Counters` — and `Undo` is correctly
**absent** before the 8th committed ply and **present** at exactly 8, matching the frozen rule
(screenshot: `docs/v5.2/evidence/powers-device-20261015/android-online-bot-powers-8plies.png`). The iOS
app embeds a client bundle **byte-identical** (103 files, 0 mismatches) to that Android bundle and was
observed running it, so the iOS feature visibility follows from the same bytes; no iOS screenshot was
obtainable on iOS 27.

## 5. API and provider state

The API is served by the Oracle V5 authority and is fully working against PostgreSQL. A **separate**
Vercel project (`mega-xo-api`) was also enabled in this session: it now has a Production-scoped
database target and its real routes answer correctly (`/api/account/session` 200 with a real session
envelope, `/readyz` 200, leaderboard 200, profile 401). Records:
`VERCEL-PRODUCTION-API-ENABLED-20261015.md`. It holds only `api_runtime` credentials and is not a
second writer.

## 6. Recovery and operations

- Neon continuous PITR enabled and a recovery point proven (`NEON-PITR-VERIFIED-20261014.md`).
- A DR restore into an isolated PostgreSQL was completed and invariant-checked
  (`P15-DR-RESTORE-PROVEN-20261014.md`): 2 actors, 2 wallets, 2 matches, 51 migrations.
- R2 backups are encrypted, uploaded and **independently read back**; local archives retain the newest
  12, remote retention is an owner decision.
- The V5 operations surface matches the V4 meaning: `/opsz` answers `{"ok":…}` from backup freshness and
  the durable outbox, and **fails red on a stale backup** rather than reporting liveness (`c172aa5`).
- The V5 host monitor, PostgreSQL integrity check and V5 health/integrity units replaced the V4 units
  that were probing the retired container (`c172aa5`), and the alert path is proven to deliver.

## 7. Genuinely residual

| Item | Why open |
| --- | --- |
| DNS for `api.megaxo.online` | Vercel alias exists, but the hostname is `NXDOMAIN` at public resolvers — an owner DNS action |
| Vercel `MEGA_CORE_URL`/`MEGA_PROXY_SECRET` | still 11-char placeholders; the Vercel Core path is not wired (the Oracle authority serves the live surface) |
| Permanent native identity | this branch uses the owner-requested `online.megaxo.xoxo`; Codex's deployed registration uses `com.antimatterinnovations.megaxo` with a **real** upload fingerprint. Which is permanent is the owner's call; the keystore behind Codex's fingerprint is not on this machine |
| Store submission / provider approval | not performed; no store review, no live commerce |
| Live rewarded ad | no ad was ever served on this network (`MegaAds.isReady('rewarded')` false); the earned callback is covered by injected-lane tests only |
| P22 operator packet, P24 scaling triggers, P16 host-level HA | separate gates; not claimed here |
| `megaxo.online` site/browser product | **DEFERRED_BY_OWNER** — not built, by instruction |

## 8. Verification honesty

State words used precisely: **implemented** (code exists), **locally tested** (unit/contract tests
observed), **staging-verified** (deployed staging exercised), **device-verified** (physical phone),
**production-enabled** (live production serves it). A green CI run, an existing file, or a template is
never counted as any of these. Where a check could not be run — an iOS screenshot on iOS 27, a live
rewarded ad — that is stated rather than substituted.
