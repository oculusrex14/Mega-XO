# Hosting and account discovery — 2026-10-12

This is a sanitized read-only inventory for R10, with R18 release and R02 support notes. It records account access and provider state, not provider approval, production readiness, or application acceptance. No account, project, database, DNS, billing, or deployment state was changed.

The evidence JSON is [hosting.json](evidence/20261012-provider-discovery/hosting.json). It was initially prepared in the isolated website worktree at SHA 222e6ded787ddc47367108d7573c6709c3dc01a8, based on f0a3144466e3e738c1ba9e4833691c21eeeb24af. External provider state is not source or build provenance. The earlier owner report that no V5 staging site served is superseded by Main's corrected private HTTP origin and the [tailnet frontend verification](evidence/20261012-staging-review/STAGING-READONLY-20261012.md): 140/140 public files match frontend source f4851a5 and bundle 8167f349. Backend/process boot identity, HTTPS and authenticated browser acceptance remain unverified. The Vercel inventory still found no Mega XO project or deployment; private Main-hosted staging is a separate environment.

## Vercel

The installed Vercel CLI is 63.1.0 and authenticated successfully as the previously verified intended account. The explicit current team scope is `oculusrex14s-projects` on Hobby. Read-only commands ran from `/tmp`; the repository was not linked. There are three projects in this team scope, but none matches Mega XO. Names and URLs for unrelated projects are omitted.

The scoped CLI project filter returned `project_not_found`; the filtered Vercel connector query returned zero Mega XO projects and zero matching deployments. This supersedes earlier personal-scope or single-project interpretations. No target project exists, so its region, project-specific limits, current usage, production capacity, and recovery readiness are unknown. Usage and cost were not queried in this verification; a previously recorded Oct 1–12 query returned “billing cost data unavailable,” which does not establish zero usage or cost. Existing CLI authentication worked, so MFA was not a blocker for this read-only inventory.

Current official Vercel documentation limits Hobby to personal, non-commercial use. This is provider policy, not a legal determination, and it does not qualify as commercial hosting for Mega XOXO. Published included usage includes 100 GB of fast data transfer, 1 million CDN requests, 4 active CPU-hours, 360 GB-hours of provisioned memory, and 1 million function invocations per month. The published project limit is 200 and the deployment limit is 100 per day. Hobby is a free tier with no billing cycle; Vercel says most exceeded limits pause use until 30 days have passed.

Vercel Pro is a concrete priced option at a $20/month platform fee, including one deploying seat and $20/month usage credit. Additional owner/member seats are $20/month each; viewer seats are free. Usage can incur on-demand charges after the monthly credit, and applicable taxes are extra. Because no Mega XO project or workload exists yet, total hosting cost cannot be estimated from this account inventory. This is public price context only; no upgrade, trial, purchase, or billing change occurred.

- [Vercel Hobby plan](https://vercel.com/docs/plans/hobby)
- [Vercel general limits](https://vercel.com/docs/limits)
- [Vercel Pro plan and pricing](https://vercel.com/docs/plans/pro-plan)
- [Vercel Terms of Service](https://vercel.com/legal/terms)

No Vercel project was linked or created, and there was no deploy, domain change, environment-variable read, trial, plan upgrade, or purchase. Unrelated project names, deployment URLs, and account identity fields were excluded from the evidence record.

## Neon, Redis, DNS, and search

The initial Neon page was in the personal scope and showed zero projects. Switching to the Antimatter Innovations organization displayed three projects whose IDs match the repository environment JSON files. This supersedes the earlier personal-scope interpretation.

| Environment | Project | Project ID | Region | Plan | Overview limits observed |
|---|---|---|---|---|---|
| Dev | mega-xo-v5-dev | silent-unit-55400508 | AWS us-east-1, N. Virginia | Free | One main branch; 0.25 CU; six-hour history; one database and compute |
| Staging | mega-xo-v5-staging | lively-shadow-52629967 | AWS us-east-1, N. Virginia | Free | One main branch; 0.25 CU; six-hour history; one database and compute |
| Production | mega-xo-v5-production | blue-sun-85454968 | AWS us-east-1, N. Virginia | Free | One main branch; 0.25 CU; six-hour history; one database and compute |

Each overview showed 0 kB object storage and no IP restrictions. I did not open a database connection or query data. The production project’s existence does not establish production authority, capacity, recovery, or approval.

The authenticated Upstash Personal workspace lists one Redis resource, mega-xo-v5-staging, on Free Tier in AWS us-east-1, N. Virginia, with TLS enabled. The displayed limits were 500,000 commands per month, 10 GB bandwidth, and 238 MB storage; the displayed usage was 1.3k commands, 156 KB bandwidth, 0 B storage, and $0.00. No keys or values were read, and no endpoint or token was copied. No team workspace was present.

Hostinger hPanel is not currently verified. The earlier browser sign-in reached GitHub OAuth consent for read-only email-address access; the consent was not submitted. The owner authorized that routine read-only sign-in, but when I resumed, the existing CUA tab no longer resolved (`No tab with id: 1438672139`). Per parent instruction, I did not retry browser access repeatedly. This is a browser-session availability blocker, not a Hostinger refusal or proof that no account exists. No Hostinger MCP inventory tools are exposed in this task. Historical Hostinger CLI evidence from October 7 listed megaxo.online and antimatterinnovations.com as domain objects, with no hosting/VPS orders visible in that historical view; current registrar, DNS, and hosting status still need verification.

Cloudflare’s direct login page rendered a last-used Google profile, but the intended identity could not be independently matched. The profile was not selected, and no Cloudflare account or zones were verified.

The previously authenticated Google Search Console session listed only the godfin.dev Domain property. No Mega XO domain property was observed. No property was created and no sitemap was submitted.

## R10 decision and next safe actions

The release register remains R10 BLOCKED_DECISION. The verified accounts do not yet establish a commercially eligible hosting plan, target-region selection, realistic capacity or recovery, or owner-approved costs. The current Vercel Hobby terms rule out Hobby as commercial hosting. Neon and Upstash target resources are Free tier and have not been load-tested or approved for production. DNS ownership is not currently verified in Hostinger or Cloudflare.

Next, verify the intended Hostinger and Cloudflare account scopes, then select a commercially eligible hosting plan and target region after capacity and recovery requirements are defined. The owner must approve any paid cost before a plan or resource changes. Do not interpret account existence, a free resource, or a public price as provider or release approval.

## R18 release hold

R18 remains BLOCKED_RELEASE. The current P21 checklist still has null store URLs. Search Console property creation, ownership verification, sitemap submission, live domain/cache/CSP changes, publication, and indexing remain held until explicit publication approval. Preserve the noindex/release hold. After release approval, verify the deployed canonical URLs, headers, redirects, crawl policy, sitemap, webmaster ownership, real store links, and approved company backlink. Do not infer publication readiness from these account observations.

## R02 support

The prior read-only GitHub settings inspection found no classic branch protections or rulesets. This was not reverified in the Vercel CLI pass and no protection configuration changed here. R02 still needs current required-check and permission review before any protection setup.
