# V5.2 post-consolidation verification — Main (2026-10-16)

Independent verification of the branch consolidation performed on `V5.2`. Claims were checked
against live repo state and re-run suites, not taken from the consolidation author's report.

## Claims verified

| Claim | Method | Result |
| --- | --- | --- |
| V5.2 is the single merge candidate and the default branch | `gh repo view` | V5.2 = default branch ✓ |
| Every codex/PR branch is contained | all 10 PR heads' content via archive tags | in V5.2 ✓ |
| No content lost by the branch deletions | each of 22 `archive/20261016-*` tags vs V5.2 | all preserved (1 redundant backup tag ahead, its content present) ✓ |
| Main's security fix retained | `core-gateway.js:1014` on V5.2 | `{ ...input, actor: actorHeader, opKey: opKeyHeader }` present ✓ |
| Key suites green | re-run on the exact final head | polar-commerce/cashfree/ingress/rate-limit 29/29, migrations 11/11 ✓ |
| Full security set green | re-run on `67a2a5f` | 90 pass / 0 fail / 12 env-gated skips ✓ |
| CI green across workflow families | `gh run list` on the content head `f5334a5` | 15/15 success, 0 failures ✓ |

## Branch/tag state at close

Remote heads: `V4.1`, `V5.1`, `V5.2`, `preserve/v51-crystal-repair-20261014`,
`preserve/v51-website-reconciliation-20261014`. Open PRs: 0.
Archive tags: 22 (`archive/20261016-*`), each restorable via
`git checkout archive/20261016-<name> -b <name>`.

Every head that was deleted was verified reachable on the remote as an archive tag before deletion,
and every archive tag's content is an ancestor of V5.2 — except `archive/20261016-backup-pre-rebase-polar`,
a deliberately-orphaned pre-rebase backup whose Polar content (`0057_polar_orders.sql`, `polar.js`,
`tests/v52-polar-commerce.test.js`) is independently confirmed present in V5.2.

## preserve/* branches (left deliberately — not unmerged work)

- `preserve/v51-website-reconciliation-20261014`: `git cherry` vs V5.2 → all 18 commits patch-applied.
- `preserve/v51-crystal-repair-20261014`: `git cherry` reports +2, but the 5 files those commits touch
  (`factories.mjs`, `RECOVERY-20261014.md`, `recovered-repair-baseline-20261014.json`, `export-three.mjs`,
  `three-qa.cjs`) are byte-identical to V5.2; the branch's apparent delta is stale-base divergence.
  Nothing V5.2 lacks.

## Residual (owner-actionable, unchanged by consolidation)

- **LR18 P0:** production retention timers run the STAGING capture job (production retention not
  enforced; backup-prune gate still intact). Procedure: `LR18-RETENTION-DR-LIVE-20261016.md`.
- **2 MEDIUM security items** (actor-free SSV/webhook lane rate limiting; Cashfree create-before-fence)
  — `V52-SECURITY-REVIEW-20261016.md`.
- Provider enablement (Apple/AdMob/Resend/store credentials) and the LR20 device pass remain owner steps.

## Note

The working directory is shared with a concurrently-running agent that also pushes to `V5.2`
(board checkpoints). All of Main's verification was performed in a separate worktree
(`/tmp/v52-verify`) at the exact tips, so no concurrent write affects these results.
