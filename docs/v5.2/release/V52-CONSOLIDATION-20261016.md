# V5.2 consolidation — single integration candidate (2026-10-16)

**Role (owner directive):** Main owns merges, production deploys and the independent security audit. Codex owns
implementation, testing and PR authoring. This record covers Main's consolidation of every branch with genuine
unmerged content into one V5.2 integration candidate (not `main`).

## Entry state

Baseline: `origin/V5.2` @ `e4e2ee4`. 21 remote heads: 10 open PRs (#20–#29), 5 merged-but-unretired
(`cashfree-web-payments`, `provider-signin-availability`, `v52-web-oauth`, `v52-game-ui-refresh`,
`v52-provider-release`), 2 preserve branches, 1 review branch, frozen `V4.1` / `V5.1` (⊂ V5.2) /
`v52-codex-integration` (stale).

## Reconciliation (evidence, not assumption)

- `git merge-tree` vs `V5.2`: **every** branch merges cleanly in isolation. Conflicts arise only *between* PRs
  that share files, so ordering matters rather than diffing.
- `git cherry` vs `V5.2`: `preserve/v51-website-reconciliation-20261014` — all 18 commits patch-applied already.
- `preserve/v51-crystal-repair-20261014` — `git cherry` reports 2 unapplied, but `git diff V5.2 <branch>` for the
  5 real files it touches is **empty**: the content is already in V5.2; only a 0-byte placeholder differs. The
  branch also carries a large stale-base delta (854 files, +456k lines) from an old base, so it must **not** be
  merged wholesale. No genuine unmerged content remains outside the 10 open PRs.
- `codex/v52-game-ui-refresh` (+0/-52) and `codex/v52-provider-release` (+0/-57) are fully contained.

## Merge set (dependency order)

| # | Branch | Tip | Merge commit | Conflicts |
| --- | --- | --- | --- | --- |
| — | doc audit | `986023a` | `8ee220c` | none |
| 21 | execution board | `88b0c4e` | `f9d75c8` | none |
| 25 | deploy-guards | `02b71c7` | *(after f9d75c8)* | none |
| 24 | compose-fence | `121909b` | `2ca27cf` | none |
| 22 | crawl-policy-headers | `69bc057` | `2057dca` | none |
| 23 | r2-list-pagination | `79a2998` | `fbddcaa` | none |
| 26 | apple-team-association | `1d30fdb` | *(auto)* | none (auto-merged `v5-production-server.cjs`) |
| 27 | mail-resend | `4c8c576` | *(auto)* | none (auto-merged server + its test) |
| 28 | research-consent-ui | `79c6f84` | `608d39e` | board doc — resolved as chronological union (CP5 then CP6–13) |
| 29 | commerce-ingress | `9390e14` | `44d04da` | `apps/web/app.js` ×3 and `scripts/p21/build-web.js` — resolved as additive union (research-consent + telemetry) |

## Conflict resolutions

All conflicts were **additive**, never competing edits to the same behaviour:

1. `CODEX-EXECUTION-BOARD-20261016.md` — both sides appended checkpoint entries. Resolved to the true
   chronological order (Checkpoints 1–13 contiguous).
2. `scripts/p21/build-web.js` — the `WEB_FILES` allowlist: kept **both** `consent.js` (LR17) and `metrics.js`
   (LR19) in one array.
3. `apps/web/app.js` — three regions: route hooks (kept both `/account` research-consent and
   `/privacy-choices` telemetry), account-action handlers (kept both `research-*` and `metrics-opt*`), and the
   two hydration functions (kept both `loadResearchConsent` and `hydrateTelemetryPanel`).

## Verification

Covering suites run on the merged head: commerce-ingress, metrics, store-pg-adapter, mail-resend,
apple-team-association, consent-ui, r2-list-pagination, compose-fence, deploy-production-guards,
v5-production-server, p21-app, p21-seo, p21-web-build. Result recorded in the ledger/CI on the exact head.

**CI on the consolidation head `911fad8`: 15/15 workflow runs SUCCESS, zero failures** — every
workflow family (P15–P24, PostgreSQL integration, release engineering, native isolated-service,
bot/tutorial, independent audit, website validation), including the two fixes below.

## Fixes landed during consolidation

1. **`ios` failed on every branch, including the pre-existing V5.2 base** — root cause: both native
   workflows hardcoded `xcrun simctl launch "$udid" online.megaxo.prototype`, but the simulator host
   builds with `PRODUCT_BUNDLE_IDENTIFIER = online.megaxo.xoxo` (the prototype id survives only as
   the Android Java package namespace), so the launch failed with
   `FBSOpenApplicationServiceErrorDomain code=4`. Fixed by reading the bundle id from the built
   product; `ios` is now green (LR02/A01).
2. **`validate` failed with `ENOENT: deploy/compose.yaml`** — a genuine PR-caused failure: PR #24
   fenced the V4 compose to `legacy-v4-recovery/compose.yaml.fenced` and made
   `deploy/compose-v5-edge.yaml` the only compose surface, but `tests/production-lifecycle.test.js`
   still read the deleted path (a removed file is not a textual conflict, so no merge marker caught
   it). Retargeted the perimeter/secrets/digest assertions to the V5 surface and strengthened them
   (the edge publishes only 80/443; provider secrets are never mounted into the edge).

## Security review

An independent security review found one HIGH actor-isolation flaw (`core-gateway.js:981` spread
the request command after the signed header actor) — fixed with a regression test proven to fail on
the old order; plus a LOW idempotency-key precedence mismatch — fixed. Two MEDIUM items (actor-free
lane rate limiting, Cashfree create-before-fence) are recorded as owner decisions. Detail:
`V52-SECURITY-REVIEW-20261016.md`.

## Residual / honest limits

- **LR18 P0 (owner action, production host):** the production retention timers run the STAGING
  capture job, so production retention is not enforced (and, as an accidental side-benefit, the
  35-day backup prune gate is still intact). Corrective procedure in
  `LR18-RETENTION-DR-LIVE-20261016.md`; high-impact host change, needs owner go-ahead.
- Provider enablement (Apple credentials, AdMob SSV URL, Resend key, store credentials) and the
  device pass (LR20) remain owner steps; no branch merge changes that.
- `codex/v52-game-ui-refresh` / `codex/v52-provider-release` are stale-but-contained; the
  `preserve/*` branches carry no genuine unmerged content (verified by `git cherry` + empty
  content diff). Safe to delete if the owner wants the remote tidied.
