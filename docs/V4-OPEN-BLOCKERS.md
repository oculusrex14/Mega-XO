# V4 open blockers and external actions

This file is the canonical handoff ledger for V4 work that cannot be completed from repository-only access.

Rules:
- Keep this file current whenever a task becomes blocked, unblocked, completed externally, or needs user/local-agent action.
- Never paste production secrets, private keys, passwords, OTPs, recovery keys, or raw database contents into this file.
- Record evidence as non-secret facts only: timestamps, hostnames, public IPs, command exit status, provider object names, release digests, and test outcomes.
- A repository implementation being complete does **not** mean an external deployment step is complete.

## Current release state

- Branch: `V4.1`
- Production origin: `https://play.antimatterinnovations.com`
- Production architecture: one authoritative Node coordinator + local SQLite WAL + Caddy TLS edge + encrypted off-box Restic backups.
- Purchases, ads, and paid-entry competition remain disabled in the V4 production baseline.
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
- **Task 14 — remaining P0:** Google web OIDC now uses the supported minimum `openid profile` contract while still keying identity only by `sub`. `scripts/provider-web-smoke.js` validates live Google/Apple authorization contracts. Billing, ads and paid entry remain fail-closed until native/provider/legal gates are complete. Privacy/account deletion is intentionally blocked on an approved retention policy rather than guessed. See `docs/V4-P0-PLATFORM-READINESS.md`.

## Repository readiness for tasks 15-20

- **Task 15 — account/session security:** verified email changes require recent reauthentication plus OTP verification of the new mailbox; other sessions are revoked after change; active sessions use opaque IDs and can be revoked individually or in bulk; security notices are queued through the encrypted mail path.
- **Task 16 — anti-abuse/DoS:** HMAC-pseudonymized IP throttles protect expensive authentication/report/export actions across restarts; broad request limits remain memory-bounded; production sockets, headers, request time and concurrency are bounded.
- **Task 17 — operator/support toolkit:** operator commands exist only on the loopback admin port, derive authentication from the proxy trust secret, expose masked diagnostics, and record every mutation in an immutable hash-chained audit table. There is no currency-grant command.
- **Task 18 — incident response:** audited global lockdown revokes sessions, OAuth/OTP state and queued sensitive mail; guarded secret rotation and atomic paired R2 rotation are implemented. See `deploy/INCIDENT-RUNBOOK.md`.
- **Task 19 — reporting/moderation:** player reports use fixed categories, duplicate/rate protection and no automatic punishment; operator review/resolution is separate and audited. See `deploy/MODERATION-RUNBOOK.md`.
- **Task 20 — privacy/data export:** recently reauthenticated players can download an allowlisted JSON export. Credentials/operator internals/reports from others are excluded. Deletion state is scaffolded but remains fail-closed pending `EXT-21`. See `docs/V4.1-PRIVACY-DATA.md`.

## External action ledger

| ID | Area | Status | Blocker / required access | Exact completion evidence |
| --- | --- | --- | --- | --- |
| EXT-01 | Oracle VPS facts | BLOCKED | Oracle Cloud/VPS access | Record public IPv4, ARM64 result, OS, Tailscale identity, and successful `scripts/vps-preflight.sh` output. |
| EXT-02 | Hostinger DNS: production | BLOCKED | Hostinger DNS + VPS public IPv4 | `play.antimatterinnovations.com` A record resolves to the VPS public IPv4. Do not add AAAA unless IPv6 is verified end-to-end. |
| EXT-03 | Oracle/host firewall | BLOCKED | Oracle network + VPS root access | Internet can reach TCP 80/443 only; Node 8080, metrics 9091, Docker API, and SQLite are not public. |
| EXT-04 | Production deployment directory | BLOCKED | VPS shell/root access | `/opt/mega-xo` initialized by `scripts/init-vps.js`; owner-only secrets; no production process started yet. |
| EXT-05 | Resend production secret | BLOCKED | Saved Resend API key + VPS shell | `/opt/mega-xo/secrets/resend_api_key` installed with mode 600; config check reports email enabled without printing the key. |
| EXT-06 | Google/Apple production credentials | BLOCKED | Provider consoles + VPS shell | Credentials installed as secret files/environment values and production config check passes. Optional until those sign-in methods are enabled. |
| EXT-07 | Cloudflare R2 backup account | BLOCKED | Cloudflare account | Standard-storage bucket created, dedicated S3-compatible token created with access limited to the backup bucket/prefix, account ID recorded. |
| EXT-08 | Off-box backup activation | BLOCKED | R2 credentials + VPS shell | Restic repository initialized; first snapshot uploaded; `restic check` passes; a snapshot is retrieved and `server/production/backup.js verify` passes. |
| EXT-09 | Backup recovery key custody | BLOCKED | Human/offline secret storage | Restic recovery password copied to a secure location outside the VPS and outside the Cloudflare account. Do not record the value here. |
| EXT-10 | Staging DNS | BLOCKED | Hostinger DNS + VPS public IPv4 | Staging hostname chosen by the staging runbook resolves correctly. |
| EXT-11 | Staging deployment | BLOCKED | VPS shell + DNS | Separate staging database/secrets deployed; real TLS works; purchases/ads/paid entry remain off. |
| EXT-12 | Real email acceptance | BLOCKED | Live staging + mailbox access | Signup OTP and forgot-password OTP received through Resend; both flows complete successfully on a real browser/device. |
| EXT-13 | Restart/reboot acceptance | BLOCKED | VPS shell | Container restart and full VPS reboot recover cleanly; unfinished escrow follows refund policy exactly once. |
| EXT-14 | Backup/restore drill | BLOCKED | VPS shell + R2 | Staging data backed up, deliberately restored through the guarded runbook, and account/wallet state verified. |
| EXT-15 | External uptime monitor | BLOCKED | UptimeRobot account/email confirmation | Free HTTPS monitor checks the V4 operational endpoint every 5 minutes and sends a test alert to an Antimatter Innovations destination. |
| EXT-16 | Backup/disk/restart alert path | BLOCKED | VPS + chosen alert destination | Local operational health failures and stale backup/disk/restart conditions generate a real alert outside the VPS. |
| EXT-17 | Production release | BLOCKED | All launch gates above | Approved `v4.x` tag publishes a multi-arch GHCR image; deploy by immutable digest; HTTPS + backup + monitoring all green. |
| EXT-18 | Google production identity | BLOCKED | Google Cloud console + staging/live browser | Exact production/staging redirect URIs registered; `provider-web-smoke.js` passes; real login, cancel, link, reauth and restore flows pass. |
| EXT-19 | Apple production identity | BLOCKED | Apple Developer account + staging/live browser | Services ID/domain/return URLs and signing key configured; provider smoke passes; real login, cancel, link, reauth and restore flows pass. |
| EXT-20 | Native identity | BLOCKED | Real Android/iOS projects + physical devices | Native challenge/nonce/token flow passes on physical devices; reinstall and revoked-credential behavior proven. |
| EXT-21 | Privacy and account deletion | BLOCKED | Approved Antimatter Innovations privacy/retention policy + public web resource | Privacy Policy/Terms approved; in-app deletion and external deletion request implemented; retained-data rules disclosed; deletion tests pass. |
| EXT-22 | Google Play Billing | BLOCKED | Play Console + Android app + backend purchase verifier | Real product IDs mapped; sandbox purchase/consume/acknowledge/refund/replay/restore tests pass; server verifier enabled only after proof. |
| EXT-23 | Apple StoreKit billing | BLOCKED | App Store Connect + iOS app + backend JWS verifier | StoreKit products mapped; Sandbox/TestFlight purchase/restore/refund/revocation tests pass; App Store Server Notifications handled. |
| EXT-24 | Production ads and consent | BLOCKED | AdMob + native SDK + privacy/consent configuration | Physical-device rewarded/SSV/replay/consent/Remove Ads acceptance passes before `MEGA_AD_MODE` can change from off. |
| EXT-25 | Physical-device release QA | BLOCKED | iOS/Android devices/builds | Required OS/device matrix completes with no launch-blocking identity, network, purchase, ad, recovery or accessibility defects. |
| EXT-26 | Paid-entry compliance | BLOCKED | Legal/platform/jurisdiction review | Written approved jurisdiction/age/store-policy design exists and server enforcement is implemented; until then paid entry remains false. |
| EXT-27 | Incident and secret-rotation drill | BLOCKED | Staging VPS + Resend/R2 credentials | Staging proves global lockdown/recovery, proxy + OTP rotation, Resend rotation, atomic R2 credential rotation and Restic key rotation with non-secret evidence. |
| EXT-28 | Operator access drill | BLOCKED | VPS/Tailscale operator access | Operator CLI works only through loopback/Tailscale administration; public admin route remains absent; lookup/session revoke/hold/audit verification drill passes. |
| EXT-29 | Moderation and appeals policy | BLOCKED | Antimatter Innovations policy decision | Conduct policy, evidence thresholds, suspension/escalation rules, appeals/support path, report retention and authorized moderator roles are approved. |
| EXT-30 | Personal data export acceptance | BLOCKED | Live staging + real account/browser | Recently reauthenticated account downloads expected JSON; stale auth is rejected; no password/session/OTP/operator material appears; export rate limits proven. |

## Local-agent execution order

1. Complete EXT-01 through EXT-04 using `deploy/VPS-RUNBOOK.md`.
2. Install production secrets using the repository secret-install tooling; complete EXT-05 and any enabled identity-provider secrets.
3. Configure the free-tier off-box backup target and complete EXT-07 through EXT-09.
4. Deploy isolated staging and complete EXT-10 through EXT-14.
5. Configure monitoring and alerting; complete EXT-15 and EXT-16.
6. Do not create the production release/tag until all mandatory backend blockers are marked COMPLETE with non-secret evidence.
7. After the backend release, execute EXT-18 through EXT-25 as independent product/platform tracks; do not enable billing or ads while their blocker remains open.
8. Treat EXT-26 as a separate future compliance decision. Technical existence of paid-entry code is not approval to enable it.
9. Complete EXT-27 through EXT-30 before a V4.1 production tag: incident operations, operator access, moderation policy and live data-export acceptance are launch gates.

## Completed external prerequisites

- Resend account created.
- `antimatterinnovations.com` verified for Resend sending with its required DNS records.
- Production Resend API key created and saved by the user. The value is intentionally not present in GitHub.
- Existing Google Workspace mail DNS remains intact.

## Post-backend product gates

- Real Google/Apple login production-console setup if those methods are enabled at launch.
- Native App Store / Play billing and receipt-notification integration.
- Production ad SDK and consent integration.
- Privacy policy, terms, account deletion, retention/legal decisions.
- Paid-entry legal/platform approval.
- Full physical-device release QA is now tracked explicitly as EXT-25.
