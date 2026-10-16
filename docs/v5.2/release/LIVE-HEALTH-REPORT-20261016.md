# Live production health report — megaxo.online (LR05, 2026-10-16)

**Method:** external HTTP probes + read-only SSH inspection of /opt/mega-xo-v5-production (state, journals, deployed tree). No production state changed; no secrets printed. Times UTC.

## Verdict

**The authority is healthy and serving; one real operational failure (backup freshness) red-letters /opsz and two monitoring units — root-caused to an R2 listing truncation, fix PR'd (#23).** No player-facing impact observed at any point.

## Verified healthy

| Check | Result | Evidence |
| --- | --- | --- |
| Apex | 200 HTML | curl 03:02-03:29 |
| www redirect | 301 → apex | Caddy |
| Retired game domain | 308 → apex | play.antimatterinnovations.com |
| Core ingress unsigned | 401 fail-closed | core.megaxo.online/ingress/health |
| /livez, /readyz | 200 {"status":"ok",...,"ready":true} | DB answers |
| Asset self-check | true (server boot report) | production-server.log |
| Redis | Aiven, namespace prdb4781, connected | boot report + readyz |
| PG authority | mega_xo_v5_production; authority-epoch present | boot report + state/ |
| Migration files | 55 on host = 55 on origin/V5.2 (tail 0053-0055 parity) | src-final tree vs git |
| /api/account/session | 200 guest session; providers capability present (PR 18) | repeat probe |
| /api/v1/leaderboard | 200 [] | public read |
| Realtime surface | /realtime/v1/snapshot answers 400 (route mounted; proper WS handshake deferred to device QA LR20) | curl upgrade probe |
| /api/monetization/* | 404 expected until LR12 | probe |
| Backup pipeline | pg_dump → sealed → R2 with verified independent readback every 5 min | backup unit journal (03:02/03:07/03:12/03:18 "backup complete") |
| Alerts | firing (lastAlertAtUtc 2026-10-16T02:20:41Z) | freshness-state.json |
| Deployed source vs repo | boot sourceCommits 2b60ed8 + c172aa5 are BOTH ancestors of origin/V5.2 — no drift; deploy receipt 6fcb2e9 @ 2026-10-15T20:10; latest bundle d4b4c3e7 | state/deploy-receipt.json + journal |

## Failed / degraded (one root cause)

| Symptom | Cause | Fix |
| --- | --- | --- |
| /opsz 503 {ok:false} | freshness check blind to new backups | PR #23 (R2 pagination) |
| mega-xo-v5-freshness.service failed, exit 2 | V5_BACKUP_STALE: newest manifest 19609 s old vs 900 s RPO — but the truncated listing only ever saw the OLDEST 500 backups (2 objects each, key-ordered page, no continuation) | PR #23 |
| mega-xo-v5-health.service failed | "operations probe /opsz is not ok; newest verified backup is stale" — same single cause | greens itself after #23 |
| mega-xo-health.service failed (legacy V4-era unit) | not investigated; flagged for LR03A cleanup | LR03A |

**Expected recovery:** after Main syncs the fixed v5-r2-client.js (PR #23 deployment steps), the next 5-minute freshness run should report state "fresh" and /opsz → 200 {"ok":true}; both monitoring units return to active.

## Header/SEO findings → PR #22

Global X-Robots-Tag noindex on every route (overriding per-page metadata); missing CSP/X-Frame-Options/nosniff/Referrer-Policy on the apex. Fixed in PR #22, pending merge/deploy. Duplicate X-Robots-Tag on core.megaxo.online is Caddy-side (LR03A edge change).

## Config drift confirmation (feeds LR03)

state/prod-source.json still declares kind "nonserving-production-source" (the checked-in inventory posture) while authority-epoch.txt exists and the process serves with MEGA_V5_PRODUCTION_SERVE — the immutable-source vs mutable-runtime separation LR03 requires is not yet in place; a stale deploy restoring the wrong posture caused the documented 502 previously.

## Not verified in this pass (honest limits)

- Authenticated gameplay/matchmaking roundtrip (needs test accounts; covered by device QA LR20). One transient 502 on /api/account/session at 03:26 — not reproducible on repeat probes; watch it.
- True in-DB migration head (needs psql; file parity + readyz + deploy validation is the evidence).
- Vercel auxiliary routing (LR09).
- A real WebSocket client handshake (LR20 device QA).
