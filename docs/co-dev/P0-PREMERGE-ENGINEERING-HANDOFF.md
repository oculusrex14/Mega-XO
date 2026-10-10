# V5 co-dev P0 engineering closeout — operator handoff

**Status:** source integration candidate; **no merge or production approval requested**.  
**Owner branch:** `V5-platform`, audited `cb54985a2f1d5c6c68d1af9c151a0189f7f9f27b`  
**Single co-dev branch:** `co-dev/v5-integration`, [draft PR #9](https://github.com/oculusrex14/Mega-XO/pull/9)  
**Last fully completed 12/12 CI checkpoint reviewed for this document:** `dc88e7a6a4cb46061543ed450fe28173e9528d2c`. **A later source/audit commit requires its own exact-head CI, never inherit these results.**

## What co-dev finished

1. Imported the main agent's G00–G24 source and **real production-authority audit** in ancestry-preserving merge commits, retaining the separate co-dev security/worker/CI fixes. Both branches have consistent ancestry at the latest owner SHA. No owner/base ref was moved and no rebase/force push was used.
2. Closed demonstrable security issues: verified session actor for all Core money commands; removed actor-header trust and on-demand login minting; removed fallback OTP/HMAC secrets; accepted validated `MEGA_PROXY_SECRET`; rejected forged forwarded Origin; refused missing/invalid client idempotency keys instead of generating new identities on retry.
3. Hardened P04–P14 concurrency, queues, tournaments, worker completion, cache isolation, match participant checks and zero-skip PostgreSQL integration. Fixed Docker Hub service startup throttling via runner-verified digest-pinned official mirrors.
4. Validated prior exact-head 12/12 Actions workflows: full Node/browser, real disposable PG/Redis, native source/host builds, P15/P16/P18/P19 and release safety checks. These are **source/CI and isolated-runner results only**.
5. Integrated operator audit showing **V4/SQLite remains the sole live writer**; reopened G22/G23/G24 and 13 previously mislabelled production-dependent tasks; kept all original 40 acceptance statuses unchanged and audited every case in [P0-ACCEPTANCE-TRIAGE.json](P0-ACCEPTANCE-TRIAGE.json). Source CI cannot close external proof.

## Merge eligibility — co-dev review checklist

- [ ] User explicitly requests the **final merge** after main agent completes independent tasks. Do not merge now.
- [ ] Recheck both HEAD SHAs and PR ancestry. If the owner advances `V5-platform`, incorporate reviewed changes in the same co-dev branch without overwriting fixes.
- [ ] All **12 required workflows** succeed against the **exact final integration SHA**, with zero skipped required database/device-source tests. Node/browser CI and native compilation do **not** equal A32–A37 physical/store verification.
- [ ] Review security diff and required `MEGA_OTP_SECRET`, `MEGA_PROXY_SECRET`, Core ingress secret and service URL deployments; no hard-coded default, headers-as-actor, hidden compatibility bypass or public actor cache.
- [ ] Review final `docs/v5/progress.json`, `TODO.md`, `PROGRESS.md`, audit and acceptance triage for consistent, unfalsified status. No accepted G22/G23/G24 unless actual eligible operator evidence exists.
- [ ] Keep `P21` (new website/browser product) deferred and do not change approved UI, paid Crown economics or V4 production behavior.
- [ ] Main agent reviews scoped changes in [PR #9](https://github.com/oculusrex14/Mega-XO/pull/9). Merge **only after** all above and the user's authorization; preserve small commits and explain final gate status.

## Main-agent tasks that require direct provider/CLI/device access

| Priority | Required concrete action and acceptance proof | Release dependency |
| --- | --- | --- |
| 1 — staging | Create full **nonserving V5 staging** with Neon schema/roles, Redis, Vercel API, Oracle Core A/B, worker and real shared sessions. Prove actual end-to-end wallet/queue/match/tournament/browser compatibility and callbacks without using production V4 writes. Record immutable SHA, targets and sanitized logs. | A12–A31 and P18 |
| 2 — provider approval | Verify Vercel plan permits actual commercial API traffic; validate Neon Free capacity and backup/recovery suitability; configure scoped secrets, TLS/mTLS as appropriate, CORS/CSRF, access logs, quotas, protected audit key, alert delivery, health and domain routing. **Do not use a Hobby plan for commercial deployment unless its terms permit it.** | A23–A31 and operations |
| 3 — true disaster recovery | Restore actual encrypted off-host backup to **independent** PostgreSQL target and reconcile; exercise Redis namespace loss, real process Core A/B failover and worker retry/dead-letter. Distinguish same-host process failover from host-region HA; measure RPO/RTO and p95/p99. | A15/A17/A27–A31 |
| 4 — physical native/provider | Reconnect authorized iPhone and Android hardware; build/sign/install; test real email, Apple/Google login, UMP consent, all four Crown products and purchase restore/refund/replay, ads SSV and Remove Ads, four themes, TalkBack/VoiceOver, offline and background/reconnect; document signed hashes and store track/review stages individually. | A01/A12/A19/A32–A37 |
| 5 — original acceptance | For each of 38 `NOT_RUN` original acceptance cases supply contract-specific proof, target/time/revision, failure traces where applicable and independent review. Use [triage](P0-ACCEPTANCE-TRIAGE.json); do not simply bulk-edit the ledger to PASS. | 40-case acceptance |
| 6 — controlled G22 | Only at **separately authorized operator window**, prove current immutable V4 backup and independent restore, drain/freeze every V4 write path, take final SQLite source, reconcile all balances/identities/receipts/history in production Neon, test first-write fence and retained-client/callback routing. Before first V5 write, reversible abort may restore V4 *only after proof*; after first write, recover on PostgreSQL. | A38/A39 and G22 |
| 7 — G23/G24 | **After accepted G22**, permanently fence V4, verify legacy paths and SQLite cold archive, preserve backups and supported clients. Record *measured* V5 capacity/SLO/trigger results. Do not scale or pay for infra based on synthetic metrics. | A40 and G23/G24 |

## Evidence integrity and no-go boundaries

- The audited live production state is V4.1.2 + SQLite and zero conflicting writers, as recorded in `docs/v5/PRODUCTION-AUTHORITY-AUDIT.md` and `docs/v5/evidence/live-production-authority-audit.json`. This report is an owner inspection **as of its timestamp**; the owner should reconfirm before any live work.
- All 12 source CI checks proving clean source only at an exact SHA **do not** authorize a production cutover. The P22 cutover-readiness test being green specifically means `cutoverAuthorized:false`, `productionWritesPermitted:false`.
- No signed physical binaries, real provider billing/grants, off-host V5 restore, controlled live cutover, first V5 write or irreversible V4 retirement has been attested by co-dev.
- **Current acceptance ledger:** A04/A05 PASS; A01–A03 and A06–A40 NOT_RUN. The triage's proof categories deliberately separate existing test evidence from the full exercise contract.
- The final merge is reserved for the user after external acceptance. No V4 teardown, domain switch, signing/purchases, paid upgrade, or production action should be inferred from this document.

## Safe operator submission packet (sanitized)

Supply **only** nonsecret source SHAs, immutable images/digests, GitHub run IDs, environment names/project IDs, observed UTC times, named tests, case IDs and statuses, result summaries, RPO/RTO/p95/p99, source/target row-hash aggregate checks, physical OS/build/device descriptors, provider console status and explicit blockers. Exclude access tokens, OTP/HMAC keys, service credentials, full wallet/identity data, raw purchase receipts and private client identifiers.
