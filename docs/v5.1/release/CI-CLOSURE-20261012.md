# V5.1 service-suite CI closure (CI01/CI02/CI03) - 2026-10-12

Main agent. Supersedes only the red-state rows of `CI-CHECKPOINT-20261012.md`; the retention
contracts otherwise stand.

## Root cause and fix (commit `99353a6`, pushed to V5.1)

- **CI01** `tests/v5-p08-transport.test.js`: the post-redeem logout test seated `svc_frank` against
  `svc_bob`, but the cross-actor test had already committed `svc_bob` into `match:p08-notpart` on the
  same durable authority, so the fixture raised `ALREADY_IN_MATCH` from the production
  single-active-match guard before the revocation assertion. Fix: a genuinely free pair
  (`svc_frank` + a dedicated `svc_grace` seed). The guard is untouched; the 1008 `SESSION_REVOKED`
  assertion, the real DB/socket/session behavior and the unredeemed-ticket check are unchanged.
  A stray `console.log` was also removed from the assertion path.
- **CI02** `tests/v5-p11-browser-compat.test.js`: `setupApiHarness` gave the API an API-role pool,
  accounts and a local Core object, but the queue read now executes through
  `resolveGateway(context)`, which the fixture never supplied, so `GET /api/v1/queue` returned 503.
  Fix: the harness composes the REAL Core host (Core + Core-owned queue service on the `core_runtime`
  pool + its ephemera namespace behind `createCoreServiceIngress`) and points the API at it with
  `createCoreGateway`. The API still holds only API-role credentials and no Core pool; the queue
  service and its pool live inside the Core host. A new test **5b** asserts that an unconfigured Core
  (no URL/secret) fails the queue read closed with an honest 503 and never a fabricated idle 200; no
  fake response or swallowed error is used.

## Executed evidence

| Environment | SHAs / command | Result |
|---|---|---|
| Owned loopback PG16 + Redis (local, macOS) | `V5_PG_REQUIRED=1 V5_REDIS_REQUIRED=1`; `tests/v5-p08-transport.test.js` | 13/13 pass |
| Owned loopback PG16 + Redis (local) | `tests/v5-p11-browser-compat.test.js` | 8/8 pass |
| CI job `disposable-services` (Linux, ubuntu-latest) | run `38238762725` on `99353a6`, step "Execute database, economy, auth, queue and abuse suites without service skips" | **728 tests, 725 pass, 0 fail, 3 skip** |
| Artifact `v51-disposable-service-evidence` id `11741841423` | `postgresql.log`, sha256 `7e9e14481d9aeb9ce27fb024a486753b0f4f1453564434f6149b46b17b54cda4` | retained |

Justified skips (reconciled to their dedicated CI, not rewritten as PASS):

- `ok 405` P15 twin-PG archive roundtrip - runs only in P15 ephemeral CI.
- `ok 497` P19 disposable Redis wipe / Core reopen - P19 disposable CI markers only.
- `ok 498` P19 real disposable load - requires a separate owned-loopback CI, not root regression.

The three broad-service skips that `CI03` flagged are therefore reconciled to the dedicated
recovery/chaos workflow `V5.1 dedicated recovery and chaos gates` (run `38238763727` on `99353a6`:
success), which owns the P15/P16/P19 fault-injection evidence.

## Other workflows on the repaired head

- `V5.1 independent audit regression` (run `38238762788`) - success.
- `V5.1 dedicated recovery and chaos gates` (run `38238763727`) - success.
- `V5.1 bot and tutorial validation` (run `38238762683`) - success.
- Android/iOS emulator/simulator artifact sets retained (`11742620619`, `11742490844`); these prove
  emulator/simulator compilation and offline launch/bundle assertions, **not** signed physical-device,
  online identity, billing/ad provider, store approval or release acceptance.

## Residual (out of Main agent's authority)

Branch-protection configuration needs Codex/repo-admin once the required-check set is frozen; the
workflow-level CI is green. No production change, model publication, index change or secret exposure
occurred during this repair.
