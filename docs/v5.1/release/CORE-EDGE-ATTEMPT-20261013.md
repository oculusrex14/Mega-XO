# P3 public Core edge attempt — Tailscale Funnel blocked by upstream bug (2026-10-13)

## Goal
Publish the signed Oracle Game Core ingress so the stateless Vercel API can reach it over HTTPS,
without exposing the website/`/api`/`/auth` surface and without a production ingress change.

## Approach taken (owner-approved: "Tailscale Funnel, Core-only listener")
1. `scripts/v51/core-edge-proxy.cjs` — a loopback-only path filter that forwards **only** `/ingress/*`
   to the single existing Core instance (`127.0.0.1:8085`). Every other path returns a real 404
   (`CORE_EDGE_PATH_FORBIDDEN`). One Core / one Redis queue namespace preserved; adds no authority
   (Core still enforces its HMAC assertion, drift, body bound, durable idempotency).
2. Deployed it on the host at `127.0.0.1:8096` (verified: `/` → 404, `/ingress/leaderboard` →
   Core's `REQUEST_EXPIRED`, identical to a direct `:8085` call).
3. `sudo tailscale funnel --bg --https=8443 http://127.0.0.1:8096` — registered cleanly;
   `AllowFunnel: {"command.tail95c48c.ts.net:8443": true}`; 443 `/` (website) left tailnet-only.

## Result: FAILED — upstream Tailscale defect
Funnel registers on the machine but **no public DNS record is ever provisioned** for the tailnet
hostname:

```
dig @ns1.dnsimple.com command.tail95c48c.ts.net A     -> NXDOMAIN (SOA only)
Google DoH     command.tail95c48c.ts.net A            -> Status 3 (NXDOMAIN)
Cloudflare DoH command.tail95c48c.ts.net A            -> Status 3 (NXDOMAIN)
tail95c48c.ts.net NS                                  -> NXDOMAIN (no delegation at all)
```
Watched ~8 minutes across 20 polls (22:28–22:35): NXDOMAIN throughout. Tailscale's own funnel
infrastructure resolves (`login.tailscale.com` → 192.200.0.x), so the defect is specific to this
tailnet's public delegation, not propagation delay. `tailscale cert` succeeds (DNS-01), so the cert
path and the DNS-record path fail independently — exactly the reported bug.

**Matches tailscale/tailscale#21502** (open, 2026-09-27; same Tailscale version 1.102.2; node host
NXDOMAIN at authoritative nameserver; cert OK; funnel config OK; also #7103, #18652, #20823).
A second reporter opened TSS-105151. This is server-side and cannot be fixed from the machine.

## State left behind (safe, reversible)
- Host `127.0.0.1:8096` Core-only proxy: **running** (ready for wiring once a public endpoint exists).
- Funnel 8443: **disabled** (`tailscale funnel --https=8443 off`). 443 `/` website unchanged.
- No DNS, no production ingress, no Vercel env changed. No secret read or printed.

## Constraint discovered for any fallback
- Public TCP from the Mac: `80` OPEN, `443` OPEN, `8443` closed/filtered.
- The production Caddy edge (`mega-xo-production-edge-1`) is the sole 443 listener and currently
  serves V4 (`{$MEGA_HOSTNAME}=play.antimatterinnovations.com` → `app:8080`). It mounts the Caddyfile
  from `/tmp/mega-release-f1e5577/deploy/Caddyfile`.
- `play.antimatterinnovations.com` already A-records to the host (public), and `command` is the
  Tailscale peer name for the same machine (`100.64.128.46` ↔ `129.80.67.164`).

## Viable paths to close P3 (need one decision)
1. **Reuse the existing public production edge on 443, path-scoped** — add a Core-only site block that
   routes `/ingress/*` to the host proxy (`host.docker.internal:8096`) and 404s everything else. No new
   DNS, no new cert. Risk: edits the file Caddy serves for live V4; mitigated by `caddy validate` +
   isolated reload + instant path-level revert.
2. **Custom domain via the owner's Hostinger DNS** — the CLI currently has working write access
   (`hostinger dns records list antimatterinnovations.com` succeeded; `update`/`snapshots` available).
   Create e.g. `core.play.antimatterinnovations.com → 129.80.67.164`, add a Caddy site block (auto TLS).
   Risk: a live DNS write to a production zone; needs separate owner approval.
3. **Wait for Tailscale to repair the tailnet's public DNS** (their bug), then Funnel works unchanged.
