# V5.2 execution board (2026-10-14)

Integration owner: Main (this agent). V5.2 is the sole active integration, release and production
branch. `V5.1` is frozen historical evidence at `077bfbc`; `V4.1` is the retained previous-production
recovery branch. V4.1.2/SQLite is still the **sole live writer** (`play.antimatterinnovations.com`).

## Frozen shared contracts

Changes to any of these require a deliberate, reviewed edit here first, because more than one agent's
code depends on the exact shape.

| Contract | Frozen value | Where it lives |
| --- | --- | --- |
| Contract version | `api/v1` | `packages/contracts/routes.js:14` |
| Canonical routes | the 40+ ids in `ROUTES` (account, native, community, competitive, monetization, party, well-known) | `packages/contracts/routes.js` |
| Realtime | ticket-authorized WSS, revision-tied snapshots | `packages/contracts/realtime.js` |
| Native bridge | typed, origin-pinned; `EARNED`/shown/dismissed/failed are distinct events | `packages/contracts/native-bridge.js` |
| Capture format | `game-capture/v1` payload + versioned event envelope; `learning.*` schema | `packages/migrations/migrations/0044…0051`, `packages/learning/` |
| Capture gate | `day-one-gameplay-capture/v1`, 15 required receipts, `RECEIPTS_READY_FOR_MAIN_REVIEW` | `packages/learning/release-gate.js` |
| Ad unit metadata | one immutable allowlist entry per placement (platform, adUnit, rewardItem, amount) | `docs/v5.1/release/PROVIDER-READINESS-INVENTORY-20261013.md` + provider console |
| Public hosts | `megaxo.online`, `www.megaxo.online`, `api.megaxo.online`, `core.megaxo.online`; Antimatter stays for mail + old-client facade | `docs/v5.1/release/VERCEL-DOMAIN-PREPARED-20261014.md`, `deploy/Caddyfile` |
| Signing / app ids | Android `online.megaxo.*`, iOS `online.megaxo.prototype`; no signing identity exists yet | `native/**` |
| SSV | provider-authenticated GET, ECDSA vs AdMob keys, no user cookie/CSRF | `packages/services/commerce.js`, `apps/api` |

## Work streams

| Stream | Owner | Files (exclusive) | Blocking class |
| --- | --- | --- | --- |
| Powers pure logic (AM02–AM04) | Main | `src/gameplay-rewind.js`, `src/app.js`, `tests/gameplay-rewind*.test.js` | release-blocking |
| Entitlement + pacing + SSV (AM09–AM11) | Main | `packages/migrations/migrations/0052_*.sql`, `src/monetization.js`, `packages/services/commerce.js`, `tests/monetization-*.test.js` | release-blocking for ad serving |
| Consent + research + retention (DC00) | Main | `packages/migrations/migrations/0053_*.sql`, `packages/learning/*`, `docs/v5.2/**` | release-blocking for day-one capture |
| Capture all-source coverage | Main | `packages/learning/worker.js`, `packages/learning/exporter.js` | needs 0053 |
| Prune (P1B) | PruneV52Tree | archive-only trees | not blocking |
| Website UI (powers) | Codex/Sol | `apps/web/**` | blocked on the frozen state contract below |
| Store + provider consoles | Codex | provider accounts | external |
| Device matrix | Main | `native/**`, evidence docs | iOS needs a signing identity |

## Blocking classification

| Item | State | Unblocked by |
| --- | --- | --- |
| V5.2 CI on the corrected retarget | green (11 ok, 0 fail, 7 running at commit `0d94f81`) | — |
| `P22 readiness` | BLOCKED (`OPERATOR_EVIDENCE_PACKET_MISSING`) | native device acceptance, provider channels, the one-time E4/E5 window |
| `DC00 day-one capture gate` | BLOCKED (`MISSING_privacyPurpose`, `MISSING_retention`) | recorded privacy/controller acceptance + approved retention schedule (now owner-authorized to write) |
| iOS physical install | blocked | Apple signing identity (none in the keychain) |
| Android device pass | device not currently attached | plug in the phone |
| Ads serving | off | AM09–AM18 + provider review |

## Frozen powers state contract (Main → Codex/Sol)

Main implements and exposes this; Codex/Sol build UI against it. Exact names, do not silently rename.

```
window.MegaPowers = {
  version: 'powers/v1',
  // entitlement inventory (banked, cross-match)
  inventory(): 'powers/inventory/v1',            // {undo:{available,reserved}, hint:{...}, undoBlock:{...}, tacticalBlock:{...}}
  // eligibility for the CURRENT match (no side effects)
  eligibility(matchSummary): {undo:{eligible:boolean,reason:string,ply:number,charges:number,perMatchUsed:number}},
  // start/present a rewarded placement; resolves only on a native-confirmed EARNED
  request(kind, context): Promise<{earned:boolean,reason:string,entitlement:string|null}>,
  // apply an earned power, deterministic
  apply(kind, context): {applied:boolean,reason:string,revision:number},
  // pacing truth (never counts a not-shown ad as exposure)
  pacing(): {rewardedShownToday:number,rewardedDayCap:number,nextEligibleAt:number}
}
```

`eligibility` is pure. `request` never grants from a `shown`/`closed` callback. `apply` is fenced on
`match.revision`. Nothing here mutates ranked, staked, tournament or LAN state.
