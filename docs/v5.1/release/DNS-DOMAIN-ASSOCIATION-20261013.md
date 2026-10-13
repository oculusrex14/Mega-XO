# P3 DNS / domain association — prepared, not attached (2026-10-13)

Prepared the `megaxo.online` domain association for the Vercel website/API projects **without
changing DNS or cutover**, per the "keep indexing and public domain cutover under the final launch
approval" rule.

## Current DNS state (read-only)

| Name | Observed |
| --- | --- |
| `megaxo.online` NS | `cosmos.dns-parking.com`, `nova.dns-parking.com` (Hostinger parking) |
| `megaxo.online` A | `2.57.91.91` (Hostinger parking page) |
| `api.megaxo.online` | no record |
| Vercel account domains | `culturebid.lol`, `bidception.lol`, `foundersbid.lol`, `bidthrone.lol`, `godfin.dev` — **no `megaxo.online`** |

So `megaxo.online` is registered and parked at Hostinger; it is not yet a Vercel domain and the
apex still serves a parking page. The **new public website must stay separate from the V4 origin**,
and V4's single ingress (`play.antimatterinnovations.com`) is untouched.

## Vercel projects ready to receive the domain

- `mega-xo-web` (root `apps/web`, static P21 bundle) — preview verified.
- `mega-xo-api` (root `apps/api`, stateless control plane) — preview bootstraps real sessions against
  staging Neon.

## Exact owner actions (one-time, when launch is approved)

The domain is at Hostinger. Either path is valid; both require the owner's DNS authority:

1. **Move nameservers to Vercel** (recommended for a clean Vercel-managed zone): in Hostinger, set
   `megaxo.online` NS to `ns1.vercel-dns.com` / `ns2.vercel-dns.com`. Then in Vercel add the domain to
   the `mega-xo-web` project and the API subdomain to `mega-xo-api`.
2. **Keep Hostinger DNS and add records**: point `megaxo.online` apex `A`/`ALIAS` at Vercel, add
   `CNAME www` and `CNAME api` to the Vercel-provided targets, and keep the existing mail records
   (MX/SPF/DKIM/DMARC) untouched.

`megaxo.online` association is added to `mega-xo-web`; `api.megaxo.online` to `mega-xo-api` (the app
manifest already carries `api.megaxo.online` as the token issuer). **Do not** attach the apex while
the origin is still V4: the apex currently serves the parked page, not V4, so pointing it at the Vercel
website is a website launch step, not a production-authority change — but it must still follow the
final launch approval and the noindex hold described in `apps/web/vercel.json` (`X-Robots-Tag:
noindex` on every page until release).

## Not done / gated

- No DNS record changed, no nameserver moved, no domain attached, no indexing change.
- The final apex cutover waits on the owner go/no-go together with the production authority transfer
  (P8). The website's `noindex` hold stays in force until then.
