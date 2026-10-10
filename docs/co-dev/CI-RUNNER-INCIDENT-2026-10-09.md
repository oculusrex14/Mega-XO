# GitHub Actions pre-run incident — 2026-10-09

**Owner:** GitHub repository administrator / primary execution agent.  
**Affected branch:** `co-dev/v5-integration` (single [draft PR #9](https://github.com/oculusrex14/Mega-XO/pull/9)).  
**Status:** **RUNNER-ALLOCATION SYMPTOM RESOLVED WHILE REPO IS PUBLIC** (2026-10-09); private repository Actions entitlement/billing root cause remains **UNVERIFIED**. This document preserves historical zero-step failures; they do NOT describe current PUBLIC-repo CI.

## Observed recovery after temporary PUBLIC visibility — 2026-10-09

The repository owner switched `oculusrex14/Mega-XO` from PRIVATE to PUBLIC. GitHub-hosted Actions immediately accepted rerun requests; actual Ubuntu and macOS runners executed commands, PostgreSQL/Redis services and native emulator/simulator boots. This strongly implicates a **private-repo account/runner eligibility, billing or spending limitation**, but the exact private-repo settings/annotations were not accessible; do not represent the specific cause as proved.

Re-run and fix cycle produced **11/11 PASS** at code SHA `9bc6f9f1398092aa8f5b7d7c553103a90525fae0`. [Full exact-source workflow/run ledger](../../CO-DEV-README.md#executed-real-github-actions-ci--2026-10-09). There were initial *genuine* failing source tests once runners started (P04 frozen-time fixture, P08 auth assertion and backpressure fixture, P19 retired P06 Redis method names, P07/P08 invalid namespace versions); those were repaired with small commits and the full set rerun, not skipped or overridden.

**Previous incidents in sections below are historical evidence only.** Keep the repo public solely under the owner's explicit temporary decision; review public history for credentials or unintended player data, assess private repo Actions spending/limits, and re-privatize only with a verified plan to preserve CI. Never claim the public switch repaired the private-runner entitlement itself. A later documentation-only commit changes HEAD; its current-head CI status must be verified separately, even though the code SHA above was fully green.
## Observed facts (not guesses)

At source SHA `6ef81396346411cbe72e35f3c97016cc5be0113c`, the 2026-10-09 10:17:34Z PR workflow runs ended `failure` within roughly four seconds, with **no GitHub-hosted runner name and no executed steps**. For example:

- [P19 workflow run 37916692249](https://github.com/oculusrex14/Mega-XO/actions/runs/37916692249): two failed jobs, IDs `113774504813` and `113774505160`, **zero job steps**; Actions timing reported Ubuntu billed time **0 ms** across both jobs.
- [Mega XO validation run 37916692202](https://github.com/oculusrex14/Mega-XO/actions/runs/37916692202): validation failed with zero steps, dependent jobs skipped.
- [P22 source-only run 37916692132](https://github.com/oculusrex14/Mega-XO/actions/runs/37916692132): job failed with zero steps.

The previous full integration audit also found **all nine** current-head workflows affected. A check-run/job-log lookup was insufficient to establish the initiating provider/account failure. GitHub repository Actions settings endpoints were not accessible through the available connector. These observations are **not executed tests** and neither prove nor disprove Node, schema, Kotlin, Swift or Redis correctness.

## Current-head recheck (after P23)

At source `41177477377e5f2412326a314cbe8a0eeaf589c6`, **10/10** triggered workflows on PR #9 concluded `failure`. Every job in each workflow had **zero executed steps** and **no runner name**, with downstream jobs skipped. In particular, the new [P23 run 37920357542](https://github.com/oculusrex14/Mega-XO/actions/runs/37920357542) and [release-engineering run 37920357484](https://github.com/oculusrex14/Mega-XO/actions/runs/37920357484) both failed before source checks began. This independently reproduces the prior incident on the newest code. **No completed P23 Node24 suite has run.**

## G08 post-gate integration rerun (2026-10-09)

After accepted G08 (`a09c1578e8dc`) was merged into co-dev and the realtime hardening tests were added, the [PostgreSQL workflow 37928384012](https://github.com/oculusrex14/Mega-XO/actions/runs/37928384012) and [release-engineering workflow 37928384048](https://github.com/oculusrex14/Mega-XO/actions/runs/37928384048) again ended **failure with zero steps and no runner assigned**. This applies to the new HTTP authentication, masked-TCP backlog and Redis due-TTL regressions as well: their Node24 tests were **not executed**. It remains a scheduling/account/platform symptom, not proof of application-test failures or passes. See [P08 co-dev review](P08-POST-GATE-HARDENING.md) for exact integration requirements.

## P24 final source review (2026-10-09)

At source `d2f8f59370c2287dd90d300e4969fdafe5c0d809`, **all 11/11** triggered workflows ended in failure with **zero executed job steps**. The new [P24 evidence-led scaling run 37930690645](https://github.com/oculusrex14/Mega-XO/actions/runs/37930690645) had a failed job with **no runner name and no steps**; [PostgreSQL run 37930691065](https://github.com/oculusrex14/Mega-XO/actions/runs/37930691065) and [release run 37930690633](https://github.com/oculusrex14/Mega-XO/actions/runs/37930690633) were likewise zero-step failures. These are not executed Node24 tests or P24 acceptance evidence. The actual cause remains unverified; see [P24 handoff](P24-SCALING-HANDOFF.md).

## Most useful owner checks, in order

1. Open any failed run directly in GitHub Actions, inspect the job banner, notices, annotations, and repository/org activity/limits. If a billing/usage lock, spending limit, GitHub-hosted runner entitlement or payment issue exists, resolve it through the account owner; **do not** publish credentials or billing data here.
2. Check repository Settings → Actions → General and available runner policy. Confirm GitHub-hosted `ubuntu-latest` is eligible for V5 PR jobs, Actions use is enabled, and no org restriction or approval gate prevents assignment. Do not weaken PR permissions, required checks or protected branches merely to green CI.
3. Check [GitHub Status](https://www.githubstatus.com/) for Actions incidents coinciding with the UTC run timestamps. An outage is a possibility, **not** a confirmed cause.
4. After remediation, rerun the **exact current PR source SHA**, not an old G07-successful checkpoint. Confirm a named runner was assigned, actual test steps executed, and zero skips/failures in each mandatory workflow: V5 PostgreSQL, main validation, P15, P16, P17, P18, P19, P20 native hosts, P22, and P23.
5. Record run IDs, source SHA, test counts, signed artifact provenance, staging/provider/device evidence and any genuine test failures. Fix actual failed assertions with small commits and repeat. If runner allocation still fails, preserve the previous unexecuted classification rather than treating old green runs as a substitute.

An independent **manual local** build/test run can help diagnose source errors, but does **not replace** protected GitHub branch checks or executed provider/device gates. A self-hosted runner is an optional later architecture decision with isolation and maintenance costs; do not add it to production or spend money solely to evade the diagnostic.

## Repeatable, safe local classification

A pure offline triage tool, `scripts/v5/ci-runner-diagnostic.js`, accepts **only** a sanitized local `.artifacts/v5-ci-runs.json` packet containing run/job IDs, exact source SHA, status, conclusion, runner allocation and step count plus billed milliseconds. The entire `.artifacts/` directory is already excluded by `.gitignore`. The tool makes **no network calls**, never fetches tokens, does not rerun workflows, and cannot approve a release.

```sh
node scripts/v5/ci-runner-diagnostic.js .artifacts/v5-ci-runs.json
node --test tests/v5-ci-runner-diagnostic.test.js
```

The classification `FAILED_BEFORE_RUNNER_OR_TEST_STEPS` is deliberately **not** `CODE_TEST_FAILURE` or `GATE_PASSED`. It reports `rootCauseVerified:false` and `releaseAuthorized:false`. This diagnostic and its regression checks have now also **executed on actual GitHub-hosted Node24 runners** as part of the 11 green workflows. A private-repo runner problem can recur if the repository is made private again without understanding its Actions entitlement.

**Do not change live V4, delete artifacts, disable GitHub branch protection or start P22/P23 production work to make these workflows look healthy.**
