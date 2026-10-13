# R05 — co-located full online acceptance (2026-10-13)

**Blocker addressed:** R05 / flow12 reported `OFFER_EXPIRED` for a full offer→both-accepts→PLAYING
journey, root-caused in `ISOLATED-COMPOSITION-AND-OFFER-LATENCY-20261012.md` as **cross-region Neon
latency** (the offer TTL is the preserved 15s constant; a co-located offer→accept measured 18.5ms, a
~14.98s margin). This run confirms it co-located near the staging DB.

**Harness:** `scripts/v51/p21-online-acceptance.cjs` run **on the staging host** against the deployed
origin `http://127.0.0.1:8085` (the isolated staging stack: API + Core ingress + queue + WSS + Neon),
so DB round trips are co-located (Neon same region), matching the intended runtime placement.

## Result — ok:true, 31/31 steps PASSED (runId 36bc6b9277b87d1cc0)
| Step | Status |
|---|---|
| signup/verify/session ×2 (real /api/account/email + OTP sink) | PASSED |
| profile read/update; friend request/accept/list | PASSED |
| direct challenge offer (Core escrow) | PASSED |
| queue join ×3 / cancel / idle-after-cancel | PASSED |
| **matchmaker paired** | PASSED |
| **concurrent accepts (the OFFER_EXPIRED path)** | PASSED |
| realtime ticket subscribe / committed move ack / opponent fanout | PASSED |
| duplicate command safe / reconnect resume (delta) | PASSED |
| HTTP snapshot fallback / snapshot anon 401 / actor fencing 403 | PASSED |
| complete legal game → terminal + durable settlement | PASSED |
| post-game profiles readable; economy + progression durable | PASSED |
| resign terminal delivery | PASSED |
| logout / logout revokes cookie / other actor unaffected | PASSED |

Evidence: `.artifacts/p3-core-edge/r05-online-acceptance.json`.

## Notes
- The harness's `readOtp` was made co-located-aware (reads the sink file directly when present; falls
  back to `ssh` for a remote run) — a harness portability fix, not a product change.
- The host cannot reach its own `*.ts.net` Tailscale-Serve name from itself (TLS `internal error`
  self-loop), so the co-located run uses the loopback origin the server binds; the same stack is what
  `tailscale serve` proxies, and the public path was verified in the P3 edge work.
- Idempotent over a fresh runId; only disposable `stg_*@example.test` actors are created.
- No production write, no provider access.
