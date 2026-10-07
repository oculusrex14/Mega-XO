# Scope, preservation contract and decisions

## Source precedence

The latest owner's request governs scope: implement/deploy V5 plus native apps, preserve the approved product, defer the new website/browser product. The current approved product contract and its explicit precedence patches govern behavior. `NewArchitecture.md` governs the target service architecture. Live runtime/provider observations establish deployment facts; dated handoffs and ledger rows remain historical evidence and can conflict. This pack adds concrete implementation decisions, not retrospective claims that those decisions were already approved or deployed.

Use the final phase table in the original architecture (lines 2439-2451). Its earlier minor-version summaries are not an additional set of work. Preserve phase numbers even when Phase 21 is deferred.

## In scope now

Backend decomposition, PostgreSQL schema/import/reconciliation, cross-platform identity, managed ephemeral coordination, durable matchmaking/matches/tournaments, background jobs, Vercel API, service security, telemetry, backup/restore, process failover, independent CI/CD, realistic staging/load testing, actual Android/iOS apps, native provider integration, and final production transition. Prepare the future browser platform and retain the existing browser client's compatibility.

The available local-provider access is an execution resource, not a presumed blocker. Existing infrastructure and deployment approvals are reusable where still applicable. New provider configurations and native builds must be proven with their actual target identifiers and credentials.

## Explicitly out of scope

New marketing pages, new browser game design, new navigation or account screens for the future website, visual rebranding, balance changes, extra spending eligibility rules, new subscription models, new puzzles/replays, resurrection of archived frames, new Bluetooth/Nearby gameplay, multi-region currency writes, Kubernetes/Kafka and speculative service proliferation. No Supabase or second identity/database product is introduced alongside the selected Neon architecture.

Existing support/privacy/terms/deletion resources and technical association files may be hosted where needed without turning them into a new website design project. Reuse approved content; do not invent legal facts.

## Product freeze and permitted adaptations

Capture baseline UI screenshots and source hashes before modifying application files. Include all four themes, account/recovery/social/profile screens, bot/local/online/party flows, tournament/lobby/store states, connection banner, keyboard and reduced-motion behavior. Capture representative phone sizes, not just desktop. Include the approved paper-layout and neon-theme behavior found in the actual baseline rather than relying on older screenshots.

Guest online remains sign-in-only, and the approved free/offline/LAN distinctions remain unchanged. Do not introduce anonymous ranked access while replacing authentication. Pure rules and all policy constants remain unchanged. Service extraction can change module imports, async repository calls and test harnesses. Client work should concentrate in account/network adapters, runtime endpoint configuration and native bridges. Avoid changing DOM/classes/text in approved screens. Automated tests must compare behavior and visual output; a changed file is not automatically a regression, and a passing hash check is not a visual test.

Acceptable exceptions are operating-system identity/billing/consent dialogs, safe-area/status-bar handling, keyboard avoidance and platform accessibility corrections that cannot be achieved in the host configuration. Log each exception in `UI-EXCEPTIONS.md`: requirement, smallest change, files, before/after screenshots, affected platforms, retained behavior and verification. Do not require a gratuitous user approval loop for a nonvisual adapter change.

## Concrete decisions supplied by this pack

| ID | Decision | Reason / boundary |
|---|---|---|
| D01 | `V5-platform` is the single long-lived integration branch | Matches the final architecture; latest green V4.1 is the starting point |
| D02 | Keep the existing JavaScript/browser UI and rules; use real Kotlin Android and Swift iOS hosts with bundled assets | Fits the current bridge contracts without a React Native/Flutter or website rewrite |
| D03 | Incremental apps/packages boundaries, not a mass file move | Reduces parity risk and preserves tests/import compatibility |
| D04 | PostgreSQL schema is normalized for authority and contention; immutable game snapshots may remain JSONB | Eliminates the one-global-state-row bottleneck without needlessly normalizing every board cell |
| D05 | API/Core/worker/backup/migration roles are distinct | Enforces ownership beyond naming conventions |
| D06 | Managed Redis/Valkey with regional primary; Upstash is a practical candidate, not a pre-existing resource claim | Must pass native TCP/pubsub/Lua/TTL/load compatibility and budget checks; do not silently replace managed production with same-host Redis |
| D07 | Start V5 CI and staging scaffolding before their later completion phases | Existing CI excludes V5; integration must be tested incrementally |
| D08 | Durable outbox plus idempotent job effects | Correctness cannot depend on an 'exactly once' network delivery promise |
| D09 | Direct Oracle realtime remains the target | Architectural/lifecycle boundary, not the obsolete claim that Vercel cannot host WebSockets |
| D10 | Preserve the old browser via a V5 compatibility layer, not an independent V4 authority | Enables production without building the new site |
| D11 | First post-import production application write is the rollback boundary | Even a refreshed session or background job can invalidate a naive SQLite fallback |
| D12 | Two same-host Core containers satisfy process failover only | Host HA needs a separate failure domain and an ingress design that survives host loss |
| D13 | New apex product remains dormant; technical/API deployments can proceed | No website design should be invented to complete an infrastructure checklist |

D02 is the recommended implementation default after verifying no newer real native targets exist locally. Preserve an existing approved native host if discovered; document the change, do not discard working code just to match this recommendation. The external platform facts informing D06/D09/D02 are in [sources/SOURCES.md](sources/SOURCES.md).

## Decisions the agent must resolve from actual inventory

Pin Node, PostgreSQL, native SDK, JDK/Gradle, Xcode and CLI versions compatible with the repository and current provider requirements. Verify existing Android package/iOS bundle identifiers and signing identities before creating new ones. Choose actual Neon projects/branches, compute and history window, Redis service/plan, Vercel team/project/region, backup destinations and monitoring targets. Do not make up account/project IDs or infer them from names.

Record current cost estimates and quotas for the chosen resources. Reuse existing entitlements and select the smallest configuration meeting measured reliability/latency requirements. Do not promise free-tier suitability or authorize unbounded autoscaling. A missing feature on the current Free plan requires a documented plan/capability resolution, not disabling required backups or silently accepting production cold starts.

## Approval and evidence discipline

The owner says the product is approved. Preserve it. Check for existing local/provider acceptance evidence before reporting open rows. A policy version, device test or store approval cannot be manufactured from tool availability alone. Unresolved external facts get a precise evidence gap and do not block unrelated coding/staging work. A harmful production action still requires the technical gates in this pack; routine phase progress does not require repeated conversational confirmation.
