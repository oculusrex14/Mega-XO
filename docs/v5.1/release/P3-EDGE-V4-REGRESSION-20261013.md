# P3 edge — V4 regression + security verification (2026-10-13)

After the additive `core.megaxo.online` Caddy block and the Edge restart, V4 was re-verified both
live and by the repo's own regression suites.

## Live
| Check | Result |
|---|---|
| `https://play.antimatterinnovations.com/` | 200 |
| `https://play.antimatterinnovations.com/livez` | 200 |
| `https://megaxo.online/` (V4.1 apex) | 200 |
| `https://core.megaxo.online/` (new edge) | 404 (website not exposed) |
| `https://core.megaxo.online/ingress/leaderboard` | reaches Core (HMAC enforced) |

## Repo regression suites (local)
| Suite | pass | fail |
|---|---|---|
| `tests/production-lifecycle.test.js` | 8 | 0 |
| `tests/production-auth.test.js` | 9 | 0 |
| `tests/production-queue.test.js` | 2 | 0 |
| `tests/production-runtime.test.js` | 10 | 1 |
| `tests/static-ui.test.js` | 16 | 0 |
| `tests/v5-p13-security.test.js` | 5 | 0 |
| `tests/v5-p11-session-boundary.test.js` | 11 | 0 |
| `tests/v5-p06-lifecycle.test.js` | 3 | 0 |

**45/46 V4 + 19/19 security.**

The single failure is `production-runtime.test.js` → *"public operational health is fail-closed on
backup freshness"* (`/opsz` returns 503 not 200). This is the **known pre-existing `opsz`
backup-freshness failure** already documented in AGENTS.md as failing on the clean tree and unrelated
to this work (and explicitly not to be suppressed, redefined or "fixed for green"). No other suite
failed; the P3 edge change touched no V4 code path.
