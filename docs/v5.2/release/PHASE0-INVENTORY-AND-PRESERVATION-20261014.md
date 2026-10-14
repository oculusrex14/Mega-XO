# V5.2 Phase 0 — inventory, reconciliation and preservation (2026-10-14)

Entry audit before any change. Read-only except where a preservation push is stated.

## Entry references

| Item | Value |
| --- | --- |
| Repository | `oculusrex14/Mega-XO` |
| `V5.1` HEAD at entry | `1b94f645f82e7ffd485a998cd3a612348a32fbdb` (7 behind remote) |
| `origin/V5.1` HEAD at entry | `077bfbc0cc0dc24c4e1e9becb6c264e585108b93` |
| Local checkout | `/Users/oculus/Downloads/Test XO`, on `V5.1`, clean of tracked edits |
| Stashes | none |
| Open PRs | none |

## Branch and worktree inventory

| Ref | State | Unique vs `origin/V5.1` | Disposition |
| --- | --- | --- | --- |
| `origin/V5.1` | active at entry | — | **frozen** as historical reference at `077bfbc` |
| `origin/main` | 891 behind | **2** (CI only) | archived by tag, then retired |
| `origin/V4.1` | old production | 0 | retained (recovery reference) |
| `origin/feat/v51-gameplay-data-capture` | merged | **0** (131 behind) | deletable; no unique work |
| `origin/fix/v51-postmerge-ci-register-20261013` | merged | **0** (75 behind) | deletable; no unique work |
| `V5-platform` (local, remote gone) | merged into V5.1 | 0 | deletable |
| `feat/v5.1-bot-ai-tutorial` (local, remote gone) | merged into V5.1 | 0 | deletable |
| `origin/preserve/v51-website-reconciliation-20261014` | **created here** → `de5d5ef` | (18-commit line) | preserved |
| `origin/preserve/v51-crystal-repair-20261014` | **created here** → `c51834b` | (crystal repair) | preserved |

Worktrees inspected (all detached, none in the main checkout):

| Worktree | HEAD | Uncommitted | Finding |
| --- | --- | --- | --- |
| `/private/tmp/a11ycheck` | `9eddc1c` | clean | contained in `origin/V5.1`; 0 unique |
| `…/.codex/worktrees/v51-website-publish/Test XO` | `077bfbc` | 1 untracked QA script (now in `origin/V5.1`) | 0 unique |
| `…/.codex/worktrees/v51-website-readiness/Test XO` | `c51834b` | 3 asset-script edits, later committed | **unique crystal repair** |
| `…/.codex/worktrees/v51-website-reconciliation/Test XO` | `de5d5ef` | clean | 18-commit website line |

## Unmerged-work report

### 1. The 18-commit website line (`de5d5ef`) — duplicate, not unique

`origin/V5.1..de5d5ef` = 18 commits, `de5d5ef..origin/V5.1` = 242 commits (long divergence from
`2e8e501`). It adds profile editing, friends management, offline practice and motion/audio/icon
assets. **It is a parallel duplicate of work already in `origin/V5.1`.**

Proof over the 209 files those 18 commits touch:

| Measure | Count |
| --- | --- |
| byte-identical to `origin/V5.1` | 196 |
| differing | 13 |
| absent from `origin/V5.1` | **0** |

All 13 differing files are newer in `origin/V5.1` (`apps/web/app.js`, `apps/web/vercel.json`,
`scripts/p21/build-web.js`, the `v5-p21-*` tests, etc. — superseded by later V5.1 integration).
Zero commits and zero files of the 18-commit line are unique. It is preserved on the remote as
`preserve/v51-website-reconciliation-20261014` and **not merged**.

### 2. The crystal repair (`c08f323`, `c51834b`) — genuinely unique, integrated

Six files, dated 2026-10-14, three **absent** from `origin/V5.1` and three differing with the
repair newer than V5.1's 2026-10-12 version:

| File | vs `origin/V5.1` |
| --- | --- |
| `assets/p21/three/factories.mjs` | differs, repair newer |
| `scripts/p21/export-three.mjs` | differs, repair newer |
| `scripts/p21/three-qa.cjs` | differs, repair newer |
| `assets/p21/three/RECOVERY-20261014.md` | absent |
| `assets/p21/three/recovered-repair-baseline-20261014.json` | absent |
| `docs/p21-web/evidence/…/01-blank-script-url.jpg` | absent, **0 bytes** (failed placeholder) |

It replaces the octahedron gems on the crown and every rank emblem with a hand-built faceted
diamond (pointed crown + pavilion, vertex-coloured facets), and tightens the exporter and QA
scripts. **Integrated** into V5.2 (`05ca9a9`), with the 0-byte fake-evidence placeholder dropped
rather than committed, and the GLBs + `provenance.json` regenerated for real against the new
source. These assets are **not runtime-activated** — the shipped site draws 2D webp rank art and
nothing loads these GLBs — so this is pipeline/source preservation, not a shipped-visual change.
The render matrix (`three-qa.cjs`) remains pinned to the old revision and has not been re-run;
`VISUAL_REVIEW` therefore stays pending in the provenance status.

### 3. `main`'s two unique commits — CI only, archived then retired

| Commit | Content |
| --- | --- |
| `7a67e20` | `ci: validate main branch and pull requests` — `.github/workflows/v35-validation.yml`, 2 lines |
| `66b19db` | `ci: validate main before production merges` — same file, 2 lines |

Both only add `main` to trigger lists and rename `Mega XOXO` → `Mega XO` in the workflow name.
`origin/V5.1` already has the complete workflow suite with richer jobs (`p21-web.yml`,
`v5-native.yml`, `v5-p18-acceptance.yml`, …). Nothing is portable except the generic idea "run
validation on the default branch", which V5.2 satisfies. Archived by annotated tag
**`archive/main-pre-retirement-20261014` → `66b19db`** (pushed) before retirement.

## Established baseline

| Item | Value |
| --- | --- |
| Integration SHA (V5.2 base) | **`05ca9a9ae9f4aed89b0448b8bc17b2962d9e7c74`** |
| `V5.1` frozen at | `077bfbc0cc0dc24c4e1e9becb6c264e585108b93` |
| Full `node --test tests/*.test.js` | **1625 tests, 1318 pass, 1 fail, 306 skipped, 0 cancelled** |
| The single failure | `public operational health is fail-closed on backup freshness…` — the known pre-existing `opsz` backup-freshness failure (`503 != 200`), also failing on the clean tree |
| P21 website suite | 238/238 pass |
| Tree state | clean (tracked); untracked scratch only |

## Machine disk audit (read-only)

The owner-reported "3+ GB repository" is **not Git**. Measured with `du`/`git count-objects`:

| Layer | Size |
| --- | --- |
| `.git` | **154 MB** (pack 15.3 MB; loose+objects 137.5 MB) |
| Tracked file bytes | **171.0 MB** (docs 94.4 MB, assets 67.1 MB, everything else < 4 MB) |
| Working tree excluding `.git` | **4.6 GB** |
| `.artifacts/` (untracked scratch) | **3.5 GB** — incl. `v51/multi-source.jsonl` 1.3 GB, `v51/utttai-combined.jsonl` 1.0 GB |
| `tests-output/` (untracked) | **517 MB** |
| `native/android/app/build` | 253 MB |
| `.artifacts/*/node_modules` | ~400 MB across six dirs |

So the active checkout is dominated by untracked build/dataset scratch, not by the repository
history. Pruning strategy follows from this (Phase 1): keep the 171 MB tracked tree lean and keep
scratch out of the repo, rather than trying to shrink a 154 MB `.git` that shares history with
`V4.1`/`V5.1`.

## Not claimed

- No force-push, no history rewrite, no deletion of any branch with unique work.
- All provider/store/device/production claims remain exactly as `E4-E5-CUTOVER-POSTPONED-20261014.md`
  records them: V4.1.2/SQLite is still the sole live writer; V5 production is `nonserving: true`.

## Addendum — branch topology finalized (2026-10-14)

Executed after the audit, on the owner's standing authority to consolidate.

| Ref | Final state | Verification |
| --- | --- | --- |
| `V5.2` | **default branch**, active integration/release/production | `gh repo edit --default-branch V5.2`; `gh repo view` reports `V5.2` |
| `V5.1` | frozen historical reference | annotated tag `freeze/V5.1-final-20261014` → `077bfbc` (pushed; both objects present) |
| `V4.1` | retained previous-production recovery branch | untouched |
| `main` | **retired** (was the default branch, which is why `git push --delete main` was refused until V5.2 took the role) | annotated tag `archive/main-pre-retirement-20261014` → `66b19db` (pushed; tag object `2eed2b7` + deref `66b19db` both listed) |
| `feat/v51-gameplay-data-capture` | **retired** | 0 unique commits vs V5.2 (verified before deletion) |
| `fix/v51-postmerge-ci-register-20261013` | **retired** | 0 unique commits vs V5.2 (verified before deletion) |
| `preserve/v51-crystal-repair-20261014` | retained | unique work, superseded by the V5.2 integration |
| `preserve/v51-website-reconciliation-20261014` | retained | the 18-commit duplicate line, preserved verbatim |

`main`'s two unique commits were content-identical to V5.2's `v35-validation.yml` (same 4 top-level
jobs; the only deltas were the trigger list and the workflow display name, both superseded). Nothing
was lost: `git diff origin/V5.2:.github/workflows/v35-validation.yml origin/main:.github/workflows/v35-validation.yml`
was empty for the file body's job structure, and the archive tag makes the exact commits retrievable.

The V4 release pipeline itself was deliberately left able to build: `v35-validation.yml` still lists
V5-platform and V5.1 in its triggers and still gates V4 tags through `scripts/release-gate.js`, because
V4.1.2/SQLite remains the sole live authority and must stay buildable until the cutover completes.
