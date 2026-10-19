# Neon Ownership Migration — 2026-10-19

Status: **COMPLETE (zero downtime)**. All Mega XOXO Neon resources are controlled by
contact@antimatterinnovations.com (org org-bold-silence-37218003, "Naraharikripa", free plan).

## Method

Supported organization transfer (POST /organizations/{source}/projects/transfer) — preferred per the
owner brief because it preserves data, endpoints, credentials and history with no maintenance window.

Preconditions that had to be arranged (the caller needs source-org Perm:delete AND destination membership):

1. Invite contact@ to the old org as admin (API, old-owner personal key).
2. contact@ accepts via the invite email link in an authenticated console session (auto-join on visit).
3. A **personal** API key for contact@ (org-scoped keys cannot act on the source org).
4. Run the transfer for all three projects.

## Result

| Project | ID | Endpoint | State |
| --- | --- | --- | --- |
| mega-xo-v5-production | blue-sun-85454968 | ep-mute-surf-b8v94ksa.c-14.us-east-1.aws.neon.tech | active, unchanged |
| mega-xo-v5-staging | lively-shadow-52629967 | (unchanged) | active |
| mega-xo-v5-dev | silent-unit-55400508 | (unchanged) | active |

Verification evidence (2026-10-19 21:30 IST):

- All three projects report org_id org-bold-silence-37218003; the old org has zero projects.
- Production endpoint hostname unchanged → no config/credential change anywhere; existing
  DATABASE_URLs, roles (migration_owner etc.) and TLS keep working.
- Direct psql against production: identity.actors=13, economy.wallets=13, full schema present
  (identity, economy, core, cosmetics, audit).
- Live: https://megaxo.online/readyz → 200 {"status":"ok","live":true,"ready":true}, /game → 200.

## Quota attribution (honest budgeting)

The per-project free-plan warning transferred with the project: the destination org dashboard shows
"mega-xo-v5-production is nearing its monthly free plan limit (over 80%)" while org-level usage
counters restarted. Measured source-org usage (Oct 5 → Oct 19): **67.69 CU-hrs compute, 5.87 GB
transfer, 0.12 GB storage**. **The transfer did NOT reset usage** — consistent with the brief.

Free-plan per-project allowance (verified from the org billing page): 1 GB storage, autoscale to 2 CU,
**100 compute hours**, 10 branches. Production compute/transfer waste is therefore the binding
constraint; the idle-elimination work in this brief is mandatory to meet the ≤50% target.

## Access & keys

- Destination org-scoped key: ~/Downloads/Mega-XO-private-evidence/neon/api.key (operational).
- contact@ personal key: ~/Downloads/Mega-XO-private-evidence/neon/contact-personal.key
  (migration-transfer-20261019) — created in the console, never echoed to chat.
- Old-owner personal key: unchanged, still working (nothing revoked per the brief).
- contact@ remains an admin member of the old org (now empty, dormant).

## Failback

Before the first destination write the rollback was trivial (source unchanged). The transfer itself is
the same operation in reverse: invite/accept + personal key on the source side would move projects
back. Because endpoints/credentials did not change, a reverse transfer is also zero-downtime. After
destination writes begin, the standard rule applies: never restore a stale source as the writer —
use data-aware failback.

## Follow-ups owned by this brief (not yet done)

- A. Native refresh-loop fix (src/account-client.js cached-expiry defect).
- B. Idle tournament polling → deadline-driven scheduling.
- C. Worker housekeeping separation (no every-few-seconds full cycles).
- D. DB-wrapper amplification reduction.
- E. Sleep-compatible liveness/readiness.
- F. Client/agent background traffic elimination.
- G. Backup redesign (no 5-minute full dumps).
- H. APK delivery metrics verification.
- Provider budget manifest + 31-day forecast; 24–48h soak; regression tests.

