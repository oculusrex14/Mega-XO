# Resend read-only acceptance inventory — 2026-10-14

## Scope and method

Read-only inspection in the existing Resend dashboard in a dedicated Brave tab. No message was sent; no signup, reset, or authentication flow was initiated. No API-key page or credential value was inspected. No message detail/body, OTP, or private payload was opened. No provider setting, DNS record, key, domain, mailbox, or billing option was changed.

## Current account state

- Workspace displayed as `antimatterinnovations`.
- The sole listed sending domain, `antimatterinnovations.com`, is **Verified** in Tokyo (`ap-northeast-1`). Its event timeline showed Domain added, DNS verified, and Domain verified on Oct 6 (dashboard-local display times: 2:37, 2:44, and 2:45 PM).
- The prior provider execution record names `contact@antimatterinnovations.com` as the existing approved sender. The current domain-detail view confirms the sending domain; it does not expose a separate sender-address approval row.
- Current plan/usage page: **Free**, 29/3,000 monthly transactional messages, 17/100 daily, 1/3 domains, 10 requests/second. Pay-as-you-go is disabled. No upgrade or paid action was taken.

## Read-only message metadata

Resend email-list search results were inspected by subject category, status, and relative age only. Recipient addresses were omitted from this evidence.

| Category | Provider metadata observed | Age shown by dashboard |
| --- | --- | --- |
| Signup verification | 3 × “Verify your Mega XO email”; **Delivered** | 6 days, 7 days, 7 days |
| Password reset | 3 × “Reset your Mega XO password”; **Delivered** | 4 days, 7 days, 7 days |
| Security notification | 1 × “Mega XO signed out all sessions for security”; **Delivered** | 7 days |
| Alert-delivery drill | 1 × “[DRILL] Mega XO alert-delivery verification”; **Delivered** | About 15 hours |

These are historical provider events. The list metadata has no V5.2 build, runtime, or request correlation. Provider **Delivered** does not prove inbox receipt, successful V5.2 signup/verification/reset/security behavior, OTP correctness, or actual end-to-end acceptance. The drill message is not signup verification.

## Remaining V5.2 real-mail acceptance

The main-owned prerequisites and actions are:

1. Acknowledge the exact V5.2 staging backend SHA/boot identity, HTTPS/API origin, stable test identity, and protected OTP workflow. Keep the OTP/private credential handling inside Main's private workflow.
2. Confirm the V5.2 mail transport is enabled against the existing Resend account and existing protected sending credential, while preserving V4 sending. Do not place secrets in this packet or Git.
3. Use an already owner-approved receiving mailbox and a Main-generated, build-correlated staging flow. Main must identify the exact V5.2 build/request in provider metadata without copying message contents or OTPs here.
4. Complete signup verification, password reset, and security-notification sends; confirm both provider event state and receipt at the approved mailbox. Record only sanitized category, time, and state.
5. Exercise consumed/expired/invalid OTP handling, throttling, and honest provider-failure handling through Main's controlled test workflow; verify that no OTP or credential appears in logs/evidence and that V4 sending remains intact.

## Current blocker

The main handoff states that the serving staging frontend is still the older manifest `5897497493617e1f389af1626451899831045840`, and that the V5.2 backend mail contract/Main release acknowledgment is pending. Without Main's confirmed V5.2 runtime identity, protected test-account/OTP path, and enabled transport, the historical Resend rows cannot be safely or honestly attributed to V5.2. This inspection therefore records **real V5.2 send/inbox acceptance: NOT RUN**.
