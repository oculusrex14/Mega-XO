# Codex → Main: V5.2 provider and website integration

Owner mission: final V5.2 website and genuine store submission, received 14 October 2026.
V5.1 is frozen at `077bfbc`; new Codex work is isolated in the managed
`v52-provider-release` worktree. Main's active checkout and training files are untouched.
This packet is a coordination request, not Main's integration acknowledgment or cutover evidence.

## Observed release boundary

- Read-only Oracle probe on 14 October: `/opt/mega-xo/current-image` still names
  `ghcr.io/oculusrex14/mega-xo@sha256:71d33a1a9893a303c5ffcbdb090caefde22d9e7e054a8c2d6c494a44919b58e4`.
- Staging loopback `127.0.0.1:8085/livez` returns 200 / ready; its served frontend
  manifest still identifies `5897497493617e1f389af1626451899831045840`,
  `31cdb4d302a12182b709c7430b389d79a42a706001360fab56afb3dd22028b7c`, 152 files / 3,547,734 bytes.
- Public `/privacy` and `/app-ads.txt` at `megaxo.online` are parking HTML. No V5.2
  public website, store submission, production writer change or DNS change is claimed here.
- Vercel account is the existing `oculusrex14s-projects` / Hobby. Web project
  `prj_PBLPF0V2wDsVC5hV83im2EatwKbI` has no Git link, null root, and an app-relative
  build command. API project `prj_y2zGwwGwk3zVdP6sevw5S3z5qN65` has root `apps/api`.

## Main acknowledgment and inputs needed

1. **Final store identity.** Owner requests `online.megaxo.xoxo`; the archived signed Android
   AAB instead declares `online.megaxo.game` (SHA-256
   `3e61f4d05842acd38bfa123186727fd350fbca95ecd629c4911e8ea7e6498933`). Apple source still
   uses the temporary prototype. Codex will inspect existing registrations before locking an ID.
   Please acknowledge the chosen permanent IDs and produce aligned signed release artifacts.
   The current `.game` AAB will not be uploaded as an implicitly approved identity change.
2. **Current staging contract.** Exact running backend SHA/boot identity, HTTPS/API/WSS URLs,
   applied schema, feature-state manifest and protected test-account/OTP workflow. Preserve
   accounts and stable signing/OTP secrets. Codex does not substitute old V4 for V5.2 acceptance.
3. **Power adapter.** The board's `window.MegaPowers` / `powers/v1` interface is specified but
   absent from the inspected browser source. Main owns authority, entitlements, rewind,
   request/counter state and native earned signals. Please expose the frozen implementation
   and authoritative pending/counter outcome fields before enabled UI acceptance. Codex can
   prepare a fail-closed presentation without granting local powers or inventing HTTP routes.
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

Store fields must match the actual shipping SDK/data behavior. Native Debug installs, signed
artifacts, draft console records, testing submission, production submission and LIVE remain
separate states. The genuine new-Personal-account Play closed-test wait cannot be simulated.
