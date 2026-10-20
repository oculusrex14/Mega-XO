# Mega XOXO V5.2 — independent post-Neon-transfer review (19 October 2026)

**Status: CONDITIONAL.** Read-only account/provider/SQL/source audit; no live site request
could be made from this review environment (public megaxo.online DNS lookup unavailable).
Do not confuse host-agent deployment reports with an independently reproduced on-device E2E.

## Authorities and evidence scope

- Integration baseline: `V5.2@20cb84abf766b9567964b1931abe5cd0604fc25b` (Oct 19 17:09:56 UTC).
- Production project: `blue-sun-85454968`, branch `br-dawn-dawn-b8f9n7zq`, database
  `mega_xo_v5_production`, endpoint `ep-mute-surf-b8v94ksa` (unchanged).
- The **live Neon project API** identifies its owner email as `contact@antimatterinnovations.com`,
  new organization `org-bold-silence-37218003` (Naraharikripa, Free). Production,
  staging and development are all under that organization. Former-org project list is empty.
  This corroborates the recorded transfer at
  `NEON-OWNERSHIP-MIGRATION-20261019.md` without assuming a data-copy migration.
- Current Neon reporting period started `2026-10-19T13:12:28Z`. At review, the project
  API exposed **20,368,261 bytes public transfer** and **936 active compute seconds** under
  the new-period counter. This reset of an *organization consumption counter* MUST NOT be
  interpreted as fresh project-level allowance or retroactive forgiveness of the old ~80% warning.
- Neon endpoint's `suspend_timeout_seconds: 0` means **provider default five-minute
  suspend**, NOT “disabled” (which uses `-1`). Provider docs: Neon API endpoint schema
  and `https://neon.com/docs/introduction/scale-to-zero`.
- The primary endpoint is direct (pooler_enabled=false), 0.25 CU fixed, PostgreSQL 16;
  the existing runtime design pins role/transaction checks independently of transfer.

## Live read-only PostgreSQL checks

Run as `migration_owner` through the **connected Neon project**:

| Verification | Observed result |
| --- | --- |
| meta.migrations | 64 rows |
| identity.actors / identity.profiles / economy.wallets | 13 / 13 / 13 |
| match.matches / tournament.rooms | 2 / 1 |
| identity.refresh_tokens | 3991; just one token issued 17:00–17:19 UTC |
| ops.outbox OTP | 9 `sent`; no failed OTP row in the sampled outbox |
| ops.outbox other kinds | 4 deletion, 11 provision, 7 revocation rows `queued` |
| pg_extension | only plpgsql (no pg_stat_statements enabled) |
| PostgreSQL metrics | 90,234 committed, 39 rolled back transactions when sampled |
| ops.outbox table scans | 3,691 sequential; 4,156 index |
| tournament.rooms index scans | 14,614 in the current stats epoch |

The current PG stats epoch may have reset due to compute restart; do NOT compare raw cumulative
counts to older epochs without a recorded reset/measurement window. No plaintext identities,
mail codes, purchase details or credentials were retrieved.

Count parity with the previous sample supports continuity, but is NOT a row-by-row
reconciliation, checksum proof, verified backup restore, or complete grants audit.

## Source and operational findings

| ID | Priority | Observation | Required closure |
| --- | --- | --- | --- |
| NPD-01 | P0 | Production default `--worker-interval=5000` still polls durable jobs/mail every **5 seconds**; the slow housekeeping split does not remove these reads. | Measure live flag/service setup. Implement durable commit-triggered wake + safe bounded retry/recovery without sacrificing OTP SLA; prove 5-minute Neon autosuspend in a true idle window. |
| NPD-02 | P1 | On a quiet instance the matchmaker's adaptive timer caps at **30 seconds** and pass/finalization timers run every 50/30 seconds. Some of these paths may reach PostgreSQL even when there is no work. | Instrument actual SQL per timer; make dormant lanes genuinely dormant, but retain matchmaking fairness, commerce settlement, alert/restore deadline and crash recovery. |
| NPD-03 | P1 | `deploy/v5/install-change-aware.sh` overwrote host-managed files BEFORE exercising the real LSN probe. Its documented rollback backed up only 2 of the 5 overwritten files. | PR hardens preflight-first staging, exact pinned wrapper/CA/role validation, all-file snapshots and rollback-on-partial-install; no live install performed by this audit. |
| NPD-04 | P1 | `deploy/v5/v5-change-check.js` parsed `--force` but ignored it, potentially skipping a requested full DR snapshot. | PR makes forced dumps validate source/probe and return dump decision. |
| NPD-05 | P1 | `deploy/v5/v5-idle-probe.js` accepted EMPTY/unrepresentative journal input and emitted a report with no measured gate. Its documented unit name was wrong. | PR requires two same-project/billing-period Neon consumption snapshots, evaluates real active time + egress and refuses an empty/invalid proof. |
| NPD-06 | P1 | 22 non-OTP outbox rows still `queued`. The mail worker only claims specific mail kinds; their authority, expiry, consumer and intentional semantics were not proven here. | Trace producers/consumers, identify real obligations vs audit-only fan-out; no blind deletion or broad worker enablement. |
| NPD-07 | P1 | No provider-verified 24–48h idle soak or independent physical device regression was available. | Main agent obtains host logs + Neon snapshots and records exact source/install sha. Codex runs real web/native auth, tutorial, gameplay, stores and APK acceptance. |
| NPD-08 | P2 | `PROVIDER-BUDGET-MANIFEST.json` has unverified Aiven/Upstash/Resend/R2/Oracle quotas; owner-only 31-day forecast is explicitly estimated. | Reverify in each live console; measure realistic traffic, backup bytes, provider commands, daily mail, resource usage; enforce 50/70/85% alerts. |

**Operational caution:** `src/account-client.js` native refresh fix, tournament
deadline-driven timer and change-aware backup source are integrated into V5.2 and the recent
signed Android release records a rebuilt client. Do not re-open already-fixed earlier issues
without a new reproduction. However, source incorporation is not proof that every host-managed
systemd helper is installed or that the expected startup flags are in effect.

## CI / live release observations at audit time

- V5.2 head `20cb84a`: checked-in GitHub Actions returned green release, P19, P15,
  gameplay-capture and P18 jobs; PostgreSQL integration was still running at the first snapshot.
  A previous `866c6ad` web-presentation lane showed a failure, not a pass on current HEAD.
  Require exact-head final required checks after any PR merges.
- Host agent release receipts claim `/readyz` and `/livez` 200, OTP delivery, account
  deletion, signed Android APK and pricing endpoints on the deployed artifact. This review
  could not reach the public domain independently and did not execute a charge or ad reward.
- `AGENTS.md` states device checks and release/merge authority are distinct; this PR changes
  only offline operational tooling and should not be deployed automatically.

## Running an honest idle soak

1. Confirm the exact prod source/host-managed launcher/backup script SHA and runtime flags.
2. Stop test clients and dev/CI agents legitimately; do not block required background obligations.
3. Capture Neon `describe_project` values **before** and **after** at least 24 hours.
   Use only project ID, sampledAtUtc, consumptionPeriodStart,
   activeTimeSeconds and dataTransferBytes, with format
   `mega-v5-neon-usage-snapshot/v1`. Never store API keys or connection strings.
4. Collect matching systemd logs without hitting the database just to monitor it.
   Include `mega-xo-v5-production.service` and `mega-xo-v5-backup.service`.
5. Run:

```bash
journalctl -u mega-xo-v5-production.service -u mega-xo-v5-backup.service -o cat --since '24 hours ago' \
  | node /opt/mega-xo-v5-production/bin/v5-idle-probe.js \
      --before /private/idle-before.json --after /private/idle-after.json \
  > /private/idle-report.json
```

Exit 0 means provider counters meet the declared idle active-time ≤5% and transfer
≤50 MB/day gates for a genuine idle window; exit 2 means failed/unverified. These
limits are a budget **target**, not evidence that the system has reached it.

**This report cannot prove whether unobserved player requests occurred**; cross-check host logs
and test timetable. A successful idle soak does not replace a backup restore or post-restart game
acceptance.

## Review / deployment requirements

- Review PR changes and run the dedicated `tests/v52-neon-post-deploy-gates.test.js` suite.
- Exercise installer with invalid scoped target, missing CA, missing pinned image and locked
  backup in disposable/isolated host fixtures: NO `$BIN` modification on preflight refusal.
- Rehearse a partial-install failure and verify byte-identical restoration of every previous
  host helper in isolated staging before running the installer on Oracle.
- After install, rerun `v5-change-check.js --force`, verify normal skip and real dump,
  independent R2 reader freshness and actual restore.
- Do not merge/deploy if current host source/config/backup helper hashes cannot be reconciled;
  keep complete rollback material. No resource plan upgrades or live writes authorized here.
