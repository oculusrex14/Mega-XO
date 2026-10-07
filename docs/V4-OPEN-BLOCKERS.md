# V4 open blockers and external actions

This file is the canonical handoff ledger for V4 work that cannot be completed from repository-only access.

Execution order for the VPS/provider takeover: `docs/V4.1-VPS-PROVIDER-HANDOFF.md`.

Rules:
- Keep this file current whenever a task becomes blocked, unblocked, completed externally, or needs user/local-agent action.
- Never paste production secrets, private keys, passwords, OTPs, recovery keys, or raw database contents into this file.
- Record evidence as non-secret facts only: timestamps, hostnames, public IPs, command exit status, provider object names, release digests, and test outcomes.
- A repository implementation being complete does **not** mean an external deployment step is complete.

## Current release state

- Branch: `V4.1`
- Production origin: `https://play.antimatterinnovations.com`
- Production architecture: one authoritative Node coordinator + local SQLite WAL + Caddy TLS edge + encrypted off-box Restic backups.
- Native purchases and ads remain disabled until their provider/device release gates are complete. Ranked Coin entry, Crown challenges and public tournaments are core closed-loop gameplay and are enabled by the game authority.
- GitHub Actions is the authoritative source for code/container validation status. A green run never marks an external blocker complete automatically; external rows require the evidence described below.

## Repository readiness for tasks 6-10

Repository-side work is implemented; external execution remains tracked below.

- **Task 6 — production secrets:** `deploy/install-secrets.sh` installs/validates Resend and optional Google/Apple secrets without putting values on the command line. Compose mounts provider credentials as Docker secrets.
- **Task 7 — encrypted off-box backups:** `deploy/configure-r2-backup.sh`, `deploy/enable-backups.sh`, and `deploy/R2-BACKUP-RUNBOOK.md` implement isolated staging/production Restic repositories, first-backup integrity proof, retrieval verification, and a conservative 2 GiB repository budget.
- **Task 8 — staging:** staging origin is `https://staging.play.antimatterinnovations.com`; it has separate state/secrets, real Caddy TLS, Basic Auth, no-index headers, and the deployment flow in `deploy/STAGING-RUNBOOK.md`.
- **Task 9 — staging acceptance:** `deploy/staging-smoke.sh` provides non-destructive live edge/security validation; the staging runbook defines real OTP, password reset, restart/reboot, and restore drills.
- **Task 10 — monitoring:** public `/opsz` reports only `{"ok":...}` while incorporating readiness, backup freshness, and disk headroom; `deploy/install-monitoring.sh` installs local five-minute health checks and Resend state-change alerts; `deploy/MONITORING-RUNBOOK.md` defines the independent UptimeRobot monitors.

## Repository readiness for tasks 11-14

- **Task 11 — immutable production release:** `scripts/release-gate.js` blocks production tags until mandatory backend infrastructure gates are complete. Tagged releases rerun full validation, publish multi-arch GHCR with provenance/SBOM, retain `immutable-release.json`, and create a GitHub Release. `deploy/verify-release.sh` proves digest/revision/version/architecture before deployment. See `deploy/RELEASE-RUNBOOK.md`.
- **Task 12 — real production email proof:** `scripts/live-email-acceptance.js` exercises actual signup OTP + password-reset OTP through the public edge without logging passwords/OTPs and proves old-password invalidation plus same-profile recovery. See `deploy/EMAIL-LIVE-ACCEPTANCE.md`.
- **Task 13 — perimeter hardening:** Caddy suppresses its server fingerprint; `deploy/audit-perimeter.sh` inspects host/container/permission hardening; `scripts/external-perimeter-probe.js` proves 80/443 are the only public service ports and validates HTTPS/private-path behavior. See `deploy/PERIMETER-RUNBOOK.md`.
- **Task 14 — remaining P0:** Google web OIDC uses the supported minimum `openid profile` contract while keying identity only by `sub`. `scripts/provider-web-smoke.js` validates live Google/Apple authorization contracts. Native billing and ads remain fail-closed until their independent provider/device gates are complete. Closed-loop Ranked/direct/tournament entry is normal gameplay. See `docs/V4-P0-PLATFORM-READINESS.md`.

## Repository readiness for tasks 15-20

- **Task 15 — account/session security:** verified email changes require recent reauthentication plus OTP verification of the new mailbox; other sessions are revoked after change; active sessions use opaque IDs and can be revoked individually or in bulk; security notices are queued through the encrypted mail path.
- **Task 16 — anti-abuse/DoS:** HMAC-pseudonymized IP throttles protect expensive authentication/report/export actions across restarts; broad request limits remain memory-bounded; production sockets, headers, request time and concurrency are bounded.
- **Task 17 — operator/support toolkit:** operator commands exist only on the loopback admin port, derive authentication from the proxy trust secret, expose masked diagnostics, and record every mutation in an immutable hash-chained audit table. There is no currency-grant command.
- **Task 18 — incident response:** audited global lockdown revokes sessions, OAuth/OTP state and queued sensitive mail; guarded secret rotation and atomic paired R2 rotation are implemented. See `deploy/INCIDENT-RUNBOOK.md`.
- **Task 19 — reporting/moderation:** player reports use fixed categories, duplicate/rate protection and no automatic punishment; operator review/resolution is separate and audited. See `deploy/MODERATION-RUNBOOK.md`.
- **Task 20 — privacy/data export:** recently reauthenticated players can download an allowlisted JSON export. Credentials/operator internals/reports from others are excluded. See `docs/V4.1-PRIVACY-DATA.md`.

## Repository readiness for tasks 21-24

- **Task 21 — privacy and account deletion:** destructive deletion is implemented behind an approved-policy configuration gate. It requires recent reauthentication, exact immutable-tag confirmation and no active competitive/room work; it revokes sessions/identities, removes active profile/social/cloud data, pseudonymizes retained integrity records, publishes the stable `/delete-account` resource and prevents a deleted identity from restoring the old profile. Production remains blocked on the actual Antimatter Innovations Privacy Policy/Terms/retention approval tracked by `EXT-21`.
- **Task 22 — Google Play Billing:** backend ProductPurchaseV2 verification, stable server account binding, immutable product mapping, consume/acknowledge finalization with retry, authenticated Pub/Sub RTDN handling, revocation/refund protection and secret/config deployment plumbing are implemented. The Android Play Billing client, Play Console products and physical-device sandbox acceptance remain `EXT-22`.
- **Task 23 — Apple StoreKit:** backend signed-transaction JWS verification, exact App Store certificate-profile/root validation, bundle/environment/product/account-token binding, Production App Store app-ID binding for Server Notifications V2, notification dedupe/refund/revocation handling and trusted-root deployment plumbing are implemented. The real StoreKit 2 client, App Store Connect products and Sandbox/TestFlight acceptance remain `EXT-23`.
- **Task 24 — production ads and consent:** AdMob SSV verification is wired into production; rewarded tickets and interstitial permits are bound to the exact Android/iOS ad unit; production ad modes require approved privacy/deletion configuration, an explicit consent release version and complete native ad units. The browser never grants a reward from a local watched callback. Real Google Mobile Ads/UMP SDK integration and device/region acceptance remain `EXT-24`. Native integration contract: `native/COMMERCE-AND-ADS.md`.

## Additional P0 hardening tasks 21-26

- **Task 21 — real VPS capacity/degradation acceptance:** repository harness is `scripts/capacity-acceptance.js` with execution/evidence rules in `deploy/CAPACITY-RUNBOOK.md`. It uses disposable state, the production coordinator, real HTTP matchmaking/matches, auth contention and forced inflight saturation. Actual Oracle ARM evidence remains `EXT-31`.
- **Task 22 — database growth and long-running safeguards:** private DB/WAL/aggregate telemetry, configurable growth warnings, guarded maintenance commands, a daily quick/foreign-key integrity check and `scripts/db-growth-smoke.js` are implemented. See `deploy/DATABASE-HEALTH-RUNBOOK.md`. Actual long-running Oracle/staging evidence remains `EXT-32`.
- **Task 23 — client network resilience and maintenance UX:** shared account transport now classifies offline/maintenance/session-expiry/timeout states, retries transient reads, retries writes with one preserved idempotency key, prevents overlapping online polls, reconnects active matches and exposes a persistent player-safe connection surface. Live restart/network-transition acceptance remains `EXT-33`.
- **Task 24 — accessibility release gate:** bottom sheets trap/restore focus and support Escape, background regions become inert, primary controls retain 44 px targets, game cells expose spoken board/cell/value labels, OS reduced-motion/forced-color behavior is covered, and Chromium CI checks keyboard use, 24 px minimum targets, 320 px reflow, 200% inherited control text and core contrast for all themes. Physical VoiceOver/TalkBack acceptance remains `EXT-34` and also feeds the broader `EXT-25` device matrix.
- **Task 25 — support-grade diagnostics:** production requests receive opaque `MX-…` support IDs; a seven-day/5,000-row sanitized index stores only time/method/normalized-route/status/public-code; operators can resolve one ID without request bodies, queries, IPs or account identifiers; players can copy an allowlisted diagnostics report. See `deploy/SUPPORT-DIAGNOSTICS.md`. The live operator drill under `EXT-28` must include one real support-ID lookup.
- **Task 26 — email/domain security posture:** production From is bound to `MEGA_EMAIL_DOMAIN`; `scripts/mail-domain-audit.js` checks MX, single-record SPF, configured provider DKIM publication, aligned return-path and DMARC coverage without printing keys. See `deploy/MAIL-DOMAIN-SECURITY.md`. Hostinger/Google Workspace/Resend publication and real-message authentication proof remain `EXT-35`.

## P1-6 privacy/legal package

Repository-side drafting and enforcement work is complete:

- public draft Privacy Policy, Terms, Support and Privacy choices pages exist at clean routes and are linked from in-app Settings;
- the existing external account-deletion page is cross-linked to the privacy/legal surfaces;
- `docs/legal/DATA-INVENTORY-RETENTION.md` inventories first-party data, implemented short-lived lifetimes, deletion behavior and unresolved retained-record durations;
- `docs/legal/COOKIE-AND-CONSENT.md` records the strictly functional web cookie/local-storage baseline and native advertising consent gate;
- `docs/legal/STORE-PRIVACY-DECLARATIONS.md` is the Apple App Privacy / Google Play Data safety working sheet;
- `docs/legal/LEGAL-APPROVAL-CHECKLIST.md` is the formal sign-off handoff;
- account deletion now also purges generic idempotency command residue for the deleted actor;
- production account deletion is fail-closed until both `MEGA_PRIVACY_POLICY_VERSION` and `MEGA_RETENTION_POLICY_VERSION` identify approved documents.

This is **draft/implementation complete, not legal approval**. The public Privacy Policy and Terms remain explicitly marked draft/not effective and `noindex`. Formal entity/age/jurisdiction/governing-law/retention/vendor/privacy-rights decisions and store submissions remain `EXT-21` plus the relevant store/device acceptance rows.


## P1-9 security and abuse acceptance

Repository-side P1-9 work is implemented and CI-gated:

- `npm run abuse:audit` explicitly covers credential stuffing, OTP abuse, account enumeration, purchase replay, ad-reward replay, challenge collusion, tournament collusion, leaderboard boosting and bot/solver abuse;
- sensitive auth, purchase/reward, matchmaking and tournament-churn surfaces have bounded production abuse budgets;
- persistent edge-limit subjects are HMAC pseudonyms rather than raw IP addresses;
- forgot-password remains existence-neutral in production;
- purchase and rewarded-ad replay remain exactly-once/account-bound;
- direct rated pair limits, friend/recent-opponent Ranked matchmaking rules and season-activity qualification limit simple win trading;
- public tournaments separate friends and now add concentrated/repeated-forfeit review signals;
- extreme move cadence adds a private `AUTOMATION_SPEED_REVIEW` signal only after a conservative sample threshold;
- behavioral signals are **review-only** and do not automatically ban, de-rank, cancel a valid result or change the intended Crown/economy rules;
- operator lookup exposes sanitized competitive-risk summaries without returning private move-timing samples.

The detailed contract is `docs/V4.1-P1-9-ABUSE-ACCEPTANCE.md`.

Real distributed/adversarial staging acceptance and heuristic false-positive tuning remain `EXT-36`.

## External action ledger

| ID | Area | Status | Blocker / required access | Exact completion evidence |
| --- | --- | --- | --- | --- |
| EXT-01 | Oracle VPS facts | COMPLETE | Oracle Cloud access (done 2026-10-07) | Public IPv4 129.80.67.164; VM.Standard.A1.Flex 4 OCPU/24 GB (region iad); aarch64; Ubuntu 24.04.4 LTS; Docker 29.5.0; Tailscale `command`/100.64.128.46; `scripts/vps-preflight.sh` PASS, all lines OK, no FAIL. |
| EXT-02 | Hostinger DNS: production | COMPLETE | Hostinger DNS + VPS public IPv4 (done 2026-10-07) | `play.antimatterinnovations.com` A -> 129.80.67.164 TTL 300 via hostinger CLI; dig + VPS getent confirm. No AAAA. Mail records untouched. |
| EXT-03 | Oracle/host firewall | COMPLETE | Oracle network + VPS root access (done 2026-10-07) | Oracle ingress TCP 80+443 from 0.0.0.0/0 added; external probes return connection-refused (path open, nothing listening yet); ufw allows 80/tcp+443/tcp; SSH remains Tailscale-only. |
| EXT-04 | Production deployment directory | COMPLETE | VPS shell/root access (done 2026-10-07) | `/opt/mega-xo` + `/opt/mega-xo-staging` initialized by `scripts/init-vps.js` (pinned node digest); all secret files mode 600; staging access hash prepared; no production process started. |
| EXT-05 | Resend production secret | COMPLETE | Saved Resend API key + VPS shell (done 2026-10-07) | `resend_api_key` installed in both roots via `install-secrets.sh --resend-file`, mode 600, format-validated, sha256-verified identical; source shredded; key value never in history/logs. |
| EXT-06 | Google/Apple production credentials | BLOCKED | Provider consoles + VPS shell | Credentials installed as secret files/environment values and production config check passes. Optional until those sign-in methods are enabled. |
| EXT-07 | Cloudflare R2 backup account | COMPLETE | Cloudflare account (done 2026-10-07) | Bucket `mega-xo-backups` (standard, APAC/default jurisdiction) created via API; bucket-scoped R2 token `mega-xo-backups-vps` (object read/write on this bucket only) with S3 credential pair installed as `backup_access_key`/`backup_secret_key` (600) in both roots; 2 GiB budget set; live probe proved init/upload/snapshot-list against R2; source secrets shredded. |
| EXT-08 | Off-box backup activation | COMPLETE | R2 credentials + VPS shell (done 2026-10-07) | Staging Restic repo initialized; first snapshot uploaded (397,312 bytes); `restic check` passes; snapshot retrieved + `backup.js verify` passes; 15-min worker running. Production activation follows production deploy (EXT-17). |
| EXT-09 | Backup recovery key custody | COMPLETE | Human/offline secret storage (done 2026-10-07) | Operator confirmed both staging + production Restic recovery passwords saved to offline password manager; values never in chat/repo. Powerful setup token revoked; scoped bucket token retained. |
| EXT-10 | Staging DNS | COMPLETE | Hostinger DNS + VPS public IPv4 (done 2026-10-07) | `staging.play.antimatterinnovations.com` A -> 129.80.67.164 TTL 300 via hostinger CLI; dig + VPS getent confirm. |
| EXT-11 | Staging deployment | COMPLETE | VPS shell + DNS (done 2026-10-07) | Staging root deployed with separate DB/secrets; real TLS via Caddy; Basic Auth enforced; staging-smoke.sh all-OK; Ranked/direct/tournament economy available. DEVIATION (recorded): local image `mega-xo-staging:local` built on-VPS from exact commit d1be8a7 (repo had no branch-push publisher); redeploy with immutable GHCR digest at v4.1.0 tag before production. |
| EXT-12 | Real email acceptance | COMPLETE | Live staging + mailbox access (done 2026-10-07) | `scripts/live-email-acceptance.js` PASS against staging: signup OTP + password-reset OTP delivered via Resend to a controlled inbox, both verified, old password rejected, same profile recovered. |
| EXT-13 | Restart/reboot acceptance | COMPLETE | VPS shell (done 2026-10-07) | Container restart recovers healthy; full VPS reboot completed, all mega-xo + co-hosted containers auto-recovered, app healthy, staging-smoke PASS post-reboot. |
| EXT-14 | Backup/restore drill | COMPLETE | VPS shell + R2 (done 2026-10-07) | Planted `drill-marker` corruption in staging DB, restored snapshot 4541468f through guarded lock flow (pre-restore snapshot retained): marker gone (0), profile (1) + credential (1) intact, services resumed, staging-smoke PASS. |
| EXT-15 | External uptime monitor | BLOCKED | UptimeRobot account/email confirmation | Free HTTPS monitor checks the V4 operational endpoint every 5 minutes and sends a test alert to an Antimatter Innovations destination. |
| EXT-16 | Backup/disk/restart alert path | BLOCKED | VPS + chosen alert destination | Local operational health failures and stale backup/disk/restart conditions generate a real alert outside the VPS. |
| EXT-17 | Production release | BLOCKED | All launch gates above | Approved `v4.x` tag publishes a multi-arch GHCR image; deploy by immutable digest; HTTPS + backup + monitoring all green. |
| EXT-18 | Google production identity | BLOCKED | Google Cloud console + staging/live browser | Exact production/staging redirect URIs registered; `provider-web-smoke.js` passes; real login, cancel, link, reauth and restore flows pass. |
| EXT-19 | Apple production identity | BLOCKED | Apple Developer account + staging/live browser | Services ID/domain/return URLs and signing key configured; provider smoke passes; real login, cancel, link, reauth and restore flows pass. |
| EXT-20 | Native identity | BLOCKED | Real Android/iOS projects + physical devices | Native challenge/nonce/token flow passes on physical devices; reinstall and revoked-credential behavior proven. |
| EXT-21 | Privacy/legal/account deletion | BLOCKED | Antimatter Innovations legal/privacy approval + final store disclosures | Approve and publish the drafted Privacy Policy/Terms; resolve legal entity/address, launch jurisdictions, age/parental position, governing law/consumer terms, processor/transfer terms and concrete retention durations including backups; assign `MEGA_PRIVACY_POLICY_VERSION` + `MEGA_RETENTION_POLICY_VERSION`; finalize Apple App Privacy/Google Play Data safety; live in-app deletion + `/delete-account` acceptance passes without restoring the deleted profile. |
| EXT-22 | Google Play Billing | BLOCKED | Play Console + real Android target/physical device | Real product IDs map to the four server catalogue IDs; Play service account/RTDN are configured; sandbox purchase/cancel/pending/consume/acknowledge/refund/replay/Remove Ads restore tests pass against the implemented backend verifier. |
| EXT-23 | Apple StoreKit billing | BLOCKED | App Store Connect + real iOS target/physical device | StoreKit products map to the four server catalogue IDs; trusted Apple roots/environment and the numeric Production App Store app ID are configured; Sandbox/TestFlight purchase/cancel/pending/finish/restore/refund/revocation tests pass and Server Notifications V2 with the expected app ID reach the implemented callback. |
| EXT-24 | Production ads and consent | BLOCKED | AdMob + Google Mobile Ads/UMP in real Android/iOS targets | Real rewarded/interstitial unit IDs and consent release version configured; UMP blocks requests until allowed and exposes privacy options; rewarded SSV grants exactly once; wrong/replayed ticket/account/unit is rejected; Remove Ads and no-ad-during-live-play behavior pass on physical devices before `MEGA_AD_MODE` changes from off. |
| EXT-25 | Physical-device release QA | BLOCKED | iOS/Android devices/builds | Required OS/device matrix completes with no launch-blocking identity, network, purchase, ad, recovery or accessibility defects. |
| EXT-27 | Incident and secret-rotation drill | BLOCKED | Staging VPS + Resend/R2 credentials | Staging proves global lockdown/recovery, proxy + OTP rotation, Resend rotation, atomic R2 credential rotation and Restic key rotation with non-secret evidence. |
| EXT-28 | Operator access drill | BLOCKED | VPS/Tailscale operator access | Operator CLI works only through loopback/Tailscale administration; public admin route remains absent; lookup/session revoke/hold/audit verification drill passes. |
| EXT-29 | Moderation and appeals policy | BLOCKED | Antimatter Innovations policy approval | Review/approve `docs/legal/MODERATION-POLICY-DRAFT.md` (or an edited replacement), including evidence standard, action ladder/suspension durations, appeal path, retention periods and authorized operator roles; record the approved policy version and run the staging moderation drill. |
| EXT-30 | Personal data export acceptance | BLOCKED | Live staging + real account/browser | Recently reauthenticated account downloads expected JSON; stale auth is rejected; no password/session/OTP/operator material appears; export rate limits proven. |
| EXT-31 | Oracle ARM capacity/degradation acceptance | BLOCKED | Oracle VPS shell + immutable release-candidate image | Run `deploy/CAPACITY-RUNBOOK.md` on the actual ARM host at multiple client levels; record image digest, VM shape, p95/p99 route latency, event-loop p99, RSS, backpressure onset and the resulting production concurrency limits. |
| EXT-32 | SQLite growth/integrity soak | BLOCKED | Staging/Oracle VPS + time to accumulate synthetic load | Run the growth benchmark at launch-scale history sizes, prove the daily integrity timer, observe DB/WAL/state growth during a multi-hour staging soak, perform guarded checkpoint/optimize in maintenance, and record backup/restore duration plus any threshold adjustments. |
| EXT-33 | Client network/restart resilience acceptance | BLOCKED | Live staging + controllable network/service restart | On a real browser/device exercise offline→online, request timeout, maintenance enter/exit, expired session, queue reconnect and coordinator restart during a match; prove no duplicate command/grant, current match state recovers, offline modes remain available, and no internal diagnostics are exposed. |
| EXT-34 | VoiceOver/TalkBack accessibility acceptance | BLOCKED | Physical iOS/Android devices | Complete keyboard-equivalent flows with VoiceOver and TalkBack: sign-in, navigation, settings/dialogs, game board destination rule, matchmaking/reconnect, wallet/store surfaces, errors/support codes and account deletion; record device/OS/build/results and remediate launch-blocking issues. |
| EXT-35 | Mail-domain authentication and DNS posture | BLOCKED | Hostinger DNS + Google Workspace + Resend consoles + real mailbox headers | Using exact current provider DNS hostnames, `npm run mail:audit` passes for MX/SPF/DKIM/aligned return-path/approved DMARC policy; real Mega XO mail shows SPF/DKIM/DMARC PASS; Google Workspace mail continues to work. Do not record keys or full message headers. |
| EXT-36 | Adversarial abuse staging acceptance | BLOCKED | Live staging + controlled multi-account clients/source IPs + real mobile sandbox integrations where applicable | Run `docs/V4.1-P1-9-ABUSE-ACCEPTANCE.md` live: multi-source credential/OTP bursts, known-vs-unknown recovery comparison, sandbox purchase/ad replay, challenge/tournament win-trading, queue boosting and scripted fast-move behavior; prove review signals reach operator lookup, exactly-once grants hold, and ordinary legitimate play is not blocked. Reuse EXT-22/23/24 evidence for real store/ad callbacks. |

## Local-agent execution order

1. Complete EXT-01 through EXT-04 using `deploy/VPS-RUNBOOK.md`.
2. Install production secrets using the repository secret-install tooling; complete EXT-05 and any enabled identity-provider secrets.
3. Configure the free-tier off-box backup target and complete EXT-07 through EXT-09.
4. Deploy isolated staging and complete EXT-10 through EXT-14.
5. Configure monitoring and alerting; complete EXT-15 and EXT-16.
6. Do not create the production release/tag until all mandatory backend blockers are marked COMPLETE with non-secret evidence.
7. After the backend release, execute EXT-18 through EXT-25 as independent product/platform tracks; do not enable billing or ads while their blocker remains open.
8. Complete EXT-27 through EXT-30 before a V4.1 production tag: incident operations, operator access, moderation policy and live data-export acceptance are launch gates.
9. Run EXT-31 on the real Oracle ARM host before freezing production concurrency limits; keep the harness on disposable state only.
10. Complete EXT-32 before freezing database growth warning thresholds; do not normalize the persistence model without measured evidence.
11. Complete EXT-33 and EXT-34 during staging/device release QA, and include one real MX support-code lookup in EXT-28.
12. Complete EXT-35 before treating Resend domain verification as production mail-security approval.
13. Complete EXT-36 on live staging before the serious public-launch gate is considered closed; tune review heuristics from evidence without changing core gameplay rules.

## Completed external prerequisites

- Resend account created.
- `antimatterinnovations.com` verified for Resend sending. This is a provider prerequisite only; full MX/SPF/DKIM/DMARC/return-path posture is independently gated by EXT-35.
- Production Resend API key created and saved by the user. The value is intentionally not present in GitHub.
- Existing Google Workspace mail DNS was previously reported intact; EXT-35 must re-prove coexistence after the final mail-authentication records/policy are frozen.

## Post-backend product gates

- Real Google/Apple login production-console setup if those methods are enabled at launch.
- Native App Store / Play billing and receipt-notification integration.
- Production ad SDK and consent integration.
- Privacy policy, terms, account deletion, retention/legal decisions.
- Full physical-device release QA is now tracked explicitly as EXT-25.
