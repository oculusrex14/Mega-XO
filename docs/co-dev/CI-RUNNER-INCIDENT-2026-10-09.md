# GitHub Actions pre-run incident — 2026-10-09

**Owner:** GitHub repository administrator / primary execution agent.  
**Affected branch:** `co-dev/v5-integration` (single [draft PR #9](https://github.com/oculusrex14/Mega-XO/pull/9)).  
**Status:** OPEN; root cause **not established**; code-only workaround not justified.

## Observed facts (not guesses)

At source SHA `6ef81396346411cbe72e35f3c97016cc5be0113c`, the 2026-10-09 10:17:34Z PR workflow runs ended `failure` within roughly four seconds, with **no GitHub-hosted runner name and no executed steps**. For example:

- [P19 workflow run 37916692249](https://github.com/oculusrex14/Mega-XO/actions/runs/37916692249): two failed jobs, IDs `113774504813` and `113774505160`, **zero job steps**; Actions timing reported Ubuntu billed time **0 ms** across both jobs.
- [Mega XO validation run 37916692202](https://github.com/oculusrex14/Mega-XO/actions/runs/37916692202): validation failed with zero steps, dependent jobs skipped.
- [P22 source-only run 37916692132](https://github.com/oculusrex14/Mega-XO/actions/runs/37916692132): job failed with zero steps.

The previous full integration audit also found **all nine** current-head workflows affected. A check-run/job-log lookup was insufficient to establish the initiating provider/account failure. GitHub repository Actions settings endpoints were not accessible through the available connector. These observations are **not executed tests** and neither prove nor disprove Node, schema, Kotlin, Swift or Redis correctness.

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

The classification `FAILED_BEFORE_RUNNER_OR_TEST_STEPS` is deliberately **not** `CODE_TEST_FAILURE` or `GATE_PASSED`. It reports `rootCauseVerified:false` and `releaseAuthorized:false`. The source-level checks for this diagnostic passed in a V8 stubbed Node environment; real Node24 CI still requires a working runner.

**Do not change live V4, delete artifacts, disable GitHub branch protection or start P22/P23 production work to make these workflows look healthy.**
