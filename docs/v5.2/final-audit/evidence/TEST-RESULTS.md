# Test Results (audit evidence index)

Trunk: codex → PR #30 → V5.2. GitHub Actions is the only suite runner (owner directive 2026-10-17). Local work is limited to targeted single-behaviour smokes recorded here.

## Baseline (2026-10-17 ~05:34 UTC, head 7f582b7 / PR merge b645f404)

- 25 checks pass, 2 fail:
  - browser-presentation: 2/745 failures, both P21-BROWSER-REFLOW, mobile320 only, routes /sponsors and /ads (run 39006747099, job 117320707075).
  - Android emulator offline first-launch: NATIVE_GAMEPLAY_SMOKE phase=move-confirm CDP_COMMAND_TIMEOUT (run 39006747061, job 117320920404). App cold start OK (TotalTime 4010ms).

## Local targeted smokes (owner single-smoke exception)

1. /tmp/strong-probe.cjs (chromium headless, 320x740, local build): BEFORE - strong contact@antimatterinnovations.com right edge 324.1px on both routes; AFTER fix - no overflowing strong. Evidence: decision log 12:05 entry.
2. node --check on well-known.js + p11 test; DEFAULT_ASSET_LINKS package list verified ["online.megaxo.xoxo","online.megaxo.game"]. No suite run.

## Remediation commits

- bdc4af4 fix(web): wrap sponsor enquiry email at 320px viewports (MXA-UI-001).
- a385774 fix(api): associate the release application id in Android App Links (MXA-REL-001) + strengthened frozen-contract test.
- 3660905 docs: audit scaffold + guardrail register v1.
- ce97b36 docs: master findings register v1.

## Revalidation

- Run set on 8886a8d (final functional head): **28/28 checks green** — including Android emulator offline first-launch 2m25s WITH the hardened smoke (evaluate ceiling 20s, move-confirm window 100 polls), validating the MXA-CI-001 fix. The terminal closure commit is docs-only (MXA-CI-001 resolution + regenerated MASTER-FINDINGS + this note); its push-triggered run is the authoritative final validation.

- Run set on 446b68b (all functional audit changes): **28/28 checks green, 0 failed, 0 pending** — includes validate (1921-test regression with the updated p05 contract), Android emulator offline first-launch (1m58s), browser-presentation (4m13s, 935 checks), PG schema/guards, P18 journeys, disposable services, ios-simulator. The 446b68b SHA is the audit functional head of record.
- Terminal commit note: the final audit commit is the MXA-INF-008 metrics intake fix plus docs-only SHA pinning; its own push-triggered Actions run is the authoritative final validation and its result is visible via `gh pr checks 30`.

- Run 39009250346 (head ce97b36): browser-presentation PASS 3m59s (the 320px fix holds in CI). validate + source-and-android FAILED on tests/v5-native-online-target.test.js:321 - a second frozen contract pinning assetlinks to exactly 1 statement (2 !== 1). Contract updated to require both statements; re-run on next head.

- Run 39009250346 (head ce97b36): browser-presentation pending at time of writing; static-website pass; realtime lanes pending.
- Native run (head ce97b36): in progress; the 7f582b7 emulator failure was classified SUSPECTED_FLAKE (no game/native code in the 10-commit range) and its failed-job rerun was cancelled by newer pushes - the current-head run is the verdict.
- Intermediate native runs (2714204b, a385774e) were cancelled by concurrency (docs-only pushes); superseded.

## Known limitations

- No local suite runs; per-check CI results are the sole suite evidence.
- Device acceptance (both phones) remains a separate owner-visible pass; CI is not device evidence.
