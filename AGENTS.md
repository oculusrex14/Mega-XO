# Mega XOXO - current execution guidance

## Owner directive, 12 October 2026

Use **V5.1 as the only development integration trunk**. The platform, bot/tutorial feature and independent audit work are merged. Retain `main` and `V4.1` unchanged; do not recreate deleted `V5-platform`, `feat/v5.1-bot-ai-tutorial` or audit branches. Preserve all local uncommitted/user work and inspect it before pruning remote-tracking refs. Use local detached worktrees/patches for independent slices, with one integration owner and small verified commits. Never force-push for tidiness.

The **P21 website is authorized and in scope**, including the later owner annotations, download/discovery work, browser-only default Mega XOXO Neon and the original four retained themes. Historical instructions to defer P21 or resume V5-platform are superseded. Future paid native Neon is not activated merely because browser Neon exists. The original implementation packs remain unchanged historical specifications.

Start with [the three-agent launch order](docs/v5.1/release/AGENT-ORCHESTRATION-20261012.md), [the consolidated handoff](docs/v5.1/release/HANDOFF-20261012.md), [the full open-work and ownership register](docs/v5.1/release/OPEN-WORK-AND-OWNERS.md), and [the expanded main-agent execution/learning plan](docs/v5.1/release/MAIN-AGENT-EXECUTION-PLAN-EXPANDED.md). For immediate CI failures also read [the checkpoint](docs/v5.1/release/CI-CHECKPOINT-20261012.md). Then read `docs/v5/{progress.json,TODO.md,OPEN-ITEMS.md,PROGRESS.md}`, `docs/v5.1/bot-ai/{progress.json,IMPLEMENTATION.md,BENCHMARKS.md,AUDIT-FIXES-20261012.md}`, `docs/p21-web/MASTER-CHECKLIST.md`, and relevant original task/acceptance contracts. Old branch names inside evidence refer to the historical checkpoint, not a current instruction.

## Preserved detailed contracts

The full previous AGENTS.md is archived byte-for-byte at [docs/v5/AGENTS-PRE-CONSOLIDATION-20261012.md](docs/v5/AGENTS-PRE-CONSOLIDATION-20261012.md). Its product, data-migration, authority, security, native-bridge, backup, secret handling, delegation and evidence requirements remain applicable except where explicitly superseded by the current owner scope above. Its production, provider, storage and device inventories are historical observations: reverify before an operational decision. Also retain `AGENT-GOAL.md`, `docs/PRODUCT.md`, precedence patches, native commerce contracts and the original implementation pack.

Canonical game rules are `src/game.js`. Preserve economy, bought/earned Crown utility, rank/season/tournament policy, all four retained/native themes and first-five bot payouts/caps. No invented gameplay/geography blockers. Guided tutorial and optional local Impossible remain unverified/unpaid; do not mint Coins/Crowns/Elo, silently relabel Expert as Impossible or upload unapproved weights. All model improvements require measured leagues, not claims from training loss, parameter count or download size.

One permanent actor; only Core mutates competitive/economic state; separate API/Core/worker/migration/backup roles. Keep the merged HMAC/body-boundary, leaderboard privacy, ticket issuer and approved-model fixes. Do not bypass tests by widening API database grants, sharing Core credentials or extending the 15-second matchmaking offer TTL.

## Actual release authority and evidence

Consolidation does **not** authorize a main merge, paid upgrade, production deployment, DNS/data-authority switch or live migration. The last recorded authority is V4.1.2/SQLite. The main agent must inspect the live VPS read-only before any separately approved cutover. After the first V5 application write, including auth/jobs/webhooks, never restart a stale SQLite writer; preserve PostgreSQL authority and use tested compatible recovery. Retain V4.1 branch/tags/immutable recovery artifacts even after runtime retirement.

Historic G00-G20 software gates do not close all original acceptance cases. The source snapshot has 104 COMPLETE/4 IMPLEMENTED/9 PLANNED original tasks; 2 PASS/38 NOT_RUN acceptance cases; 49 DONE/24 PARTIAL/7 BLOCKED/2 DEFERRED bot tasks; 70 checked/160 unchecked website items. These overlap and are not a production-readiness percentage. Signed physical apps, real providers/stores, full staging acceptance, tutorial comprehension and a strong approved neural model remain unproven. `champion_cycle.py` currently writes a manifest only; manual prior experiments are not an executing continuous-learning service.

Every checkpoint records IDs, exact SHA, command, target/environment, pass/fail/skip result, evidence path and rollback. Distinguish implemented/local/CI/staging/device/submitted/approved/live. Preserve historical evidence and explicitly supersede stale claims. Never suppress a real failure or substitute a simulator for device acceptance.

## Canonical production domain (owner directive, 15 October 2026)

The public game is **https://megaxo.online**, served by the Oracle V5 authority (web bundle + API +
realtime from one process). `www.megaxo.online` 301-redirects to the apex; `core.megaxo.online` keeps
the isolated `/ingress/*` Core edge. `play.antimatterinnovations.com` is **retired for the game** and
308-redirects to the apex — that domain is reserved for the parent-company website, and only its
`contact@` email may appear in product copy. Do not add the antimatter host back to app, CORS, CSRF or
Vercel config. The Vercel `mega-xo-web`/`mega-xo-api` projects remain a separate, deferred surface and
are not the game origin.

The browser client reads `/api` and opens `new URL('/realtime/v1', page.origin)` same-origin, and the
session cookie is `__Host-mega_session` (host-only, no `Domain`), so the whole app must stay on one
hostname. Deploys use [scripts/v51/deploy-production.cjs](scripts/v51/deploy-production.cjs), which
archives the live trees as a dated rollback point and carries the host-managed `serve.sh` and
`docs/v5/environments/production.json` (`nonserving:false`) across the swap; losing either takes
production down.

## Four-owner split

**ChatGPT WebUI:** source/evidence audit, integration/CI hygiene, targeted tests and independent research-protocol review.

**Codex app:** website development, visual/browser acceptance and authorized browser-console/account setup. The owner explicitly permits sign-in/account creation/configuration; verify existing accounts before creating duplicates. Main agent provides CLI/build integrations.

**Main agent (oh-my-pi):** CLI/SSH on VPS and both DGX Sparks, isolated service composition, native builds, recovery/migration rehearsals, measured bot work and the real continuous-learning system. Serialize shared schemas/identity/economy/integration changes and continue independent safe slices when another is blocked.

**Human:** phone testing/feedback, visual decisions, novice-user study, MFA/identity or formal attestations requiring the owner, spending/pricing and exact-build release/cutover approval. Access permission is not evidence of provider approval.

Never print or commit secrets, OTPs, private/signing keys, full env files, raw player data or authenticated traces. Discover current permissions, quotas, hardware and filesystem suitability; do not delete unrelated data, reformat disks, alter shared ComfyUI/system packages or destructively initialize backup repositories. Training stays offline on owner-controlled compute; game inference remains client-first.
