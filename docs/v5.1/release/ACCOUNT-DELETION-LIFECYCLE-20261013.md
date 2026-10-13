# Account deletion / privacy / retention lifecycle — R15/P21 + DC08-adjacent (2026-10-13)

Real disposable accounts were created, deleted and observed on the **live isolated staging origin**
`https://command.tail95c48c.ts.net`, and the deletion end state was read back from the staging
PostgreSQL (Neon `mega_xo_v5_staging`) through the deployed runtime roles.

Driver: `scripts/v51/p21-account-deletion-lifecycle.cjs` (30 steps; HTTPS only, plus read-only SELECTs).
It never prints a password, one-time code, cookie, bearer, email address or secret, and it only
touches actors it creates this run.

| | |
| --- | --- |
| Deployed origin source | commit `5ee26799eb6e82ff659fe76f2c5984739c219772` (`/opt/mega-xo-v51-staging/deploy-receipt.json`) |
| Verified local tree | `packages/services/accounts.js`, `apps/api/routes/account.js`, `apps/api/routes/social.js` byte-identical to the deployed origin (md5 compared) |
| Deletion policy on this origin | `{ enabled: true, policyVersion: 'v51-staging' }` (`scripts/v51/p21-staging-server.cjs`); observed live as `policyVersion: "v51-staging"` |
| Fix commit | `1a80ebc` (branch `V5.1`) |
| Outbound email | **disabled** by design (`docs/v5/environments/staging.json` → `outbound.email = "disabled"`); the one-time code is read out-of-band from the staging OTP sink over ssh |

## 1. Defect found and fixed (real, not a test artifact)

`packages/services/accounts.js:deleteAccount` computed the tombstone and the pseudonymized actor hash
and **committed both durably** — the tombstone is written into the `identity.profiles` row (as its
24-char scrub prefix) and, with the `actorHash`, into the `account.deletion` outbox payload — but its
final return value exposed only `{ deletionPending, receiptId, policyVersion }`. The route builds its
response from `result.tombstone` / `result.actorHash` (`apps/api/routes/account.js`), so the live
acknowledgement silently dropped two durable facts it had just committed.

Observed on the live origin **pre-fix** — HTTP 200 with four body keys:

```json
{ "deleted": true, "status": "pending", "receiptId": "del_<uuid>", "policyVersion": "v51-staging" }
```

Post-fix the acknowledgement carries all six documented keys:

```json
{ "deleted": true, "status": "pending", "receiptId": "del_<uuid>",
  "tombstone": "deleted_<32 hex>", "policyVersion": "v51-staging", "actorHash": "<43-char base64url>" }
```

The fix returns the two already-committed values; nothing else changed (no route, rule, economy or
policy change). `tombstone` and `actorHash` are pseudonymous and carry no PII (the outbox payload
contains no email, no tag and no credential material — verified below).

## 2. Exact routes and observed status codes

Every request is HTTPS to the staging origin, with cookie auth + `X-CSRF-Token` + `Origin` on mutations.

| Route | Method | Caller | Observed |
| --- | --- | --- | --- |
| `/api/account/session` | GET | anonymous | `200` — issues session cookie + `csrf`; `linked:false`, `actorId:null` |
| `/api/account/email` `{action:'continue'}` | POST | anonymous session | `200` — `challengeId` (delivery stripped; code written to the OTP sink only) |
| `/api/account/email` `{action:'verify'}` | POST | anonymous session | `200` — links the actor and **rotates** the cookie/CSRF |
| `/api/account/save` `{revision:0,...}` | POST | linked A | `200` — a real `profile.profile_saves` row to be removed by deletion |
| `/api/community/friend` (`request`/`accept`) | POST | linked A/B | `200` — a second viewer for the visibility checks |
| `/api/account/deletion` | GET | linked A | `200` — `{ available:true, policyVersion:"v51-staging", confirmation:"MEGA-<8 hex>", recentlyVerified:true }` |
| `/api/account/delete` (no credentials) | POST | anonymous | `401` `AUTH_REQUIRED` |
| `/api/account/delete` (guest session) | POST | anonymous session | `401` — guest auth state unchanged |
| `/api/account/delete` (wrong tag) | POST | linked A | `409` `DELETE_CONFIRMATION_REQUIRED` |
| `/api/account/delete` (missing tag) | POST | linked A | `409` `DELETE_CONFIRMATION_REQUIRED` |
| `/api/account/delete` (correct tag) | POST | linked A | **`200`** `{deleted:true, status:"pending", receiptId, tombstone, policyVersion, actorHash}` |
| `/api/account/profile` | GET | revoked A bearer | `401` `AUTH_REQUIRED` |
| `/api/account/save` | GET | revoked A bearer | `401` `AUTH_REQUIRED` |
| `/api/account/deletion` | GET | revoked A bearer | `401` `AUTH_REQUIRED` |
| `/api/account/session` | GET | revoked A bearer | `200` — boots a **fresh anonymous** session (`linked:false`, `actorId:null`) |
| `/api/community/profile/:id` | GET | linked B | A: `200` before → **`404` `PROFILE_NOT_FOUND`** after |
| `/api/community/search?q=<tag\|username>` | GET | linked B | `200`, `[]` — the deleted actor is absent by both its retained tag and its former username |
| `/api/community/friends` | GET | linked B | `200` — the deleted actor is absent from the friend list |
| `/api/account/delete` (replay, same revoked bearer) | POST | revoked A | `401` — terminal, no second receipt |
| `/api/account/email` `{action:'continue'}` on the **same address** | POST | anonymous | `200` → verify creates a **new** actor with a **new** tag; the former tag is never restored |

`Cache-Control: no-store` on the deletion acknowledgement.

## 3. Durable end-state transitions (read back from staging)

Read-only SELECTs on the live staging database via the deployed roles `api_runtime` (the API's own
grant surface) and `worker_runtime` (the only role that can read the outbox payload).

**Committed inside `deleteAccount`'s one transaction** (`packages/services/accounts.js:1629`):

| Effect | Observed |
| --- | --- |
| `privacy.requests` intake row | `kind='deletion'`, **`state='requested'`**, `policy_version='v51-staging'`, `completed_at IS NULL` |
| `identity.eligibility.verified` | **`false`** (the API's real disable; `suspended`/`security_hold` are not in the API's column grant) |
| `identity.profiles` tombstone | `username == display_name == "deleted_<24-char scrub>"` (matches the outbox tombstone prefix), `stats_visibility='private'`, `presence_visibility='hidden'`, the `MEGA-########` tag row retained as a soft reference |
| `identity.email_credentials` for the actor | **0 rows** |
| `identity.email_credentials` for the address | no surviving row belongs to the deleted actor (the only row is the re-signup actor's) |
| `identity.identities` | **0 rows** (every linked login identity removed, not just email) |
| `identity.sessions` | **0 rows** (all sessions revoked) |
| `identity.email_challenges` | **0 rows** |
| `profile.profile_saves` | **0 rows** |
| `ops.outbox` hand-off row `account.deletion:<actor>` | **1 row, `state='queued'`** |
| `privacy.deletion_receipts` | **0 rows** for this receipt — the API writes no permanent receipt |

**`account.deletion` outbox payload** (read via `worker_runtime` — the API cannot read it), exactly
six keys:

```
payload keys : actor, actorHash, policyVersion, receiptId, retained, tombstone
retained     : ["purchase_replay_records", "operator_security_audit", "pseudonymized_moderation_outcomes"]
receiptId    : matches the acknowledgement
actorHash    : 43-char base64url digest present
tombstone    : deleted_<32 hex>, matches the acknowledgement (post-fix)
carries email: false   carries tag: false   carries password material: false
```

**Grant boundary proven live:** `api_runtime` reading `privacy.deletion_receipts` fails with SQLSTATE
**`42501`** (permission denied) — the API runtime cannot write or read the permanent receipt; that row
belongs to the `worker_runtime` state machine (`0022`).

## 4. Implemented vs. verified vs. provider/worker-dependent

**Implemented (code present and exercised):**
- Coordinated deletion intake: policy gate (`ACCOUNT_DELETION_UNAVAILABLE` when disabled), recent-auth
  window (`REAUTH_REQUIRED`), exact player-tag confirmation, `ACCOUNT_BUSY` on live competitive
  occupancy, canonical lock order (actor auth mutex → eligibility row lock → live-bearer re-read).
- Real disable: sessions/challenges/sign-in attempts/identities/credential removed, profile
  tombstoned and closed, account marked unverified, cloud save removed.
- Durable hand-off: `privacy.requests` at `'requested'` + a bounded `account.deletion` outbox row
  carrying `{actor, receiptId, tombstone, actorHash, policyVersion, retained}`.
- Visibility: profile view/search/friends hide a deletion-pending actor from every other viewer;
  OTP verification of a deletion-pending actor is refused (`INVALID_OTP`).
- Post-commit presence fencing: Redis revocation hints + presence drop so a delayed heartbeat cannot
  resurrect the revoked session.

**Verified live on staging this run:** all of the routes and durable transitions in §2–§3, on
disposable accounts, with exact status codes and read-back state. Local PG16 suites:
`tests/v5-p11-account-social.test.js` **6/6** (including the new acknowledgement + end-state
assertions), `tests/v5-p04-services.test.js` + `tests/v5-p05-integration.test.js` **43/43**,
`tests/privacy-export.test.js` **4/4**.

**Worker/Core-dependent (NOT deployed on this origin) — reported, not claimed:**
- Completion of the `privacy.requests` state machine (`requested → completed`), the **permanent
  `privacy.deletion_receipts`** row, and economic/competitive erasure are owned by `worker_runtime`
  and are **not** present here: the request stays `'requested'`, the receipt row count is `0`. The API
  deliberately never returns `{deleted:true}`-as-complete; the acknowledgement is `status:"pending"`.
- **Email delivery stays disabled** (`outbound.email = "disabled"`). Signup/verify therefore reads the
  one-time code from the staging OTP sink — the real delivery leg is provider-dependent and out of scope.

**DC08-adjacent (training-data deletion/lineage) — boundary stated honestly:**
- The gameplay-training capture pack (`docs/v5.1/data/PLAYER-GAMEPLAY-TRAINING-IMPLEMENTATION-PACK-20261013.md`,
  DC00–DC15) is **NOT STARTED**. There is **no** `learning` schema, no `game-capture/v1` serializer,
  no capture worker and no source-to-subject index in the repository (`packages/migrations/` has no
  learning migration). Consequently DC08's "deletion removes/excludes all affected captures and
  previously exported shards" has **nothing to act on yet**.
- What the shipped API does provide for a future DC08 integration: the `account.deletion` outbox row
  is the natural lineage anchor — it is durable, idempotent (`outbox_id = account.deletion:<actor>`)
  and pseudonymous (contains `actor` + a hashed `actorHash`, no email/tag/credential). A capture worker
  that keys captures by actor can, on claiming this kind, exclude that actor's captures.

live_6key_reverification: PENDING (owner-coordinated redeploy of commit >= 1a80ebc)

## 5. Guest-auth preservation

`LINK_ACCOUNT_REQUIRED` / `AUTH_REQUIRED` remain **auth state**, not account or deletion state. An
unknown caller still receives an anonymous session (`linked:false`, `actorId:null`), and every
linked-only route (including `/api/account/delete`) is a `401` for it. The deletion path neither
reads nor changes that classification; the verified run confirms the guest session and the guest
`/api/account/delete` `401` are unchanged across the deletion flow.

## 6. Reproduce

```
node scripts/v51/p21-account-deletion-lifecycle.cjs \
  --origin https://command.tail95c48c.ts.net \
  --otp-sink /opt/mega-xo-v51-staging/staging-otp.jsonl --ssh command
# read-only, HTTP-only:
node scripts/v51/p21-account-deletion-lifecycle.cjs --no-db
```

Exit code is `0` and `ok:true` when every step passes. Against the **current** origin (pre-fix route)
exactly one step fails by design — `DL_10_delete_acknowledged_pending` — because the acknowledgement
omits `tombstone`/`actorHash`; every other pre-fix step passes (29/30), which is what isolates the
defect to the response projection rather than the deletion itself.
