# Resend readiness snapshot — 2026-10-14

Observed read-only in the existing Resend workspace `antimatterinnovations` at 2026-10-14 00:54 UTC. Repository worktree HEAD at observation: `78b258224d799d8e29e6d7b6cae1bb25dcbe1758` (detached). No Resend configuration was changed; no key was created, copied, or revealed; no email was sent.

## Provider account

- `antimatterinnovations.com` is `Verified`; the detail page says the domain is ready to send. Provider region shown: Tokyo (`ap-northeast-1`). The domain event list showed DNS verified and Domain verified.
- Observed sender on an existing message: `Mega XO by Antimatter Innovations <contact@antimatterinnovations.com>`.
- The single existing key is named `Mega XO production`; metadata shows `Sending access`, restricted to `antimatterinnovations.com`, 12 total uses, created about 8 days earlier, last used about 4 days earlier. Token value and creator identity are omitted. Leave this key unchanged to preserve the existing V4 production path.
- Plan/quota page showed Free: 12 / 3,000 monthly transactional messages, 0 / 100 daily messages, 1 / 3 domains, and 10 requests/second. Pay-as-you-go was disabled; no upgrade or billing action was taken.

## Recent delivery evidence

- The Emails page was set to its default last-15-days/all-statuses view and showed 12 rows; all 12 were `Delivered`.
- The subjects included Mega XO email verification, password reset, and password-changed notices. A password-changed detail page showed provider events `Sent` then `Delivered`; the linked request log showed `POST /emails` status 200 and the existing production key.
- Provider `Delivered` records establish the provider event only. This check did not inspect inbox placement or message authentication headers. Recipient addresses, message bodies, OTPs, and message IDs are omitted.

## V5 handoff and gaps

- V5.1 staging still deliberately disables outbound email in `docs/v5/environments/staging.json` and `scripts/v51/p21-staging-server.cjs`; controlled auth acceptance uses an out-of-band OTP sink. No real V5 signup/reset/change flow was run.
- `server/production/config.js` supports `RESEND_API_KEY_FILE` through an absolute-path secret-file check (regular file, at most 16 KiB, no `other` permission bits). That config is not wired into the current `scripts/v51/p21-staging-server.cjs`; staging needs explicit transport integration before the secret can be used. A separate V5 staging key should be created only after coordination with Main, named for V5 staging, and set to `Sending access` with domain restricted to `antimatterinnovations.com`. The create-key form confirmed that exact least-privilege scope is available; it was canceled without submission.
- Main should provision the separate key only into the isolated V5 staging secret store as a 0600 file, mounted read-only and exposed as `RESEND_API_KEY_FILE`; do not put the token in source, shell history, browser logs, or V4 configuration. Keep the existing production key and V4 delivery untouched.
- No explicitly owned dedicated test mailbox was identified in the reviewed contracts, so Gmail/inbox inspection and live acceptance remain pending. Before any synthetic signup/reset/change delivery, verify the staging transport is wired to Resend and select a dedicated mailbox the owner controls. Inspect recipient mailbox/authentication headers without saving addresses, OTPs, full headers, or authenticated traces.

## Actions not performed

No API key creation/rotation/revocation, DNS edit, sender/domain change, billing action, account creation, email send, or production configuration change. The existing untracked `scripts/p21/staging-browser-qa.cjs` was left untouched.
