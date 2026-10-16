# LR21 review pass - owner-reported fixes, power-up Crowns, premium pass (2026-10-16)

Lane: Codex app. Base: V5.2 e25d7f5 (board checkpoint 26). Trunk commits this pass:
**f02f3ec** (owner-reported fixes + crown-banked power-ups) and the premium-pass commit on top.

## Owner-reported items and their resolution

| # | Report | Resolution |
|---|---|---|
| 1 | "ad consent is not available here" blocks power presses | Owner rule: install = implicit ad consent. Android now treats UMP's persisted consent status as authoritative (MegaAndroidAds.canRequestAds no longer requires updatedThisLaunch) and gathers consent at bridge install, so a first-session press never sees a false CONSENT_UNAVAILABLE. Copy changed to point at the Crown fallback. |
| 2 | Powers need a Crown path when ads are unavailable | MegaPowers.purchase(kind): Undo 2 Crowns, Hint 3 Crowns. Debit is idempotent on the device save wallet (D.spendCurrency, convert()-style operation ledger); the charge is banked only after the debit succeeded, so Crowns can never be taken without a charge landing. Pressing a power with no ad lane now offers the purchase instead of a dead-end toast; the Store lists both charges. |
| 3 | "Host on this Wi-Fi" -> "fullbutton is not defined" | src/party-ui.js called app.js's fullButton from its own IIFE scope. A module-local fullButton now exists; the crash is gone. |
| 4 | "Rewards and theme" should be "Store" | All user-facing strings renamed (home entry, quests entry, page header + kicker, wallet/settings sheets, loading fallback). Route id stays 'rewards'. |
| 5 | Home: Daily quest, Store, Save your progress each boxed, in order | home() now owns three .home-section cards in that order; the old decorate()-appended entries were removed and the community layer reconciles the account card in place (no duplicate CTA, no re-render loop). |
| 6 | Android needs Sign in with Apple | NOT landed this pass - see the account-link section: both need the same server decision flow, so they are sequenced together next lane. |
| 7 | Google sign-in created a brand-new account; want the email-match prompt + 30-day old-profile deletion | Spec'd, not landed this pass (auth-touching; deliberately not rushed) - see below. |
| 8 | Staging not visible on 4195 | Rebuilt and serving: http://127.0.0.1:4195 from .artifacts/lr21-review-web (source_commit f02f3ec, bundle sha256 9e57abd6...). |

## Premium pass

Mega Pass is defined as the owner-approved premium-pass ENTITLEMENT (not stored value):
one-time purchase, removeAds forever, structural revoke-on-refund identical to remove_ads.
Landed: src/monetization.js PRODUCTS entry (id mega_pass, once, suggestedUSD 4.99) and
packages/services/commerce.js entitlement projection (removeAds also granted by mega_pass).
Every provider lane validates through M.product(), so Cashfree/Polar/Play/StoreKit all accept it
once the price exists. Still external (dashboard/config, no code left): create the product in
Play Console / App Store Connect (id mega_pass), add the Polar price UUID to the polarCatalog env
(and/or Cashfree catalog price), and surface it on the web checkout listing.

## Verification

- Per-file runner (node tests/X.test.js): domain 32/32, gameplay-rewind 15/15, community 18/18,
  monetization-policy 8/8, monetization-store 13/13, v52-commerce-ingress 7/7,
  v52-polar-commerce 5/5, v52-polar-provider 4/4, v52-cashfree-v5 9/9.
- Pre-existing, NOT caused by this pass: tests/cashfree-web-checkout.test.js and
  tests/production-lifecycle.test.js hang at process exit (child leak) after all assertions pass -
  verified on a clean tree via stash. LR02 should note the flaky-exit suites.
- Device: OnePlus 5199676e updated to online-debug versionCode 8 (1.0.0-lr21.0) via
  adb install -r; gradle 8.14.6 (/opt/homebrew/opt/gradle@8) + JAVA_HOME 17.0.20.1 - the default
  homebrew gradle 9.8.1 is INCOMPATIBLE with AGP 8.x (InternalProblems removed).

## Account-link flow (decided design, next lane's first item)

Decided UX (owner): on a provider sign-in whose VERIFIED email matches an existing account,
prompt: "We found an account associated with this email" with two options - log in to that
account, or create a new profile; creating a new profile warns that the old profile will be
deleted and the old profile is scheduled for deletion 30 days later. Polish wording via Sol.

Implementation plan (auth-touching, so it lands as its own reviewed commit):
1. server/identity-provider.js verify(): return the provider-verified email alongside
   {provider, subject} (Google: only when email_verified; Apple: id_token email). The current
   "intentionally no email" comment is superseded by the owner decision - keep it minimal:
   verified email only, used solely for match/prompts, displayed masked.
2. Migration 0059: identity.signin_attempts decision columns (decision_email, decision_actor,
   decision_expires) + identity.identities.verified_email; extend the owner-read secret functions
   (0039 pattern) accordingly. Mirror in the SQLite legacy schema (server/community-store.js).
3. packages/services/accounts.js finishVerified(): when no (provider,subject) actor exists, the
   attempt intent is 'login', and the verified email matches an existing account (email_credentials
   OR identities.verified_email), do NOT create anything: persist the decision onto the consumed
   attempt row and return {choiceRequired, state, maskedEmail, existing:{tag, username}}. Add
   decide(token-less, {state, choice}) - single-use, expiry-bounded, session-bound: 'link'
   attaches the identity to the existing actor (existing account wins, primary button);
   'new' creates the fresh actor and schedules the OLD actor's deletion at now+30d via the
   coordinated-deletion path (outbox row + scheduled sweep in the maintenance loop).
4. Routes: POST /api/account/decision (web, session+CSRF) and the native decision leg on
   /api/account/native/token's response contract ({choiceRequired} instead of tokens, then the
   decision call presents the bootstrap sessionToken). community-http callback renders the choice
   page; src/community.js renders the dialog with the Sol-polished copy.
5. Android: MegaAndroidIdentityBridge surfaces choiceRequired as a native two-button AlertDialog,
   then finishes the grant. iOS follows when the iPhone lane reopens.
6. Tests: email-match choice, link path, new-profile path + 30-day scheduling, expiry,
   single-use, and "no prompt when the provider identity already exists".

Anti-abuse notes: the prompt only ever fires on PROVIDER-VERIFIED emails (never self-reported),
the decision record is single-use and expires with the attempt TTL, and 'link' requires the
identity to be unattached (it always is, or no prompt would have fired). Masked email only ever
crosses the wire.
