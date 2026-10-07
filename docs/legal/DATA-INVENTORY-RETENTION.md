# Mega XO V4.1 data inventory and retention schedule

Status: **DRAFT FOR LEGAL/PRIVACY APPROVAL**  
Draft date: 2026-10-07

This file is the implementation-facing source of truth for P1-6 retention review. It distinguishes automatically enforced lifetimes from policy durations that Antimatter Innovations still must approve.

Production account deletion is fail-closed unless both `MEGA_PRIVACY_POLICY_VERSION` and `MEGA_RETENTION_POLICY_VERSION` identify approved documents.

## 1. Data inventory

| Data class | Examples | Purpose | Linked to account? | Current storage |
| --- | --- | --- | --- | --- |
| Account identity | internal player ID, email, Google/Apple subject | authentication, recovery, account linking | yes | SQLite |
| Profile | player tag, username/display name, avatar, visibility, region preference | account presentation and privacy controls | yes | SQLite / aggregate state |
| Session/auth security | hashed session token, CSRF value, auth timestamp, OAuth state/nonce/verifier | authentication and reauthentication | directly or session-linked | SQLite |
| OTP/recovery | email, purpose, OTP hash, pending password hash, challenge status | email verification and password recovery | yes or pending account | SQLite |
| Gameplay | cloud practice save, matches, moves/results, ratings, rank/season/tournament records | core game functionality | yes | SQLite aggregate + profile save |
| Social | friends, requests, blocks, presence | social functionality | yes | SQLite |
| Economy | Coins, Crowns, owned items, ledger | core economy and integrity | yes | SQLite aggregate |
| Store purchase | product, transaction/receipt identifiers, entitlement/refund/revocation state | fulfilment, restore, replay/refund protection | yes before deletion; pseudonymous after deletion where retained | SQLite |
| Advertising | consent release state, ad-unit/ticket/reward verification | ad eligibility and reward integrity, only when enabled | potentially yes | SQLite / native provider |
| Moderation | report category/detail, target, outcome, reviewer audit | safety/moderation | yes before deletion; target can become pseudonymous | SQLite |
| Operator/security audit | operator action, actor reference, reason, chained audit hash | security, incident response, accountability | pseudonymous/account-linked | SQLite |
| Support correlation | MX support ID, time, method, normalized route, status, public code | user support and incident diagnosis | deliberately not account-linked | SQLite |
| Network abuse control | short-lived HMAC-pseudonymized network/rate buckets | abuse/rate limiting | not stored as raw IP | SQLite / memory |
| Transactional email queue | encrypted pending destination/message payload; delivery state | OTP/security mail delivery | temporarily | encrypted SQLite row |
| Backup | encrypted point-in-time database snapshot | disaster recovery | contains then-current database | Restic-encrypted off-box repository |

## 2. Automatically enforced short-lived retention

| Record | Implemented lifetime / bound | Enforcement |
| --- | --- | --- |
| Guest session | 24 hours | session expiry + cleanup |
| Linked session | 14 days | session expiry + cleanup; max five recent sessions after sign-in replacement |
| Presence | stale rows removed after about 1 hour | community cleanup |
| OAuth/sign-in attempt | usable for 5 minutes; stale records cleaned about 1 hour after expiry | community cleanup |
| OTP/email challenge | OTP valid 10 minutes; expired rows cleaned after about 1 hour; consumed challenges older than 1 day removed | community cleanup |
| Pending mail payload | encrypted while pending; payload cleared on sent/expired or terminal failure | mail worker |
| Mail outbox envelope | terminal rows removed after 7 days | mail cleanup |
| Support correlation | 7 days and newest 5,000 rows cap | slow runtime cleanup + insertion cap |
| Production abuse/rate buckets | per-window expiry for V4 production limits | expiry cleanup |
| Mail budget counters | bounded operational window, currently up to 40 days | expiry cleanup |

These are implementation facts and may be stated in operational documentation. They are not a substitute for the final legal retention schedule.

## 3. Account-lifetime data

Unless the approved policy sets an earlier lifecycle, the following are retained while an account exists because they provide the service:

- profile and verified identities;
- cloud practice save;
- social relationships and privacy settings;
- wallet/owned-item state;
- ratings, rank/season/tournament state;
- match history and competitive integrity state;
- reports submitted by the player while needed for moderation;
- purchase entitlement/receipt state needed to fulfil or restore products.

Players can export the allowlisted account data after recent reauthentication.

## 4. Account-deletion behavior already implemented

On confirmed deletion Mega XO:

- revokes sessions and pending sign-in state;
- deletes email credentials and linked identity rows;
- deletes the active profile and cloud save;
- removes social relationships;
- removes generic idempotency command rows for the deleted actor;
- deletes reports submitted by the deleting player;
- converts historical opponent/match/economy/purchase references to a random deletion tombstone;
- strips free-text detail from reports whose target was the deleted player;
- deletes store account-binding identifiers;
- cancels queued sensitive mail associated with the account;
- replaces the actor in the deletion workflow with the tombstone;
- stores a minimal deletion receipt containing a one-way actor hash, random tombstone, completion time, approved policy version and retained-record category names.

A deleted external identity can later create a new account, but it cannot restore the former player tag/profile.

## 5. Retained-after-deletion categories requiring final durations

The implementation currently supports retaining only minimum/pseudonymous records for these purposes, but **final time limits are not approved yet**:

| Category | Why retention may be required | Current deletion treatment | Final duration |
| --- | --- | --- | --- |
| Purchase/replay/refund integrity | prevent duplicate grants, process refunds/revocations, store disputes, accounting obligations | actor references pseudonymized; provider transaction integrity records remain | **LEGAL/POLICY DECISION REQUIRED** |
| Operator/security audit | incident investigation, abuse response, accountability | account mapping removed; historical actor UUID becomes pseudonymous | **LEGAL/POLICY DECISION REQUIRED** |
| Moderation outcomes | repeat-abuse/safety evidence and appeal handling | reporter-owned reports deleted; reports about deleted target use tombstone and free text is stripped | **LEGAL/POLICY DECISION REQUIRED** |
| Deletion receipt | prove request completion and prevent accidental re-link/restore disputes | one-way actor hash + tombstone + policy/version metadata only | **LEGAL/POLICY DECISION REQUIRED** |
| Encrypted backups | disaster recovery | deleted data can remain inside older encrypted snapshots until backup retention/pruning removes them | **LEGAL/POLICY DECISION REQUIRED** |

No production value may be assigned to `MEGA_RETENTION_POLICY_VERSION` until the rows above have approved durations and the backup pruning policy is aligned.

## 6. Backup deletion propagation

Restic backups are encrypted and off-box. The current backup worker does **not** automatically prune old snapshots; pruning is a guarded operator action.

Before approving the retention policy, Antimatter Innovations must define:

1. normal snapshot retention windows;
2. maximum time deleted account data may remain only inside encrypted disaster-recovery backups;
3. whether restored backups require a post-restore deletion/tombstone reconciliation step;
4. legal holds and who can authorize them;
5. evidence retained after pruning.

The backup runbook must be updated to the approved schedule before `MEGA_RETENTION_POLICY_VERSION` is set in production.

## 7. Policy decisions still required

Legal/privacy approval must determine at minimum:

- launch countries/regions and applicable privacy/consumer laws;
- final legal entity/controller identification and address;
- minimum age and parental-consent position;
- purchase/security/moderation/deletion-receipt retention periods;
- backup retention and deletion propagation;
- data-subject/request response periods;
- international-transfer safeguards and processor agreements;
- whether any regional opt-out/sale/share rights apply if advertising is enabled;
- support/moderation appeal retention;
- legal-hold procedure.

## 8. Change control

A release that adds a new SDK, data type, purpose, processor, advertising behavior, analytics collection or retention category must update:

1. this inventory;
2. the public Privacy Policy;
3. Apple App Privacy answers;
4. Google Play Data safety answers;
5. consent/disclosure UI where applicable;
6. the approved policy/version identifiers before the feature is enabled.
