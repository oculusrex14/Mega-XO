# Codex → Main: V5.2 provider and website integration

Owner mission: final V5.2 website and genuine store submission, received 14 October 2026.
V5.1 is frozen at `077bfbc`; new Codex work is isolated in the managed
`v52-provider-release` worktree. Main's active checkout and training files are untouched.
Main integrated the guarded website UI at `1c0746b` / `ad847de` and redeployed its bundle.
This packet records that source integration, not a production-cutover acknowledgment.

## Observed release boundary

- Read-only Oracle probe on 14 October: `/opt/mega-xo/current-image` still names
  `ghcr.io/oculusrex14/mega-xo@sha256:71d33a1a9893a303c5ffcbdb090caefde22d9e7e054a8c2d6c494a44919b58e4`.
- The earlier staging frontend `5897497` / `31cdb4d3…` is superseded by an independent
  14 October HTTPS manifest probe: `ad847dea17c8becc2ac4f3dbbd2654e05c379fe4`,
  `d9e281c01003bf61082692258297fbeea692790f55daeaa19f63c0ae0cbdae31`, 160 files /
  3,685,921 bytes. `/livez` and `/readyz` both return 200 / ready. Main records the
  deployment in `STAGING-V52-DEPLOYED-20261014.md`; this is the frontend identity.
- Public `/privacy` and `/app-ads.txt` at `megaxo.online` are parking HTML. No V5.2
  public website, store submission, production writer change or DNS change is claimed here.
- Vercel account is the existing `oculusrex14s-projects` / Hobby. Web project
  `prj_PBLPF0V2wDsVC5hV83im2EatwKbI` has no Git link, null root, and an app-relative
  build command. API project `prj_y2zGwwGwk3zVdP6sevw5S3z5qN65` has root `apps/api`.

## Main acknowledgment and inputs needed

1. **Final store identity.** Owner requests `online.megaxo.xoxo`; Apple has registered it under
   paid Individual Team `6N6C9338NX`, with App Store Connect Apple ID `6822833387`
   (Prepare for Submission; manual release). Play's availability check passed, but app creation
   still requires the account holder's precise policy/signing/export declarations. The archived signed Android
   AAB instead declares `online.megaxo.game` (SHA-256
   `3e61f4d05842acd38bfa123186727fd350fbca95ecd629c4911e8ea7e6498933`). Apple source still
   uses the temporary prototype. Please acknowledge the owner-selected `.xoxo` IDs and produce
   aligned signed release artifacts.
   The current `.game` AAB will not be uploaded as an implicitly approved identity change.
2. **Current staging contract.** Exact running backend SHA/boot identity, HTTPS/API/WSS URLs,
   applied schema, feature-state manifest and protected test-account/OTP workflow. Preserve
   accounts and stable signing/OTP secrets. Codex does not substitute old V4 for V5.2 acceptance.
3. **Power adapter integration.** Main has implemented `src/powers-ui.js` and integrated the
   guarded website presentation. The deployed browser still has no native reward provider;
   the adapter explicitly refuses unshipped kinds. Main owns native earned signals, Core
   entitlements and request/counter authority. Freeze the verified actor/match context and
   inventory reservation representation before enabling website controls; token/null
   reservations must not be silently read as numeric zero. Browser, native and authoritative
   cross-match acceptance remain separate.
4. **Research account routes.** Migration 0052 implements adult choice/withdrawal, but the
   inspected route manifest has no authenticated client read/write/withdrawal contract.
   Please freeze those routes, notice version, age-band meanings, response and revocation
   behavior. Codex will wire the single account choice, never infer a grant from a missing row.
5. **Release readiness.** Exact V5.2 release SHA, production image/schema, API and ticketed WSS
   endpoints, cookie/CSRF/origin contract and Main's technical switch acknowledgment. Do not
   point production API at historical staging Core. Codex prepares the website/DNS candidate
   and publishes with Main's single-writer cutover, not before it.
6. **Provider verification.** Proven production AdMob SSV callback and negative/idempotency/
   actor-ticket tests; current Resend secret-file integration and normal V5 email flows;
   native test-ad/UMP/ATT evidence; review accounts; signed AAB/IPA SHA and feature manifest.
   Secrets, credentials and OTPs stay outside Git and ChatGPT evidence.

## Responsibilities and holds

Codex uses separate Luna Max agents for Play, Apple, AdMob and hosting, scheduled within the
four-slot runtime; Sol owns the scoped web power presentation. Each lane writes separate
evidence files. Main retains backend, native builds, database authority and cutover.

New payments, paid trials, upgrades and chargeable overages remain unauthorized. Hobby is retained
for the current noncommercial project. Enabling commercial ads/purchases requires a permitted
hosting arrangement; Vercel's [fair-use definition](https://vercel.com/docs/limits/fair-use-guidelines)
includes advertising a sale and advertisements. No plan upgrade was made.

Owner has approved the repository's suggested USD base prices: `crowns_100` $0.99,
`crowns_525` $4.99, `crowns_1100` $9.99, and `remove_ads` $3.99, with store-localized
equivalents. The Apple agent reports all four base schedules saved; the console receipt records
the exact outcomes. This approves configuration, not a real charge or live commerce. The owner
confirmed existing Apple identity/address and supplied private proof for Apple. Final legal
certifications, verification challenges and the Paid Apps Agreement remain distinct steps.

Store fields must match the actual shipping SDK/data behavior. Native Debug installs, signed
artifacts, draft console records, testing submission, production submission and LIVE remain
separate states. The genuine new-Personal-account Play closed-test wait cannot be simulated.
