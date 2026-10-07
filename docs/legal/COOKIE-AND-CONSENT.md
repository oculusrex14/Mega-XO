# Mega XO cookie, local-storage and advertising consent inventory

Status: **DRAFT FOR RELEASE/LEGAL REVIEW**  
Draft date: 2026-10-07

This document records what the product actually stores on a device and the release gates that apply before non-essential tracking or advertising technology can be enabled.

## Web baseline

### First-party session cookie

Production uses the first-party cookie:

`__Host-mega_session`

Properties enforced by the production perimeter:

- `Secure`
- `HttpOnly`
- `SameSite=Lax`
- `Path=/`
- maximum age aligned to the linked-session lifetime

Purpose: authentication, CSRF/session continuity and account security.

The cookie is not an advertising cookie and is not intentionally exposed to JavaScript.

### Local browser storage

The web client uses local storage for functional game/client state such as:

- visual/settings preferences;
- offline/practice progress;
- local non-server state required to resume the client experience.

This storage is used for product functionality, not behavioral advertising.

### Current web tracking posture

The current V4.1 web baseline intentionally has:

- no third-party advertising script;
- no third-party marketing cookie;
- no behavioral analytics SDK;
- no cross-site retargeting implementation.

A release must not introduce one without updating this inventory, the Privacy Policy, store declarations and the applicable consent design.

## Native advertising posture

Advertising is fail-closed by default with `MEGA_AD_MODE=off`.

A release cannot enable rewarded or interstitial ads unless all of the following are complete:

- approved Privacy Policy and retention schedule;
- explicit `MEGA_AD_CONSENT_VERSION`;
- complete platform ad-unit configuration;
- native Google Mobile Ads integration;
- native UMP/privacy-options integration;
- physical-device and regional consent acceptance;
- exact Apple/Google privacy declarations for the SDK version that actually ships.

The repository's server-side gate is not a legal determination that consent is sufficient in every jurisdiction.

## Remove Ads behavior

When ads are enabled, the product design is:

- Remove Ads suppresses automatic/interstitial advertising;
- optional rewarded ads may remain available where clearly voluntary and allowed;
- ads must not appear during active gameplay or sensitive transitions;
- rewarded grants require server-side verification and replay protection.

The public Privacy Policy and store metadata must describe the behavior of the released build.

## Consent decision required before public launch

Legal/release review must answer:

1. Which countries/regions are launch markets?
2. Does the web baseline need a consent banner for its strictly functional storage under those laws?
3. What UMP consent modes/regions are required for native ads?
4. Is personalized advertising allowed at launch, or should the product be limited to non-personalized/limited ads?
5. Are age-gating or child-directed ad restrictions required?
6. What "sale", "share", targeted-ad or opt-out rights apply in launch regions?
7. Where must a persistent privacy-options entry point be shown?

No new tracking/advertising technology should be enabled before those answers are reflected in code and the effective Privacy Policy.
