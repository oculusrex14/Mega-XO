# Consolidated CI checkpoint - 12 October 2026

Read this after HANDOFF-20261012.md. **Integration is complete; release validation is not all green.** No production change or model publication occurred. This checkpoint supersedes earlier pending-run descriptions, not the original acceptance contracts.

Validated configuration source: `88907f8b6f90cf06acfd45b5bd694d4e963ab188`. Subsequent handoff/instruction changes are documentation only. Application source remains the clean audit merge `02452da428dd93eea5a66f91ffb1a71d5a543e1f`.

| Workflow | Run | Result |
|---|---|---|
| General Mega XOXO validation | 38211589114 | SUCCESS; image/publish jobs skipped, no deployment |
| Bot/tutorial validation | 38211589152 | SUCCESS |
| Independent security/role/PG audit | 38211589113 | SUCCESS |
| P21 website build/browser/accessibility | 38211589116 | SUCCESS |
| Dedicated disposable recovery/chaos | 38211589105 | SUCCESS |
| Extended services/platform | 38211589138 | FAILURE in disposable-services; Android emulator, iOS simulator, Firefox and WebKit jobs passed |

Run URLs use `https://github.com/oculusrex14/Mega-XO/actions/runs/<run-id>`.

The retained `v51-disposable-service-evidence` artifact ID `11729685939` contains `postgresql.log`: **727 tests, 722 pass, 2 fail, 3 skip**. Artifact ZIP digest reported by GitHub: `7ba7cc82710e62e5894ef1b4094b180eb0ea7ea12184e20a8fc15fba055c5900`. Prefer the complete retained TAP artifact over partial/contradictory earlier job-log summaries. Other path-filtered neural/league runs need their own exact run evidence; neither a training smoke nor a successful workflow approves an Impossible model.

## R02 immediate repair: Main agent executes, ChatGPT reviews

### CI01 - isolate the post-redeem logout fixture

Failure: `tests/v5-p08-transport.test.js:798`, `post-redeem session logout refuses subscribe`, raises `ALREADY_IN_MATCH` from `playMatch` before the revocation assertion.

Source inspection: the shared database already has `svc_bob` in `match:p08-notpart` with `svc_dave`. The later logout test attempts a new Frank/Bob match. This fixture reuses an occupied actor; the production single-active-match guard is correct. Use separately seeded actors or another genuinely unoccupied fixture pair. Keep actual database/socket/session revocation behavior and the 1008 close assertion. Verify the entire file, not only the named test, because the defect is order-dependent. Do not relax `Authority._offer`, clear arbitrary production occupancy or suppress the test.

### CI02 - compose the real queue read dependency

Failure: `tests/v5-p11-browser-compat.test.js:533`, read-only GET test, sees `503` instead of `200` for `/api/v1/queue`.

Source inspection: `setupApiHarness` passes API-role pool, accounts and a local Core object. `createApiHandler` now installs queue operations through `resolveGateway(context)`, but this harness does not supply the signed Core gateway/ingress composition. Wire the existing real Core ingress/gateway and real queue dependencies into the fixture, following the working P11 signed-gateway tests. Keep API/Core credentials separate and preserve no-write snapshot assertions. Also retain a negative test showing a missing/unhealthy configured Core returns an honest service error. Do not make the test pass with a fake idle response, swallowed error, direct privileged API SQL or expanded grants.

### CI03 - close the validation loop

Run both complete fixture files against owned disposable PostgreSQL and Redis, then the complete extended workflow and affected general/audit/browser checks. Capture exact SHA, command, run, TAP totals, justified skip identities and retained artifact hashes. The three broad-service skips must be reconciled to the dedicated recovery/chaos evidence; do not blindly rewrite skips as PASS. Repair any newly exposed failures rather than truncating the suite. Update R02 and the source acceptance ledgers only after the matching evidence exists.

The fresh Android/iOS results prove emulator/simulator compilation and offline launch/bundle assertions, **not signed physical-device, online identity, billing/ad provider, app-store approval or release acceptance**.
