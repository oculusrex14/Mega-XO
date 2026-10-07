# Source register and evidence boundaries

**Reviewed:** 7 October 2026. Repository content was accessed through the connected GitHub tool, not public web scraping. Public technical verification used official provider documentation through web search and Exa. No production secrets or database contents were accessed.

## User-supplied primary sources

- **[H]** [HANDOFF-V5.md](HANDOFF-V5.md): supplied deployment handoff, preserved byte-for-byte. Especially sections 1-10 / lines 12-192. Runtime states are handoff-reported, not automatically current facts.
- **[A]** [NewArchitecture.md](NewArchitecture.md): supplied target architecture and 25-phase program, preserved byte-for-byte. Final phase details start at line 1266; final milestone table is lines 2439-2451.
- **[U]** Latest owner instruction in this conversation: implement/deploy architecture on V5 onwards; native Android/iOS included; existing UI/game approved; new website/browser product deferred, its infrastructure required. This is the scope authority.

## Pinned repository observations

All blob references below use `8a77d3f4eb95e363fb967efe9b01f814a703dbae`. Mutable branch/CI APIs were used to establish that baseline; subsequent source reading was pinned. This is a selected review, not an assertion every file/line was audited.

### R01 - Branch resolution
https://api.github.com/repos/oculusrex14/Mega-XO/branches/V4.1

Head, commit message and timestamp observed via connected GitHub API; mutable reference resolved to the pinned SHA.

### R02 - Latest inspected successful validation
https://github.com/oculusrex14/Mega-XO/actions/runs/37649977689

Exact head matched; completed/success. This is provider evidence, not a local rerun.

### R03 - package.json
https://github.com/oculusrex14/Mega-XO/blob/8a77d3f4eb95e363fb967efe9b01f814a703dbae/package.json

Entire file; version/runtime/test entry points.

### R04 - Root repository tree
https://api.github.com/repos/oculusrex14/Mega-XO/git/trees/4160e3d7773ac621cd89b388de39caf4fac524ad

Root tree and selected source/native trees inspected; no root package-lock or V5 apps/packages at this baseline.

### R05 - V4 validation/release workflow
https://github.com/oculusrex14/Mega-XO/blob/8a77d3f4eb95e363fb967efe9b01f814a703dbae/.github/workflows/v35-validation.yml

Lines 1-185; V4-only triggers, Node/browser tests, ARM/AMD images and release path.

### R06 - Native identity README
https://github.com/oculusrex14/Mega-XO/blob/8a77d3f4eb95e363fb967efe9b01f814a703dbae/native/README.md

Entire file; real-app gap, identity bridge, provider configuration and contradictory old paid-entry gate sentence.

### R07 - Native commerce/ads contract
https://github.com/oculusrex14/Mega-XO/blob/8a77d3f4eb95e363fb967efe9b01f814a703dbae/native/COMMERCE-AND-ADS.md

Entire file; four-product mapping, store account context, delivery/finalization and ads/consent contract.

### R08 - Release-to-head comparison
https://github.com/oculusrex14/Mega-XO/compare/f31618d1fd3d7cb3d82b9ad90f4c689ebe36248e...8a77d3f4eb95e363fb967efe9b01f814a703dbae

Ahead by two commits; only enable-backups.sh and V4-OPEN-BLOCKERS.md changed.

### R09 - Open-blocker ledger
https://github.com/oculusrex14/Mega-XO/blob/8a77d3f4eb95e363fb967efe9b01f814a703dbae/docs/V4-OPEN-BLOCKERS.md

Start and targeted lines 111-225; completed/open status differences and EXT-17 backup claim.

### R10 - Serialized economy persistence
https://github.com/oculusrex14/Mega-XO/blob/8a77d3f4eb95e363fb967efe9b01f814a703dbae/server/economy-store.js

Entire file; state/commands schema and BEGIN IMMEDIATE authority boundary.

### R11 - Authority serialized state and rules
https://github.com/oculusrex14/Mega-XO/blob/8a77d3f4eb95e363fb967efe9b01f814a703dbae/src/authority.js

Selected lines 1-105; larger output truncated near end. Export/restore, clock-dependent season defaults, actor IDs, asset fields and early command handling inspected.

### R12 - Community persistence
https://github.com/oculusrex14/Mega-XO/blob/8a77d3f4eb95e363fb967efe9b01f814a703dbae/server/community-store.js

Selected first 120 lines; output partially truncated. Schema, session/hash/email and practice-save handling inspected, not a full audit.

### R13 - Room/tournament persistence
https://github.com/oculusrex14/Mega-XO/blob/8a77d3f4eb95e363fb967efe9b01f814a703dbae/server/rooms.js

Lines 1-70; room schema, shared economy transaction, reservation and settlement.

### R14 - Monetization persistence
https://github.com/oculusrex14/Mega-XO/blob/8a77d3f4eb95e363fb967efe9b01f814a703dbae/server/monetization-store.js

Entire inspected file (first 85 requested lines covered it); grants/receipts/ad ticket state and finalization.

### R15 - Production assembly and recovery
https://github.com/oculusrex14/Mega-XO/blob/8a77d3f4eb95e363fb967efe9b01f814a703dbae/server/production/main.js

First 145 requested lines; assembly, job intervals, startup recovery and operational health.

### R16 - Community/compatibility HTTP handler
https://github.com/oculusrex14/Mega-XO/blob/8a77d3f4eb95e363fb967efe9b01f814a703dbae/server/community-http.js

Lines 1-125; route handling, cookies/CSRF and mutating GET queue/match logic. Tool wrapper truncated after the source text.

### R17 - Shared account client
https://github.com/oculusrex14/Mega-XO/blob/8a77d3f4eb95e363fb967efe9b01f814a703dbae/src/account-client.js

Entire file; retries, operation keys, connectivity, cookie/CSRF and party fetch adapter.

### R18 - Canonical product rules
https://github.com/oculusrex14/Mega-XO/blob/8a77d3f4eb95e363fb967efe9b01f814a703dbae/docs/PRODUCT.md

Lines 1-170; precedence notes and competitive/economy/rank/tournament rules.

### R19 - Repository README
https://github.com/oculusrex14/Mega-XO/blob/8a77d3f4eb95e363fb967efe9b01f814a703dbae/README.md

Entire inspected content; stale title and approved product/archived-frame precedence notes.

### R20 - Current deployment Compose
https://github.com/oculusrex14/Mega-XO/blob/8a77d3f4eb95e363fb967efe9b01f814a703dbae/deploy/compose.yaml

Entire inspected file; image, resource/secret/network/ingress/backup controls.

### R21 - Combined server assembly
https://github.com/oculusrex14/Mega-XO/blob/8a77d3f4eb95e363fb967efe9b01f814a703dbae/server/community-server.js

First 140 requested lines; routes, static legal paths and service composition.

### R22 - Persistent store bindings
https://github.com/oculusrex14/Mega-XO/blob/8a77d3f4eb95e363fb967efe9b01f814a703dbae/server/store-bindings.js

Entire file; random IDs generated once and persisted by actor, requiring lossless migration.

## Official external references

External facts inform implementation details; they do not overwrite the approved product or prove a particular Mega XO account has a provider feature enabled. Prices, plans, tool versions, SDK requirements and provider statuses must be rechecked at execution. No secondary technical sources are used as authority.

### E01 - Neon connection pooling
https://neon.com/docs/connect/connection-pooling

Read via Exa official-source result. PgBouncer transaction mode and pooled/direct distinctions; direct pg_dump. Web-tool open separately failed.

### E02 - Neon logical backup/restore
https://neon.com/docs/manage/backup-pg-dump

Read via Exa. Independent logical backups through direct connections; restore procedure.

### E03 - Neon connection choice
https://neon.com/docs/connect/choose-connection

Read via Exa. Interactive vs single-query transport and session-sensitive operations.

### E04 - Neon production checklist
https://neon.com/docs/get-started/production-checklist

Read via Exa. Production suspension/restore-history decisions depend on configured plan and latency goals.

### E05 - Neon serverless pooling guide
https://neon.com/docs/guides/serverless-connection-pooling

Read via Exa. Small client pools and aggregate backend connection limits.

### E06 - Vercel deployment promotion
https://vercel.com/docs/deployments/promoting-a-deployment

Official documentation retrieved. Preview promotion rebuilds; staged production promotion preserves the build.

### E07 - Vercel staged production via CLI
https://vercel.com/docs/cli/deploying-from-cli

Official documentation retrieved. --prod --skip-domain followed by verified promotion. Local agent must inspect current CLI help before executing.

### E08 - Upstash Redis compatibility
https://upstash.com/docs/redis/overall/compatibility

Official search result read. Candidate managed Redis compatibility must still be tested for selected commands and plan.

### E09 - Upstash Redis REST API
https://upstash.com/docs/redis/features/restapi

Official search result read. REST capabilities include transactions/scripting/pubsub; do not assume a categorical lack of pubsub.

### E10 - Upstash getting started
https://upstash.com/docs/redis/overall/getstarted

Official search result read. Provider/region selection; no claim of an existing Mega XO Redis resource.

### E11 - Android local WebView content
https://developer.android.com/develop/ui/views/layout/webapps/load-local-content

Official page opened. WebViewAssetLoader/local HTTPS content model.

### E12 - Android native bridge risks
https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges

Official page opened. Untrusted frames/origins and broad bridges are risks; use narrow trusted-content integration.

### E13 - Apple WKScriptMessage
https://developer.apple.com/documentation/webkit/wkscriptmessage

Official search excerpt. Frame/context APIs for native bridge validation; verify exact SDK API signatures locally.

### E14 - Android Keystore
https://developer.android.com/privacy-and-security/keystore

Official page opened. Keystore holds cryptographic keys; encrypted token blob is an application design choice.

### E15 - Google Play Billing integration
https://developer.android.com/google/play/billing/integrate

Official page opened. Native purchase integration; current supported SDK/target requirements must be checked at implementation.

### E16 - Google Play Billing security
https://developer.android.com/google/play/billing/security

Official page opened. Backend verification and delivery/finalization ordering; do not trust client purchase reports.

### E17 - Google Mobile Ads Android privacy
https://developers.google.com/admob/android/privacy

Official page opened. Consent/UMP evaluation before ad requests.

### E18 - Vercel WebSocket beta announcement
https://vercel.com/changelog/websocket-support-is-now-in-public-beta

Published 22 June 2026; opened and dated. Vercel Functions now support WebSockets; keeping direct Oracle realtime is an architectural choice, not a platform impossibility.

### E19 - Apple device-only Keychain accessibility
https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly

Official search result read. Device-only foreground-accessible item behavior; select the actual app accessibility policy deliberately.

### E20 - Vercel preview-to-production guide
https://vercel.com/docs/deployments/promote-preview-to-production

Official guide retrieved; confirms preview promotion produces a new production build.

## Explicit additions/corrections to the source plan

The native bundled-host strategy, least-privilege role enforcement, detailed migration coverage, one-use ticket storage choice, first-post-import-application-write rollback boundary, early CI/staging work, future-browser deferral bypass, legacy-origin compatibility and managed Redis candidate selection are implementation recommendations in this pack. They were not all specified at this detail in the supplied files.

The original phrase "job resumes exactly once" is implemented as at-least-once delivery with fenced idempotent effects. Two same-host Core instances provide process recovery, not host redundancy. The original rollback wording around "meaningful/significant" writes is tightened to the first post-import application write. Earlier Vercel no-WebSocket assumptions are not used because the dated June 2026 official announcement supersedes them.

## What was not verified

Live production DNS/TLS/HTTP/SSH, actual provider resources/plan settings, R2 backup objects/restore, local untracked changes, signing credentials, native compilation/devices and store approval were not established by this review. Public probes from the review container failed to resolve the host. The raw sanitized failure record is included in `evidence/public-probes.json`; it is not an external outage diagnosis.

Local implementation must resolve contradictions between [H], the ledger and current evidence. Preserve original statements and append the resolution; do not silently rewrite the sources or assume the owner has unapproved gameplay.
