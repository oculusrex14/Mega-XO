# Independent end-to-end audit - Hubble (Sol 6.1 xhigh) - 2026-10-16

Audited clean V5.2 at 3ddb06ae1d253c1d8ee253ab120d66367ec05d14, covering exactly:
- 1dde7dd - native session/transport fixes
- 5c87b2e - callback admission limiter and sendJson import
- 3ddb06a - documentation/checkpoint

OVERALL VERDICT: FAIL - changes required. The 13 requested suites pass (110 pass / 0 fail / 0 skip,
per-file runner, disposable-PG journeys executed not skipped), but native completion/race defects and
commerce integration failures remain. RELEASE RECOMMENDATION: block promotion of this range until the
P1/P2 findings are resolved and verified. No repo files were edited by the auditor; no deployment,
migration or production inspection occurred.

## 1. Native device fixes - FAIL

F1 (P1) The initiating refresh caller is never answered. MegaNativeSessionManager.kt:160 - only
callers entering while refreshing is already true enter pendingRefresh; the caller starting the
rotation is never registered and finishRotation answers only that list. Success, failure and the 15s
watchdog all lose the initiating callback. Inherited, but it directly breaks the new restore path:
restore marks answered=true before calling refresh(complete), disabling its own timeout response.
Native state can restore successfully while JS waits ten seconds and returns its original guest state
(an in-memory probe of the real account client reproduced nativeLinked=true, returnedLinked=false,
zero profile reads). The direct expiry-refresh path in src/account-client.js:125 has no JS timeout
and still hangs indefinitely.

F2 (P1) Generation checking protects gate release but not rotation execution or session mutations.
MegaNativeSessionManager.kt:175 - the 15s watchdog reopens the gate while the transport is still
active (until its own 20s watchdog) or while vault work remains blocked; a second rotation can start
and old queued vault work can dispatch another refresh request. An old generation cannot directly
release a newer gate (answer: no), but applyServerResponse runs BEFORE the generation check - an
abandoned rotation can still save credentials, install an old session, or process a terminal 401
against newer state. No lifecycle fence prevents a pending successful response from restoring state
after sign-out.

F3 (P2) Session watchdogs answer bridge callbacks from the wrong thread. MegaNativeSessionManager.kt:228,
MegaNativeApiBridge.kt:35 - the restore watchdog calls complete() directly and the rotation watchdog
invokes waiters directly; these reach reply.postMessage() without posting to the main thread, but
JavaScriptReplyProxy has a UiThread contract; the bridge swallows posting exceptions, leaving promises
outstanding.

F4 (P2) Two io threads do not bound vault operations or sign-in/sign-out completion.
MegaSecureSessionVault.kt:41, MegaNativeSessionManager.kt:253 - vault load/save/clear share one
synchronized monitor, so one stalled Keystore op holds the monitor and the second thread blocks behind
it; sign-out waits for vault clearing and sign-in waits for credential persistence, both without
operation deadlines - both can still hang indefinitely.

F5 (P2) Teardown can discard completions and leave session workers alive. MegaNativeHttpClient.kt:183,
MegaXOActivity.kt:243 - HTTP close() removes queued work and shuts down watchdogs without answering
pending callers; requests racing shutdown can throw executor rejections; timed-out queued requests are
retained and can transmit later. Activity destruction calls only sessionManager.clearLocal() and never
closes the manager executors; even the manager close() omits its watchdog executor.

Positive: ordinary HTTP execution has an atomic exactly-once completion guard; restore's fast path
avoids vault work; concurrent JS ensure() calls share loading; browser session/CSRF/logout matched the
baseline in a deterministic comparison probe.

## 2. Callback admission limiter - FAIL

Core design PASSES: independent 600-per-UTC-minute provider budgets, atomic ops.rate_buckets upserts,
purpose-separated HMAC identities, ignored forwarding headers, admission before gateway/signature
work, 429/Retry-After/no-store refusal, fail-closed storage errors. Four defects remain:

F6 (P1, inherited integration) Production POST callbacks never receive their request bodies.
v5-production-server.cjs:986, monetization.js:151 - the production listener passes a raw Node request
to the API handler; nothing reads the stream into req.body, but these routes require a string there.
Loopback probe with the REAL API handler: AdMob GET 200 (1 gateway call); AdMob POST 400
INVALID_SSV_PAYLOAD (0); Cashfree POST 400 INVALID_WEBHOOK (0); Polar POST 400 INVALID_WEBHOOK (0).
Admission ran first in all four cases. POST callbacks are unusable after the import fix.

F7 (P2) The IP parser accepts malformed literals and aliases them to valid addresses
(provider-callback-limit.js:73): ::ffff:192.0.2.256 -> 192.0.3.0; ::ffff:192.0.2.01 accepted despite
leading-zero rejection standalone; ::ffff:192.0.2. accepted; 1.2.3.4:: accepted (misplaced embedded
IPv4); arbitrary text after % is discarded. Embedded-IPv4 components bypass the standalone parser's
validation. Proxy auth still applies - not an unauthenticated bypass.

F8 (P2) Malformed CIDR config can WIDEN trust instead of failing closed (provider-callback-limit.js:134):
Number('') === 0 so 127.0.0.1/ silently becomes /0 (probe accepted a remote assertion under that
config); hex/negative-zero prefixes accepted; valid mapped CIDRs like ::ffff:127.0.0.1/128 fail
because canonicalization collapses the address before validating the prefix.

F9 (P2, inherited) GET SSV forwarding is not universally byte-preserving (monetization.js:107):
new URL(...).search normalizes legal query characters (probe: custom_data=abc'def ->
custom_data=abc%27def), changing signed bytes. The current test covers percent escapes but misses
this normalization.

## 3. sendJson fix - PASS (for the missing identifier)

monetization.js:23 supplies the missing identifier; no other undefined identifiers in the route file.
Mental revert is decisive: without the import the admitted and refused callback tests return false
instead of true and the missing-admission test throws while sending its error - all three route tests
genuinely detect the missing import.

F10 (P1, inherited integration) Several authenticated commerce routes still fail before reaching Core.
monetization.js:133, core-gateway.js:442 - Cashfree/Polar creation supplies key but no opKey; status
reads supply no opKey; the gateway requires opKey. Probe with the REAL route + REAL gateway:
OPKEY_REQUIRED, zero gateway fetches, handled=false for general status, cashfree order creation/
status, polar checkout creation/status. Generic claim (which supplies opKey) reached the gateway.
These fall through to the API 404. The memo's recorded dropped-fields + fetch-wrapper defects remain
open; fixing sendJson alone does not restore end-to-end commerce.

## 4. Secrets/hygiene - PASS-WITH-FINDINGS

No introduced credential material, OTPs, private keys or raw player records. The committed
proxy-secret string is explicitly a synthetic test fixture. readSecretFile (v5-production-server.cjs:160)
checks absolute paths, regular files, symlink refusal, descriptor permissions, bounded size; the proxy
secret is never printed; missing/unsafe secret files abort startup; missing proxy config defaults to
loopback trust, not unrestricted trust. F8 is the malformed-configuration exception.

F11 (P3) The checkpoint commits an owner account identifier and hardware identifiers
(CODEX-EXECUTION-BOARD-20261016.md:291) - use pseudonymous references and keep the mapping private.

F12 (P4) Proxy-key comparison leaks length, not key-byte prefixes (provider-callback-limit.js:168):
wrong-length values return before timingSafeEqual; equal-length mismatches use it. Comparing
fixed-size digests would remove the length distinction. Not a release blocker.

## 5. Test honesty - PASS-WITH-FINDINGS

Executed per-file with Node v26.8.2 and local PostgreSQL 16.15; every requested process exited
successfully. Counts: v52-provider-callback-rate-limit 11/0/0; v52-rate-limit 4/0/0;
v52-commerce-ingress 7/0/0; v52-polar-commerce 5/0/0; v52-polar-provider 4/0/0; v52-cashfree-v5
9/0/0; v51-v5-production-server 12/0/0; v5-migrations 11/0/0; v5-native-online-target 19/0/0;
native-smoke-target 3/0/0; monetization-store 13/0/0; monetization-policy 8/0/0;
account-deletion 4/0/0. TOTAL 110 pass / 0 fail / 0 skip; disposable-PG journeys executed, none
skipped. production-lifecycle.test.js reported 8 pass / 0 fail / 1 expected Linux-only skip but did
not exit after 150s (interrupted; the known child-leak quirk) - not counted as cleanly completed.

Coverage explains the green results: native concurrency checks largely inspect source patterns, the
JS host stub exposes no restore op, and callback route tests bypass real HTTP body streaming
(v5-native-online-target.test.js:209, v52-provider-callback-rate-limit.test.js:126).

## 6. Claims vs documentation - FAIL

F13 (P2) Checkpoint 23 overstates completion guarantees (board:293): "all caller-visible waits are now
bounded" is false under F1/F4/F5; two io threads do not bypass the vault monitor; restore is NOT once
per process (two successive guest session() calls invoked restore twice in the client probe); the 423ms
observation does not establish completion of the new initiating JS restore path. Test counts match the
audit; Decision 2 is accurately open; Decision 1 is implemented but does not fully satisfy
canonicalization/integration requirements.

P3 provenance: the documents cite ff14dbc/0e3c486, neither an ancestor of HEAD (post-rebase);
stable patch IDs match 1dde7dd/5c87b2e - record the mapping.

## Minimal required follow-up

1. Repair native callback ownership (answer the initiating rotation), fence stale work before
   dispatch/persistence/session mutation, and make deadlines + teardown settle every operation on the
   main thread.
2. Add bounded HTTP body reading after admission, preserve exact callback bytes, and fix commerce
   opKey propagation alongside the recorded gateway/provider transport defects.
3. Reject malformed IP/CIDR inputs and preserve GET SSV query bytes without URL normalization.
4. Add executable race/restore/teardown + real HTTP/gateway regression coverage; correct the
   checkpoint guarantees and commit mappings.

