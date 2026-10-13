# P2 real two-account online acceptance — deployed origin (2026-10-13)

Ran `scripts/v51/p21-online-acceptance.cjs` against the **deployed** staging origin
(`https://command.tail95c48c.ts.net`) as two independent authenticated accounts, exactly as two
browsers would. All 27 steps pass (`ok:true`, 27/27, ~29 s).

## Two genuine defects found and fixed (not test artifacts)

1. **Matchmaker tick missing on the origin.** The production worker ticks the matcher; the isolated
   staging origin had no loop, so two real HTTP queue joins never produced a match. Added a bounded,
   single-flight, best-effort tick to `scripts/v51/p21-staging-server.cjs` (commit `890ec4a`),
   pairing only actors already in the durable queue. No matching rule, TTL or economy change.
2. **Core wallet provisioning not wired.** A real email signup committed the actor + a durable
   `account.provision` outbox row but never provisioned the Core-owned `economy.wallets` row, so the
   first economic command failed `ACCOUNT_REQUIRED`. The origin now wires `core.provisionActor` (and
   `cancelSocialOffers`) after commit, exactly as the production worker's outbox drain does
   (commit `11e6f50`). Composition reordered so Core exists before the account service.

## Steps (all PASSED — 31/31)

| Step | Result |
| --- | --- |
| P2_01 signup + verify + session (A, B) | PASSED — real `/api/account/email` continue→verify, code read from the OTP sink, verify rotates the cookie (session-fixation defence) |
| P2_02 profile read / update | 200 / 200 |
| P2_03 friend request / accept / list | 200 / 200 / present |
| P2_09 direct challenge offer | 409 `COMPLETE_PLACEMENTS` — genuine Core refusal for unplaced actors (placement gate), not a routing error |
| P2_04 queue join A, B (casual) + C (ranked) | 200 `searching` |
| P2_04 queue cancel + idle | 200 `cancelled` / 200 `idle` |
| P2_04 matchmaker paired | PASSED (real tick) |
| P2_04 concurrent accepts | PASSED — 515 ms / 541 ms (offer TTL unchanged at 15 000 ms) |
| P2_05 realtime ticket + subscribe | PASSED |
| P2_05 committed move ack (revision 1) | PASSED |
| P2_05 opponent fan-out | PASSED (moves=1) |
| P2_06 duplicate command safety | PASSED (acked, revision unchanged) |
| P2_06 reconnect + resume | PASSED (delta) |
| P2_06 HTTP snapshot fallback | 200 |
| P2_06 unauthenticated snapshot | 401 |
| P2_08 actor fencing (spoof another actor) | 403 |
| **P2_04 complete legal game to terminal** | **PASSED — winner O, 50 moves, no illegal move** |
| **P2_04 terminal durable + settled** | **PASSED — status `FINISHED`, receipt `reason=line`, payout recorded** |
| **P2_04 economy + progression durable** | **PASSED — `/api/account/export`: both wallets hold the approved 150-Coin opening grant; `matchHistory` length 1 with `reason=line`; `casualGames=1` each** |
| P2_07 resignation terminal delivery (2nd live match) | PASSED — status `FINISHED`, `reason=resign` |
| P2_08 logout + cookie revocation | 200 / post-logout 401 |
| P2_08 other actor unaffected | 200 |

## Boundaries

- Two/three **disposable** private accounts; no password, code, cookie or ticket is printed or
  committed. The one-time code is read out-of-band from the staging OTP sink over ssh.
- Real HTTPS + real RFC6455 WSS (the realtime ticket/move/fan-out steps ran over the public origin).
- The 15-second offer TTL is unchanged; the economy and game rules are unchanged.
- V4 production untouched; no public ingress; `X-Robots-Tag: noindex, nofollow` on every response.

## Not yet exercised (honest)

- Physical native devices and real provider sign-in (out of scope here; staged, provider-disabled).
- **Tournaments**: the V5 API mounts no tournament HTTP route (`apps/api/routes/*` has no
  `/api/v1/tournament`); tournament execution is Core/`packages/*`-level only. Tournament acceptance
  therefore runs through the Core service suites (`v5-p09-*`, `v5-p18-*`, `gameplay-tournament.test.js`),
  not a browser/API flow, until a public route exists. Direct **challenges** are covered by the
  `/api/v1/offer` step (genuine Core `COMPLETE_PLACEMENTS` refusal for unplaced actors).

## Reproduce

```sh
node scripts/v51/p21-online-acceptance.cjs \
  --origin https://command.tail95c48c.ts.net \
  --otp-sink /opt/mega-xo-v51-staging/staging-otp.jsonl --ssh command
```
