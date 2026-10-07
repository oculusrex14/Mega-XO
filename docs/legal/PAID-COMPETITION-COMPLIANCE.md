# Mega XO P1-7 paid competition compliance design

Status: **IMPLEMENTATION SAFEGUARDS COMPLETE; PAID ENTRY REMAINS DISABLED**  
Research snapshot: 2026-10-07

This document is a technical/legal handoff, not a legal opinion. The production server must continue to reject `MEGA_PAID_ENTRY_ENABLED=true` until EXT-26 is completed with written legal/platform approval and the approved model is implemented.

## 1. Current platform and India constraints

### Apple App Store

Current Apple App Review Guideline 5.3 says, among other things:

- sweepstakes and contests must be sponsored by the app developer;
- official rules must be presented in the app and must state that Apple is not a sponsor or otherwise involved;
- apps may not use Apple In-App Purchase to buy credit or currency used with real-money gaming;
- real-money gaming apps must have the required licenses/permissions where used, must be geo-restricted to those locations and must be free on the App Store.

Official source: https://developer.apple.com/app-store/review/guidelines/

Technical consequence for Mega XO: Apple only creates this IAP prohibition when the feature is classified as **real-money gaming**. Mega XO Crowns have no cash-out or real-world redemption, so the repository no longer applies a blanket purchased-Crown ban. Instead, iOS purchased-Crown entry is allowed only when the approved jurisdiction policy explicitly includes `ios` in `purchasedEntryPlatforms` and records an Apple review/approval reference. A real-money-prize model remains separately prohibited.

### Google Play

Google Play's current Real-Money Gambling, Games, and Contests policy generally prohibits real-money gambling/gaming except specified licensed/approved categories. Approved gambling apps must be free, cannot use Google Play In-app Billing, must block minors and unauthorized geographies, and must meet licensing/application requirements.

For other real-money games, contests and tournament apps, Google says it does not allow users to wager/stake or participate using real money, including in-app items purchased with money, to obtain prizes of real-world monetary value, outside the stated exceptions/pilots.

Official source: https://support.google.com/googleplay/android-developer/answer/9877032

Technical consequence for Mega XO: Google Play's quoted prohibition is tied to obtaining a **prize of real-world monetary value**. Closed-loop Crowns with no cash-out are not treated by the repository as automatically prohibited. Android purchased-Crown entry still requires explicit jurisdiction/platform approval in `purchasedEntryPlatforms`; any real-world-prize model remains a separate Google approval/legal path.

### India

The Promotion and Regulation of Online Gaming Act, 2025 (Act 32 of 2025) came into force on **1 May 2026**. The Online Gaming Authority of India (OGAI) was constituted in April 2026.

The Act:

- defines an online money game irrespective of whether it is based on skill, chance, or both;
- defines "other stakes" to include credits, coins, tokens or similar real/virtual things purchased with money directly or indirectly or in relation to an online game;
- prohibits online money games and online money gaming services;
- separately defines an "e-sport" that, among other conditions, is recognised under the National Sports Governance Act, registered with the Authority, is determined solely by player skill, may charge registration/participation fees solely for entering/administrative costs and may include performance-based prize money, but **must not involve bets, wagers or other stakes**.

The final 2026 Rules direct OGAI to examine, among other things, whether fees/deposits are genuine registration/participation/administrative fees or are instead bets/wagers/stakes and how prizes/benefits/in-game assets can be transferred or monetised.

Official sources:

- Act: https://www.meity.gov.in/static/uploads/2025/10/8a7f103cefc68ed8aaa2ebc9a2ed7c13.pdf
- 2026 Rules: https://www.meity.gov.in/static/uploads/2026/04/7e0b02d37fd07f81fa48578a9996aa85.pdf
- commencement notification: https://www.meity.gov.in/static/uploads/2026/04/089ca9904b13f019b41a391584ab10ea.pdf
- OGAI: https://www.meity.gov.in/ministry/our-organisation/details/online-gaming-authority-of-india-ogai-MzNxgjMtQWa

Technical consequence for Mega XO: **the current player-funded Crown/entry pools are not treated as an India-compliant e-sport registration-fee model. India remains denied unless Antimatter Innovations obtains the required recognition/registration and an approved implementation satisfies that determination.**

## 2. Current Mega XO mechanics: compliance classification

### Ranked Coin queue

Current ranked queue:

- charges equal Coin contributions from both players;
- creates a player-funded pool;
- retires part of the pool and pays part back according to the match result.

Repository classification: **pooled stake**.

Production status: **disabled while `MEGA_PAID_ENTRY_ENABLED=false`**.

### Direct ranked Crown challenge

Current direct ranked challenge:

- challenger funds the Crown pot;
- 50% is retired;
- 50% is paid to the winner.

Repository classification: **pooled stake**.

Production status: **disabled**.

### Public tournament tables

Current Low/Medium/High/Premium public tournament tables:

- collect ten player entries;
- form a pool directly from those entries;
- retire 10%;
- distribute the remainder as placement payouts.

Repository classification: **pooled stake**.

Production status: **disabled**.

The CI command `npm run competition:audit` mechanically asserts that all of these remain classified as pooled stakes and remain denied by the future-compliance baseline.

## 3. Purchased-currency provenance and policy control

P1-7 keeps explicit server-side provenance for money-purchased virtual currency, but provenance is no longer a global eligibility blocker.

New account fields:

- `purchasedCrowns`
- `purchasedCoins`
- `legacyCompetitionRestricted`

Behavior:

1. Apple/Google Crown purchases increase both the visible Crown balance and `purchasedCrowns`.
2. Crown -> Coin and Coin -> Crown conversion carries purchased provenance with it.
3. Spending updates the tracked provenance so the service can tell how much of a balance originated from store purchases.
4. Ranked/direct/tournament eligibility receives that funding context and the **jurisdiction/platform eligibility policy** decides whether purchased value is accepted.
5. Where a market approves purchased virtual entry, bought and earned Crowns are treated the same for entry purposes.
6. Where a market does not approve it, the policy denies the entry before funds move.
7. India is deliberately configured as a no-purchased-virtual-entry jurisdiction until product-specific legal/OGAI approval resolves the statutory `other stakes` issue.

This preserves the product value of Crowns without making a single global legal assumption.

## 4. Approved future model: registration fee, never pooled stake

The current stake model is not the model recommended for any future launch.

Any future P1-7 implementation should use a separate **registration-fee competition model**:

- entry/registration fee is fixed and disclosed before entry;
- entry fee is not placed into a player prize pool;
- prize schedule/value is fixed independently of the number/value of player entries;
- prizes are funded by Antimatter Innovations/sponsor budget, not entrant stakes;
- no player can increase the prize by staking more;
- no side bets, challenger-funded pots or head-to-head stakes;
- no cash-out or transfer of Mega XO virtual currency;
- real-world/cash prizes remain disabled unless a separate platform/legal implementation is approved;
- refunds, cancellations, voids and technical failures have explicit rules;
- official competition rules identify Antimatter Innovations as sponsor/organizer and, where relevant, state Apple/Google are not sponsors.

The current `server/competition-compliance.js` deliberately approves only this narrow registration-fee shape. It refuses:

- pooled stakes;
- player-funded prize pools;
- cash-out;
- real-world prizes in the baseline implementation.

A later legal decision to permit any of those requires a reviewed code change, not merely a configuration edit.

## 5. Jurisdiction gate

Paid competition must be **allowlist-only**.

Server eligibility must use a trusted location determination and must never rely on:

- the player's profile country;
- locale/language;
- App Store/Play Store country alone;
- a client-supplied country;
- a checkbox stating "I am in an allowed location."

The compliance engine requires:

- ISO country;
- optional state/territory/subdivision;
- server-trusted location status;
- proxy/VPN/risk signal;
- jurisdiction-specific legal review ID;
- platform allowlist.

Unknown, conflicting or high-risk location means deny.

### India

An India policy entry additionally requires:

- classification as a recognised e-sport;
- National Sports Governance Act recognition identifier;
- OGAI registration identifier;
- jurisdiction-specific legal review.

Those values do not exist today, so India remains denied.

## 6. Age gate

Mega XO's conservative product baseline is **18+ for any paid registration-fee competition**.

The server compliance engine requires a verified age assertion. A self-declared date of birth or client boolean is not sufficient for paid competition.

The future age provider should return the minimum information needed, ideally an age-over-threshold assertion plus verification timestamp rather than retaining unnecessary identity documents.

Verification older than one year is treated as stale by the current compliance engine.

Any jurisdiction that requires an age greater than 18 can configure a higher minimum after legal review.

## 7. Platform-specific gate

Policy is platform-specific.

### iOS

- iOS purchased virtual entry is allowed only when that jurisdiction explicitly lists `ios` in `purchasedEntryPlatforms` and provides the required Apple review identifier. This is separate from any real-money-prize approval.
- Any feature Apple treats as real-money gaming requires the Apple licensing/geo/free-app conditions in addition to local law.
- Contest rules must be available in-app and state Apple's non-involvement.
- Do not assume an approved web model is automatically App-Store compliant.

### Android / Google Play

- Play-Billing-funded real-money competition is not an approved path.
- Any real-world-prize model must undergo a separate Google Play eligibility/approval analysis.
- Do not assume a legal web contest is distributable through Google Play.

### Web

Web does not remove gambling/contest/consumer-law obligations. It simply removes App Store/Play distribution rules from that channel. Jurisdiction, age, payment, tax, consumer, AML/KYC and advertising rules still require review.

## 8. Spending and harm protections

Before any paid registration-fee implementation is wired to users, the server must enforce policy-defined controls such as:

- daily entry-spend cap;
- daily net-loss cap where legally relevant;
- maximum per-entry fee;
- cooling-off period;
- voluntary self-exclusion;
- hard account hold support;
- no credit/negative balance;
- no automatic re-entry;
- no auto top-up;
- no loss-chasing prompts;
- clear entry fee and prize terms before confirmation;
- deterministic refund on service cancellation;
- separate fraud/collusion review for suspicious outcomes.

The current compliance engine already requires daily entry/loss context and can enforce caps, but no real paid-registration transaction path is connected yet.

## 9. Fraud, collusion and competitive integrity

Legal approval does not replace anti-abuse engineering.

A paid competition launch requires:

- authoritative server gameplay;
- exact idempotency on entry/reservation/settlement/refund;
- no client-submitted winner;
- anti-collusion/pair-repeat controls;
- multi-account/device/payment risk rules;
- bot/solver detection and enforcement process;
- tamper-evident operator actions;
- dispute and appeal process;
- retained evidence consistent with the approved privacy/retention policy.

P1-9 remains the deeper abuse-testing track.

## 10. Tax, KYC/AML, prize reporting and funds handling

These are unresolved external legal/compliance decisions.

For each allowed jurisdiction, counsel/payment providers must determine:

- whether participant identity verification/KYC is required;
- whether AML/sanctions checks are required;
- whether prize/tax reporting applies;
- whether participant funds must be segregated;
- whether unclaimed prizes/fees have special treatment;
- permitted refund/chargeback handling;
- whether Antimatter Innovations needs a gaming/contest/esports licence or registration;
- whether a payment provider permits the activity.

Do not build a generic "KYC completed" client field and treat the problem as solved.

## 11. Required approval artifact before enablement

EXT-26 may only be marked complete when the repository has a signed-off policy containing, for every allowed jurisdiction:

- country/state/territory;
- legal review identifier/date/counsel;
- exact competition model;
- minimum age;
- allowed platforms;
- regulator/licence/registration identifiers where required;
- approved payment rail;
- approved prize type;
- entry/spend/loss limits;
- geolocation requirements;
- KYC/AML/tax requirements;
- official-rules version;
- refund/void policy;
- responsible-spending/self-exclusion policy;
- effective and expiry/re-review dates.

The server must consume the approved facts; the app must not infer them.

## 12. Current release decision

For V4.1:

```text
MEGA_PAID_ENTRY_ENABLED=false
```

remains mandatory.

Store purchases, once enabled under their own P0 gates, **may** fund Crown/derived-Coin competition entry in jurisdictions/platforms whose approved policy explicitly permits purchased virtual entry. This does not override the separate pooled-stake, age, geo, or India restrictions.

The existence of dormant stake mechanics is not authorization to expose them.
