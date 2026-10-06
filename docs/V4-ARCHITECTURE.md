# V4: VPS production architecture

Status: implementation plan and acceptance contract. V4 starts at V3.5.1 `3cca2f8eb600b98257954fe54022ac2bc7212a45`. This is not a claim that a VPS has been provisioned or a public service deployed.

## Input and decisions

The supplied `mega-xo-architecture.md` is an advisory for V3.5, not the current repository. It describes one Oracle ARM VPS (four cores, approximately 20 GiB RAM), Docker and Tailscale. Hardware, region, available ports and DNS authority must be confirmed on the real VPS. The quoted capacity and edge latency are unverified assumptions, not benchmarks.

Adopt: a modular Node monolith; one game coordinator; colocated SQLite; Caddy HTTPS; private administration; whole-database backups; staging/prod separation; immutable release references. Do not add Neon, Supabase, Valkey, Vercel, Kubernetes or a second database to the authoritative command path at launch. Additional network round trips and services are not justified by measured demand.

Correct for the current product: email OTP verification/reset now exist; the frame catalogue, Starter bundle and frame redemption routes were removed; Cosmetic Credits are retained; no replay/puzzle product is being added. Do not reintroduce archived features from the advisory. Seven-year retention, 18-month move retention and universal platform/legal conclusions in the advisory are not accepted as approved policy. A separate privacy/retention decision is required before public launch.

## Runtime boundaries

```
Player -> HTTPS Caddy -> production HTTP boundary -> existing buildService()
                                      |               |
                                      |               +-- identity/profile/save
                                      |               +-- game/wallet/ratings
                                      |               +-- rooms/matchmaking/jobs
                                      |               +-- monetisation (disabled)
                                      +-- bounded auth work, rate limits, metrics
                                                      |
                                           local SQLite WAL volume
                                                      |
                                   online snapshot -> encrypted off-box backup
```

Use one origin for the browser and API. Caddy alone publishes web ports. The Node port and SQLite are never public. Management is local/SSH through Tailscale; no public SQL console or money-grant endpoint. Cloudflare is optional; it must not be assumed to be the DNS authority merely because a domain was purchased at Hostinger. Forwarded client IPs are trusted only through an explicitly authenticated reverse-proxy boundary.

Production composition lives separately from the game rules. `server/production/` owns configuration, HTTP perimeter, lifecycle, monitoring and operations. Existing `buildService()` remains the application composition root; no alternative public economy/LAN handler. Production email work must be bounded and must not block match execution with password hashing or hold a SQLite transaction during network delivery.

## Safety invariants

- Exactly one game coordinator per database, enforced with an OS-held lock in the supported Linux launcher. Never delete its lock file while processes may be alive.
- WAL is local storage only; `synchronous=FULL`; migration history is ordered and checksummed. Refuse unknown future schema versions instead of guessing.
- Runtime startup: validate configuration, acquire process lock, migrate, construct stores, recover unresolved work once, start jobs, then become ready.
- Runtime shutdown: fail readiness, stop accepting new work, drain bounded in-flight HTTP requests, stop jobs, then close database handles. Interrupted matches follow the explicit restart/refund policy.
- Never trust client currency, Elo, account IDs, paid flags, ad completions or unverified store evidence. Ads, purchases and paid-entry competition stay disabled in this production baseline.
- Secrets are mounted files or server environment values, never committed, baked into images, exposed by health checks, or returned by diagnostics.
- No raw URLs/query strings, OTPs, emails, passwords, cookies, tokens, receipt bodies or arbitrary exception text in access logs.
- API/callback responses are not cached. Static content is same-origin, bounded and protected by security headers. No arbitrary proxy endpoint.
- Backup the entire SQLite database with the online backup API, including WAL-visible committed data. Never copy only the live `.sqlite` file. Encrypt off-box copies; preserve a recovery key outside the VPS.
- Rollback changes application image, not live user data. A database restore is a separate, explicit downtime operation with integrity/schema checks.

## Capacity and scale

SQLite WAL still has one writer. The inherited economy stores a serialized aggregate in one state row: transaction work and JSON parsing grow with retained data. Adding replicas or an external database does not automatically fix that design. V4 will measure seeded API latency and auth contention; those local results do not establish an ARM VPS capacity guarantee.

Before scaling to multiple coordinators: normalize account/match/ledger storage behind repositories, migrate and compare invariants, move ephemeral matchmaking/presence to shared leases, implement partition ownership and durable dispatch, then load-test. Do not put a cache on the money source of truth. Add WebSocket/SSE fanout only when polling measurements justify it. Move analytics off the command path rather than synchronously dual-writing.

## Availability, backups and cost

One VPS is one failure domain, not high availability. The advisory's 99.5% availability, 15-minute RPO and four-hour RTO are targets requiring operational evidence. A 15-minute backup schedule is not a guaranteed 15-minute RPO if uploads fail. Surface backup age and test restores.

No new paid service is required by the baseline. Resend is already chosen; respect its free sending allowance with an application budget. Off-box object storage is optional configuration, but mandatory operationally before inviting users. Use a verified free allowance, a dedicated backup prefix, a strict application quota and alerts; never assume free tiers are unlimited or that a budget notification stops billing. Keep independent copies outside the VPS/provider account where feasible.

## Acceptance gates

Automate configuration rejection, proxy spoof protection, bounded bodies, auth and email recovery invariants, migrations from V3.5.1, singleton startup, recovery, health/maintenance, backup corruption/restore, all existing game tests, browser regression and local load evidence. Extend the existing validation workflow. Build both amd64/arm64 images in CI; publish only explicitly approved releases. A green build is not a live deployment.

Before public launch: confirm actual VPS/OS/ports and hostname; DNS/TLS; install secrets; send real signup/reset emails; test reboot/backup/restore and real-device network failures; settle privacy/account-deletion/retention requirements. Native billing, ad SDKs and paid-entry approval remain separate work.

## Primary references reviewed

- https://sqlite.org/wal.html - one writer and local-filesystem constraint.
- https://sqlite.org/backup.html - consistent online database snapshots.
- https://nodejs.org/api/sqlite.html - synchronous database API and backup interface.
- https://caddyserver.com/docs/caddyfile/options - trusted-proxy parsing.
- https://docs.docker.com/compose/how-tos/use-secrets/ - service-scoped secret mounts.
- https://resend.com/docs/api-reference/emails/send-email - server-side email delivery contract.

Numerical limits introduced by V4 are explicit starting budgets to validate, not measured industry optima.
