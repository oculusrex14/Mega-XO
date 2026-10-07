# Mega XO V5 implementation and deployment pack

**Prepared:** 7 October 2026. **Purpose:** one continuous, evidence-gated implementation goal for the owner's local agent. **Deliverable here:** a plan and inspection utilities, not a deployed V5 system.

## Give the agent this goal

Open **[AGENT-GOAL.md](AGENT-GOAL.md)** and give its entire contents to the local agent with this folder available beside its Mega-XO checkout. It is the authoritative execution brief for this package. The agent should read the referenced documents from disk as it advances, rather than paste every file into a single model context.

The work includes the hybrid backend, data migration, deployment, recovery, Android and iOS application targets, native services, and browser-ready infrastructure. It excludes designing or building the new `megaxo.online` website/browser experience. The existing approved browser game remains a compatibility client; preserving it is not permission to redesign it.

## Reading order

1. [Agent goal](AGENT-GOAL.md), then [current-state audit](CURRENT-STATE.md).
2. [Scope and decisions](SCOPE-AND-DECISIONS.md), [target architecture](ARCHITECTURE.md), and [execution order](EXECUTION.md).
3. The relevant file under [phases](phases/INDEX.md), with its referenced technical specifications.
4. [Acceptance matrix](ACCEPTANCE.md) and [cutover runbook](specs/07-CUTOVER-AND-LEGACY-COMPATIBILITY.md) before any production transition.

`tasks.json` is a machine-readable task graph. `templates/` contains evidence, inventory, decision, progress, and release-manifest templates. `tools/` contains **read-only inspection/baseline tools**, not deployment scripts. `sources/` contains both original supplied files byte-for-byte and the source register. `evidence/` contains this review's sanitized observations.

## What is frozen

**One permanent Mega XO actor, one authoritative PostgreSQL database, one Game Core competitive/economy authority.** Vercel hosts the stateless platform API and future presentation; Oracle hosts Game Core and the initial worker; managed Redis/Valkey holds disposable coordination; Neon holds durable player state; R2 holds independent encrypted backups.

The approved game rules, four themes, layout, economy, Crown utility, account behavior, moderation decisions, and archived/deferred product features are not a redesign backlog. Change adapters, persistence, hosting and native integration, not the product. Native SDK dialogs and strictly necessary safe-area/keyboard/accessibility corrections are the only anticipated presentation exceptions, and require evidence.

## Important findings before execution

The inspected GitHub branch is `V4.1` at `8a77d3f4eb95e363fb967efe9b01f814a703dbae`; its latest inspected validation run succeeded. The handoff identifies deployed `v4.1.1` at an earlier application commit. The two are not interchangeable release identities.

The handoff and committed ledger disagree on backup health and some completed external checks. This pack does not declare a production outage or silently close those checks. The local agent must reconcile them against current runtime/provider evidence. This review could not resolve the production hostname from its execution environment; no successful public runtime response or SSH inspection was obtained.

The repository contains native integration adapters and contracts, not complete buildable Android/iOS applications. V5 must produce real targets and artifacts. Existing CI does not run automatically on a V5 branch; enabling V5 validation is an early task.

## Completion boundary

Complete Phases 0-20, **mark Phase 21 intentionally deferred**, then complete 22-23 when their evidence gates pass. Phase 24 produces a measured scaling plan; it does not authorize speculative infrastructure. Do not stop permanently after Phases 0-3. Do not make the deferred website a prerequisite for production migration.

A build, an internal distribution upload, store review approval, and production enablement are separate states. Report each accurately. Missing actual device or provider evidence is not a reason to abandon independent engineering work, nor permission to fabricate a successful test.

## Verify this package

From the unpacked folder:

```sh
python3 tools/validate-pack.py .
```

Then inspect the read-only tool usage in [tools/README.md](tools/README.md). These tools do not create branches, change DNS, provision services, deploy images, or alter databases. The agent must implement and validate the deployment tooling as part of V5.

Evidence and source boundaries are detailed in [sources/SOURCES.md](sources/SOURCES.md). No production secrets, database snapshots, signing credentials, or font files are included.
