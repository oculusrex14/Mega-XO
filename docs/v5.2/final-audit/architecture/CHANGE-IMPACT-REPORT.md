# V5.2 change-impact report

Source: `7f582b749a1128b86e53ddcbcda57b569b0953cf`. Graph: 3,175 nodes / 8,167 edges. No application files were edited. This report identifies review neighborhoods; it does not authorize a migration, deployment, provider mutation or gameplay change.

GitNexus had no index for this checkout. Its exploration/impact workflow informed the dependency review, but a fresh index was not written. The accompanying deterministic source graph is the fallback, with lexical uncertainty retained on edges. Direct dependency does not mean every possible edit breaks its caller.

## Change neighborhoods

Counts below are distinct upstream graph nodes first reached at each depth, excluding already visited nodes and `TESTED_BY`/containment edges. Included relationships: `DEPENDS_ON`, `CALLS`, `TRIGGERS`, `RENDERS`, `READS`, `WRITES`, `CONFIGURED_BY`. Counts include features, screens and interaction declarations as well as modules; they are not caller-file counts or test coverage percentages.

| Target module | Depth 1 / 2 / 3 | Review risk | Required consumers to inspect |
| --- | --- | --- | --- |
| `src/game.js` | 41 / 249 / 334 | Critical rule contract | Website board, native app, worker/search/encoding, tutorial replay, Core/authority and game-history reconstruction |
| `src/domain.js` | 21 / 309 / 52 | Critical economy contract | Local rewards, all five payouts/caps, rank/season policies, wallet/exchange, Core projections and purchase utility |
| `src/app.js` | 151 / 181 / 0 | High presentation/state coupling | Root index controls, sheets, local save, powers, party/community/monetization hooks, native bundle and system-bar theme propagation |
| `apps/web/board.js` | 16 / 140 / 0 | High browser workspace coupling | Website `/game`, homepage preview, tutorial, online/tournament/spectator modes, all five palettes and keyboard/revision fences |
| `src/account-client.js` | 9 / 462 / 4 | Critical session/transport | Website and signed-native requests, provider capabilities, profile refresh, logout/revoke, cookie/CSRF boundary and account recovery |
| `packages/services/accounts.js` | 11 / 0 / 0 | Critical identity/data | Production composition, API routes, secret-read functions, identity locks, native session issuance, coordinated deletion and worker handoff |
| `packages/services/core.js` | 9 / 4 / 0 | Critical competitive/economic | Signed gateway/ingress, queue/offer acceptance, move idempotency, actor occupancy, tournament/commerce settlement and role guards |
| `packages/services/commerce.js` | 5 / 0 / 0 | Critical receipt/economy | Provider handlers, receipt binding, duplicate delivery/refund, pass periods, Core-only economic writes and store finalization |
| `src/bot/search.js` | 10 / 2 / 0 | High measured-behavior | Worker engine selection, runtime budgets, tactics/routing, historical league provenance and labels; strength cannot be inferred from an unchanged engine name |

The zero counts at deeper levels illustrate graph limitations; they do not establish that accounts/Core/commerce have no indirect runtime consumers.

## Concrete changes needed, without implementation

### Account-choice production parity — SAGAN-002 / SAGAN-004

Required slice: PostgreSQL migration + least-privilege repository reads + account-service decision state machine + browser/native DTO/routes/callback + native grant completion + durable scheduled deletion/cancellation + UI + tests. Preserve source-session → provider-subject → actor authentication lock order, single-use states and absolute expiry. Resolve ambiguous email matches explicitly. Require existing-profile ownership before touching that actor. Keep Core occupancy/economic ownership intact.

Do not reuse SQLite DDL in runtime PostgreSQL code, grant API access to credential/economy tables, share Core credentials, or call immediate deletion at the start of a promised recoverable grace period. The legacy cancellation promise requires an actual authenticated cancellation transition. Test coverage must include actual PostgreSQL rows and competing decisions/cancellation, not just `CommunityStore` fixtures.

Relevant existing tests: `tests/v52-account-link.test.js` (SQLite only), `tests/v5-p11-native-session.test.js`, `tests/v52-web-oauth.test.js`, `tests/account-deletion.test.js`; migration and real-PG tests must accompany the implemented slice. No new tests were run locally.

### Native provider capabilities — SAGAN-012

`nativeEnsure()` obtains the host's real compiled providers; `nativeSessionFromProfile()` discards that set and substitutes the account's linked providers. Preserve separate supported and linked sets through the profile/session DTO. An Android profile linked to Apple must not make an Apple SDK adapter appear. An account not yet linked to a compiled provider must still be able to initiate an authorized link. Read Android and iOS bridge capability reports together; do not broaden bridge origins to compensate for missing adapters.

### Website account controls — SAGAN-003

Change the actual linked `/account` CTA and supply a real control destination/action. The website shell contains the website board, not the retained app account overlay. Either implement website security controls or explicitly navigate to the retained account UI with a reliable opening action. Merely changing the text, pointing to `/game`, or adding an unhandled query parameter leaves the control unreachable.

Verify linking/reauthentication, export, deletion and session management from the real browser route. Remember that legal-document main content overrides some fallback functions in `pages.js`; test the built route's actual content.

### Native default theme — SAGAN-001

Restrict the After Hours default to a true first-run save initialization. A stored Vector preference is valid user work and must survive restart. Check fresh install, saved Vector, each of the other originals, migrated settings and cloud-practice adoption separately on both hosts. Keep website Neon default and the four native palettes separate. Do not activate paid native Neon.

### Website reflow — SAGAN-006

Baseline CI identifies the sponsor enquiry email as unbreakable content on `/sponsors` and alias `/ads` at 320px. The integrator subsequently committed a narrow wrap rule in `bdc4af4`; this workstream did not edit it. Treat that as source remediation pending exact-candidate CI, not a passing baseline test. Keep the alias in the validation matrix.

### Power wallet and browser integration — SAGAN-009 / SAGAN-010

The native Bot adapter purchases from `data.wallet`; its primary wallet renderer can show `online.profile.wallet`. The Store does disclose device-wallet spending. Resolve the remaining balance/purchase feedback ambiguity with the economy owner; do not silently turn local practice charges into API-authoritative spending. Preserve bought/earned Crown utility and idempotent item delivery.

The website power controller intentionally defaults its verification gate to false. `board.js` does not supply a verified actor/match binding or the app adapter. Do not enable it by setting a client boolean or inventing a binding. Ordinary play remains available; native Bot power behavior is not proof that website powers work.

## Architecture review gates

- Rules: inspect canonical legality, free-choice routing, terminal behavior and differential optimized-board checks.
- Identity: prove actor continuity, subject uniqueness, supported-vs-linked providers, cancellation and CSRF/native credential boundaries.
- Economy: preserve caps, receipts, account binding and single Core mutation authority.
- UI: inspect actual builder routes, legal precedence, selector/helper call sites, truthful disabled states and 320px/zoom/keyboard behavior.
- Native: generated-byte provenance and simulator builds are distinct from physical device, SDK/provider and store acceptance.
- AI: compare exact source/model/rules hashes to measured artifacts. Current default is `legacy`; historical improved-search results do not certify the currently selected engine or current changed experimental source.

The final release certification and acceptance of residual scope belong to the integration workstream and owner.
