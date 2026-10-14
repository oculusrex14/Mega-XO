# Vercel domain association — prepared and attached (2026-10-14)

Reversible preparation executed by Main in the Codex-lane Vercel account `oculusrex14s-projects`.
**No DNS record was changed**; `megaxo.online` still resolves to its existing Hostinger parking
address, so nothing user-visible changed. This step only makes the required records explicit so the
apex/API switch is a mechanical cutover action.

## Done (account-level, reversible)

| Action | Result |
| --- | --- |
| Add `megaxo.online` to the Vercel account | created (owner `oculusrex14`) |
| Attach `megaxo.online` to project `mega-xo-web` | `attached: true`, `verified: true`, `domainOwnership: current-scope` |
| Add `api.megaxo.online` to the Vercel account | created |
| Attach `api.megaxo.online` to project `mega-xo-api` | attached |

## The exact records the owner must set at Hostinger

From `vercel domains verify megaxo.online`:

| Record | Name | Value |
| --- | --- | --- |
| `A` | `@` | `216.198.79.1` |
| `A` | `@` | `64.29.17.1` |
| `CNAME` (www) | `www` | `747232a3b9c433cc.vercel-dns-017.com` |
| `CNAME` (api) | `api` | `cname.vercel-dns.com` |

Alternative: move the nameservers to `ns1.vercel-dns.com` / `ns2.vercel-dns.com`.

Current state (Hostinger): `megaxo.online` NS = `cosmos.dns-parking.com`, `nova.dns-parking.com`;
apex A = `2.57.91.91` (parking page). Vercel reports `invalid-configuration` — expected until the
records change.

## What was deliberately NOT done

- **No DNS record changed and no nameserver moved.** The apex currently serves a parking page rather
  than V4, so pointing it at Vercel is a launch step; it is left for the owner's cutover window.
- **The V4 facade and `play.antimatterinnovations.com` are untouched.**
- **No production alias was promoted**; the website project still serves only its preview.
- The `X-Robots-Tag: noindex` release hold on the website build remains in force.

## Honest limits

Attaching a domain is not a DNS change, a certificate issuance, a production alias or a launch. Until
the records above are set at the DNS provider and the project is promoted, `megaxo.online` continues
to serve the parked page and the Vercel project continues to serve previews only.
