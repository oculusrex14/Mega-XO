P05 preparation design, NOT implementation or acceptance. [V] denotes repository-source observations from the original analysis; [D] denotes proposed/selected design; [P] denotes provider proof still required. Parent corrections below reflect the P03 encoding boundary and current P04 runtime decisions. Execute G04 before P05 implementation.

=====================================================================
PART A - TODAY'S EXACT SEMANTICS (V)
=====================================================================

A1. SESSION MODEL. server/community-store.js:81-99.
- _issue(actor=null, authAt=0): token = 32 random bytes base64url; csrf = 24 random bytes base64url; created=now; expires = created + (actor ? 14*DAY : DAY) [V]. So linked lifetime = 14 days, anonymous = 1 day; auth_at starts at 0 for an anonymous bootstrap and at now() for any linked issuance.
- Storage: account_sessions(token PK, actor NULL, csrf NOT NULL, created, expires, auth_at NOT NULL DEFAULT 0). The source PRIMARY KEY stores SHA256(bearer) as 43-character base64url; V5 stores those SAME 32 bytes as 64-character lowercase hex. This is reversible re-encoding, not a hash-of-a-hash. P03/P04 already implement the explicit hashIn/hashOut boundary in packages/db/pg/repositories.js; preserve it. The raw bearer is never stored [V].
- session(token): rejects non-string or >128 chars; reads live row where expires>now; if actor is set, calls requireAccount(actor) and returns null on failure [V]. requireAccount throws ACCOUNT_UNAVAILABLE when suspended||hold||!verified (community-store.js:74). So suspension/hold/unverified-email disable a session without deleting the row.
- Issuance paths: bootstrap() inserts an anonymous row when no valid token [V]; _replaceSession(session, actor, created) clears the old presence, ROTATES (deletes) the presented session row, issues a new one with auth_at=now(), then revokes every session for that actor beyond the newest 5 (slice(5)) [V]. Session fixation protection and a 5-session cap are therefore existing, tested semantics (tests/community.test.js:12-14, tests/production-auth.test.js:97-101).
- Public session id: _sessionId = sha256(token_hash) hex slice(0,24); /^[a-f0-9]{24}$/ is enforced on revoke [V]. The raw hash is never returned.

A2. COOKIES AND CSRF. server/community-http.js:13-15, server/production/perimeter.js:87-94.
- Browser (https origin): cookie name __Host-mega_session; Set-Cookie: Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600; Secure [V]. Loopback dev: mega_dev_session with the same attributes minus Secure, and only when the origin is localhost/127.0.0.1/[::1] with allowLocalHttp [V].
- The __Host- prefix forces host-only + Path=/ + Secure, so the old play.antimatterinnovations.com cookie can never be read at api.megaxo.online by widening a domain [V per spec 02 s3].
- CSRF: every account/community/v1 POST requires exact Origin equality plus a JSON content type (requireSameOriginJson) and x-csrf-token compared constant-time against the session's stored csrf [V: packages/contracts/http-guards.js, community-http.js:30-31]. The perimeter's own /api/account/email branch re-checks Origin and CSRF before EmailAuth.dispatch [V].
- Two distinct error-surfacing paths exist and are frozen: perimeter publicErrors (401/409/429/503/400/500-REQUEST_FAILED) for the email route, and community-http's accountStatus/safeError for everything else [V]. The route manifest freezes auth/origin/key per route (packages/contracts/routes.js).

A3. RECENT AUTHENTICATION ('auth_at') - WHAT IS GATED. Window = 15 minutes = 900000 ms, except two legacy CommunityStore paths that use 15*60000 (same number) [V].
| Gate | Source | Code on expiry |
|---|---|---|
| Email link start (production) | email-auth.js:68 | REAUTH_REQUIRED |
| Email link verify (production) | email-auth.js:109 | REAUTH_REQUIRED |
| Email change-email start | email-auth.js:127 | REAUTH_REQUIRED |
| Email change-email verify | email-auth.js:96 | REAUTH_REQUIRED (returned as {error}) |
| Provider link intent | community-store.js:154 | REAUTH_REQUIRED |
| Unlink provider | community-store.js:177 | REAUTH_REQUIRED |
| Data export | community-store.js:221 | REAUTH_REQUIRED |
| Account delete | community-store.js:236 | REAUTH_REQUIRED |
| Display only: sessions list | community-store.js:93 | recentlyVerified flag |
| Display only: deletionStatus | community-store.js:233 | recentlyVerified flag |
Re-authentication: emailReauth (community-store.js:148) and EmailAuth.reauth both verify the current password and then UPDATE account_sessions SET auth_at=now() for the CURRENT session only [V]. A passive token/cookie refresh is NOT a recent-auth source today; V5 must keep that property [D].

A4. SIGNIN ATTEMPTS (state/nonce/PKCE). community-store.js:152-175.
- start(token, provider, intent, kind): requires an existing session; provider in {google,apple}; intent in {login,link,reauth}; kind in {web,native}; intent=reauth requires a linked session else LINK_ACCOUNT_REQUIRED; intent=link applies the 15-min gate; then rate 'signin' 15/300s. Row: PK = sha(state), session = sha(session bearer) (the same hash as account_sessions.token), provider, kind, intent, target = session.actor for link/reauth else NULL, nonce (32B b64url), verifier (32B b64url), expires = now + 5*60000 (5 min), used=0 [V].
- consume(token, state, provider, kind): inside a tx, requires row.used=0, expires>now, row.session===current hash, provider/kind match, then sets used=1 BEFORE the provider exchange [V]. One-use and bound to the browser session, the provider and the transport kind.
- PKCE: Google only - authorization URL carries code_challenge = base64url(sha256(verifier)) with code_challenge_method=S256, code_verifier is sent on exchange, prompt=select_account [V]. Apple uses no PKCE; it sends response_mode=query and authenticates with a client secret built as an ES256 JWT (iss=teamId, sub=clientId, aud=https://appleid.apple.com, exp=iat+300) [V].
- cleanup() deletes signin_attempts with expires < now-1h [V]. deleteAccount deletes attempts by target actor and by session hash [V]. incident-lockdown sets used=1 for all unconsumed attempts [V].

A5. EMAIL CHALLENGES + v4_email_versions (STALE-CREDENTIAL PROTECTION). server/production/email-auth.js; community-store.js:99-147.
- email_challenges(id PK, session, email COLLATE NOCASE, purpose, actor NULL, code_hash, password_salt NULL, password_hash NULL, created, expires, attempts DEFAULT 0, verified_at NULL, consumed DEFAULT 0) [V].
- TTL 600000 ms (10 min); cooldown 60000 ms per (session,email,purpose); code is 6 digits; code_hash = HMAC-SHA256(secret, [id,email,purpose,code].join('|')) base64url [V].
- Issuing supersedes: UPDATE ... SET consumed=1 WHERE session=? AND email=? AND purpose=? and cancels any queued outbox rows whose id is one of those challenges [V, production path only].
- Verify matrix [V]: consumed||verified_at -> INVALID_OTP; expires<=now -> mark consumed, OTP_EXPIRED (EmailAuth) / INVALID_OTP semantics on the legacy path; attempts>=5 -> OTP_LOCKED; wrong code -> attempts+1, INVALID_OTP; a correct code is only honoured while the challenge row is still unconsumed and unverified.
- v4_email_versions(challenge PK REFERENCES email_challenges ON DELETE CASCADE, credential_hash NULL). stamp(row) = sha256(actor + '|' + password_hash) hex. At challenge creation the current credential stamp is recorded. verify joins email_challenges to v4_email_versions (INNER JOIN) and, for purposes reset/verify-existing/change-email, requires stamp(current credential) === stored credential_hash, else INVALID_OTP / RESET_NOT_AUTHORIZED [V]. This is the stale-credential protection: an OTP minted before a password change cannot be used afterwards. recover() consumes challenges that have no version row, and slow() prunes orphan version rows [V].
- Purpose matrix [V]: signup (creates actor), verify-existing (marks verified_at, rotates session), link (requires linked session + recent auth + session.actor===row.actor), reset (marks verified_at, then reset completes with a new password and revokes ALL sessions/presence for the actor), change-email (updates email_credentials.email and identities.subject, revokes every other session/challenge/mail).
- Password: production scrypt N=131072 r=8 p=1 32-byte, prefix 'scrypt-v1$'; legacy unprefixed N=16384 accepted and upgraded only after a successful verify [V].
- Asymmetry to preserve deliberately: EmailAuth.link answers EMAIL_IN_USE for both 'email belongs to someone else' and 'this actor already has an email', while CommunityStore.emailLinkStart distinguishes EMAIL_ALREADY_LINKED. Production mounts EmailAuth for /api/account/email, so EMAIL_IN_USE is the deployed behaviour; EMAIL_ALREADY_LINKED is not in the perimeter publicErrors set and is only reachable through the non-production store path [V].

A6. PROVIDER LINKING RULES (finishVerified). community-store.js:159-174.
- attempt.target = session.actor for link/reauth. If target set and != session.actor -> ACCOUNT_CHANGED. reauth requires the (provider,subject) identity to already exist for that actor -> REAUTH_ACCOUNT_MISMATCH. If target set and the subject already belongs to a different actor -> ACCOUNT_LINKED_ELSEWHERE (no merge, ever). If no target and the subject exists -> reuse that actor (login). If no target and no subject -> create u_<uuid> and addAccount(verified:true) with the 150-coin opening grant, inside the same community transaction. suspended/hold -> ACCOUNT_UNAVAILABLE. If the actor already has a DIFFERENT subject for that provider -> PROVIDER_ALREADY_LINKED (the identities UNIQUE(actor,provider) constraint is the durable expression of this). INSERT OR IGNORE identities; provider_linked security notice when newly inserted and not a fresh account; then _replaceSession.
- Identities table enforces PK(provider,subject) and UNIQUE(actor,provider) [V] - the second-provider and no-hijack rules are already durable, not merely service-level.

A7. LOGOUT / REVOKE.
- logout(token, all=false) [V]: all && actor -> clearActorPresence + revokeAll(actor); otherwise clearPresence(current) + rotate(current) i.e. the presenting session row is deleted. Returns {signedOut:true}; the handler clears the cookie with Set-Cookie ... Max-Age=0.
- revokeSession(token, id) [V]: id must be 24-hex; row must belong to the caller's actor and be unexpired; revoking the current session is refused with CURRENT_SESSION; otherwise presence cleared + row deleted + a session_revoked security notice.
- revokeOtherSessions(token) [V]: clears other presence and deletes other rows, returns {revoked:count}, emits other_sessions_revoked.
- Operator [V, operator-service.js]: sessions-revoke -> revokeAll(actor,...) audited as sessions_revoke_all with an incident_sessions_revoked notice; suspend/hold ON also deletes all sessions+presence; incident-lockdown deletes every session in the system, marks all unconsumed signin_attempts used, consumes all unconsumed email_challenges (nulling password material) and cancels queued mail; all operator mutations are appended to the HMAC-chained v41_operator_audit.
- There is NO global 'revoke all sessions for everyone' player-facing route, and NO per-device revocation concept today [V].

A8. NATIVE CHALLENGE / FINISH TODAY. community-http.js:89-90.
- POST /api/account/native/challenge and /finish are ordinary cookie-authenticated, CSRF-protected same-origin routes. The challenge returns {state, nonce, expires}; the host SDK produces an ID token which is POSTed back to /finish; the server consumes the attempt, verifies the token for that nonce and native audience, calls finishVerified, sets a fresh __Host-mega_session cookie and returns {linked, csrf, profile, created} [V]. So today native is NOT cookie-free - it rides the WebView cookie jar. V5-05-04's 'native bearer path' is a genuine new transport, not a rename [V].

A9. WHAT DOES NOT EXIST TODAY (do not claim otherwise).
- No refresh token of any kind; no token family, generation, rotation or reuse detection [V].
- No access token, no JWT issuance, no JWKS, no signing key registry or kid rotation for our own tokens [V].
- No WebSocket server, no ticket issuer, no ticket redemption; packages/contracts/realtime.js is a validated library only and says so in its own header [V].
- No device registry; the only per-session identity is the opaque token hash plus an optional 4-session-per-actor ceiling from _replaceSession [V].
- No actor readiness state; addAccount creates a fully-formed account with an opening balance in the same transaction that creates the identity [V].
- 'Service assertions' exist only as the static x-mega-proxy-key shared secret at the perimeter [V]; there is no signed inter-service credential.

=====================================================================
PART B - V5 TARGET DESIGN (V5-05-01 .. V5-05-06)
=====================================================================

B0. SHARED MODEL. Keep actor_id/tag/provider subject/email/transaction id as exact text identities [V per P02 s5.1]. Every new table gets: TEXT keys verbatim, timestamptz, bytea/text hashes with an explicit CHECK, and a per-family idempotency key rather than one invented convention [D, matching the existing scopes.js discipline].

--- V5-05-01 ACTOR READINESS AND LINKING SEMANTICS ---

B1.1 Derived readiness, not another durable state machine [D, V5-D014].
Wallet-row existence is the single provisioning-ready fact. `pending_ready` means the actor/identity exists but the Core wallet does not; `ready` means the wallet exists. Verified/suspended/security_hold remain separate identity.eligibility facts. Deletion-pending derives from the durable privacy request. Do NOT add identity.actor_readiness or a parallel ready flag.
Provisioning handshake: API atomically creates the permanent actor, identity/profile/eligibility and the deterministic account.provision outbox event. Core processes provision:<actor_id>, creates the approved wallet/default rows and opening:<actor_id> ledger entry atomically, and records the outcome. Outbox delivery attempts/leases belong to the worker coordination rows; they are not another economic/readiness authority.
| Event | Durable decision | Effect / guard |
|---|---|---|
| Create actor | Serialized provider-subject ownership and permanent unique identity | Actor/profile/eligibility + outbox in one API transaction; no wallet write |
| Provision retry / lost response | Core operation outcome and wallet/ledger identities | Exact replay; no second opening grant |
| Callback succeeds but wallet absent | Actual wallet lookup remains false | Honest pending response; never infer ready from callback acknowledgment |
| Delete races provision / match admission | Shared actual eligibility row lock; re-read eligibility and occupancy | Disable or Core admission wins atomically; no disabled busy actor or late provisioning |
Deletion coordination: API disables auth/admission and records pending intake/outbox; Core performs economic/occupancy effects; worker completes the policy-bound receipt. Never claim completed deletion while financial data remains. Non-economic identity work and truthful pending reads stay available; no new gameplay/economy policy.


B1.2 Linking semantics and transition tables.
Rule set [V preserved + D additions]:
1. (provider,subject) -> exactly one actor. Two actors can never share a subject; conflicting link answers ACCOUNT_LINKED_ELSEWHERE and never merges wallets.
2. An actor may hold at most one identity per provider (UNIQUE(actor,provider)); a different subject for the same provider answers PROVIDER_ALREADY_LINKED.
3. An actor may hold at most one email credential (email_credentials.actor UNIQUE); a second email answers EMAIL_IN_USE on the production path.
4. No email-based merge, no email-derived actor id, no provider-subject-as-actor-id ever.
5. link (provider or email) requires a linked session + auth_at within 15 min; reauth requires the subject to already belong to the session actor.
6. Deleting the account does not create a replacement actor [V].
7. Cannot unlink the final method: count identity.identities under the ONE actor auth/identity mutex; count <=1 -> LAST_LOGIN_METHOD. Credential/identity deletion and invalidation of all relevant pending attempts/challenges commit together. Do not add a blanket last-method DELETE trigger that would prohibit approved coordinated account deletion.
Transition table for unlink/relink [D]:
| Event | Precondition | Effect | Failure codes |
|---|---|---|---|
| unlink provider P | linked, recent auth, P present, method count >=2 | delete identities(P); if P='email' delete email_credentials; invalidate signin_attempts where target_actor=actor and provider=P; revoke refresh families created by a session bound to P | REAUTH_REQUIRED, LAST_LOGIN_METHOD, PROVIDER_NOT_LINKED |
| relink P after unlink | recent auth | normal link; new subject may differ only if the old subject is free | PROVIDER_ALREADY_LINKED / ACCOUNT_LINKED_ELSEWHERE |
| link while pending_ready | allowed | identity added; readiness untouched | none |
| unlink while provisioning | allowed | provisioning continues; ledger entry unaffected | none |
ADDED [D]: unlink must also consume outstanding email_challenges for the removed email/actor and must not leave an in-flight signin_attempt able to re-add the removed provider; today unlink does neither [V].

--- V5-05-02 ACCESS SIGNING AND PUBLIC VERIFICATION ---

B2.1 Concrete algorithm and key choices [D].
- Algorithm: EdDSA over Ed25519 (Node crypto 'EdDSA'), 64-byte signature, JWK kty=OKP crv=Ed25519. Rationale: small, fast, deterministic verification, no padding oracle class, available in the Node >=24 runtime both packages already target [V package.json engines]. The verifier MUST use a per-issuer algorithm allowlist: our own tokens EdDSA only; Google/Apple ID tokens remain RS256-only exactly as server/identity-provider.js already enforces [V].
- kid grammar: mxv5-<env>-<yyyyqq>-<seq>-<crc8> where env in {stg,prd}, seq is a small monotonically increasing integer per environment, crc8 is a checksum of the public JWK thumbprint [D]. kid is a routing hint only; authority always comes from the registry row.
- Claims (minimal): iss (https://api.megaxo.online, exact), aud (per client class: 'mega-browser', 'mega-android', 'mega-ios', 'mega-core'), sub = actor_id, sid = the public 24-hex session id, gen = integer session/refresh generation, amr = ['pwd'|'otp'|'google'|'apple'], ath = auth_at epoch seconds (for the 15-min recent-auth gate), iat/nbf/exp/jti. FORBIDDEN in a token: balances, ranks, entitlements, roles, permission grants, or any provider subject [D per spec 02 s2].
- TTLs: access token 300 s; realtime ticket 10 s; API->Core service assertion 15 s; refresh lives in the family table, not a JWT [D, numbers in Part F].

B2.2 Public verification path [D].
- GET /.well-known/jwks.json (and /api/account/jwks for the compatibility facade) served by the API from identity.signing_keys. Response is bounded: at most 8 keys and 16 KiB, Cache-Control: public, max-age=300, s-maxage=300 plus an ETag/X-JWKS-Version. Never no-store for the public key set; always no-store for private account responses.
- Verification rules for consumers: fetch JWKS over TLS to the exact issuer host, cache with the published max-age and a hard ceiling; require kid; allowlist alg; reject crit/jku/x5u/alg:none and any token whose header alg differs from the allowlist; on unknown kid refresh once with a >=60 s minimum interval; never fall back to a shared secret.
- Key lifecycle table [D]:
| State | Servable in JWKS | Signs | Min residence |
|---|---|---|---|
| staging | yes | no | >=24 h before activation |
| active | yes | yes | until replaced |
| retiring | yes | no | >= 360 s (access TTL 300 s + 60 s skew) and >= 15 min operationally |
| retired | no | no | - |
Rotation is operator/CI-driven with a runbook; an emergency rotation path exists for a suspected key compromise (immediate retire + short forced overlap). Test hooks: wrong alg, wrong issuer, wrong audience, unknown kid, retired kid, expired/nbf-in-future, and JWKS unavailability while a valid cached key exists [A13].
- Revocation reality stated explicitly: local signature validation cannot revoke immediately. Maximum revocation delay for read-only projections = the access token TTL (300 s) [D]; for sensitive operations (export, delete, unlink, any economic command, realtime subscribe) the authority must check durable session/account status, so those are effectively immediate [D].

--- V5-05-03 REFRESH ROTATION AND DEVICE REVOCATION ---

B3.1 Tables [D] (see Part C for why they are identity.*, not a new schema).
identity.refresh_families(family_id PK, actor_id, session_id, device_id NULL, created_at, absolute_expires_at, state CHECK IN ('active','revoked','expired'), generation bigint NOT NULL DEFAULT 0, reused_in_grace int NOT NULL DEFAULT 0, revoked_at NULL, revoke_reason NULL).
identity.refresh_tokens(token_hash PK, family_id FK, generation bigint, state CHECK IN ('active','rotated','revoked','expired'), issued_at, valid_until, rotate_at NULL, grace_until NULL, first_seen_ip_hash NULL, user_agent_hash NULL).
identity.devices(device_id PK, actor_id, platform CHECK IN ('android','ios','browser'), label NULL, created_at, last_seen_at, revoked_at NULL).
identity.session_generations(actor_id PK, generation bigint NOT NULL DEFAULT 1, updated_at) - the durable revocation counter the access token's gen claim is checked against [D].

B3.2 Rotation requirements; the original access-only retry proposal is rejected [D].
- Store refresh credentials only as hashes. Serialize the durable family transition in PostgreSQL, independent of Redis; rotate exactly once and record the successor identity atomically.
- A bounded legitimate same-generation retry must recover the committed successor credential even if the winning response was lost. Returning only access with “the client already has the new refresh” is insufficient. Hash-only storage does not make deterministic, domain-separated secure successor derivation from the presented credential impossible; freeze and review the concrete protocol before V5-05-03 implementation.
- Keep refresh rotation generation distinct from session/account revocation version; ordinary refresh must not accidentally revoke still-valid access or fail a check against a different counter.
- A true replay outside the accepted retry contract revokes the family and descendants, records the durable revocation and security event, and returns SESSION_REVOKED. A rate-limited request inside the legitimate retry window must not be relabeled replay solely to log out the family.
- Browser and native host use single-flight refresh. Redis may provide a hint/cache only; its loss cannot permit double rotation, resurrect revoked sessions or invalidate a properly committed retry.

B3.3 Revocation surfaces [D].
| Action | Effect |
|---|---|
| revoke one device | revoke families for device_id, bump session generation, retain device row with revoked_at |
| revoke one session | revoke that session's family, bump its generation |
| log out current | delete/rotate the presenting session, revoke its family |
| log out all devices | revoke all families + all sessions for the actor, bump session_generations, clear presence |
| provider unlink | revoke families whose session was created by that provider's amr |
| password reset / change | revoke ALL families + sessions for the actor [V today's semantics] and consume outstanding challenges [V] |
| suspend / hold | revoke all families + sessions and block admission [V today's semantics] |
State table [D]: active -> rotated | revoked | expired; rotated -> revoked (on family replay); revoked and expired are terminal. No transition ever returns to active for the same generation. Expiry sweeps delete rows only after absolute_expires_at + a retention margin, and the revocation decision is always re-derived from families/sessions rather than from a cache [D].

--- V5-05-04 BROWSER AND NATIVE CREDENTIAL PATHS ---

B4.1 Browser path (preserve the retained client) [D].
- Cookie names kept exactly: __Host-mega_session on https, mega_dev_session on loopback. Attributes kept: Path=/; HttpOnly; SameSite=Lax; Secure (https only); Max-Age=1209600 for a linked session, 86400 for an anonymous one. SameSite must stay Lax rather than Strict because the Google/Apple callback is an inbound top-level navigation that must still carry the session cookie for state binding [V flow from community-http.js:24-26].
- Keep the established host-only cookie boundary. If a separate refresh cookie is needed, its name/attributes must be valid: __Host- requires Secure, no Domain, and Path=/, so __Host-mega_rt with Path=/api/account/refresh is forbidden. No cross-domain session cookie or wildcard Origin relaxation.
- CSRF unchanged: the session GET returns the csrf value in JSON; POSTs send x-csrf-token; the server compares constant-time; Origin is checked exactly and the JSON content type is required. Cache-Control: no-store on all private account/session responses [V].
- Every POST that changes credentials additionally requires the 15-min recent-auth window exactly as today [V].

B4.2 Native path [D].
- No cookies at all. The host authenticates with Authorization: Bearer <access token>; the refresh secret never leaves the platform secure store (Android Keystore-encrypted blob; iOS Keychain with a device-only accessibility policy), and access tokens live in host memory.
- New endpoints (add to packages/contracts/routes.js, owner A): POST /api/account/native/token (challenge+finish or refresh grant), POST /api/account/native/refresh, POST /api/account/native/logout. The existing cookie-based /api/account/native/challenge and /finish remain as a compatibility path for the shipped bridge until the retained browser build retires [V current behaviour].
- Credential resolution must be unambiguous: a request presenting BOTH a session cookie and a bearer header is rejected with a new AMBIGUOUS_CREDENTIAL code rather than guessed [D]. A browser Origin header is NOT evidence of a genuine app; native endpoints therefore require the bearer credential plus a client-class header, and device attestation is explicitly out of scope and must not be claimed as proof [D per spec 02 s3].
- Origin/CSRF protections are never globally disabled to make native work; the browser surface keeps strict Origin and CSRF, and native simply has no cookie path to protect [D].
- Reinstall/restore: a missing secure-store entry means the app must re-run the provider flow; the server must never mint a new actor for a lost credential [V rule, D enforcement].

--- V5-05-05 DURABLE ONE-USE REALTIME TICKETS ---

B5.1 Ticket table [D]. identity.realtime_tickets(ticket_hash PK, actor_id NOT NULL, session_id NOT NULL, generation bigint NOT NULL, environment text NOT NULL, audience text NOT NULL, match_scope text NULL, connection_class text NOT NULL, issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, redeemed_at timestamptz NULL, redeemed_by text NULL, redeem_connection_id text NULL, redeem_ip_hash text NULL). Indexes: (actor_id, expires_at), partial (expires_at) WHERE redeemed_at IS NULL for the sweep, (redeemed_by, redeemed_at).
B5.2 Issuance [D]. POST /api/v1/realtime/ticket (authenticated browser session+CSRF, or bearer): body allowlist {match_id?, connection_class}; the server mints a 32-byte random ticket, stores only sha256-base64url, binds actor + session id + generation + environment + audience + optional match scope + expiry, and returns {ticket, expires_in, environment, audience}. The ticket is at most 43 characters, comfortably inside the envelope's 512-character ceiling [V realtime.js]. The ticket is NEVER placed in a query string or URL; packages/contracts/realtime.js already forbids that in validateEnvelopeTransport and provides redactTicket(value) -> '[redacted:N]', which every proxy, access-log and error serializer must use [V].
B5.3 Redemption (durability and exactly-once) [D]. Core redeems with a single statement: UPDATE identity.realtime_tickets SET redeemed_at=now(), redeemed_by=:core_node, redeem_connection_id=:conn WHERE ticket_hash=:h AND redeemed_at IS NULL AND expires_at>now() RETURNING actor_id, session_id, generation, environment, audience, match_scope; zero rows means TICKET_INVALID / TICKET_EXPIRED / TICKET_REDEEMED (disambiguated by a follow-up read). Because the state is a durable row with a WHERE redeemed_at IS NULL predicate, exactly one of two racing nodes wins, and the outcome survives process death and total Redis loss [A14]. The actor used for authorization is ALWAYS the redeemed row's actor_id; the envelope's actor field is cross-checked against it and a mismatch is FORBIDDEN [V realtime.js validateEnvelope guarded by authenticatedActor]. subscribe may carry a ticket only on a connection that has not yet redeemed; the ticket is consumed once either way [D].
B5.4 Admission limits [D]: at most 3 outstanding unredeemed tickets per actor; at most 4 concurrently redeemed (live) connections per actor; per-IP issuance budget; a global in-flight cap. Counts are evaluated against the durable table for the authoritative decision, with an ephemeral Redis counter used only as a fast rejection path; losing Redis can therefore only make admission more conservative, never less.
B5.5 Lifecycle table [D]: issued -> redeemed (atomic; terminal for replay) | expired (sweep; TICKET_EXPIRED on use) | revoked (session/account revocation before redemption; TICKET_INVALID). A redeemed ticket is never reusable; reconnecting requires a new ticket. Connection lifetime is bounded by min(access token TTL, session generation validity); a ping/pong heartbeat detects a dead socket and a revoked session closes subscriptions on the next authoritative check.

--- V5-05-06 COMPATIBILITY AND TRANSITION PROOFS ---

B6.1 Preserve v4.1.2 LINK_ACCOUNT_REQUIRED exactly. The shipped client classifies LINK_ACCOUNT_REQUIRED as an auth state (not an outage), shows "Sign in to play online." and stops the poller; tests/static-ui.test.js:156-157 and tests/v5-contracts.test.js:243 pin it, and AGENTS.md forbids regression [V]. Therefore: an anonymous/unlinked session calling an online competitive route MUST still receive HTTP 401 with error LINK_ACCOUNT_REQUIRED; the status table in packages/contracts/http-guards.js already encodes ACCOUNT_STATUS[LINK_ACCOUNT_REQUIRED]=401 and must not be re-mapped [V]. No new 403/503 may replace it, and guest bootstrap must still be able to create an anonymous session - with the operational caveat that GET /api/account/session WRITES a row, so ARMED-mode read-only smoke must not call it [V spec 07 s5E].
B6.2 Cookie-domain boundary. The retained client stays same-origin behind a V5 compatibility facade on its existing host, so the host-only __Host-mega_session continues to work with no domain widening and no session exchange [D, preferred]. Only if the client must be moved to a different origin is a bounded one-time session exchange permitted: POST /api/account/session/exchange on the old origin mints a single-use durable code bound to actor+session+30 s expiry, redeemed once at the new origin; it is never a broad cookie domain and never creates an actor [D].
B6.3 Three-client proofs. Same actor resolves through email, Google and Apple across a browser-style harness, Android and iOS, including cancel, bad nonce/state, wrong audience, already-linked identity, wrong-account reauth, expired refresh, concurrent refresh, session revoke, reinstall and provider revocation [A12]. Friend graph, saves, wallet, purchases and ranks must be current across all three without platform-specific sync jobs [A12].
B6.4 Migration-session decision: preserve imported session digests/CSRF and expiry/auth_at through the established reversible base64url↔hex boundary. No schema relaxation, permanent dual encoding, hash-of-hash or forced global logout is required by the encoding difference. Preserve source bearer resolution; any separately justified session invalidation requires an explicit security/cutover decision, not a fabricated encoding limitation. Never mint a replacement actor for a lost credential.
B6.5 Compatibility adapters are versioned before activation; V4 sessions in live production stay untouched; new credential keys are staged in isolation [V phase 05 abort boundary].

=====================================================================
PART C - P02 SCHEMA MAPPING (local://v5-p02-schema-design.md, read successfully)
=====================================================================

G1..G10 map P05 additions against the CURRENT migration chain; they are not instructions to reopen accepted P02 or alter the immutable supplied pack. Verify existing objects before adding any new table.

G1. Session encoding is already resolved: base64url and hex encode the same SHA256 bytes (hashIn/hashOut). P05 may add explicit platform/device/revocation/auth-method metadata required by the chosen protocol; do not relax the 64-hex CHECK or rehash imported digests.
G2. No refresh model at all -> add identity.refresh_families, identity.refresh_tokens, identity.session_generations (columns in B3.1).
G3. No signing keys -> add identity.signing_keys(kid PK, environment, algorithm CHECK IN ('EdDSA'), public_jwk jsonb, private_ref text NOT NULL (a REFERENCE/secret-manager key, never key material in the row), state CHECK IN ('staging','active','retiring','retired'), created_at, activate_at, retire_at NULL, thumbprint text UNIQUE).
G4. No device registry -> add identity.devices (columns in B3.1).
G5. No realtime tickets -> add identity.realtime_tickets (B5.1). Note that monetization.reward_tickets is a DIFFERENT domain (ad rewards, 5-minute ticketLifetime plus a 24-hour callbackGrace, from src/monetization.js:5) and must not be reused or conflated [V].
G6. No readiness table is needed: wallet existence plus eligibility/privacy facts are authoritative (B1.1).
G7. No parallel core.actor_provisioning table is needed: existing outbox delivery coordination, deterministic Core outcomes and wallet/opening-ledger identities cover provisioning and replay.
G8. Durable signin attempts already bind session/provider/kind/intent/target/nonce/verifier/expiry and one-use state. Finish must revalidate that consumed attempt after external provider I/O; unlink/revoke invalidates actor-bound attempts across sessions. Add lifecycle metadata only if the concrete P05 protocol actually needs it. State/session digests retain the same explicit encoding boundary as G1.
G9. identity.email_challenges and identity.email_credential_versions are correctly modelled already [V]. Add: superseded_by text NULL for the chain, and keep the INNER-JOIN semantics explicit - a challenge with no version row must be unverifiable, matching EmailAuth.verify and matching recover() which consumes exactly those challenges [V]. credential_hash = sha256(actor + '|' + password_hash) hex must be reproduced verbatim.
G10. Retention/security events -> add audit.security_events(event_id PK, at, actor_id NULL, kind, detail jsonb, prev_hash, entry_hash) OR formally route these through support.events; P02 has no home for refresh-replay detection, ticket rejection or key rotation events, and operator_audit is operator-scoped [V]. Also add ops.rate_buckets.security_class boolean NOT NULL DEFAULT false so P06 keeps authentication/OTP budgets durable while moving ordinary rate budgets to Redis [D].
Not-a-gap (already correct in P02): identity.identities provider/subject/actor with PK(provider,subject) and UNIQUE(actor,provider); identity.email_credentials email PK + lower() UNIQUE with actor UNIQUE; identity.actors actor_id text PK; economy.ledger entry_id PK (which is what makes the opening grant idempotent); core.actor_occupancy (which serialises deletion against match entry).

=====================================================================
PART D - PERMANENT FACTS vs REDIS EPHEMERA
=====================================================================
PERMANENT AUTHORITY (PostgreSQL; owner-scoped policy deletion/retention still applies): actors, identities, email_credentials, email_credential_versions, sessions, refresh families/tokens, revocation metadata, devices, signing-key public parts + secret references, one-use realtime tickets, signin attempts, email challenges, security/audit events and authentication rate budgets. “Durable” does not prohibit the approved unlink/logout/privacy/expiry deletes.
EPHEMERAL (Redis, rebuildable, never authoritative): presence/heartbeat (today's session_presence is explicitly not migrated [V]), candidate queue indices and matching tickets, public/TTL caches and projections, non-security rate budgets, revocation HINTS (mx:<env>:v1:revoked:<session_id>, TTL = access TTL + 60 s), refresh single-flight locks, JWKS client caches, socket routing and connection registries, pubsub notifications, ticket negative caches.
Rule: a Redis wipe may only make the system more conservative. It must never resurrect a revoked session, re-enable a redeemed ticket, or allow a second starting grant. Every one of those three decisions is derivable from PostgreSQL alone [V spec 02 s6, ARCHITECTURE s State classes].

=====================================================================
PART E - FAILURE / REPLAY MATRIX
=====================================================================
1. Two concurrent signups, same email: email_credentials PK/UNIQUE + challenge consumption; second gets EMAIL_IN_USE, one actor, one 150-coin grant. [A08/A12]
2. Two concurrent provider logins, same subject: identities PK(provider,subject); second reuses the actor through finishVerified's found path [V].
3. Duplicate provisioning command: operation id 'provision:<actor>' + ledger id 'opening:<actor>' -> PK violation on replay, no second grant. [A09/A12]
4. Provisioning accepted but process dies before commit: outcome row absent, so a retry re-executes; the deterministic ledger id makes the effect idempotent.
5. Provisioning committed but response lost: Core returns the stored outcome on the same operation id; the client never invents a new key [V spec 03 s1].
6. Parallel refresh, same family: within grace -> same rotated outcome, no family revoke (reused_in_grace bounded at 3). [A13]
7. Refresh replay outside the contract: family revoked, generation bumped, audit + notice, SESSION_REVOKED on every descendant. [A13]
8. Refresh presented after logout: session row deleted and family revoked; SESSION_REVOKED even if an access token is still inside its 300 s validity for non-sensitive reads. [A13]
9. Revoked access token used on a sensitive op: durable session/generation check fails immediately. [A13]
10. Stale access token after key rotation: retiring key stays in JWKS >= 360 s; after that the token fails with UNKNOWN_SIGNING_KEY semantics, and the client refreshes. [A13]
11. Unknown kid (attack or clock skew): exactly one forced JWKS refresh with a >=60 s minimum interval, then reject. [V pattern in identity-provider.js keys(force)].
12. Wrong alg / alg:none / crit / jku / x5u: rejected by the header allowlist. [V pattern]
13. Wrong issuer or audience: rejected; service tokens and player tokens have disjoint audiences. [A23]
14. Ticket reuse on the same node, on another node, and after a Redis wipe: the WHERE redeemed_at IS NULL update wins once; the DB row is the only authority. [A14/A15]
15. Expired ticket: sweep marks expired; redemption returns TICKET_EXPIRED. [A14]
16. Ticket for the wrong session/environment/audience or a mismatched actor field: redemption refuses or the envelope guard returns FORBIDDEN. [A14]
17. Unauthorised match subscription: actor is never taken from the payload; membership is re-checked against match.participants. [A14/A17]
18. Ticket material in a log or URL: validateEnvelopeTransport rejects non-POST/non-JSON; redactTicket is applied at every log boundary. [A14]
19. In-flight signin_attempt after unlink/suspend: invalidated_at stops it; the attempt is one-use and 5-minute bounded anyway. [A13]
20. Email OTP used twice: consumed=1 + verified_at; second attempt INVALID_OTP. [V]
21. OTP replayed after a password change: credential_hash mismatch -> INVALID_OTP / RESET_NOT_AUTHORIZED. [V]
22. Brute force on an OTP: attempts>=5 -> OTP_LOCKED; the attempt counter is durable and survives a Redis wipe. [V]
23. Resend storm: 60 s cooldown per (session,email,purpose) plus per-session/per-address budgets; supersede consumes the old challenge. [V]
24. Deletion racing a match entry: actor row locked first, then occupancy; the loser gets ACCOUNT_BUSY or the command is refused. [A11/A16]
25. Deletion racing session issuance: admission disabled first; a racing bootstrap finds the actor non-serveable. [A07]
26. Suspend/hold while a socket is subscribed: generation bump closes subscriptions on the next authoritative check. [A13/A19]
27. Operator incident-lockdown: sessions deleted, attempts used, challenges consumed, outbox cancelled, audit appended atomically [V]; the V5 version must keep all five effects in one unit of work.
28. Redis total loss during queues and active games: assets, results, identity, tickets, revocations all intact; presence/queue/cache rebuild [A15].
29. Wrong-account reauth: REAUTH_ACCOUNT_MISMATCH; no session rotation, no identity change. [V test tests/community.test.js:31-34]
30. Second provider link onto an actor whose session changed mid-flight: ACCOUNT_CHANGED / requireCurrent hash check. [V email-auth.js requireCurrent]

=====================================================================
PART F - CONCRETE TTL / BOUNDS TABLE [D]
=====================================================================
| Item | Value | Note |
|---|---|---|
| Anonymous browser session | 1 day | preserved [V] |
| Linked browser/native session | 14 days | preserved [V], Max-Age 1209600 |
| Session cap per actor | 5 (existing slice(5)); V5 keeps 5 | [V/D] |
| Recent-auth window | 15 min | preserved exactly [V] |
| Access token TTL | 300 s | [D] |
| Max revocation delay, read-only | <= 300 s | [D] |
| Max revocation delay, sensitive/realtime/economic | immediate (durable check) | [D] |
| Service assertion TTL | 15 s | [D] |
| Realtime ticket TTL | 10 s unredeemed | [D] |
| Refresh same-family grace | 10 s, max 3 reuse-in-grace per family | [D] |
| Refresh single-flight lock TTL | 5 s, hint only | [D] |
| Refresh absolute lifetime | = session lifetime (14 d) | [D] |
| Signin attempt TTL | 5 min | preserved [V] |
| Email OTP TTL / cooldown / attempts | 600 s / 60 s / 5 | preserved [V] |
| JWKS cache max-age / min refresh interval | 300 s / 60 s | [D] |
| Retiring key residence | >= 360 s (operational >= 15 min) | [D] |
| JWKS size | <= 8 keys, <= 16 KiB | [D] |
| Outstanding unredeemed tickets per actor | 3 | [D] |
| Concurrent live realtime connections per actor | 4 | [D] |
| Envelope / snapshot / delta / error caps | 8192 / 262144 / 65536 / 1024 bytes | frozen [V realtime.js] |

=====================================================================
PART G - CROSS-SERVICE CALL CONTRACTS
=====================================================================
C1. API -> Core command. Transport: HTTPS to the private Core ingress with a short-lived Ed25519 service assertion in Authorization: Bearer <jwt>; iss=https://api.megaxo.online, aud='mega-core', sub='service:api_runtime', scope='command:player', plus actor, op (operation id), fp (canonical fingerprint) and jti. TTL 15 s. The jti is recorded in Redis with a 120 s TTL purely to shed obvious replays; the real replay defence is the durable core operation-outcome row keyed by the same operation id, which must be looked up BEFORE any stale-revision rejection [V DurableStore.run ordering]. Core then runs the existing validateInvocation guard with a principal it derives itself [V packages/contracts/invocation.js] and never trusts an actor, balance or outcome from the body.
C2. Core -> PostgreSQL ticket redemption. Core is granted EXECUTE only on a narrow SECURITY DEFINER function identity.redeem_realtime_ticket(p_ticket_hash text, p_connection_id text, p_node text, p_now timestamptz) RETURNS TABLE(actor_id text, session_id text, generation bigint, environment text, audience text, match_scope text), with SET search_path = pg_catalog, public and no dynamic SQL [D, per ARCHITECTURE's 'restricted functions... narrow, explicit-search-path and auditable']. Core has no direct INSERT/UPDATE/DELETE grant on identity.realtime_tickets, so A04's negative test (core cannot mutate credential tables except through the audited function) still holds.
C3. Core -> session/eligibility status. A read-only view core.actor_access_state(actor_id, session_id, generation, state, verified, suspended, security_hold, amr) granted SELECT to core_runtime, backed by identity.sessions + identity.session_generations + identity.eligibility. No credential columns (password_hash, salt, code_hash, verifier, nonce, refresh hashes) are exposed.
C4. API -> worker. Security notices (session revoked, provider linked/unlinked, refresh replay detected, email changed, password changed) are written as ops.outbox rows in the same transaction as the mutation, encrypted at rest exactly as v4_outbox is today [V MailOutbox.seal], and delivered by the worker with a stable business id (never a fresh UUID per retry).
C5. Native host -> API. Bearer-only: POST /api/account/native/token, /native/refresh, /native/logout. No cookie dependency; ambiguous cookie+bearer requests are refused. Never accepts an ID token as proof of a session; it only mints one after provider verification.
C6. Rules for all assertions. Separate key material and audiences from player tokens; rotate on a fixed schedule with an overlap window; never put an assertion in a client response; reject a token whose kid is unknown after one bounded JWKS refresh; and log only op/actor references, never raw tickets, refresh secrets or ID tokens.

=====================================================================
PART H - ACCEPTANCE HOOKS
=====================================================================
A12 (phases 5,20; shared actor identity): exercise login/link for email, Google and Apple across browser-style, Android and iOS; expect the same actor and permanent bindings, no email merge and no separate mobile account; evidence is actor-hash comparison plus real provider/device evidence, not raw tokens. Owner: V5-05-01, V5-05-04, V5-05-06.
A13 (5,13,20; refresh and revocation): race refresh, replay an old refresh, revoke a device and all devices, rotate keys with active sockets; expect a legitimate parallel retry to be handled, real replay/revocation enforced, and a bounded documented delay. Owner: V5-05-02, V5-05-03.
A14 (5,8; one-use realtime tickets): redeem concurrently on two nodes, replay after Redis loss, try a wrong session/environment/audience; expect exactly one valid redemption. Owner: V5-05-05.
Cross-cutting consumers: A04 role isolation (identity.* grants and the SECURITY DEFINER seam), A15 Redis total loss (tickets and revocation survive), A19 transport recovery (ticket + resume), A23 Vercel/Core ownership (forged or replayed service assertion with an altered actor/body), A24 retained browser compatibility (unchanged cookie/CSRF/callback behaviour and no shared-cookie fiction), A33 native bridge security (no token material in JS/web content, secure-store persistence).
EXPLICIT CORRECTION: the ticket text mentions 'A08/A09'. A08 is 'Deterministic restartable import' (phase 3) and A09 is 'Escrow and ledger' (phases 3,4); neither is a P05 acceptance hook. P05 only needs to avoid breaking them: its new tables must be importable deterministically (no constructors, no time rolling) and must not touch economy.ledger semantics.

=====================================================================
PART I - PROVIDER-PENDING ITEMS [P]
=====================================================================
P1. Google: native client IDs for the nativeAudiences list, iOS Google client id, and the exact registered redirect URIs for both api.megaxo.online and the retained origin; live PKCE acceptance on the token endpoint [P, config.js reads these from env].
P2. Apple: Service ID, Team ID, Key ID and private key for the web flow; Return URLs for both origins; confirmation that the web/native grouping and nonce treatment match the already-implemented server contract; real device proof [P].
P3. Neon: citext availability, role-creation capability, whether SECURITY DEFINER functions and explicit revokes are permitted on the current plan, and pooled-vs-direct connection semantics (session-level locks are not assumed) [V? per P02 s6].
P4. Managed Redis: no instance is provisioned; all ephemera decisions remain provisional until V5-06-01 records the real provider, region, command support and limits [P].
P5. Vercel: team/project, the api.megaxo.online domain and any retention of the old origin; current credentials are reported absent [P, V5-O009].
P6. Email: Resend key and sender identity for security notices; existing per-day/per-month mail budgets must be preserved [P].
P7. Signing-key custody: decide where the Ed25519 private keys live (Oracle sealed file with a documented rotation runbook vs a provider KMS); only the public JWK plus a key REFERENCE may live in the database [P/D].
P8. Real device acceptance for A12/A33 (physical iPhone/Android, signing identities) is not currently available [P, V5-O011].

=====================================================================
PART J - RISKS AND DECISIONS FOR THE PARENT
=====================================================================
R1. Finalize the concrete hash-only idempotent refresh protocol at P05 design freeze. Prove simultaneous callers, lost winning response, bounded retries and genuine replay without false revocation. No owner decision is needed to reject the erroneous claim that successor recovery is inherently impossible.
R2. Session/state hash encoding is resolved and reversible; preserve P03/P04 conversion and source credentials. Do not reopen G03, weaken constraints or force logout for this non-problem.
R3. Coordinated deletion is asynchronous and must say pending until Core/worker completes it; preserve confirmation/recent-auth/busy/privacy semantics and adapt affected consumers to truthful completion. Never return the old completed response prematurely just to satisfy an implementation-specific test.
R4. Adding identity.devices introduces a device identity the shipped client does not send; the retained browser client must keep working with device_id NULL and a browser-class session, so device revocation is native-only until the browser adapter emits one.
R5. The realtime ticket route must be added to packages/contracts/routes.js (and a realtime ticket DTO added next to the existing ticket validators), otherwise it becomes an undocumented route that the compatibility coverage test cannot see.
