# Infrastructure, provider configuration and environment plan

Applies to Phases 0, 2, 6, 11, 13, 15-18 and 22. Resource names below are proposed labels unless explicitly identified as a verified/reported existing object. Resolve actual IDs through the authenticated local tools and record them in the environment inventory.

## 1. Discovery before provisioning

Use local CLI help/version and account inspection for GitHub, Hostinger, Vercel, Neon, Cloudflare and Oracle access. Prefer installed pinned versions once selected; do not run an unreviewed `@latest` installer throughout CI. Record versions without copying credentials. The handoff's known Neon org is `org-wandering-sea-53820697`; confirm it before creating anything and pass the org explicitly to noninteractive commands.

Inspect current provider objects before making duplicates. Preserve the existing DNS zone, project/team relationships, R2 repositories, GitHub release/package history and native identifiers. Confirm credentials are scoped to the intended environment and that quotas permit the deployment. Local tool presence alone is not evidence the account has a required paid feature or store-signing permission.

Do not print `.env`, `docker inspect` environment arrays, CLI auth files, service-account JSON, Apple private keys, token-bearing URLs or full database connection strings. Templates store secret references/paths, never values. Record object IDs, hostnames, regions, configuration fingerprints, checked time and evidence status.

## 2. Environment topology

| Environment | Durable database | Redis | API | Core/worker | Data policy |
|---|---|---|---|---|---|
| Local | Disposable PostgreSQL | Local container | Local API | Local processes/containers | Synthetic fixtures |
| PR preview | Ephemeral branch from sanitized nonproduction seed | Nonproduction credential/namespace | Protected Vercel preview | Shared isolated dev target or disposable test services | No production data or credentials |
| Staging | Separate Neon staging project/database | Separate managed service/credentials | Stable staging Vercel target | Dedicated V5 project/root/network/ports | Synthetic or explicitly sanitized controlled copy |
| Production | Separate Neon production project/database | Separate managed service/credentials | Production API project/deployment | Production Core A/B and worker | One live durable authority |

Separate Neon projects for production and nonproduction are the recommended isolation default. Preview branches originate from sanitized nonproduction data, not the production branch. Separate credentials and compute/quotas matter; a branch name alone does not prevent accidental access. Verify PR cleanup removes only the PR's own resources and cannot delete staging/production by pattern collision.

Bootstrap staging incrementally from Phase 2 onward. Phase 18 is its full acceptance milestone, not the first time V5 may deploy to staging.

## 3. Neon

Create or adopt the actual selected region near IAD after measuring network RTT from Oracle and the chosen Vercel compute region. Record project/branch/database/endpoint IDs, PostgreSQL version and maintenance/upgrade policy. Configure TLS verification, roles, bounded compute/autoscaling, production always-on behavior and a restore-history window that meets the agreed recovery target. Verify the current plan actually supports the configuration; the handoff's Free plan is not a production capability guarantee [E01-E05].

Provision runtime roles per architecture. Keep migration/backup direct connections distinct from pooled runtime strings. Bound the combined pool budget across both Core instances, worker, Vercel fan-out, backups and migrations; leave operational headroom. Measure lock waits and connection churn under load. Avoid accidental schema changes from connection initialization or session assumptions invalidated by transaction pooling.

Set nonproduction outbound email/provider modes before importing data. Never permit a staging worker to send real security emails or process live purchase notifications from a production-derived copy.

## 4. Managed Redis/Valkey

Select the managed product after checking current regions and capabilities. Upstash can be evaluated through existing Vercel/provider access, but is not assumed provisioned. Core needs reliable long-lived native subscriptions and tested atomic queue operations; Vercel needs bounded stateless access. Check TCP/TLS, pubsub, scripting, sorted sets, TTL, atomicity, connection limits, eviction and command compatibility [E08-E10].

Use separate staging/production credentials and services. Configure explicit namespaces/versioning even within an isolated service. Pin client versions and retry/connection limits. Failover and complete data-loss tests must show that PostgreSQL still owns all permanent assets/results. Do not silently put the production Redis process on the same Oracle host simply because a managed plan needs configuration.

## 5. Oracle host and ingress coexistence

Known handoff target: `ssh command`, `/opt/mega-xo` production, `/opt/mega-xo-staging` old staging. Verify actual names and running containers. Inventory unrelated services before adjusting Docker networks, firewall, disk limits or resource quotas.

Create new deployment roots such as `/opt/mega-xo-v5-staging` and `/opt/mega-xo-v5` with distinct Compose project names, networks, volumes and loopback admin ports. Initially expose staging only privately or through explicitly allocated nonconflicting ports. No second edge may bind host 80/443.

Preferred shared-host transition: keep the existing Caddy edge as the sole public listener; add narrowly scoped V5 host/path routes using a validated configuration and atomic reload. Back up the old configuration, prove the old production routes unchanged, and define immediate configuration rollback. Attach the edge to the minimum necessary networks or explicit loopback upstreams. Do not stop production to bring back the old staging edge.

Core and worker containers remain non-root, read-only where possible, capability-dropped, bounded in CPU/memory/PIDs/logs, with explicit health checks and graceful shutdown. Preserve Caddy's known required capabilities. Keep admin/metrics on loopback or Tailscale only. Never expose PostgreSQL/Redis/admin ports publicly. Provision headroom for backups and the co-hosted workloads; run stress tests in isolated disposable targets, not against the production host without resource controls.

Core A and B on this machine allow rolling deploy and process failure recovery. They do not survive a machine or shared-edge failure. A second host and independent ingress require a separate, explicit host-HA capacity decision; do not claim such redundancy without deploying and testing it.

## 6. Public routing and domains

| Host/resource | Target now | Constraint |
|---|---|---|
| `api.megaxo.online` | Vercel account/control-plane API | Exact production and staging env bindings; no UI product required |
| `rt.megaxo.online` | Oracle Caddy -> healthy Core instances | WSS and HTTPS fallback/service ingress; no public admin routes |
| `megaxo.online` | Reserved/dormant Vercel presentation project | No new website or browser design; non-product response until owner plans it |
| `www.megaxo.online` | Reserved redirect policy to apex | Do not launch an unplanned product page |
| Existing `play.antimatterinnovations.com` | Retained approved client plus V5 compatibility facade at cutover | Same-origin cookie flow; no second SQLite authority |
| Staging API/realtime names | Stable explicitly chosen staging hosts | Separate data, auth audiences and credentials; protected test UI |
| Association/legal/deletion resources | Minimal required static/technical routes | Reuse approved content; necessary files reachable by intended platform validators |

Get DNS record values from the actual Vercel project/provider, not memorized A/CNAME defaults. Export a before/after zone diff; change only necessary records and keep mail MX/SPF/DKIM/DMARC untouched. R2 storage use does not require moving Hostinger DNS to Cloudflare. Do not add AAAA records without verified IPv6 reachability.

Verify TLS, redirect chains, response headers, certificate renewal, WebSocket upgrade and private-path rejection. Avoid putting provider callbacks behind a preview password wall they cannot pass. Use dedicated stable callback endpoints or narrow protection exceptions, with cryptographic provider authentication still mandatory. Do not exempt entire APIs from protection to make one callback work.

## 7. Vercel-to-Core reachability

Do not assume Vercel Functions can reach a Tailscale-only Oracle endpoint by default. Implement an explicitly reachable HTTPS command ingress, for example an allowlisted service path on the realtime hostname, authenticated with short-lived audience-scoped service credentials. Keep this distinct from operator/admin access. A hostname or `/internal` path is not an access-control boundary.

Bind the assertion to issuer, audience, intended actor/context, method/path, request hash, short expiry and replay identity. Core revalidates player authorization and operation idempotency; a service assertion does not authorize arbitrary wallet grants. Strip untrusted forwarding/actor/service headers at ingress. Test direct calls, replay, altered body, wrong audience, forged actor and expired credentials. Use separate service signing material from sessions, audit HMAC and provider keys.

## 8. R2, monitoring and deploy records

Preserve the existing encrypted V4 Restic repositories and recovery passwords. Never initialize a new repository over an existing prefix or rotate credentials without testing rollback/pull/read access. Use distinct V5 backup destinations and retention policy, with independent encryption and off-host key custody. The current 2 GiB V4 repository budget is not evidence it fits PostgreSQL; size it from real dump/restore measurements and document cost/retention changes.

Retain UptimeRobot and existing mail alerts, then add V5 public health and private detailed telemetry. Record real alert-delivery/recovery tests. Flip GHCR visibility back only if current state requires it and authenticated deployments can still pull exact digests; repository privacy and package privacy are separate settings.

Environment inventory and release manifests must include service deployment IDs/digests, config/schema versions, provider IDs/regions, domains, secret-reference identifiers, backup targets, resource caps and owner. They must not contain raw secrets. See [operations](06-CI-SECURITY-AND-OPERATIONS.md) and [cutover](07-CUTOVER-AND-LEGACY-COMPATIBILITY.md).
