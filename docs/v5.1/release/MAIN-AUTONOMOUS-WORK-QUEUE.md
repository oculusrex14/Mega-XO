# Main-agent autonomous work queue

Source of truth for the standing "continue autonomously until complete" instruction. One integration
owner (Main) serializes shared-file writes. WebUI owns `scripts/v51-readiness-*.py` and its tests; Codex
owns P21 browser/provider files. Main must not overwrite either.

Branch `V5.1`. Update status + commit + evidence on every meaningful unit. No force-push, no `main`/`V4.1`
writes, no live-V4 change, no paid provisioning, no store publication, no production cutover, no model
release.

## P0 - WebUI-reproduced safety defects (`scripts/v51-readiness-probes.py`)

| ID | Status | Commit | Evidence |
| --- | --- | --- | --- |
| WEB-AI-01a/b/c promotion gate fail-closed | COMPLETE | `b1db862` | probes exit 0; operator test; model-gate 10/10 |
| WEB-AI-02a constructor read-only | COMPLETE | `b1db862` | probe: owner bytes unchanged |
| WEB-AI-02b atomic lease | COMPLETE | `b1db862` | probe: one ACQUIRED, one REFUSED |
| WEB-AI-03 resume verifies output hashes | COMPLETE | `b1db862` | probe: tampered output not reused |
| WEB-AI-04 neural feedback wired | COMPLETE | `b1db862` | probe: injected engine reached; sync path byte-identical |
| WEB-AI-08 wall-clock heartbeat + STOP clear | COMPLETE (partial) | `b1db862` | heartbeat thread; resume clears STOP |
| WEB-AI-05 complete league receipts | COMPLETE | `324f380` | 200-family receipt; verifier enforces targets |
| WEB-AI-06 teacher-eval leakage | COMPLETE | `324f380` | family split; missing=failure; pinned revision; 3/3 |
| WEB-AI-07 label provenance + budget | COMPLETE | `324f380` | budget threaded; real option-order permutation; 6/6 |
| WEB-AI-08 two-cycle feedback PROOF | COMPLETE | `4aa03e3` | chain `3da3ed00…`->`7245a902…`; real kill/resume |
| WEB-DOC-01 register repair (R26/R28) | COMPLETE | `4aa03e3` | `73d866a0…`; audit structuralErrors 0 |
| WebUI re-verification (independent gate) | COMPLETE | `324f380`/`4aa03e3` | `V5.1 independent readiness evidence` GREEN |

## P0 - secure staging

| ID | Status | Commit | Evidence |
| --- | --- | --- | --- |
| Staging OTP secret mismatch | COMPLETE | `b3b80bc` | e2e 8/8; cross-restart code verifies |
| HTTPS/WSS via tailscale serve | BLOCKED (owner enablement) | - | `https://login.tailscale.com/f/serve?node=nLo62ZkXpj11CNTRL` |
| Realtime auth origin = HTTPS staging origin | PENDING | - | verify after HTTPS enabled |
| Real mailbox delivery | BLOCKED (provider creds) | - | sink proves bridge only; provider disabled by design |
| Flow-12 accept latency (Neon cross-region) | BLOCKED (region-local host) | - | measured 17.4s accept / 2.5s RTT; co-located 10/10 |

## R/B/CL and original acceptance

R03-R09, R11, R19-R20 operational acceptance and the 25-phase/40-case/82-task bot checklists proceed
after the P0 block. Track each as COMPLETE (with commit+test+evidence) or EXTERNALLY BLOCKED (with the
exact owner action).
