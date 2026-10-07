# Identity, API and client compatibility contracts

Applies to Phases 1, 5, 8, 11, 13, 18, 20 and 22. Preserve existing client-visible account flows; these changes are transport and service-boundary work.

## 1. Permanent identity and account lifecycle

Mega XO actor IDs remain the application primary identity. Google and Apple subjects are exact linked-provider credentials, never replacement actor IDs. Do not merge by email or create a separate native account namespace. Keep existing link/unlink, recovery, recent-auth and session/device semantics. Preserve provider audience/issuer/signature/nonce/state/PKCE verification and explicit authorized-party checks. Apple web/native grouping and nonce treatment must match the already implemented server contract [R06].

Account creation needs a single idempotent workflow: account service creates the permanent actor/identity in a pending-ready state, requests Core-owned initial-wallet provisioning, then exposes a ready account. Retry and cancellation cannot create two actors or issue starting currency twice. A user may authenticate while a provisioning retry is pending, but the adapter should preserve existing loading/error behavior rather than invent a new onboarding screen.

Deletion first prevents new competitive enrollment and session use, then follows the existing approved eligibility, privacy and retained-record behavior. A deletion racing a match entry must serialize against actor state/occupancy. Do not cascade-delete evidence needed to verify a purchase, financial settlement or retained audit policy; do not retain unnecessary identifying data outside approved policy. Restores must reapply deletion/tombstone controls before serving users.

## 2. Access, refresh and revocation

Use asymmetric signed short-lived access credentials with strict issuer, audience, allowed algorithm, key ID, issue/expiry and minimal actor/session/scopes/auth-time claims. Never put wallet/rank values into the token as authority. Publish a bounded JWKS cache; rotate with overlapping verification keys and test unknown/retired-key behavior. Tokens for a player API are not service/admin tokens.

Store refresh credentials as hashes with durable session/family/rotation metadata. Define expiry, reuse detection, device revocation and all-device logout. Native clients and the browser session layer must single-flight refreshes. A bounded, carefully tested concurrent-refresh retry mechanism may return the same rotated outcome to the same legitimate request; do not treat ordinary parallel requests as evidence to revoke an entire family. A true replay outside the accepted rotation contract revokes/alerts according to the existing security policy.

Local signature validation avoids an identity-database lookup on every read, but does not by itself provide immediate revocation. State the maximum revocation delay, and validate authoritative session/account status for sensitive economic/identity operations. Push revocation hints through Redis, backed by durable session generation/version; loss of hints cannot resurrect a revoked session. Test existing WebSockets after logout, suspension, account deletion and key rotation.

Set concrete TTLs and budgets in a versioned configuration ADR after measurement. Suggested design starting point, not an existing product rule: access measured in minutes, service assertions/tickets measured in seconds, existing device-session lifetime preserved unless explicitly migrated. Never hide security or latency changes in default library settings.

## 3. Browser and native storage are deliberately different

**Browser:** host-only Secure HttpOnly refresh/session cookie, SameSite policy, exact Origin checks and CSRF protection on cookie-authenticated writes. Use `Cache-Control: no-store` for private account/session responses. Return only the existing safe session/profile shape to the client. The old `__Host-mega_session` at `play.antimatterinnovations.com` cannot be shared with `api.megaxo.online` by setting a broad cookie domain.

**Android:** the native host holds tokens. Store the refresh blob encrypted with a key held in Android Keystore; the Keystore holds a cryptographic key, not an arbitrary raw token value [E14]. Exclude sensitive session material from backup/restore and clear/revalidate stale installation state. Keep access tokens in host memory where practical.

**iOS:** the native host owns access/refresh lifecycle and stores the refresh secret in Keychain with a deliberately chosen device-only accessibility policy. Handle reinstall/restore and protected-data-unavailable cases without inventing a new actor. Do not keep provider tokens or refresh credentials in localStorage or JavaScript preference files.

Native bearer endpoints do not depend on a WebView cookie jar or browser CSRF token. A browser Origin header is not proof a request came from a genuine mobile app. Separate cookie and bearer credential resolution and reject conflicting ambiguous credentials; keep strict browser Origin/CSRF enforcement rather than globally disabling it for native compatibility.

## 4. Compatibility facade and route inventory

Generate a complete route manifest from `server/production/perimeter.js`, `community-http.js`, `http.js`, `party-http.js`, `monetization-http.js`, provider notification handlers and static legal routes. Every entry needs method, current auth/CSRF, request/response shape, side effects, future owner, timeout/retry, cache class, idempotency and compatibility test.

Known groups from [R16,R21]:

| Group | Intended owner and handling |
|---|---|
| `/api/account/session`, login/email/recovery/link/unlink, sessions/revoke | Vercel Account/API, equivalent existing semantics |
| `/auth/callback/google`, `/auth/callback/apple` | Account service on exact registered origin; retain old callback compatibility |
| `/api/account/native/challenge`, `/finish` | Account service with explicit native bearer/challenge flow while preserving bridge intent |
| `/api/account/profile`, `/save`, `/export`, `/delete` | Account/API; privacy work delegated durably where needed |
| `/api/community/friends`, `/search`, `/profile/*`, `/friend`, `/report` | Account/API; privacy-aware read models and transactional social state |
| `/api/community/presence` | Platform auth plus ephemeral Redis presence |
| `/api/v1/queue`, `/cancel-queue`, `/offer`, `/accept`, `/decline`, `/cancel`, `/move`, `/resign` | Game Core, whether reached by legacy HTTP facade or realtime |
| `/api/v1/convert`, `/quest`, `/cosmetic`, `/purchase` | Core-owned economic commands; no direct Vercel wallet updates |
| `/api/v1/profile`, `/match/*`, invitations/challenges | Authorized projections, with any lazy expiry/tick delegated to Core |
| `/api/party/*` | Core-owned rooms/tournaments; preserve separate free LAN bearer behavior |
| Monetization/provider callbacks | Exact existing route inventory required; verify/persist/dedupe then Core processing |
| Operator/metrics | Private Tailscale/loopback only, never public Vercel routing |

`/api/v1` is already in use. Preserve its schema or introduce an explicitly new version for incompatible contracts. A new internal `/realtime/v1` schema may coexist. Do not derive future API names from this example and silently remove current routes.

The current queue/match GETs can mutate timeouts or matchmaking [R16]. Their V5 replacement must be either a genuinely read-only snapshot backed by Core timers or a compatibility handler that delegates the authoritative action to Core. The API database role must not acquire competitive write power because of a misleading HTTP verb.

## 5. Shared client adapter

Retain the `MegaAccount.request/session/peek/reset/id/connectivity` surface [R17]. Preserve player-safe error names, `MX-...` support IDs, no-overlap polling and one stable operation key across retries. Refactor its transport dependency so browser mode uses its same-origin session facade and native mode sends through the host's allowlisted HTTP bridge. Keep safe public response shapes; no transport or credentials should leak into UI rendering code.

Audit direct `fetch` calls in app/community/party/monetization controllers; the existing party POST monkeypatch is not sufficient for arbitrary native origins. Centralize only the required requests and preserve the LAN authorization branch. Add contract tests for offline, maintenance, timeout, expired/revoked session, retry and concurrent refresh. Preserve the existing connection banner's theme and scroll placement.

## 6. Realtime ticket and protocol

The authenticated API issues a short-lived, audience-bound, one-use realtime ticket associated with actor, session, environment and expiry. Recommended baseline: store a hash and atomically redeem in PostgreSQL so replay remains rejected after Redis loss. Admission is bounded; do not put refresh tokens in a WebSocket query string. If a ticket transport involves URLs/subprotocols, explicitly redact it at every proxy/log boundary.

Core authenticates before joining any match subscription. Actor identity in the payload is ignored for authorization or must equal the authenticated actor; match membership and account/session status are checked independently.

Proposed shared command envelope:

```json
{
  "protocol": "realtime/v1",
  "operation_id": "stable-client-generated-key",
  "match_id": "existing-text-match-id",
  "expected_revision": 17,
  "command": {"type": "move", "move": {"board": 2, "cell": 4}}
}
```

The nested move example is illustrative: derive the exact board/cell shape and indexing from current game contracts before freezing it. An envelope must not inadvertently change the existing legal-move representation.

Responses include operation identity, committed revision, safe snapshot/delta and server time. Duplicate operation with the same canonical payload returns its previous result; reused key with a different payload is a conflict; stale revision triggers a snapshot refresh, not a guessed reapplication. On reconnect, exchange last acknowledged revision, return any available bounded delta or a full latest snapshot, and resubscribe. Revision gaps are normal recoverable delivery events. Retain HTTP polling fallback against the same authority.

## 7. Identity acceptance matrix

Prove the same actor through email, supported Google and Apple flows on browser-style harness, Android and iOS. Cover cancel, bad nonce/state, wrong audience, already-linked identity, wrong-account reauth, expired refresh, concurrent refresh, session revoke, reinstall and provider revocation. Verify friend graph, saves, wallet, purchases and ranks are current across clients without platform-specific synchronization jobs. Device proof must include actual provider UI, not only fixtures.
