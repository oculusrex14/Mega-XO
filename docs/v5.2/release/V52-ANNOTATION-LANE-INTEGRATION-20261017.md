# V5.2 annotation-lane integration — Main (2026-10-17)

Outcome of Main's independent review of the Codex annotation lane on `V5.2`. Main authored nine
fixes. All work is on `V5.2`; nothing was merged to `main` and nothing was deployed.

## Regressions found in review and fixed

The lane's `8b8d811` (account-link flow) grew two sqlite tables — `identities` gained
`verified_email`, `signin_attempts` gained five `decision_*` columns — but three writes still used
positional `INSERT … VALUES(?,…)` and broke at runtime. All three now name their columns.

| Fix | Commit | Symptom | Proof |
| --- | --- | --- | --- |
| Migration fixture inserts | `20cc65c` | `table identities has 5 columns but 4 values were supplied`; P18 disposable job's `sqlite-snapshot-to-postgres-import` suite failing since `5977dcfc` (last green `493b2ec`) | full P18 disposable suite 61 assertions / 6 suites green locally |
| Production email write | `18035c2` | same error in `server/production/email-auth.js` verify() — every email signup/link/verify aborted; failed P1-9 OTP-abuse + account-enumeration acceptance tests | p1-abuse-acceptance 9/9, affected account suites 41/41 |
| Guard test | `1170a36` | none (preventive) | `tests/v5-schema-insert-drift.test.js` catches the exact regression when reintroduced |
| Web test fixtures | `c1632d1` | the lane added `apps/web/store.js` (imported by `app.js`) but the `v5-p21-account-web` sandbox did not spread it → 7 × `WEB_PRODUCT_IDS is not defined`; the sponsors redesign renamed the preferences panel and copy, leaving `v52-public-annotations` asserting dead markup | account-web 7/7, annotations 7/7, affected web suites 90/90 |
| Frozen-contract tests | `716c5b1` | `f02f3ec` added the crown-banked `purchase` lane (pre-existing: fails on `493b2ec`/`f02f3ec`/`9ef2ebf`); `8b8d811` added the owner-decided Google `email` scope | powers + provider-authorization 31/31 |
| **Retained client syntax error** | `2616d68` | `8b8d811` wrote raw apostrophes inside single-quoted JS strings in `src/community.js` (`couldn't`/`We'll`/`profile's`/`won't`), so the file failed to parse, `MegaCommunity` never loaded, and the browser client never reached the guest control — the real cause of the `v52-bot-tutorial` `[data-c="guest"]` timeout | `node --check src/community.js` passes; affected tests 56/56; gate added |
| P21 store-unavailable QA | `bd02ae1` | the Mega Pass panel kept `data-store-action="purchase"` on its disabled button, so the P21 browser QA `P21-BROWSER-SYNTHETIC-STORE-UNAVAILABLE` check (and `v5-p21-pages:168`) found a purchase action while the provider was unavailable; P21 web was green at `493b2ec` and red from `5977dcfc` | P21 browser QA 934 checks / 0 failures; v5-p21-pages 18/18; broad web suites 106/106 |
| API body ceiling | `7bedd6c` | `5c37ed6` capped every POST/PUT/PATCH body at 100 KiB and `req.destroy()`d on overflow, so the native challenge/finish/token contract (300000) was unreachable — a legitimate 200 KiB native body answered 413 — and genuine overflow reached the client as ECONNRESET; `v5-p11-native-session` body-limit test broke | native-session 8/8; p13-security + contracts + monetization-http + ingress-bounds 40/40 at CI concurrency; 200 KiB native body reaches the route; p13 8.3 re-pinned to the real >300000 ceiling |

## What Main verified on the lane (unchanged from the review record)

- Suites re-run on the exact head: 132/0, 39/0/1-skip, 14/0, and the full PG-gated tournament
  journey 14/0/0.
- Migrations 0058/0059/0060: applied on a disposable PG16.15, conformance `--verify` ok, 60/60
  checksums, correct role posture, no destructive SQL.
- Security deltas reviewed: Polar v1 framing (fixed the comma-separated gap at `811c349`),
  provider-callback IP limiter (fail-closed), core-gateway arg forwarding, spectator read-only,
  member projection.
- Annotation assets: mega-pass.webp is transparent and served at `/assets/art/`; 7 sponsor
  placements + disclosure; one capabilities-fed tournament catalog.

## Owner decisions recorded

- **Website approved for deployment** (owner's port-4196 UI review complete). Deployment waits on
  integration plus the pre-deploy env/webhook items below.

## Residual (owner-actionable)

- Optional: `POLAR_PRICE_MEGA_PASS` / `POLAR_PRICE_CENTS_MEGA_PASS` in the approved env, and verify
  the Polar sandbox price ids for all five products.
- Point the Polar/Cashfree webhooks at
  `https://megaxo.online/api/monetization/{polar,cashfree}/webhook`.
- LR02 final CI stays last per the standing order.
- iPhone device-matrix pass outstanding.
