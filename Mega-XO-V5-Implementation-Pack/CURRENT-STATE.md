# Current state: observed, reported, and unresolved

**Review date:** 7 October 2026. This is a targeted repository/deployment-handoff review, not a full code audit or live database inspection. GitHub reads were pinned to one commit after resolving the branch. Public probes failed from this review environment; no SSH was executed. Source keys below resolve in [the source register](sources/SOURCES.md).

## 1. Verified repository baseline

| Item | Observation | Basis |
|---|---|---|
| Repository | `oculusrex14/Mega-XO`, private; default branch `main` | GitHub repository API |
| Inspected branch | `V4.1` | GitHub branch API |
| Head | `8a77d3f4eb95e363fb967efe9b01f814a703dbae` | [R01] |
| Head message | `V4.1: record completed production release` | [R01] |
| Timestamp | 2026-10-07 16:10:28 UTC | [R01] |
| Latest inspected CI | Actions run `37649977689`, completed/success, exact head above | [R02] |
| Package | `mega-xo`, version `4.1.1`, Node `>=24.0.0` | [R03] |
| Source organization | Root browser assets, `src/`, `server/`, `native/`, `tests/`, `deploy/`; not yet the V5 apps/packages layout | [R04] |
| Dependency baseline | Root package has no dependency declarations and root tree has no package lock | [R03,R04] |
| V5 CI | Existing main workflow excludes V5 branch/tag patterns | [R05] |
| Native state | Kotlin/Swift adapters and contracts; documentation explicitly says these are not complete APK/IPA targets | [R06,R07] |

No local test run was performed by this review. The successful run is GitHub evidence, not a claim of fresh test execution here. Do not run `npm ci` against this baseline before introducing a real lockfile. Preserve `npm test` as the current full Node test entry point.

The handoff identifies production application commit `f31618d1fd3d7cb3d82b9ad90f4c689ebe36248e`. Comparing it to the inspected head showed exactly two later commits and changes only to `deploy/enable-backups.sh` and `docs/V4-OPEN-BLOCKERS.md` [R08]. The branch's operational script correction does not prove that every installed copy or the deployed image contains it. Record code SHA, image digest and installed deployment-script revision separately.

## 2. Deployment facts reported by the handoff

[H: lines 27-53, 78-116] reports:

- V4.1.1 serves `https://play.antimatterinnovations.com`; immutable image is `ghcr.io/oculusrex14/mega-xo@sha256:225b93ccf8718e9fa4484cdcd920604a1535d86f35c6dfec9eae11777bd3df4f`.
- Oracle host `openclaw-host`, IPv4 `129.80.67.164`, A1 Flex 4 OCPU / 24 GB, IAD, ARM64, Ubuntu 24.04.4, Docker 29.5.0. Access is `ssh command` over Tailscale, not public SSH.
- Production root `/opt/mega-xo`; V4 staging root `/opt/mega-xo-staging`. Staging is intentionally stopped because its edge would contend for production ports 80/443.
- Hostinger maintains the existing play/staging DNS A records. Caddy terminates TLS. Mail records are to remain untouched.
- UptimeRobot checks `/livez` and `/opsz`; host monitoring and DB-integrity timers are installed; an every-15-minute backup container exists.
- Secret files are mode 600 and audit HMAC uses a dedicated secret. Restic recovery keys are operator-held offline.
- Neon CLI is authenticated to Antimatter Innovations, org `org-wandering-sea-53820697`, on a Free plan; no projects existed at handoff time. This is a reported account snapshot, not a current provider API observation here.

## 3. Conflicts to resolve without redesigning the product

| Conflict | Evidence | Required next action |
|---|---|---|
| Production backup healthy vs failing | Handoff section 7 reports `BACKUP_TRANSPORT_FAILED`/invalid snapshot and `/opsz false`; ledger EXT-17 records verified backups and `/opsz true` | Inspect actual repository, credentials scope, last successful snapshot, fresh retrieval/verification and current runtime; retain both historical statements until reconciled |
| 'All EXT-01 through EXT-30 complete' vs open rows | Handoff summary versus ledger EXT-06 and EXT-18 through EXT-25 still `BLOCKED` | Check local/provider evidence and update statuses; do not treat blanket prose as device/provider proof |
| Capacity/network/device/mail/abuse acceptance | Ledger EXT-31 through EXT-36 remains `BLOCKED` | Reuse any existing valid evidence; otherwise execute V5-targeted acceptance. SQLite-specific tasks can be superseded explicitly by PostgreSQL tests after migration, not falsely marked performed |
| Moderation approval vs other policy approval | EXT-29 approved moderation; EXT-21 still contains privacy/legal/retention decisions | First locate the owner's existing approval and actual published versions. Do not reopen approved policy, fabricate missing legal facts, or infer all policies from moderation approval |
| Root README title vs deployed version | README still headed V3.5.1; package and release are V4.1.1 | Treat product-precedence notes as relevant; do not infer runtime version from README title |
| Native documentation's older paid-entry wording | Native README includes an older gate sentence; PRODUCT and ledger explicitly permit normal closed-loop Crown gameplay | Preserve the later approved purchased/earned Crown equivalence. Billing SDK release readiness must not become a new currency-spending gate |

[R09] is the committed ledger, not a live provider registry. The owner's statement that everything is working/approved is a preservation constraint and may reflect newer local evidence. It is not permission to invent device test results. Prefer current direct evidence and record the resolution.

## 4. Code-level facts that shape V5

### Data is not just a collection of SQLite tables

`server/economy-store.js` stores `Authority.export()` in `state(id=1,json)` and serializes command writes with `BEGIN IMMEDIATE` [R10]. This JSON contains accounts, matches and nested commands, receipts, snapshots, weekly payouts, burn totals, journal and league-week state [R11]. Account/profile/session/social/save/privacy tables also exist [R12]. Tournaments have separate room JSON and command tables but mutate the same economy JSON transactionally [R13]. Monetization combines account JSON, receipts, ad tickets, commands and provider-specific tables [R14].

`Authority.restore()` applies defaults and calls season logic using the current time [R11]. A migration that simply instantiates it can alter historical source state. Extract raw data and make every transformation explicit. Actor IDs allow non-UUID text; ratings carry hundredths. Both details must survive schema design.

Store binding values are randomly generated once and persisted in `v41_store_bindings`; Google account IDs and Apple app-account tokens must be copied, not regenerated [R22]. Native receipts depend on these bindings.

### Process-local orchestration and mixed handlers must be separated

`server/production/main.js` assembles the service, runs one-second game/mail/purchase work and 15-second cleanup, and voids active/offered matches at startup recovery [R15]. V5 must replace restart-void recovery with durable revision/deadline recovery as explicitly requested by the architecture, without changing competitive rules.

`server/community-http.js` mixes account, social and competitive endpoints. Even GET queue/match handlers can tick matchmaking or trigger timeout/expiry [R16]. A route being named GET does not make it safe for a read-only Vercel implementation. Classify actual effects and delegate authority to Core.

`/api/v1` already exists. Keep its compatibility contract; do not silently assign incompatible semantics to the same path. `src/account-client.js` centralizes cookie/CSRF requests, operation-key retries and connectivity events, plus a party-POST adapter [R17]. This is the preferred nonvisual seam for new transport, not a reason to rewrite UI screens.

### Native apps must be built, not merely wrapped around a URL

The existing `MegaNativeIdentity`, `MegaBilling`, and `MegaAds` contracts define integration boundaries [R06,R07]. Real projects, signing, bundled assets, lifecycle handling and physical-device acceptance remain separate deliverables. The new website is not needed to render the native game. Do not package the entire repository: `src/authority.js` is explicitly server-only despite living under `src/` [R11].

### Protect accepted behavior and existing operations

Four theme keys appear in save validation: `vector`, `midnight`, `paperclub`, `afterhours` [R12]. PRODUCT and the V3.5.1 precedence notes preserve the approved economy and archived frame direction [R18,R19]. The live UI needs a fresh baseline captured locally, including any approved changes not yet pushed.

Compose already has strict non-root/read-only service settings, loopback admin exposure, isolated secrets and the necessary Caddy capabilities [R20]. Preserve these properties in the new deployments. Two default Compose edges cannot simultaneously bind 80/443. Native and V5 work must not stop production simply to run staging.

## 5. Scope of inspection and mandatory local follow-through

Read here: package/workflow, branch/CI/compare APIs, root/src trees, product and native documents, ledger, main production assembly, core persistence, first-party HTTP routing, client transport, room/monetization stores, store bindings and deployment Compose. Some larger source reads were selected ranges, not exhaustive audit. Exact sources/ranges are registered.

Not verified here: live health/DNS/TLS, runtime process list, R2 objects/restore, Neon/Vercel/Redis actual accounts and quotas, provider consoles, installed secrets, offline backups, local worktree, physical devices, build/signing toolchain and current store review requirements. `evidence/public-probes.json` records this environment's DNS failures; it is not evidence the service is down globally.

The local agent's Phase 0 inventory closes these gaps. Existing verified evidence should be carried forward, not needlessly recreated; new topology-specific behavior still needs new acceptance.
