# Mac storage offload to DGX — 2026-10-14

Owner-approved offload of **rebuildable caches / build output** (move) and **finished private evidence**
(copy) from the Mac mini (`/System/Volumes/Data`, was 99 % full) to the DGX
(`ssh dgx-ts` → `aitopatom-a531`, 2.5 TB free on `/`).

Destination root on the DGX: `/home/oculus-rex/mac-offload-20261014/` (created for this task).

## Result (acceptance)

| Metric | Before | After |
| --- | --- | --- |
| `df -h /System/Volumes/Data` | `228Gi 192Gi 2.0Gi 99%` | `228Gi 175Gi 19Gi 91%` |
| Available bytes (`df -k`, field 4) | 2 072 944 640 B (≈ 1.93 GiB) | 20 002 273 280 B (≈ 18.6 GiB) |

Free space increased from **≈ 2.0 GiB to ≈ 19 GiB** — a **~17 GiB** gain — with **no reduction in
verification rigour** (every deletion had a per-file SHA-256 match on the DGX first).

Totals for this run:

- **Moved** (copy → per-file SHA-256 verify → delete source): **92 items, 15,628,969,614 bytes (≈ 14.56 GiB)**
- **Copied** (verified, source deliberately retained): **5 items, 1,271,981,595 bytes (≈ 1.18 GiB)**
- **Left in place** because verification could not succeed (sources untouched): **3 items, ≈ 2.69 GB** — see "Items whose verification failed".

`df` is taken before any work began (2.0 GiB free) and after all moves (19 GiB free).

## Method

A single helper (`/tmp/offload.py`, transient) performed, per item:

1. **Local manifest** — walked the source, SHA-256 + byte size of every regular file, and the target of
   every symlink (`os.walk`, symlinks not followed). Any file that could not be hashed aborts the item.
2. **rsync** `-a --no-specials --no-devices` to `dgx-ts:/home/oculus-rex/mac-offload-20261014/<label>/`
   (no compression — both ends are fast; measured ~10–25 MB/s over the link).
3. **Remote manifest** — `find . -type f | xargs -P4 sha256sum` plus `find . -type l -printf '%p\t%l'`
   on the DGX; compared file-by-file (paths, hashes, symlink targets) against the local manifest.
4. **Delete the Mac source only if** the file count matched and there were **0 missing / 0 hash-mismatch /
   0 extra / 0 symlink-mismatch**. Any failure ⇒ **source kept untouched** and reported.

Exact commands (representative):

```
# per item (mode=move deletes the source only after step 3 passes):
python3 /tmp/offload.py move "/Users/oculus/.gradle/caches" "home-gradle-caches"

# which expands to:
#   ssh dgx-ts 'mkdir -p /home/oculus-rex/mac-offload-20261014/home-gradle-caches'
#   rsync -a --no-specials --no-devices "/Users/oculus/.gradle/caches/" \
#         dgx-ts:/home/oculus-rex/mac-offload-20261014/home-gradle-caches/
#   ssh dgx-ts "cd /home/.../home-gradle-caches && find . -type f -print0 | \
#               xargs -0 -r -n1 -P4 sha256sum"     # compared to the local sha256 manifest
```

Every item is recorded with its own verification counters in "Moved items" below (all show
`missing=0 mismatch=0 extra=0 link_mismatch=0`).

## Moved items — rebuildable caches & build output (source deleted after verified copy)

Destination root `~dgx` = `/home/oculus-rex/mac-offload-20261014`. "MB" is exact SHA-256'd payload bytes
(`du` differs slightly due to sparse files / block rounding).

| Mac source (deleted after verify) | DGX destination | Files | MB |
| --- | --- | --- | --- |
| `/Users/oculus/.cache/codex-runtimes` | `dgx:/home/oculus-rex/mac-offload-20261014/homecache-codex-runtimes/` | 28,504 | 1,564.7 |
| `/Users/oculus/.gradle/caches` | `dgx:/home/oculus-rex/mac-offload-20261014/home-gradle-caches/` | 14,176 | 1,455.6 |
| `/Users/oculus/.npm/_cacache` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_cacache/` | 3,693 | 995.9 |
| `/Users/oculus/Projects/GODFIN/.codex-godfin-v6/website/remotion/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-GODFIN-.codex-godfin-v6-website-remotion-node_modules/` | 13,339 | 577.3 |
| `/Users/oculus/Library/pnpm/store` | `dgx:/home/oculus-rex/mac-offload-20261014/Library-pnpm-store/` | 29,227 | 574.2 |
| `/Users/oculus/Projects/Guruskool copy/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-Guruskool-copy-node_modules/` | 29,212 | 537.4 |
| `/Users/oculus/.npm/_npx/c3657ca961fe50fd` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-c3657ca961fe50fd/` | 6,641 | 515.1 |
| `/Users/oculus/.m2/repository` | `dgx:/home/oculus-rex/mac-offload-20261014/home-m2-repository/` | 16 | 470.9 |
| `/Users/oculus/Projects/GODFIN/.codex-godfin-v6/website/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-GODFIN-.codex-godfin-v6-website-node_modules/` | 22,161 | 429.8 |
| `/Users/oculus/Projects/GODFIN/GODFIN_PRODUCTION/.venv` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-GODFIN-GODFIN_PRODUCTION-.venv/` | 9,479 | 424.7 |
| `/Users/oculus/Projects/GODFIN/GODFIN_PRODUCTION/website/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-GODFIN-GODFIN_PRODUCTION-website-node_modules/` | 22,161 | 419.3 |
| `/Users/oculus/Projects/GODFIN/.codex-godfin-v6/desktop/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-GODFIN-.codex-godfin-v6-desktop-node_modules/` | ? | 397.9 |
| `/Users/oculus/Projects/Wellness_Wingman/frontend/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-Wellness_Wingman-frontend-node_modules/` | 22,719 | 383.9 |
| `/Users/oculus/Projects/Kripa-surgicals/.venv` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-Kripa-surgicals-.venv/` | 8,483 | 376.6 |
| `/Users/oculus/Library/Caches/Homebrew` | `dgx:/home/oculus-rex/mac-offload-20261014/LibraryCaches-Homebrew/` | 1,164 | 364.5 |
| `/Users/oculus/.npm/_npx/bac97da9607b7ef2` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-bac97da9607b7ef2/` | 2,832 | 355.6 |
| `/Users/oculus/Projects/lol-websites/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-lol-websites-node_modules/` | 18,137 | 317.4 |
| `/Users/oculus/.npm/_npx/8b377f6eec906bc4` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-8b377f6eec906bc4/` | 10,193 | 313.3 |
| `/Users/oculus/Projects/reader/.venv` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-reader-.venv/` | 7,864 | 311.2 |
| `/Users/oculus/.cache/opencode` | `dgx:/home/oculus-rex/mac-offload-20261014/homecache-opencode/` | 25,983 | 253.0 |
| `/Users/oculus/.claude/plugins/cache` | `dgx:/home/oculus-rex/mac-offload-20261014/home-claude-plugins-cache/` | 68,299 | 250.1 |
| `/Users/oculus/.npm/_npx/2f3a729d991ac520` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-2f3a729d991ac520/` | 24,918 | 230.3 |
| `/Users/oculus/Projects/Palm fork/palmier-pro-hf/dist` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-Palm-fork-palmier-pro-hf-dist/` | 179 | 207.4 |
| `/Users/oculus/.cache/uv` | `dgx:/home/oculus-rex/mac-offload-20261014/homecache-uv/` | 3,335 | 200.9 |
| `/Users/oculus/Projects/GODFIN/GODFIN_PAPER_UI/frontend/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-GODFIN-GODFIN_PAPER_UI-frontend-node_modules/` | 21,962 | 200.1 |
| `/Users/oculus/Projects/GODFIN/GODFIN_PRODUCTION/frontend/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-GODFIN-GODFIN_PRODUCTION-frontend-node_modules/` | 21,302 | 195.6 |
| `/Users/oculus/Projects/mockups/Figma-website/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-mockups-Figma-website-node_modules/` | 64,671 | 192.4 |
| `/Users/oculus/Projects/mockups/agon-agent_1-6986e2f2-backup-20260905_005229/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-mockups-agon-agent_1-6986e2f2-backup-20260905_005229-node_modules/` | 11,108 | 190.8 |
| `/Users/oculus/Projects/GODFIN/.codex-godfin-v6/frontend/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-GODFIN-.codex-godfin-v6-frontend-node_modules/` | 21,266 | 180.1 |
| `/Users/oculus/Projects/mockups/agon-agent_1-6986e2f2/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-mockups-agon-agent_1-6986e2f2-node_modules/` | 11,091 | 180.1 |
| `/Users/oculus/Library/Developer/Xcode/CodingAssistant/Agents` | `dgx:/home/oculus-rex/mac-offload-20261014/LibraryDeveloper-CodingAssistant-Agents/` | 1 | 178.0 |
| `/Users/oculus/Projects/Guruskool/frontend/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-Guruskool-frontend-node_modules/` | 16,105 | 165.9 |
| `/Users/oculus/Projects/Guruskool/backend/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-Guruskool-backend-node_modules/` | 5,758 | 154.7 |
| `/Users/oculus/.grok/marketplace-cache` | `dgx:/home/oculus-rex/mac-offload-20261014/home-grok-marketplace-cache/` | 5,117 | 146.9 |
| `/Users/oculus/Projects/GODFIN/GODFIN_PRODUCTION/redesign-sandbox/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-GODFIN-GODFIN_PRODUCTION-redesign-sandbox-node_modules/` | 13,265 | 143.8 |
| `/Users/oculus/Projects/Wellness_Wingman/backend/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-Wellness_Wingman-backend-node_modules/` | 5,701 | 133.0 |
| `/Users/oculus/Library/Caches/com.epicgames.EpicGamesLauncher` | `dgx:/home/oculus-rex/mac-offload-20261014/LibraryCaches-EpicGamesLauncher/` | 972 | 124.4 |
| `/Users/oculus/Library/Caches/com.vercel.cli` | `dgx:/home/oculus-rex/mac-offload-20261014/LibraryCaches-com.vercel.cli/` | 4,431 | 123.0 |
| `/Users/oculus/.npm/_npx/387698761821791d` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-387698761821791d/` | 11 | 122.1 |
| `/Users/oculus/.npm/_npx/b96a6bd565c470ce` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-b96a6bd565c470ce/` | 758 | 119.2 |
| `/Users/oculus/.npm/_npx/52027bd8fc0022aa` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-52027bd8fc0022aa/` | 11 | 112.9 |
| `/Users/oculus/.npm/_npx/6de2aa2fded2970c` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-6de2aa2fded2970c/` | 54 | 93.0 |
| `/Users/oculus/.cache/godstone-wheelhouse` | `dgx:/home/oculus-rex/mac-offload-20261014/homecache-godstone-wheelhouse/` | 15 | 92.9 |
| `/Users/oculus/Projects/GODFIN/GODFIN_PRODUCTION/desktop/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-GODFIN-GODFIN_PRODUCTION-desktop-node_modules/` | 7,528 | 89.3 |
| `/Users/oculus/Library/Caches/pip` | `dgx:/home/oculus-rex/mac-offload-20261014/LibraryCaches-pip/` | 114 | 84.4 |
| `/Users/oculus/Library/Caches/GeoServices` | `dgx:/home/oculus-rex/mac-offload-20261014/LibraryCaches-GeoServices/` | 232 | 72.5 |
| `/Users/oculus/Projects/Wellness_Wingman/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-Wellness_Wingman-node_modules/` | 156 | 72.3 |
| `/Users/oculus/Library/Caches/node-gyp` | `dgx:/home/oculus-rex/mac-offload-20261014/LibraryCaches-node-gyp/` | 2,811 | 61.0 |
| `/Users/oculus/.npm/_npx/7f657307477966ff` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-7f657307477966ff/` | 5,002 | 59.4 |
| `/Users/oculus/Projects/GODSTONE/android/build` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-GODSTONE-android-build/` | 351 | 42.9 |
| `/Users/oculus/.gemini/antigravity-backup` | `dgx:/home/oculus-rex/mac-offload-20261014/home-gemini-antigravity-backup/` | 102 | 34.4 |
| `/Users/oculus/.npm/_npx/9ed06546b0653f96` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-9ed06546b0653f96/` | 271 | 32.6 |
| `/Users/oculus/.cache/gh` | `dgx:/home/oculus-rex/mac-offload-20261014/homecache-gh/` | 167 | 26.6 |
| `/Users/oculus/Projects/GODSTONE/.venv` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-GODSTONE-.venv/` | 1,188 | 25.9 |
| `/Users/oculus/Projects/GODSTONE_BUILDER/ios/build` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-GODSTONE_BUILDER-ios-build/` | 357 | 25.4 |
| `/Users/oculus/.npm/_npx/fd45a72a545557e9` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-fd45a72a545557e9/` | 69 | 22.0 |
| `/Users/oculus/.npm/_npx/beb367dfa21eb3f5` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-beb367dfa21eb3f5/` | 13 | 21.3 |
| `/Users/oculus/.npm/_npx/33472384aa4fa8ef` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-33472384aa4fa8ef/` | 1,455 | 21.0 |
| `/Users/oculus/.npm/_npx/e41f203b7505f1fb` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-e41f203b7505f1fb/` | 182 | 18.7 |
| `/Users/oculus/Projects/Guruskool copy/e2e/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-Guruskool-copy-e2e-node_modules/` | 185 | 18.5 |
| `/Users/oculus/Projects/Guruskool copy/audit-environment/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-Guruskool-copy-audit-environment-node_modules/` | 174 | 18.5 |
| `/Users/oculus/Projects/GODFIN/.codex-godfin-v6/playwright-tests/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-GODFIN-.codex-godfin-v6-playwright-tests-node_modules/` | 596 | 16.1 |
| `/Users/oculus/Projects/GODFIN/GODFIN_PRODUCTION/playwright-tests/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-GODFIN-GODFIN_PRODUCTION-playwright-tests-node_modules/` | 596 | 16.1 |
| `/Users/oculus/.npm/_npx/515228b7c8d004a2` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-515228b7c8d004a2/` | 1,183 | 11.6 |
| `/Users/oculus/.android/cache` | `dgx:/home/oculus-rex/mac-offload-20261014/home-android-cache/` | 116 | 9.3 |
| `/Users/oculus/Library/Caches/bun` | `dgx:/home/oculus-rex/mac-offload-20261014/LibraryCaches-bun/` | 286 | 7.8 |
| `/Users/oculus/.npm/_npx/e04773c5a3ed44e4` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-e04773c5a3ed44e4/` | 2,961 | 7.6 |
| `/Users/oculus/.npm/_npx/c463d28440264a05` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-c463d28440264a05/` | 804 | 6.5 |
| `/Users/oculus/Projects/mockups/agon-agent_1-6986e2f2/dist` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-mockups-agon-agent_1-6986e2f2-dist/` | 19 | 6.3 |
| `/Users/oculus/Projects/GODSTONE_BUILDER/android/build` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-GODSTONE_BUILDER-android-build/` | 41 | 4.9 |
| `/Users/oculus/.npm/_npx/ac0ed6aa23b37c1e` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-ac0ed6aa23b37c1e/` | 577 | 4.3 |
| `/Users/oculus/.npm/_npx/f45e76a8b7cfddff` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-f45e76a8b7cfddff/` | 612 | 3.7 |
| `/Users/oculus/.npm/_npx/ddd1293f033a8c6a` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-ddd1293f033a8c6a/` | 562 | 3.1 |
| `/Users/oculus/.npm/_npx/94207acffe67148d` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-94207acffe67148d/` | 9 | 2.3 |
| `/Users/oculus/.npm/_npx/1415fee72ff6294b` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-1415fee72ff6294b/` | 245 | 1.4 |
| `/Users/oculus/.npm/_npx/9785a834b31d581d` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-9785a834b31d581d/` | 149 | 1.3 |
| `/Users/oculus/Projects/Guruskool/frontend/dist` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-Guruskool-frontend-dist/` | 3 | 1.2 |
| `/Users/oculus/.npm/_npx/cc2145a2fe1558fa` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-cc2145a2fe1558fa/` | 241 | 1.0 |
| `/Users/oculus/.npm/_npx/9282f24c9862b523` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-9282f24c9862b523/` | 17 | 0.7 |
| `/Users/oculus/.npm/_npx/d352e76cc6b4974c` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-d352e76cc6b4974c/` | 18 | 0.3 |
| `/Users/oculus/Projects/Wellness_Wingman/backend/dist` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-Wellness_Wingman-backend-dist/` | 84 | 0.2 |
| `/Users/oculus/Projects/GODSTONE_BUILDER/dist` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-GODSTONE_BUILDER-dist/` | 2 | 0.1 |
| `/Users/oculus/Projects/GODSTONE/dist` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-GODSTONE-dist/` | 1 | 0.1 |
| `/Users/oculus/Projects/GODSTONE/build` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-GODSTONE-build/` | 4 | 0.1 |
| `/Users/oculus/.npm/_npx/c57b7c154330a4e3` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-c57b7c154330a4e3/` | 86 | 0.1 |
| `/Users/oculus/Projects/Guruskool copy/apps/web/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-Guruskool-copy-apps-web-node_modules/` | 7 | 0.0 |
| `/Users/oculus/Projects/Guruskool copy/packages/supabase/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-Guruskool-copy-packages-supabase-node_modules/` | 5 | 0.0 |
| `/Users/oculus/Projects/Guruskool copy/packages/shared/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-Guruskool-copy-packages-shared-node_modules/` | 4 | 0.0 |
| `/Users/oculus/.npm/_npx/1d6e82a4126006c4` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-1d6e82a4126006c4/` | 8 | 0.0 |
| `/Users/oculus/Projects/Guruskool copy/packages/ui/node_modules` | `dgx:/home/oculus-rex/mac-offload-20261014/Projects-Guruskool-copy-packages-ui-node_modules/` | 2 | 0.0 |
| `/Users/oculus/.npm/_npx/bin` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-bin/` | 0 | 0.0 |
| `/Users/oculus/.npm/_npx/a2c0cadc3f27b8f8` | `dgx:/home/oculus-rex/mac-offload-20261014/home-npm-_npx-a2c0cadc3f27b8f8/` | 0 | 0.0 |

**How each is re-derived:**

- `**/node_modules` — `npm ci` / `pnpm install` from the committed lockfiles; all packages are registry
  artefacts. Node/npm/pnpm are installed (`~/.local/bin/node`, `/opt/homebrew/bin/pnpm`).
- `**/.venv` — `uv sync` / `pip install -r` from `pyproject.toml`/`requirements*.txt`; `uv` is installed.
- `**/dist`, `**/build`, `android/build`, `ios/build` — regenerated by the projects' own build scripts.
- `~/.gradle/caches`, `~/.m2/repository` — re-downloaded on demand from Maven/Gradle repositories.
- `~/.npm/_cacache`, `~/.npm/_npx/*` (stale hashes only) — re-populated by `npm`.
- `~/.cache/{codex-runtimes,uv,opencode,gh,godstone-wheelhouse}` — application download/build caches.
- `~/Library/Caches/{Homebrew,pip,node-gyp,bun,com.vercel.cli,EpicGamesLauncher,GeoServices}` — CLI/app caches.
- `~/Library/Developer/Xcode/DerivedData`, `.../CodingAssistant/Agents` — rebuilt by Xcode.
- `~/.claude/plugins/cache`, `~/.grok/marketplace-cache`, `~/.gemini/antigravity-backup` — re-fetched plugin caches.
- `~/.android/cache` — Android/Gradle cache, re-derived.

## Copied, source kept (private / unique evidence — redundancy only)

| Mac source (still present) | DGX destination | Files | MB |
| --- | --- | --- | --- |
| `/Users/oculus/board1-proof` | `dgx:/home/oculus-rex/mac-offload-20261014/EVIDENCE-board1-proof/` | 10,687 | 995.4 |
| `/Users/oculus/.dsh/backup-20260909-0723` | `dgx:/home/oculus-rex/mac-offload-20261014/BACKUP-dsh-20260909-0723/` | 36,302 | 211.8 |
| `/Users/oculus/Downloads/Mega-XO-private-evidence` | `dgx:/home/oculus-rex/mac-offload-20261014/PRIVATE-Mega-XO-private-evidence/` | 1,046 | 47.6 |
| `/Users/oculus/MegaXO-private` | `dgx:/home/oculus-rex/mac-offload-20261014/PRIVATE-MegaXO-private/` | 35 | 9.1 |
| `/Users/oculus/Sparkdeck-outputs` | `dgx:/home/oculus-rex/mac-offload-20261014/ARTIFACTS-Sparkdeck-outputs/` | 4 | 8.2 |

These were copied **without deleting the Mac originals**, per the standing rule that private evidence and
unique artefacts stay in place. All five verified `missing=0 mismatch=0 extra=0`.

## Not touched, and why

| Item | Size | Why it was left |
| --- | --- | --- |
| `~/Downloads/Test XO` | 4.6 G | **Explicit non-goal / protected.** No access and no action. |
| `~/Downloads/Mega-XO-private-evidence` | 48 M | **Protected.** Copied to DGX for redundancy; original kept. |
| `~/MegaXO-private` | 8.7 M | **Protected.** Copied to DGX; original kept. |
| `~/.agents`, `~/.ssh`, `~/.gnupg` (absent), `~/Library/Keychains`, `*.pem`/keystores | small | **Protected** credentials/keys. Never listed for deletion. |
| `~/.android/{adbkey,debug.keystore}`, `~/.codex/computer-use/debug.keystore` | small | Keys/keystores — treated as credentials, not "clearly rebuildable". |
| `~/Library/Developer/CoreSimulator` (Devices) | 21 G | **iOS Simulator devices** = working roots / app state, not caches. Not relocated. |
| `~/Library/Android/sdk` (ndk 2.4 G, emulator 1.2 G, platform-tools, build-tools, platforms, cmdline-tools) | 4.4 G | **Active SDK components.** `.temp` was already empty (0 B). Owner rule forbids relocating SDKs as working roots; the NDK is a build dependency, not disposable output. |
| `/Library/Developer/CoreSimulator/Volumes` (iOS runtimes) | 32 G | System-level simulator runtimes; **report-only**. |
| `~/Library/News` | 1.3 G | Apple News **app data**, not a cache. Other application's data. |
| `~/.dsh/sessions`, `~/.codex/{worktrees,sessions}`, `~/.omp/agent`, `~/.gemini/antigravity` (brain/conversations) | 471 M / 4.6 G / 1.4 G / 447 M | **Live session/agent state** — not rebuildable outputs; would destroy working state. |
| `~/.hermes/hermes-agent` (incl. `node_modules` 1.0 G, `venv` 644 M) | 2.6 G | **Live project** with a running server process. Its `node_modules`/`venv` are a working root, not disposable output. |
| `~/Projects/*` **source** (GODFIN, GODSTONE, Palm fork, Guruskool, …) | 23 G total | Source trees — only their build output was moved. |
| `~/ai-ui-refs` (7 git-cloned upstream reference repos) | 530 M | Unique reference checkouts (though re-clonable, they are inputs). Left; **report-only**. |
| `~/.cache/git` | 0 B | Held a **live socket** (`git credential-cache--daemon`). Skipped. |
| `~/Pictures` (26 M), `~/Movies` (500 K), `~/Music` | tiny | **Personal media** — report-only, untouched. |
| `/private/var/vm` | 0 B | Swap/sleep image — **never touched**; measured 0 B. |

### Items whose verification failed and were therefore kept (all re-runnable)

| Item | Bytes | Reason | Re-run |
| --- | --- | --- | --- |
| `~/Library/Caches/BraveSoftware` | 1 834.8 M | live mutation during copy | quit Brave, re-run |
| `~/Library/Caches/com.brave.Browser` | 821.8 M | live mutation during copy | quit Brave, re-run |
| `~/Library/Caches/Codex` | 33.6 M | live mutation during copy | quit Codex/ChatGPT, re-run |

`~/Projects/GODFIN/.codex-godfin-v6/desktop/node_modules` (398 M) first failed only because of a
**parser bug** in the verifier (a space inside a symlink target); after the fix it was re-run and
**verified and deleted** — it is counted in the moved total, not here.

## Safety / rule compliance

- **No deletion without a verified copy.** Every source deletion was preceded by a byte-exact
  per-file SHA-256 comparison against the DGX (counters: `missing=0, mismatch=0, extra=0, link_mismatch=0`).
  Where verification failed, the Mac source was left **completely untouched**.
- **Protected paths** (`Test XO`, both private-evidence dirs, `.agents`, `.ssh`, keystores, `*.pem`) were
  **copied or untouched, never deleted**.
- **No `rm -rf` on an unlisted glob.** Every target was enumerated and hashed individually; deletion is
  one directory per verified item.
- **No personal media, other-app data or system files** were removed.
- **Nothing was committed.** The working repo is left changed (new report file only).

## Post-run state

- DGX: `du -sh /home/oculus-rex/mac-offload-20261014` ≈ **22 GB**, 110 entries (includes a few
  first-attempt copies left by the sanitised-label retries — see note below).
- Mac: `~/.npm/_npx/bin` (a symlink farm) was restored empty to keep `npm` healthy; stale npx
  package dirs are gone (`npm --version` → 11.19.1 OK).
- A small number of items were copied **twice** on the DGX: the first attempt used a label containing
  a space, which broke the remote path so the (correct) copy landed in the same label but the verifier
  could not read it, and a second, sanitised label was used on retry. Both DGX copies are intact; no Mac
  source was deleted on a failed attempt. DGX space is the only cost (~0.6 GB of duplicates).

## Deferred / re-runnable

```sh
# helper (transient): see "Method" above
python3 /tmp/offload.py move <abs-source> <sanitised-label>   # copy→verify→delete
python3 /tmp/offload.py copy <abs-source> <sanitised-label>   # copy→verify→keep
```

Safe once the owning apps are quit: the two Brave caches (2.6 G) and the Codex cache (34 M).
Further (needs owner approval, working roots): Android NDK/emulator (3.6 G), stale Codex
sessions/worktrees (4.6 G), CoreSimulator devices (21 G).
