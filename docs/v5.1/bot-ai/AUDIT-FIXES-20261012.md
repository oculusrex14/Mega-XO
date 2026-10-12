# V5.1 independent code-audit fixes — October 12, 2026

Branch: `fix/v51-independent-audit-20261012` (based on feature commit `cc4665a`). Review in draft PR #11. These fixes are isolated from the main agent's moving `feat/v5.1-bot-ai-tutorial`; **do not overwrite either branch by copying old files or merge to `main` without authorization**.

## What is fixed in code

| Finding | Fix and guard |
| --- | --- |
| Signed Core helper threw when evaluating a supplied clock | Correct function selection and signature/expiry/forgery tests |
| Core ingress could accumulate unbounded unsigned body | 100 KiB bound on length, streamed bytes, buffered and pre-parsed bodies; 10s deadline, 413/408 codes; HTTP tests |
| Research candidate could be pinned or selected for playable Impossible | Only `APPROVED` models are playable; `RESEARCH` remains offline only, with tests |
| P21 guided lesson could be changed to same-screen mode before Beginner handoff | Lock mode and difficulty during guidance; restore Beginner/bot on skip and handoff; test synthetic changes |
| Rating and wealth filters produced identical global SQL | Shared whitelist, bound tier/region predicates *before* LIMIT, visibility/security checks, wealth opt-in, preserved Elo decimals and exact wealth display; signed Core + API + PG tests |
| Ticket creation crossed API/Core least-privilege boundary | API mints tickets through `api_runtime` only, Core redeems; fail closed when issuer unconfigured; test malicious client actor/session overrides |
| Signed Core service was only mounted in disposable test composition | Add `apps/game-core/ingress-server.js` as a boot-composable HTTP listener using only Core service, Core pool and optional Core queue; no API pool or ticket issuer; explicit external bind guard; signed HTTP host regression |

## Test / release gates

- Local Node 22 (not reference Node 24): `node --test tests/v51-audit-*.test.js tests/v51-p21-bot.test.js tests/bot/pack.test.cjs tests/bot/impossible-session.test.cjs`: 53 tests, 51 pass, 2 optional runtime skips. This does not substitute for the PostgreSQL integration or browser/device matrix.
- Dedicated Node 24 + disposable PostgreSQL 16 workflow: `.github/workflows/v51-audit-fixes.yml`. Includes complete P11 Core Gateway and P12 read-cache suites and a new real PG metric/privacy test. Follow its CI run; do not mark the live gate passed until green.
- Strong SQL privacy policy: eligibility `verified && !suspended && !security_hold`, profile `stats_visibility=public`, wealth `wealth_public=true`. These are additive public disclosure restrictions.
- Core service host does **not** perform production deployment automatically. The main agent must inject guarded `core_runtime` PG connections, initialized Core/queue services, a non-default shared secret and a private listener/proxy in its process manager. Verify a real signed Vercel API -> Core round trip. Core should not receive `api_runtime` connection material.
- API ticket issuance needs `MEGA_TICKET_ENV` (e.g. `stg` for validated staging, appropriate configured production code) and optional `MEGA_TICKET_AUDIENCE` (default `mega-core`). Environment and audience **must match** the realtime consumer config exactly. If unset and no injected issuer, the route correctly responds 503 rather than issuing from Core. Do not synthesize this from user input.
- Do not expose Core directly to the public internet without reverse-proxy TLS, network access control, rate/size bounds and owner approval. Nonloopback binds are disabled unless explicitly acknowledged.
- Staging acceptance flow 12 (`OFFER_EXPIRED`) is **environment-dependent**: ~0.7s per PostgreSQL round trip from the previously tested remote location consumes a 15-second offer window. Run that scenario from a co-located staging worker and profile database round trips; **do not** extend offer expiry merely to make an isolated test pass.
- Physical iOS/Android, Safari, VoiceOver/TalkBack, fresh-player comprehension, DGX neural Impossible strength and full P22–P24 live acceptance remain separate tasks. Research model rejection is intentional.
- P21 SEO's noindex and release hold, the live V4 authority, paid rewards, and unverified neural catalog were not changed.

## Suggested main-agent integration order

1. Pull the independent PR as a feature-branch merge or cherry-pick in original commit order, resolving **only** conflicts against newer concurrent files.
2. Run the dedicated audit CI gate and all four existing V5.1 feature workflows on the **resulting merged SHA**.
3. Deploy signed Core HTTP wiring and API-role ticket issuer only in owner-approved isolated staging; confirm ingress auth, role grants and realtime tickets in separate processes.
4. Run co-located staging offer/accept, cross-platform account/leaderboard and browser/native acceptance; keep production disabled until written owner approval.
