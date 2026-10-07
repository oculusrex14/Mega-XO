# P1-7 paid competition approval checklist

Status: **OPEN — do not enable paid entry**  
Owner: Antimatter Innovations  
Technical reference: `docs/legal/PAID-COMPETITION-COMPLIANCE.md`
Rules drafting reference: `docs/legal/COMPETITION-RULES-TEMPLATE.md`

This checklist is the evidence package required before EXT-26 can move from BLOCKED.

## Product model

- [ ] Confirm the old Ranked/direct/public-tournament **pooled stake** model will not be used for paid competition.
- [ ] Define one fixed registration/participation fee per approved competition class.
- [ ] Define prizes independently of participant entry collections.
- [ ] Confirm Antimatter Innovations or an approved sponsor funds the prize schedule.
- [ ] Confirm no side bets, player-created stakes, variable pots or winner-takes-other-player-funds behavior.
- [ ] Confirm Mega XO currency has no cash-out, transfer-to-user or redemption for real-world value in the approved baseline.
- [ ] For each jurisdiction/platform, explicitly decide whether store-purchased Crowns/derived Coins may fund closed-loop virtual-currency entry; missing approval means deny.
- [ ] Approve cancellation, technical-failure, no-show, disqualification and refund rules.

## Jurisdiction matrix

For **every** country and, where relevant, state/territory:

- [ ] legal-review identifier and date;
- [ ] reviewer/counsel;
- [ ] allowed competition type;
- [ ] minimum age;
- [ ] licence/registration/permit identifiers;
- [ ] approved payment rail;
- [ ] approved prize type;
- [ ] tax/prize-reporting treatment;
- [ ] KYC/identity-verification requirement;
- [ ] AML/sanctions requirement;
- [ ] required geolocation accuracy/frequency;
- [ ] VPN/proxy/location-conflict handling;
- [ ] responsible-spending obligations;
- [ ] self-exclusion/cooling-off obligations;
- [ ] advertising restrictions;
- [ ] record-retention requirements;
- [ ] legal re-review/expiry date.

No jurisdiction is allowed by inference. Missing row = denied.

## India

Before allowing any paid-registration competition in India:

- [ ] obtain product-specific Indian legal advice under the Promotion and Regulation of Online Gaming Act, 2025 and current Rules;
- [ ] confirm whether Mega XO qualifies for the e-sport route;
- [ ] obtain the required National Sports Governance Act recognition;
- [ ] obtain OGAI registration/determination as applicable;
- [ ] record the official identifiers in the server policy;
- [ ] prove the fee is registration/participation/administrative rather than a stake/wager;
- [ ] prove prize funding is not an entrant pool;
- [ ] confirm current OGAI codes/advisories/user-verification requirements;
- [ ] confirm tax/payment-provider requirements;
- [ ] validate the exact web/iOS/Android distribution model separately.

Until all rows pass, India remains denied.

## Apple App Store

- [ ] product-specific review against current App Review Guideline 5.3;
- [ ] official competition rules available inside the app;
- [ ] rules name Antimatter Innovations as sponsor/organizer;
- [ ] rules expressly state Apple is not a sponsor or involved;
- [ ] if iOS purchased-Crown entry is intended, obtain product-specific Apple review/legal approval for the closed-loop model and record the review identifier; never use IAP currency with a real-money-prize model;
- [ ] if Apple classifies the model as real-money gaming, obtain every required licence/permission and configure runtime georestriction;
- [ ] confirm app remains free if required by the applicable Apple rule;
- [ ] App Review notes contain the model, jurisdiction controls and supporting documents;
- [ ] written App Review acceptance or other retained approval evidence where applicable.

## Google Play

- [ ] product-specific review against current Real-Money Gambling, Games and Contests policy;
- [ ] confirm whether the proposed model is distributable on Google Play at all;
- [ ] do not use Play Billing as a real-money gaming funding path;
- [ ] if a Google-approved licensed category is involved, complete Google's application/approval and licence requirements;
- [ ] block minors and unauthorized locations where policy requires;
- [ ] use the required age rating and responsible-gaming disclosures if applicable;
- [ ] retain written approval/evidence for the actual app/model/jurisdictions.

## Age verification

Technical baseline is 18+, but law/platform policy may require higher.

- [ ] choose age-verification provider/method;
- [ ] server receives a verified assertion, not a client boolean;
- [ ] minimize retained identity material;
- [ ] define verification validity/recheck interval;
- [ ] define mismatch/appeal path;
- [ ] update Privacy Policy/data inventory/store declarations.

## Trusted geolocation

- [ ] choose server-side geolocation/risk provider or equivalent trusted method;
- [ ] country/state determination occurs before entry;
- [ ] do not trust profile country, locale or store country alone;
- [ ] define VPN/proxy detection;
- [ ] define location-conflict handling;
- [ ] re-check location at the legally required cadence;
- [ ] keep only retention-minimized compliance evidence.

## Spend and harm controls

- [ ] maximum entry fee;
- [ ] daily entry-spend cap;
- [ ] daily/weekly loss cap if applicable;
- [ ] cooling-off control;
- [ ] voluntary self-exclusion;
- [ ] hard account hold;
- [ ] no negative balance or credit;
- [ ] no auto top-up;
- [ ] no automatic re-entry;
- [ ] no loss-chasing/urgency messaging;
- [ ] clear fee/prize/refund disclosure immediately before confirmation;
- [ ] user-visible history for fees, refunds and prize outcomes.

## Integrity and abuse

- [ ] P1-9 collusion/bot/boosting tests passed for the approved competition type;
- [ ] participant/account/device/payment multi-account controls;
- [ ] server-authoritative game result;
- [ ] idempotent entry/reservation/settlement/refund;
- [ ] dispute evidence and operator audit;
- [ ] independent review path for high-value/suspicious events;
- [ ] documented suspension/disqualification/appeal rules.

## Policy artifact

Before server integration, create a reviewed policy artifact satisfying `server/competition-compliance.js`:

- [ ] immutable policy version;
- [ ] approval ID;
- [ ] effective timestamp;
- [ ] expiry/re-review timestamp;
- [ ] explicit `purchasedEntryPlatforms` per jurisdiction (empty where not approved);
- [ ] Apple/Google review identifiers when iOS/Android purchased virtual entry is listed;
- [ ] `allowPooledStake=false`;
- [ ] `allowCashOut=false`;
- [ ] `allowRealWorldPrize=false` for the baseline implementation;
- [ ] `prizeFunding=organizer`;
- [ ] explicit jurisdiction/platform allowlist;
- [ ] legal review ID for every jurisdiction;
- [ ] minimum age and spend limits;
- [ ] India regulatory IDs if India is present.

A later proposal to enable cash/real-world prizes or player-funded pools requires a **new legal review and reviewed code change**. Purchased closed-loop virtual entry is already modeled as a jurisdiction/platform policy decision.

## Live staging acceptance

Before a future enablement change:

- [ ] unknown location denied;
- [ ] denied country/state denied;
- [ ] VPN/location-risk condition denied;
- [ ] underage/unverified age denied;
- [ ] stale age verification denied;
- [ ] purchased virtual currency follows the jurisdiction/platform funding policy before reservation;
- [ ] insufficient earned funds denied distinctly;
- [ ] entry cap denied;
- [ ] loss cap denied;
- [ ] self-excluded/cooling-off account denied;
- [ ] correct fee shown before consent;
- [ ] cancellation/refund is exactly-once;
- [ ] service restart cannot duplicate entry/prize/refund;
- [ ] chargeback/refund does not claw money from an innocent opponent;
- [ ] collusion/bot escalation works;
- [ ] platform-specific behavior matches approved distribution.

Only after this evidence is recorded should a separate reviewed release consider replacing the hard `MEGA_PAID_ENTRY_ENABLED=false` production stop.
