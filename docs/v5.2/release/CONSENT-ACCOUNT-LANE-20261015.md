# Account-lane research consent: implemented and proven (2026-10-15)

Codex reported that migration 0052 implements the consent **data model** but no authenticated client
route exists. 0052's own comment defers that route to this lane, so it is implemented here, minimally,
with the properties proven against real PostgreSQL rather than asserted.

## What was added

| Item | Detail |
| --- | --- |
| Migration **0054** | `learning.actor_consent(actor)` (read) and `learning.set_consent(actor, notice, research, version, band)` (write). Granted to **`api_runtime` only**; `REVOKE`d from `PUBLIC`. Additive: no table, column or constraint touched. |
| Routes | `account.research.read` **GET** `/api/account/research` (linked, no CSRF on a GET) and `account.research.write` **POST** `/api/account/research` (linked, **CSRF required**, 16 KiB body bound). No route accepts an actor parameter — the actor comes from the session. |
| Service | `researchConsent(token)` / `recordResearchConsent(token, choice)`, both resolving the actor through `linkedRow`, with the notice/consent versions supplied by configuration rather than invented by the client. |
| Repository | `consent(actor)` / `recordConsent(...)` on the same owner-created function-call discipline as `account_state`: a missing function (`42883`) or an unusable reply raises `CONSENT_READ_UNAVAILABLE` / `CONSENT_WRITE_UNAVAILABLE`, never a fabricated consent state. |
| API | `getResearchConsent` / `postResearchConsent`, refusing an unauthenticated caller with `AUTH_REQUIRED`. |

## The response shape (what Codex's UI should render)

```json
{"recorded":false,"research":false,"withdrawn":false,
 "noticeVersion":null,"consentVersion":null,"ageBand":null,"grantedAt":null,"withdrawnAt":null}
```

`recorded:false` means **no record — render "not consented"**, never a grant. When a record exists,
`research` is true only for an affirmative, non-withdrawn, adult choice; `withdrawn:true` and
`withdrawnAt` are present after a withdrawal.

## Proven against real PostgreSQL (six cases, staging)

| # | Case | Result |
| --- | --- | --- |
| 1 | Absent record | `recorded:false, research:false` — not a grant |
| 2 | Operational-only choice | recorded, `research:false` |
| 3 | Affirmative adult | `research:true`, `grantedAt` stamped |
| 4 | Affirmative → "no" | `withdrawn:true`, `withdrawnAt` stamped |
| 5 | Re-consent after withdrawal | **REFUSED** `CAPTURE_CONSENT_WITHDRAWN` |
| 6 | Affirmative with a non-adult band | **REFUSED** `CAPTURE_CONSENT_ADULT_ONLY` |

## A defect 0053 introduced, found by this work

Migration 0053 replaced `record_consent` to make a recorded withdrawal durable — but its body was
**reconstructed rather than copied** from 0052, and the reconstruction changed the accepted `band`
vocabulary from 0052's `('adult','youth','unknown')` to a set of **age bands**. The consequence was
worse than the bug it fixed: a legitimate `band='adult'` call, the only band that can grant research,
was refused with `CAPTURE_CONSENT_ARGUMENT`, so the lane could not record an affirmative at all.

It survived earlier checks because the failure was masked by `SCHEMA_INCOMPATIBLE` from an unrelated
cause (the connection budget). Migration **0055** restores 0052's `record_consent` exactly, with only
the `withdrawn_at` durability fix applied, and a test now asserts that the validation guards match 0052
line for line and that the age-band vocabulary cannot leak back into the consent band check.

This is the second time in this session that reconstructing a function body from memory instead of
copying it introduced a defect. Recorded deliberately rather than quietly fixed: **copy the body, do
not retype it.**

## Applied state

Both databases verify at **55 checksums + catalog conformance** — staging and production, forward-only,
with 0052's and 0053's own checksums unchanged.
