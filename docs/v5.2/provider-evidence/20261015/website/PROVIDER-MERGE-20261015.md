# Provider branch merge review — 15 October 2026

Prepared in `/Users/oculus/.codex/worktrees/v52-provider-release/Test XO` without committing or pushing.
The existing PR15 remains open for Main review. This is a source merge, not release/cutover approval.

- Provider HEAD: `00e1d7e86e9ba0a70af58ed3eb2e7f0639032cac`.
- Merge target and `MERGE_HEAD`: `origin/V5.2` at
  `59b65b0b26399d31f8ee55ac119a550a6c4a4519`.
- Command: `git merge origin/V5.2 --no-commit`.
- Environment: macOS arm64, Node `v26.8.2`.

## Resolution and inventory

Git reported one conflicted file: `native/ios/MegaXO.xcodeproj/project.pbxproj`, in the Debug/Release
build-settings lines. The resolution retains the reviewed `ASSETCATALOG_COMPILER_APPICON_NAME =
AppIcon` in both configurations and the owner-selected `online.megaxo.xoxo` ID in both. Main's
`ASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS = NO` and all other target settings
remain. The asset-catalog file references and resource build phase also remain wired.
The Debug identity now differs from the earlier free-provisioned `online.megaxo.prototype` artifact.
Main must separately choose/verify its Debug provisioning and rebuild; this source resolution does
not establish that an `online.megaxo.xoxo` Debug build is signed, installed or hardware-validated.

`src/app.js` auto-merged. Its complete staged diff against the target consists only of the four
reviewed local-connection edits: skip local online polling, neutral unconfigured-build copy, hide an
outage banner only in explicit local state, and truthful unavailable-online action copy. Main's
current Undo/Hint implementation and lifecycle are preserved. `src/powers-ui.js`, game rules,
economic authority, production entry point, service roles, association routes, deployment source and
Main's release/authority evidence match the merge target.

The initial post-merge inventory showed Main's
`docs/v5.2/release/BACKEND-AND-RELIABILITY-AUDIT-20261015.md` absent. It was absent from both provider
HEAD and merge base `93dd7c56a7c9d271503170e7b02395d0c0b0113b`; a full-history deletion search on the
provider branch found no deletion commit for this path. Thus it was not an intentional prior
provider deletion. No causal explanation for the initial merge-index omission is established.
Following root's instruction, the exact target copy was restored and staged. Its index blob is
`2edeec4e413b0e0ccc2c49b7e3dbbe4c3157b957`, identical to `origin/V5.2`.

The complete staged comparison against `origin/V5.2` contains the intended provider evidence,
AppIcon/native identity wiring, Friends retry, local connection handling, draft key art and their
tests/scripts/documentation. It contains no deleted Main document or change to Main's authority,
gameplay or powers implementation. No new match redesign changes from the separate game-UI branch
were applied here.

`assets/store/v5.2/key-art-source.png` changed mode only: `100755 → 100644`. Its Git blob remains
`aaa6315bb0729afd914a17a671ded5bcb3b5269c`; no image bytes changed.

## Executed checks

**174 pass / 0 fail / 0 skip:**

```
node --test tests/v52-local-connectivity.test.js tests/v5-client-bundle.test.js tests/v5-native-online-target.test.js tests/v5-p21-account-web.test.js tests/v5-p21-friends.test.js tests/static-ui.test.js tests/v5-native-foundations.test.js tests/powers-game-ui.test.js tests/powers-integration.test.js tests/gameplay-rewind.test.js tests/powers-entitlements.test.js
```

**14 pass / 0 fail / 5 skip:**

```
node --test tests/v5-p11-website-foundations.test.js tests/v51-v5-production-server.test.js tests/v5-pg-integrity.test.js
```

The five skips explicitly report `no V5_PG_URL`: real association endpoint, health endpoint, legal
resource, OAuth callback and browser-auth/PostgreSQL composition cases were not run. They are not
counted as passes. Operational unit/boundary checks ran locally; no live service was contacted.

**43 pass / 0 fail / 0 skip**, including the resolved native-icon settings and Friends retry path:

```
node --test tests/v52-native-icons.test.js tests/v5-p21-app.test.js
```

Also passed:

- `plutil -lint native/ios/MegaXO.xcodeproj/project.pbxproj`;
- `bash -n deploy/v5/db-integrity-check.sh deploy/v5/host-health-monitor.sh`;
- `git diff --check` and `git diff --cached --check origin/V5.2`; no remaining entries from
  `git ls-files -u`.

A full staged check against provider HEAD (`git diff --cached --check`) reports five trailing-space
lines in Main's unchanged `CUTOVER-EVENT-20261015.md:3–7`. They are the document's two-space Markdown
hard breaks, already present on `origin/V5.2`; the exact Main document was preserved. The provider
delta check against `origin/V5.2` has no whitespace errors.

Total executed: **231 pass / 0 fail / 5 skip**. No signed build, device test, provider action, UI
capture, deployment or authority transition occurred. The merge remains staged and uncommitted for
root's concrete review. Rollback before commit is the ordinary abort of this isolated merge; prior
reviewed provider milestones remain in the provider branch history.
