# V5.2 infrastructure and recovery audit — Planck

Requested source baseline: **7f582b749a1128b86e53ddcbcda57b569b0953cf**, PR #30 → V5.2. Live observations were read-only on 17 October 2026, approximately 06:05–06:18 UTC. Source, current working checkout, CI run head and actual deployed runtime are separate evidence identities.

The canonical game is https://megaxo.online. PostgreSQL is the serving authority; the stopped SQLite application is retained recovery material, not an acceptable fallback writer. Vercel projects are a separate deferred surface and are not the game's origin.

Only the assigned reports/register were written. No local test suite, deployment, service restart, SQL mutation, backup/restore/prune, firewall change, DNS change, provider transaction, email or Git mutation was performed. Read-only SSH used the existing command alias with BatchMode, StrictHostKeyChecking and UpdateHostKeys=no. It read service/port/container metadata, public code hashes, specific sanitized freshness diagnostics and filesystem metadata, not environment files, secret values or player data.

## Findings

| ID | Priority / status | Required action |
|---|---|---|
| MXA-INF-001 | **P0 VERIFIED_DEFECT** | Preserve a complete previous runtime during deploy; the current unhealthy-restart rollback deletes files previously moved out of its archive. |
| MXA-INF-002 | **P0 VERIFIED_DEFECT** | Production-named retention units still run a staging script; independently correct the target without enabling unproved backup pruning. |
| MXA-INF-003 | P1 VERIFIED_DEFECT | Deploy the paginated R2 helper to the actual host bin/lib; current freshness/health are failed and public /opsz is 503. |
| MXA-INF-004 | P1 VERIFIED_DEFECT | Make release inputs genuinely immutable; HEAD/manifest checks do not constrain rsync's mutable working-tree/dependency inputs. |
| MXA-INF-005 | P1 SUSPECTED_RISK | Stopped legacy container retains writable /data; restart=no alone is not an effective stale-writer fence. |
| MXA-INF-006 | P1 UNTESTED_ASSUMPTION | Certify the actual final deployed source/bundle/dependencies; live hashes do not match the requested audit candidate. |
| MXA-INF-007 | P1 NOT_RUN | Obtain successful final required CI/device acceptance; original failures and cancelled retry are not passes. |
| MXA-INF-008 | P2 VERIFIED_DEFECT | Parse raw HTTP telemetry JSON and define its error helper; normal network batches currently fall through to 404. |
| MXA-INF-009 | P2 NOT_RUN | Collect sanitized live PostgreSQL role/membership/TLS/migration posture using an approved audit connection. |
| MXA-INF-010 | P2 NOT_RUN | Prove restoration of an actual production archive, storage/retention policy and alert delivery without substituting disposable tests. |

Full file/symbol/line, impact and command evidence: [planck-findings.csv](../evidence/planck-findings.csv). The integrator owns overall release certification; this workstream has unresolved release-blocking findings.

## Observed serving topology

| Component | Evidence / actual observation |
|---|---|
| Public IPv4 | megaxo.online A=129.80.67.164; core and retired play host resolve to the same address. No apex AAAA answer was observed. |
| www | CNAME megaxo.online; HTTPS response 301 Location=https://megaxo.online/ |
| Retired game host | HTTPS play.antimatterinnovations.com/game returns 308 Location=https://megaxo.online/game, then 200 |
| Public edge | Caddy responses; host listeners 0.0.0.0:80 and :443; edge container running |
| V5 service | mega-xo-v5-production.service active/running, WorkingDirectory=/opt/mega-xo-v5-production/src-final, User=root |
| Combined game listener | Private bridge 172.18.0.1:8080; source composes web bundle, /api, Core ingress, realtime, timers and worker in one process |
| Core edge | Private bridge 172.18.0.1:8096; unsigned HTTPS /ingress/command returns 401; source proxy only allows /ingress/* |
| Other isolated listeners | 127.0.0.1:8085, :3000, :3001 observed; they are not inferred to be game authority from their ports alone |
| PostgreSQL | Candidate and production entry are PG-backed; runtime role assertions are structural. Live database catalogs/credentials were not exported or directly queried. |
| Redis/Valkey | Candidate composes managed ephemera for queue/leases/presence/fan-out; not durable wallet/identity authority. Live provider configuration/capacity was not queried. |
| Legacy application | mega-xo-production-app-1 exited, restart=no, image sha256:71d33a1a9893a303c5ffcbdb090caefde22d9e7e054a8c2d6c494a44919b58e4 |
| Backup/freshness/integrity/health | All four timers active/waiting. Last backup and integrity units success; freshness and health units failed with exit 2. |
| Recovery storage | Source uses encrypted PG dump plus independent R2 reader readback; recent local R2 receipt metadata exists. This is not a new restore verification. |

The runtime deliberately shares one process while using distinct pools. The source comment's API boundary means the API handler is not handed a Core pool; it does not mean the operating-system process has no Core credentials. This distinction underlies SEC-007.

No firewall changes were made. Read-only UFW output showed SSH 22 restricted to 100.64.0.0/10, 80/443 public, 8080/8096 allowed from 172.18.0.0/16, and Tailscale UDP 41641. ss showed no public PostgreSQL/Redis listener. This is host posture, not a full external port scan or proof of cloud-security-list rules.

## DNS, TLS, redirects and headers

Commands executed:

    curl -sS -o /dev/null -w '%{http_code} %{url_effective}\n' -L https://play.antimatterinnovations.com/game
    curl -sS -o /dev/null -w '%{http_code} %{url_effective}\n' -L https://www.megaxo.online
    curl -sS -o /dev/null -w '%{http_code} %{url_effective}\n' -L https://megaxo.online/livez
    curl -sS -o /dev/null -w '%{http_code} %{url_effective}\n' -L https://megaxo.online/api/monetization/status

The actual commands additionally set bounded connect/overall timeouts. Results, in that order:

    200 https://megaxo.online/game
    200 https://megaxo.online/
    200 https://megaxo.online/livez
    404 https://megaxo.online/api/monetization/status

Separate header-only reads verified the initial 308/301 codes, not merely final successful destinations. No authenticated cookies were provided; Set-Cookie headers were excluded from printed header output. GET /api/account/profile returned 401; no session bootstrap was called.

| Host | Certificate observation |
|---|---|
| megaxo.online | CN=megaxo.online; Let's Encrypt YE1; valid from 2026-10-15 14:30:49 GMT to **2027-01-13 14:30:48 GMT** |
| core.megaxo.online | CN=core.megaxo.online; Let's Encrypt YE1; valid from 2026-10-13 16:22:58 GMT to **2027-01-11 16:22:57 GMT** |

Certificate command: openssl s_client -connect HOST:443 -servername HOST followed by openssl x509 -noout -subject -issuer -dates. Normal curl requests used certificate verification, not -k. DNS commands used dig +noall +answer for A/AAAA/CNAME. No DNSSEC, OCSP, full protocol/cipher inventory or renewal-timer acceptance is claimed.

Live /game, /livez, /api/account/profile and /api/monetization/status carried HSTS max-age=31536000 but lacked Content-Security-Policy, X-Content-Type-Options, X-Frame-Options and Referrer-Policy. Sensitive API/health responses carried no-store. X-Robots-Tag remained noindex,nofollow; this audit did not change indexing policy. Detailed security implication is SEC-002.

## Runtime and deployment identity

| File | Candidate SHA-256 | Live SHA-256 |
|---|---|---|
| scripts/v51/v5-production-server.cjs | bfafdd43885cb25f2854df8cd84f4bd4999d551f216c8ca86ca7a688cb06eb8d | 97e95d6c9306b19d9c73535e751d28b682d02f8f24b3317d57b325b31656ea75 |
| apps/api/index.js | 475911ffd70723e2863d7030223bc88d9c7b4fc5a496aeab40f0c7dd3f500fb3 | 225c151c726b692949a325a0b02656062cf58a59a0e3e05190f7be60d9ece559 |
| deploy/v5/v5-r2-client.js / live bin helper | e35dee618c9c153ca86fbe0262fd0171f5352d1b0d18afc6a8c38e7163abbe2b | e4f5a47592766da00833d5227a7e7aae0ef152efb1f0e0c1850d13152920f138 |

Read-only sha256sum/shasum commands obtained these hashes. The helper is deployed outside src-final in /opt/mega-xo-v5-production/bin; swapping source alone does not update it.

The mismatch is not evidence of an unauthorized deployment: PR #30 is a candidate, and this audit had no deployment authority. It **does** prevent treating live checks as exact-candidate acceptance and explains why source fixes cannot automatically close observed live defects. The eventual release receipt must identify source SHA, bundle hashes, migration state, host-managed authority state, dependencies and deployed helper versions separately.

The shared local checkout changed during the audit. At 06:13 UTC it was a385774ef24ebbecb71ec9d73cd2e658d6a0665d with other-lane work present. Its package-association and reflow fixes are follow-ups, not changes made by Planck. No git state was restored, staged or otherwise mutated.

## Service roles, migration and jobs

| Role/service | Intended and source-checked boundary | Evidence limit |
|---|---|---|
| API / api_runtime | Account/social/privacy, operational intake, ticket issuance; no economy DML | production-server:638-659,937-980; no live catalog proof |
| Core / core_runtime | Wallet, match, escrow, tournament, receipt/ad grants and economic outcomes | core/commerce constructors reject wrong pool; signed gateway preserves actor |
| Worker / worker_runtime | Durable leases, outbox mail, privacy retention; no unrestricted wallet write | production-server:873-880; worker-workflows:522 onward |
| Migrator / migration_owner + v5_owner | Direct administrative DDL; checksummed forward-only chain | scripts/v5/migrate.js:54-57,124; not runtime credentials |
| Backup / backup_reader | Read-only snapshots over direct verified TLS; no DDL/TEMP or runtime role membership | pg/guards.js and backup source; independent live catalog check NOT_RUN |
| Audit / audit_runtime | Dedicated audit capability, separate from competitive authority | Source role inventory; full live audit-key custody not inspected |

The one API pool passed for worker rate-bucket cleanup is explicit: production-server:875-877; this is not economy DML or a Core credential loan. Conversely the store provider facade internally uses Core revocation reads and worker finalization writes; that facade currently has the async-consumer defect ECO-017.

The candidate starts bounded matchmaker and tournament timers and a single-flight 50-second pass-grant timer. Worker.tick/start handles mail/privacy workflows. It does not compose a purchase-finalization retry caller (ECO-016). Every job's actual production provider binding/lag was not established merely by the process being active.

Redis/Valkey carries rebuildable queue/lock/hint state; durable commands, session generation, ticket consumption, wallet/escrow and outcomes remain PG facts. Source ticket/session/match checks survive a Redis fan-out loss by rereading PG. Current Redis quotas, persistence, network ACLs and failover were not independently exercised.

## P0: rollback archive is not self-contained

At deploy-production.cjs:153-157, both carried node_modules and restored host-managed serve.sh, rehearse.sh and production inventory are **moved** from the old archive into the new tree. At :186-190, the unhealthy-deploy branch stops the service, removes the new tree and moves the old archive back.

The old archive therefore lacks files required to launch; deletion of the new tree deletes their remaining copies. A fixed public readiness endpoint cannot rescue that rollback path. Retaining a directory named rollback is not proof of a usable recovery artifact. The read-only host search found serve.sh in only one historical archive; no rollback was executed.

Preserve independent complete runtime trees or restore the shared inputs before deleting either side, and prove an intentionally unhealthy restart in isolated GitHub/approved staging. Never fall back to the stale SQLite writer. Additional source limits: the source/web mv sequence is not a single filesystem-wide transaction, migration protection counts files rather than performing migration compatibility analysis, and readinessVerdict failure after an HTTP-200 response does not itself enter the shell's rollback branch. These limits require targeted recovery evidence, not relaxed health checks.

## P0: retention units target staging

Read-only systemctl show for all three live production-named services reported:

    mega-xo-v52-retention@spool.service
    mega-xo-v52-retention@backups.service
    mega-xo-v52-retention@captures.service
    ExecStart=/opt/mega-xo-v51-staging/bin/capture-job.sh retention

This freshly corroborates docs/v5.2/release/LR18-RETENTION-DR-LIVE-20261016.md:5. It is not evidence that a destructive sweep executed during this audit. Production retention and safe backup-pruning proof remain separate. Correct the reviewed production binding while keeping destructive backup pruning disabled until explicit safe-prune/recovery acceptance.

## Backup encryption, freshness and rollback evidence

Backup source (deploy/v5/v5-pg-backup.sh:34-48,73-100) uses a pinned PostgreSQL 16 image, direct backup_reader TLS, encrypted streaming archive, recipient public key, 0600 protected inputs/0700 directories, a local lock, ciphertext upload with non-overwrite precondition, and independent-reader readback. Local retention keeps twelve archive/manifest/receipt sets; remote pruning is not silently enabled. The source is meaningful implementation evidence, not proof of private key custody or successful decryption of today's production archive.

Observed host state:

- Backup and DB-integrity service results were success.
- Freshness and health service results were exit-code/2; /opsz returned 503 with only {"ok":false}.
- The freshness journal reported uploaded backup age **116098 seconds** against **900 seconds** RPO, following several earlier stale observations.
- Recent upload-receipt file metadata existed at 06:01:50, 06:07:06 and 06:12:14 UTC.
- The installed bin/v5-r2-client.js has max-keys code but **no continuation-token code**. The candidate helper explicitly paginates at lines 150-166.

These observations support an installed freshness-listing defect, not the claim that no backup has been made for 32 hours. Recent upload receipts do not independently prove today's restore/RTO/key-custody acceptance either. Update the actual deployed helper and re-observe independent-reader freshness; do not suppress the alarm or redefine /opsz as process liveness.

Alert code uses an existing operational mail channel, but this audit did not send an alert or inspect private mail. Successful alert receipt is NOT_RUN. Restore, R2 policy/immutability, credential scope and destructive-prune acceptance remain INF-010.

## Legacy SQLite fence

The legacy app container is stopped and restart policy is no. Its root filesystem is read-only, but docker inspect reported **destination=/data RW=true**. Privileged filesystem metadata showed the old SQLite file mode 0600, owner opc, and no immutable i attribute. No database contents were read.

The absence of an active old process does not prove a second writer currently exists; none was observed. It also does not demonstrate an effective restart fence. The writer-fence verifier itself explicitly returns observedEffectiveFenceVerified:false and cutoverAuthorized:false (scripts/v5/p22/writer-fence.js:83-97): it validates a declared manifest, not an actual container reboot.

Preserve V4 branch/tags/image and immutable recovery artifacts, but require an effective stale-writer prevention mechanism. Any restart/reboot rehearsal belongs on an isolated approved recovery target, never this serving authority.

## GitHub Actions evidence and supply chain

Only existing GitHub metadata and failed logs were read; no local suite, workflow emulation or rerun was initiated by this audit.

| Run / job | Observed result | Scope/limit |
|---|---|---|
| 39006747033 / 117320655866 | SUCCESS | PostgreSQL schema/runtime integration associated with baseline head |
| 39006747120 / 117320656058 | SUCCESS | HMAC/ticket/privacy audit regression |
| 39006747074 / 117320656168 | SUCCESS | Disposable service/platform validation |
| 39006747076 / 117320656070 | SUCCESS | Real encrypted copy to second **isolated** PG16; not production restore |
| 39006747079 / 117320655940 | SUCCESS | Pure cutover/writer-fence negatives; not observed host reboot proof |
| 39006747061 / 117320920404 | FAILURE, original attempt | Android installed/cold-started; move-confirm then CDP_COMMAND_TIMEOUT; root cause not independently proven |
| 39006747061 / 117326995722 | CANCELLED, later retry | Latest metadata read; cancellation is not acceptance |
| 39006747099 / 117320707075 | FAILURE | Browser presentation: 935 checks, two mobile320 failures |

Commands: gh run view RUN --repo oculusrex14/Mega-XO --job JOB --log-failed; gh run view RUN --json status,conclusion,jobs. Job URLs are https://github.com/oculusrex14/Mega-XO/actions/runs/RUN/job/JOB.

The browser report prints source_commit=b645f404cdd512a87e00ef0f31318b6bc8de6894 while run metadata is associated with head 7f582b7. Preserve both identities; do not silently label a merge-checkout/built artifact as the exact local snapshot. Final provenance must correlate the checkout/build manifest with the PR head. Other lanes fixed reflow after baseline; only their new CI evidence can close that finding.

Workflows generally use read-only contents permissions, pinned checkout/setup-node revisions, disposable PG/Redis and digest-pinned service images. Native actions still use mutable tags (SEC-006). No exact-SHA npm/native advisory result was obtained; a prior zero-advisory report is historical. The deploy script also carries old node_modules and rsyncs mutable/untracked source; INF-004 requires actual release-input provenance.

## Non-mutating closure sequence

1. Integrator triages source defects against the final SHA and deduplicates overlapping specialist IDs.
2. Main produces complete isolated rollback and actor/period economic conservation evidence; no production deployment is implied.
3. Main reconciles installed helper versions, live retention bindings and the effective legacy fence with an approved operations plan.
4. GitHub must pass the required final-candidate checks; device/provider acceptance must name exact artifacts and approval states.
5. Only a separately authorized deploy/cutover/operational change can establish the final live state. Keep PostgreSQL authority after all V5 application writes.
