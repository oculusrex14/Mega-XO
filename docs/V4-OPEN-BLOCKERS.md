# V4 open blockers and external actions

This file is the canonical handoff ledger for V4 work that cannot be completed from repository-only access.

Rules:
- Keep this file current whenever a task becomes blocked, unblocked, completed externally, or needs user/local-agent action.
- Never paste production secrets, private keys, passwords, OTPs, recovery keys, or raw database contents into this file.
- Record evidence as non-secret facts only: timestamps, hostnames, public IPs, command exit status, provider object names, release digests, and test outcomes.
- A repository implementation being complete does **not** mean an external deployment step is complete.

## Current release state

- Branch: `V4`
- Production origin: `https://play.antimatterinnovations.com`
- Production architecture: one authoritative Node coordinator + local SQLite WAL + Caddy TLS edge + encrypted off-box Restic backups.
- Purchases, ads, and paid-entry competition remain disabled in the V4 production baseline.
- Last fully green source + amd64/arm64 baseline before tasks 6-10: `c5fb98962a68cf3e7eaa9ff6c3dcdb9d055d875a`. The current tasks 6-10 head must pass final exact-head validation before release.

## Repository readiness for tasks 6-10

Repository-side work is implemented; external execution remains tracked below.

- **Task 6 — production secrets:** `deploy/install-secrets.sh` installs/validates Resend and optional Google/Apple secrets without putting values on the command line. Compose mounts provider credentials as Docker secrets.
- **Task 7 — encrypted off-box backups:** `deploy/configure-r2-backup.sh`, `deploy/enable-backups.sh`, and `deploy/R2-BACKUP-RUNBOOK.md` implement isolated staging/production Restic repositories, first-backup integrity proof, retrieval verification, and a conservative 2 GiB repository budget.
- **Task 8 — staging:** staging origin is `https://staging.play.antimatterinnovations.com`; it has separate state/secrets, real Caddy TLS, Basic Auth, no-index headers, and the deployment flow in `deploy/STAGING-RUNBOOK.md`.
- **Task 9 — staging acceptance:** `deploy/staging-smoke.sh` provides non-destructive live edge/security validation; the staging runbook defines real OTP, password reset, restart/reboot, and restore drills.
- **Task 10 — monitoring:** public `/opsz` reports only `{"ok":...}` while incorporating readiness, backup freshness, and disk headroom; `deploy/install-monitoring.sh` installs local five-minute health checks and Resend state-change alerts; `deploy/MONITORING-RUNBOOK.md` defines the independent UptimeRobot monitors.

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

## Local-agent execution order

1. Complete EXT-01 through EXT-04 using `deploy/VPS-RUNBOOK.md`.
2. Install production secrets using the repository secret-install tooling; complete EXT-05 and any enabled identity-provider secrets.
3. Configure the free-tier off-box backup target and complete EXT-07 through EXT-09.
4. Deploy isolated staging and complete EXT-10 through EXT-14.
5. Configure monitoring and alerting; complete EXT-15 and EXT-16.
6. Do not create the production release/tag until all mandatory blockers are marked COMPLETE with non-secret evidence.

## Completed external prerequisites

- Resend account created.
- `antimatterinnovations.com` verified for Resend sending with its required DNS records.
- Production Resend API key created and saved by the user. The value is intentionally not present in GitHub.
- Existing Google Workspace mail DNS remains intact.

## Deferred product gates not part of V4 tasks 6-10

- Real Google/Apple login production-console setup if those methods are enabled at launch.
- Native App Store / Play billing and receipt-notification integration.
- Production ad SDK and consent integration.
- Privacy policy, terms, account deletion, retention/legal decisions.
- Paid-entry legal/platform approval.
- Full physical-device release QA.
