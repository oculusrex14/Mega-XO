# LR14 - powers behavior audit (2026-10-16)

**Method:** the shipped limit constants read from src/gameplay-rewind.js (version-pinned powers-1 policy) checked against the owner-approved limits; the powers behavioral suites executed. Static/source evidence plus the device receipts cited below - the live server-adjudication proof across devices is the LR20 pass.

## Owner-approved limits vs the shipped constants (EXACT MATCH)

| Owner-approved limit | Shipped constant (src/gameplay-rewind.js POLICY, version powers-1) | Match |
| --- | --- | --- |
| Bot Undo: up to 2 uses per Bot match, ONE rewarded offer per match | botUndoCharges: 2, botUndoPackagesPerMatch: 1 (botUndoFirstPly: 8 - no undo before ply 8) | EXACT |
| Casual Undo: 3 initiations per player per match | casualInitiationsPerPlayer: 3 | EXACT |
| Casual Undo: only ONE successfully applied Undo per match | casualAppliedPerMatch: 1 (the casualUndo state machine tracks applied/appliedBy/blocked) | EXACT |
| Tactical: 2 delivered hints per game, up to 3 initiations | hintDeliveries: 2, hintActivations: 3 | EXACT |
| Tactical Block: 2 successful blocks, up to 3 activations | blockSuccesses: 2, blockActivations: 3 | EXACT |
| Banked powers: stockpiles preserved, no invented expiration | bankCapacity: 1, owedCapacity: 1 (no expiry field in the policy) | EXACT |
| 10-per-UTC-day shared rewarded ceiling (Credits+boost+Undo together) | rewardedDayCap: 10 (src/monetization.js POLICY.rewardedAggregateDayCap: 10, enforced in the rewarded-power lane) | EXACT |
| Normal Bot rewards unchanged by Undo use | the rewind lane journals no Bot-payout mutation (gameplay-rewind POLICY has no payout field) | VERIFIED BY ABSENCE |

## Behavioral suites (executed 2026-10-16)

| Suite | Result |
| --- | --- |
| tests/v52-p21-powers.test.js | EXIT 0 (14 passing checks incl. the powers UI/state machine) |
| tests/v5-p18-staging-public-head.test.js | EXIT 0 (public-head powers posture) |
| tests/v52-consent-ui.test.js | EXIT 0 (the new consent card does not disturb the account panel) |

## Server-adjudication notes (LR14 scope)

- The Casual Undo/Block state machine (casualUndo: initiations/requests/applied/appliedBy/blocked per side) lives in the shared gameplay-rewind module the server-authoritative match uses - the client clock cannot decide the response window (the state machine is replayed server-side; LR20 verifies the live roundtrip).
- The rewarded lane enforces the shared 10/UTC-day ceiling at the LEDGER level (monetization.js POLICY + the commerce service ticket lifetime 5min, callback grace 24h, rewardCredits 5, casualCredits 2, casualDayCap 10 - all matching the documented economy).
- No ranked/tournament placement of the power kinds exists in the mode allow-list (the policy gates kinds per mode).

## Remaining for full LR14 closure

1. Cross-device same-game acceptance (the two phones, one shared match) - the LR20 device pass.
2. Ad-cancel/no-fill/retry with the LIVE AdMob SSV - LR15 enablement (the verifier is wired; the console setup is the owner step).
3. Banked-purchase flow end-to-end with the store verifier landed (PR #29) - the purchase sandbox pass.
