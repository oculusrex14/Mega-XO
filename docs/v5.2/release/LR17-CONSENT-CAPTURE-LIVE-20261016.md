# LR17 — consent & capture live verification (2026-10-16)

**Method:** live HTTPS probes against megaxo.online + signed-in browser session (player_f6ecb6a6f4) + source reading of the consent/capture stack. No data written to production except reads; no player data printed beyond the owner's own session handles.

## Verified live / in source

| Check | Result | Evidence |
| --- | --- | --- |
| Consent routes exist + fail closed | GET/POST /api/account/research and /api/account/deletion all return 401 AUTH_REQUIRED for anonymous callers — no shape leak, no route confusion | curl 2026-10-16 |
| Consent service contract | research:true REQUIRES an adult age band, enforced in the database (CAPTURE_CONSENT_ADULT_ONLY); the service explicitly does not soften it; withdrawal delegates to migration 0052 semantics; notice/consent versions bounded | packages/services/accounts.js (researchConsent/recordResearchConsent) |
| One-time semantics | The choice is recorded once per actor; unknown/absent body records a refusal, never a grant (route comment + implementation) | apps/api/routes/account.js 222-254 |
| Deletion is a real state machine | API half: full session revocation, identity/credential removal, public scrub, unverified marking, privacy.requests intake row + account.deletion outbox hand-off; the API never writes a receipt or claims deleted:true | accounts.js deleteAccount |
| Session persistence | Signed-in state restored across new tabs (host-only cookie, no Domain) — matches the LR05 identity evidence | browser session 2026-10-16 |
| Capture schema exists | migrations 0045-0048 (gameplay capture lifecycle, source fidelity, intent integrity, unstarted-void exclusion) + 0052-0055 (consent/retention) in the deployed tree (55=55 file parity, LR05) | packages/migrations + host tree |

## GAP (the one real finding): no research-consent UI surface

The privacy-choices page covers data download, deletion, profile/social, sessions and advertising (and correctly states ads stay disabled pending the consent gate) — but NOTHING renders the optional research choice. The API, service and DB constraints are complete; the player-facing surface is missing. E03 requires a clear onboarding notice that explains necessary operational data and optional research separately, an affirmative opt-in (never preselected), remembered across sessions without repeated prompting, with withdrawal.

**Implementation plan (next slice, small):** a consent card in the signed-in account panel (apps/web/pages.js linked branch + app.js hydration): when GET /api/account/research reports not-consented, render the one-time two-part notice (necessary operations vs optional research, age-band question for research) with an explicit opt-in defaulting OFF and a decline action; once recorded, render the current choice with a change/withdraw control (POST). Prerendered shell unchanged (client-hydrated card only) — the zero-new-UI-in-apps/api invariant is untouched; the p11/build/seo suites gate the change.

**Also verified absent (correct for now):** no day-one training claims anywhere in the capture lane; advertising disabled with an explicit consent-gate note on the live page.

## Delegated to Main (DB-level, exact checks)

- learning.policy state + the capture productionAuthorized gate: read-only SQL against production (SELECT from the policy/capture tables; no player rows printed). The unit evidence cannot prove the LIVE gate; the deployed tree has the migrations but the running posture must be confirmed once by the operator.
- Collector receipts freshness (ops.outbox account.provision/capture kinds) — same read-only pass.
