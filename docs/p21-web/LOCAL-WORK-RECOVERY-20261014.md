# Local-work save checkpoint — 14 October 2026

The owner requested all remaining local work be committed. Codex inspected all five registered repository worktrees, fetched current `origin/V5.1`, and preserved Main's active checkout and its recent commits.

## Integration-ready preserved inputs

- `scripts/p21/staging-browser-qa.cjs`: previously untracked 1,415-line browser acceptance runner saved unchanged. JavaScript syntax passes. It requires private operator receipts, private test actors and an approved OTP stdin bridge, and refuses mismatched or mail-enabled targets. It has **not** been claimed as live acceptance for the current deployment. Its older exact-HEAD/process contract needs reconciliation before a new run; no guard was weakened in this save.
- `mega_xoxo_website_logo_pack/`: README and four original transparent PNG branding assets, approximately 5.2 MiB, copied byte-for-byte from Main's untracked local inputs. Website exports remain unchanged.
- `.agents/skills/neon/`, `.agents/skills/neon-postgres/`, and `skills-lock.json`: existing local skill source/reference files and locked upstream provenance, retained unchanged. They contain no provider credentials and no installation/configuration was performed by this save.
- `MAIN-AGENT-EXECUTION-PLAN.md`: the original local 12 October plan, retained unchanged as a historical input. It is distinct from both committed release plans; later owner decisions and the current execution board remain authoritative. Saving it does not reinstate superseded release or scope restrictions.

All 19 original untracked files were captured with exact SHA-256/byte checks before and after copying. Main's source files were neither deleted, moved nor overwritten. They may continue to show as untracked in Main's older checkout until Main integrates this commit; their exact contents are already committed in the isolated integration worktree.

## Separate unfinished recovery commit

The detached website-readiness worktree now contains local commits `c08f323` and `c51834b`, preserving its three previously modified crystal/export/QA files, the original zero-byte JPG capture placeholder, an explicit recovery note and its original captured repair-baseline hashes. This unfinished asset work remains separate from active `V5.1` source; its stale source pin, generated GLBs and visual acceptance must be reconciled before integration. The empty JPG is a failed capture placeholder, never screenshot evidence. Syntax and whitespace checks passed; no render/production acceptance is claimed.

The complete portable recovery diff is also committed at `docs/p21-web/evidence/20261014-local-recovery/crystal-repair.patch`, based on `3775a2f07e043c96856dea207276200f09aa4fad`. This backs up the unfinished work in the integration repository without applying it to runtime source. The original-input byte/hash inventory is stored alongside it.

The other two older detached worktrees were clean, and their existing committed tips are already ancestors of the current integration trunk. No branch was discarded or force-pushed. `main` and `V4.1` remain unchanged.

Ignored private evidence, secret files, dependencies and generated caches remain in place and are deliberately excluded from Git. Committing local work does not authorize publishing credentials or raw authenticated traces.
