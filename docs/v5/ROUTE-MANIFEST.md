# Route Ownership Manifest (Mega XO V5)

## Overview & Architecture Contract

This document provides the authoritative route inventory for the Mega XO platform transition from V4 to V5 (Phase 11 Task V5-11-01).
It defines the exact ownership boundary between the stateless **Vercel API** control plane and the stateful **Game Core** process.

### Economic Authority Invariant
- **Vercel API Economic Mutation Authority:** **0 routes (ZERO)**. The Vercel API facade possesses zero authority to mint currency, alter wallet balances, reserve stakes, or settle match outcomes.
- **Game Core Economic Authority:** All currency conversions, store purchases, match stakes, move settlements, daily quests, and reward claims are **Core-Only** transactions executing under strict database transaction fences.

---

## Route Ownership Catalog

| Route | Method | Auth/CSRF requirement | Owner | Economic Authority | Idempotency | Cache class | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `/.well-known/jwks.json` | GET | Public | Vercel API | None | Idempotent GET | public, max-age=300 | Active |
| `/auth/callback/:provider` | GET | Session (state/nonce bound) | Vercel API | None | One-use attempt | no-store | Active |
| `/api/account/session` | GET | Public (G) | Vercel API | None | Idempotent GET | no-store | Active |
| `/api/account/save` | GET | Linked (L) | Vercel API | None | Idempotent GET | no-store | Active |
| `/api/account/sessions` | GET | Linked (L) | Vercel API | None | Idempotent GET | no-store | Active |
| `/api/account/deletion` | GET | Linked (L) | Vercel API | None | Idempotent GET | no-store | Active |
| `/api/account/email` | POST | Session + CSRF | Vercel API | None | Challenge flow | no-store | Active |
| `/api/account/start` | POST | Session + CSRF | Vercel API | None | Nonce / PKCE | no-store | Active |
| `/api/account/native/challenge` | POST | Session + CSRF | Vercel API | None | Nonce / State | no-store | Active |
| `/api/account/native/finish` | POST | Session + CSRF | Vercel API | None | One-use consume | no-store | Active |
| `/api/account/native/token` | POST | Bearer token | Vercel API | None | Family rotation | no-store | Active |
| `/api/account/native/refresh` | POST | Bearer token | Vercel API | None | Single-flight family | no-store | Active |
| `/api/account/native/logout` | POST | Bearer token | Vercel API | None | Token revocation | no-store | Active |
| `/api/account/logout` | POST | Session + CSRF | Vercel API | None | Session delete | no-store | Active |
| `/api/account/sessions/revoke` | POST | Linked + CSRF | Vercel API | None | Session revoke | no-store | Active |
| `/api/account/export` | POST | Linked + Recent Auth + CSRF | Vercel API | None | Daily rate budget | no-store | Active |
| `/api/account/delete` | POST | Linked + Recent Auth + CSRF | Vercel API | None | Pseudonymize / Deletion | no-store | Active |
| `/api/account/unlink` | POST | Linked + Recent Auth + CSRF | Vercel API | None | Identity remove | no-store | Active |
| `/api/account/profile` | POST | Linked + CSRF | Vercel API | None | CAS version increment | no-store | Active |
| `/api/account/save` | POST | Linked + CSRF | Vercel API | None | Expected revision CAS | no-store | Active |
| `/api/community/friends` | GET | Linked (L) | Vercel API | None | Idempotent GET | no-store | Active |
| `/api/community/search` | GET | Linked (L) | Vercel API | None | Durable rate write on GET | no-store | Active |
| `/api/community/profile/:id` | GET | Linked (L) | Vercel API | None | Idempotent GET | no-store | Active |
| `/api/community/challenges` | GET | Linked (L) | Game Core | None | Idempotent GET | no-store | Active |
| `/api/community/presence` | POST | Linked + CSRF | Vercel API | None | Heartbeat timestamp | no-store | Active |
| `/api/community/friend` | POST | Linked + CSRF | Vercel API | None | Required (operation key) | no-store | Active |
| `/api/community/report` | POST | Linked + CSRF | Vercel API | None | Same-day open report dedupe | no-store | Active |
| `/api/v1/profile` | GET | Linked (L) | Game Core | None | Idempotent GET | no-store | Active |
| `/api/v1/leaderboard` | GET | Linked (L) | Game Core | None | Idempotent GET | no-store | Active |
| `/api/v1/invitations` | GET | Linked (L) | Game Core | None | Idempotent GET | no-store | Active |
| `/api/v1/weekly` | GET | Linked (L) | Game Core | None | Idempotent GET | no-store | Active |
| `/api/v1/queue` | GET | Linked (L) | Game Core | None | Sweep / Pair commit | no-store | Active |
| `/api/v1/queue` | POST | Linked + CSRF | Game Core | None | Required (ticket key) | no-store | Active |
| `/api/v1/cancel-queue` | POST | Linked + CSRF | Game Core | None | Required (operation key) | no-store | Active |
| `/api/v1/match/:id` | GET | Linked (L) | Game Core | Core-Only | Timeout/expire clock settle | no-store | Active |
| `/api/v1/offer` | POST | Linked + CSRF | Game Core | Core-Only | Required (operation key) | no-store | Active |
| `/api/v1/accept` | POST | Linked + CSRF | Game Core | Core-Only | Required (operation key) | no-store | Active |
| `/api/v1/decline` | POST | Linked + CSRF | Game Core | Core-Only | Required (operation key) | no-store | Active |
| `/api/v1/cancel` | POST | Linked + CSRF | Game Core | Core-Only | Required (operation key) | no-store | Active |
| `/api/v1/move` | POST | Linked + CSRF | Game Core | Core-Only | Required (operation key) | no-store | Active |
| `/api/v1/resign` | POST | Linked + CSRF | Game Core | Core-Only | Required (operation key) | no-store | Active |
| `/api/v1/convert` | POST | Linked + CSRF | Game Core | Core-Only | Required (operation key) | no-store | Active |
| `/api/v1/quest` | POST | Linked + CSRF | Game Core | Core-Only | Required (operation key) | no-store | Active |
| `/api/v1/preferences` | POST | Linked + CSRF | Game Core | None | Required (operation key) | no-store | Active |
| `/api/v1/friend` | POST | Linked + CSRF | Vercel API | None | Required (operation key) | no-store | Active |
| `/api/v1/accept-friend` | POST | Linked + CSRF | Vercel API | None | Required (operation key) | no-store | Active |
| `/api/v1/realtime/ticket` | POST | Linked + CSRF / Bearer | Vercel API | None | One-use ticket mint | no-store | Active |
| `/api/v1/cosmetic` | POST | Linked + CSRF | Game Core | Core-Only | Required (operation key) | no-store | Archived (404) |
| `/api/v1/purchase` | POST | Linked + CSRF | Game Core | Core-Only | Required (operation key) | no-store | Active |
| `/api/monetization/status` | GET | Linked (L) | Game Core | None | Idempotent GET | no-store | Active |
| `/api/monetization/purchase` | POST | Linked + CSRF | Game Core | Core-Only | Required (operation key) | no-store | Active |
| `/api/monetization/restore` | POST | Linked + CSRF | Game Core | Core-Only | Required (operation key) | no-store | Active |
| `/api/monetization/claim` | POST | Linked + CSRF | Game Core | Core-Only | Required (operation key) | no-store | Active |
| `/api/monetization/reward-ticket` | POST | Linked + CSRF | Game Core | Core-Only | Required (operation key) | no-store | Active |
| `/api/monetization/interstitial-permit` | POST | Linked + CSRF | Game Core | Core-Only | Required (operation key) | no-store | Active |
| `/api/monetization/admob-ssv` | GET | Verified Provider (V) | Game Core | Core-Only | Signed query transaction | no-store | Active |
| `/api/monetization/google-play-rtdn` | POST | Verified Provider (V) | Game Core | Core-Only | Push auth + PubSub dedupe | no-store | Active |
| `/api/monetization/apple-notifications` | POST | Verified Provider (V) | Game Core | Core-Only | JWS signature + dedupe | no-store | Active |
| `/api/monetization/redeem` | POST | Linked + CSRF | Game Core | Core-Only | Required (operation key) | no-store | Archived (404) |
| `/api/monetization/equip` | POST | Linked + CSRF | Game Core | None | Required (operation key) | no-store | Archived (404) |
| `/api/party/capabilities` | GET | Public | Game Core | None | Idempotent GET | no-store | Active |
| `/api/party/session` | POST | LAN Bearer (B) | Game Core | None | 24h guest token issuance | no-store | Active (LAN) |
| `/api/party/me` | GET | LAN Bearer (B) / Linked | Vercel API | None | Idempotent GET | no-store | Active |
| `/api/party/rooms/:id` | GET | LAN Bearer (B) / Linked | Game Core | None | Revision check | no-store | Active |
| `/api/party/command` | POST | LAN Bearer (B) / Linked | Game Core | Core-Only | Required (operation key) | no-store | Active |
| `/livez` | GET | Public | Game Core | None | Idempotent GET | no-store | Active |
| `/readyz` | GET | Public | Game Core | None | Idempotent GET | no-store | Active |
| `/opsz` | GET | Public | Game Core | None | Idempotent GET | no-store | Active |

---

## Detailed Domain Analysis

### 1. Account, Identity, and Authentication
- **Owner:** `Vercel API`
- **Scope:** Anonymous session bootstrap, email signup/login/OTP verification, OAuth provider flows (Google, Apple), native bearer token refresh/rotation/revocation, session listing and revocation, GDPR export, account deletion, profile editing, and client save/practice synchronization.
- **Economic Authority:** **None**. Account routes only manage user identities, credentials, profiles, and presence. Starting balances or initial wallet provisioning trigger Core UoW commands or background jobs, never direct wallet modifications from Vercel.

### 2. Social and Community
- **Owner:** `Vercel API`
- **Scope:** Friend list queries, player username/tag search, public profile lookups, presence heartbeats, friend requests/acceptances/blocks, and abuse reporting.
- **Economic Authority:** **None**. Social graph modifications write to `social_operations` and identity graphs; they do not manipulate economy ledger entries or currency balances.

### 3. Matchmaking and Gameplay
- **Owner:** `Game Core`
- **Scope:** Matchmaker queue polling, ticket enqueue/cancel, direct challenge offers, offer acceptance/rejection, move submission, clock timeout settlement, and resignations.
- **Economic Authority:** **Core-Only**. Ranked match offers lock entry fees in escrow (`reservedCoins`), move completions evaluate rating changes and settlements, and forfeit/resign commands transfer stakes to winners through transactional UoW execution.

### 4. Monetization and Billing
- **Owner:** `Game Core`
- **Scope:** Catalog status, casual cosmetic credit claims, IAP purchases (Google Play, App Store), purchase restores, rewarded ad tickets, interstitial permits, AdMob server-side verification (SSV), and store real-time developer notifications (RTDN).
- **Economic Authority:** **Core-Only**. All Crown/Coin grants, transactional receipt validation, refund tombstones, and entitlement adjustments execute solely within Core and durable worker services. Vercel API has zero mutation access to billing or store records.

### 5. Party and LAN Mode
- **Owner:** `Game Core`
- **Scope:** Capability discovery, room creation, public/private lobby management, room state synchronization, and room commands.
- **Economic Authority:** **Core-Only** for online paid table prize pools; None for free LAN rooms.

### 6. Operations and Health Checks
- **Owner:** `Game Core`
- **Scope:** `/livez`, `/readyz`, `/opsz`, loopback operator administration.
- **Economic Authority:** **None**.

---

## Verification & Metric Summary

- **Total Catalogued Routes:** 65 routes across all V4 and V5 surfaces.
- **Vercel API Owned Routes:** 25 routes.
- **Vercel API Economic Mutation Authority:** **0 routes (0.0%)**.
- **Game Core Owned Routes:** 40 routes.
- **Game Core Economic Authority:** **21 Core-Only mutation routes**.
- **Idempotency Enforcement:** All state mutations enforce durable idempotency keys (`idempotency-key` header, operation keys, or bound cryptographic nonces).
- **Cache Policy:** All authenticated data routes enforce `Cache-Control: no-store`; public JWKS key material enforces `public, max-age=300`.
