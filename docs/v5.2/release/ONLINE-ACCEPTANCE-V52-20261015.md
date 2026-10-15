# Two-account online multiplayer acceptance on V5.2 staging (2026-10-15)

Goal priority (2) — "finish real two-account online multiplayer end-to-end acceptance" — executed
against the **deployed** staging origin with the real harness, over real HTTPS and a real RFC6455
WebSocket upgrade. Two genuinely independent accounts, disposable, no in-process shortcut.

## Invocation

```
node scripts/v51/p21-online-acceptance.cjs \
  --origin https://command.tail95c48c.ts.net \
  --otp-sink /opt/mega-xo-v51-staging/staging-otp.jsonl \
  --ssh command
```

Run against the V5.2 bundle serving staging (`bundle_sha256 17b1d88e…`) at the time of this run.
It signs in two disposable accounts through the real `/api/account/email` flow, reading each one-time
code from the staging OTP sink — so email verification is part of the path, not bypassed.

## Result: **31/31 PASSED, 0 observed, 0 failed**

| Step | What it proves |
| --- | --- |
| `P2_01_signup_verify_session_a` / `_b` | two independent accounts created, verified and sessioned |
| `P2_02_profile_read` / `_update` | profile read and write |
| `P2_03_friend_request` / `_accept` / `_list_contains` | the real friendship flow between the two |
| `P2_09_direct_challenge_offer` | a direct challenge is issued |
| `P2_04_queue_join_a` / `_b` / `_c_ranked` | both queue, plus a ranked join |
| `P2_04_queue_cancel` / `_idle_after_cancel` | cancel is honoured and the queue returns to idle |
| `P2_04_matchmaker_paired` | **the matchmaker actually pairs the two accounts** |
| `P2_04_concurrent_accepts` | simultaneous accepts are safe |
| `P2_05_realtime_ticket_subscribe` | **ticket-authorized WSS subscribe over real HTTPS** |
| `P2_05_committed_move_ack` | a committed move is acknowledged |
| `P2_05_opponent_fanout` | **the opponent receives it in realtime** |
| `P2_06_duplicate_command_safe` | a duplicated command is idempotent |
| `P2_06_reconnect_resume` | reconnect resumes from the durable revision |
| `P2_06_http_snapshot_fallback` | the HTTP snapshot fallback works |
| `P2_06_snapshot_anon_401` | an anonymous snapshot read is refused 401 |
| `P2_08_actor_fencing_403` | acting as another actor is refused 403 |
| `P2_04_complete_legal_game_terminal` | **a complete legal game is played to a terminal result** |
| `P2_04_terminal_durable_settled` | the terminal result is **durably settled** |
| `P2_04_post_game_profiles_readable` | both profiles remain readable afterwards |
| `P2_04_economy_and_progression_durable` | economy and progression are durable after settle |
| `P2_07_resign_terminal_delivery` | resignation delivers a terminal result |
| `P2_08_logout` / `_revokes_cookie` | logout revokes the cookie (401 afterwards) |
| `P2_08_other_actor_unaffected` | the other account is unaffected (200) |

## Honest scope

- This is **staging**, not production. V4.1.2/SQLite remains the sole live writer and no production
  online path is claimed.
- The accounts are **disposable/synthetic**, created by the harness for this run; no real player data
  is involved and no credential, code, cookie or ticket is printed.
- Realtime is verified as a real WSS upgrade with ticket authorization and opponent fanout. It is not
  claimed to be verified through a physical browser UI.
- This does not replace the provider/store acceptance, which remains external.
