# V5.2 annotation-lane integration — Main (2026-10-17)

Outcome of Main's independent review of the Codex annotation lane on `V5.2`, ending with three
fixes Main authored. All work is on `V5.2`; nothing was merged to `main` and nothing was deployed.

## Regressions found in review and fixed

The lane's `8b8d811` (account-link flow) grew two sqlite tables — `identities` gained
`verified_email`, `signin_attempts` gained five `decision_*` columns — but three writes still used
positional `INSERT … VALUES(?,…)` and broke at runtime. All three now name their columns.

| Fix | Commit | Symptom | Proof |
| --- | --- | --- | --- |
| Migration fixture inserts | `20cc65c` | `table identities has 5 columns but 4 values were supplied`; P18 disposable job's `sqlite-snapshot-to-postgres-import` suite failing since `5977dcfc` (last green `493b2ec`) | full P18 disposable suite 61 assertions / 6 suites green locally |
| Production email write | `18035c2` | same error in `server/production/email-auth.js` verify() — every email signup/link/verify aborted; failed P1-9 OTP-abuse + account-enumeration acceptance tests | p1-abuse-acceptance 9/9, affected account suites 41/41 |
| Guard test | `1170a36` | none (preventive) | `tests/v5-schema-insert-drift.test.js` catches the exact regression when reintroduced |

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
