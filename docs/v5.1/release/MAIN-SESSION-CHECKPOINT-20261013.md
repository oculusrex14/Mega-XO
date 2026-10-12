# V5.1 Main-agent session checkpoint - WebUI defect closure, recovery, quantization

Branch `V5.1`. This session executed the owner's standing autonomous instruction (fix WEB-AI-01..08,
secure staging, then every remaining Main-owned task). All work is committed and pushed; no
force-push, no `main`/`V4.1` write, no live-V4 change, no provider/cutover/model release.

## Commits (oldest -> newest)

| SHA | Unit |
| --- | --- |
| `b3b80bc` | staging: ONE stable OTP secret shared by account service + API handler |
| `b1db862` | WEB-AI-01..04: fail-closed gate, read-only constructor, atomic lease, resume integrity, neural producer |
| `324f380` | WEB-AI-05/06/07: complete league receipts, teacher family split, budget provenance |
| `4aa03e3` | WEB-AI-04/08: two-cycle self-play proof, atomic generation, safe partial cleanup, R22/R28 register repair |
| `15f1af4` | R19: real SIGTERM/resume operator test; frozen classical baseline + exploit bound |
| `2706408` | operator runs real neural self-play when a champion exists |
| `e421ccf` | R27: INT8 non-inferior to float at a 5-point margin (300 families) |
| `2be56a6` | queue: R19/R22/R24/R27 completions + external blockers |
| `4fe0562` | evidence: adjacent-tier calibration separated + monotonic (100 families) |
| `d2d9c8a` | export records the MEASURED quantization regression bound to the artifact |
| `c807206` | staging: realtime handshake accepts the same origins as the HTTP API |

## Verification ledger (this host unless noted)

- WebUI probes `scripts/v51-readiness-probes.py`: **7/7 NEGATIVE_CONTRACT_PASSED, exit 0**.
- `V5.1 independent readiness evidence` GitHub Actions workflow (WebUI's own fail-closed gate): **GREEN**
  on `324f380`, `2706408`.
- Bot suites: learning-operator **6/6 with prereqs** (incl. real SIGTERM+resume), training-data 6/6,
  tactics 6/6, model-gate 10/10, register 6/6, audit 10/10, teacher-leakage 3/3.
- p21/browser/tutorial: 90/90.
- Live staging (real Neon `mega_xo_v5_staging` + Upstash): e2e sign-in **8/8**, and a code minted before
  a restart verifies after it. `/`, assets, fonts, worker 200; missing asset 404.
- Leagues: 200-family pvp receipt (verifier enforces targets, model 0.015); INT8-vs-float 300 families
  0.498 CI[0.475,0.522]; adjacent tiers separated/monotonic.

## Two-cycle learning loop (R22/R24)

`training/bot/selfplay.cjs`: cycle 1 self-plays from a frozen ONNX artifact; cycle 2 trains on cycle 1's
shard and self-plays from the new artifact with `parentModelSha256` = cycle 1's model. Proven chain:
`3da3ed00...` -> `7245a902...`, `SELF_PLAY_FROM_RESEARCH_ARTIFACT`.

## Honest residuals (BLOCKED - owner/provider/device, not Main code)

- **Staging OTP sink proves the HTTP bridge, NOT a real mail provider** (provider disabled by design).
- **HTTPS/WSS** via `tailscale serve` needs one owner enablement:
  `https://login.tailscale.com/f/serve?node=nLo62ZkXpj11CNTRL`. The realtime origin fix is committed and
  will be exercised once the URL is live.
- **Flow-12 accept latency** is a measured cross-region Neon limit (17.4 s accept vs the preserved 15 s
  TTL); needs a host near the Neon region. Co-located queue suite is 10/10.
- **R25/R26** teacher distillation needs the isolated DGX unsloth venv (external).
- **R28** model distribution: no candidate meets the gate; `APPROVED_CATALOG` stays empty (correct).
- Device/moderated-study/store/cutover rows (R03/R06/R08/R11/R17/R20/R21/R29/R30) are external.

## Next actions for an interrupting agent

1. Re-read `docs/v5.1/release/MAIN-AUTONOMOUS-WORK-QUEUE.md` for the live ledger.
2. Re-run `python3 scripts/v51-readiness-probes.py --output .artifacts/readiness/probes.json` (expect exit 0).
3. Pick the highest-priority unblocked row; device/provider rows need the owner.
