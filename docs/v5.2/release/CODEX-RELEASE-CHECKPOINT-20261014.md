# V5.2 provider/browser release checkpoint — 14 October 2026

Codex work is on `codex/v52-provider-release`. [PR #14](https://github.com/oculusrex14/Mega-XO/pull/14)
was merged into V5.2 at 17:40:33 UTC on 14 October (merge `1c0746b`). Main's trunk advanced to `939d299`: it merged Codex's guarded UI at
`1c0746b` / `ad847de` and recorded the staging redeploy. Source integration is therefore
confirmed by Git history; a production technical-switch acknowledgment remains outstanding.
Main's checkout, database, signing material and training work were not changed by Codex.

## Completed, with evidence categories

| Lane | Actual outcome | Evidence |
| --- | --- | --- |
| Apple account | Paid Individual membership verified, Team `6N6C9338NX` | `provider-evidence/20261014/apple/ACCOUNT-ACCESS-20261014.md` |
| Apple application | Registered `online.megaxo.xoxo`; ASC Apple ID `6822833387`; version 1.0.0 **Prepare for Submission**, manual release; saved subtitle/category/local game copy | `apple/REGISTERED-APP-20261014.md`, `apple/ASC-APP-READINESS-20261014.md` |
| Apple products | Four catalogue IAP drafts created; approved USD base prices saved; **no review submission or live sale** | `apple/ASC-BUSINESS-IAP-DRAFTS-20261014.md` |
| Play | Existing Personal account accessible, empty app list; `.xoxo` availability check passed; unsaved app form prepared | `play/CONSOLE-AND-LISTING-DRAFT-20261014.md` |
| AdMob | Exact two apps/four units reverified; both Require review; SSV blank, no UMP messages; no serving changes | `admob/ADMOB-READINESS-20261014.md` |
| Resend | Existing verified domain and Free limits rechecked; historical Delivered events separated from V5 acceptance | `resend/READ-ONLY-ACCEPTANCE-20261014.md` |
| Google Cloud | Approved business account verified; generic project `silken-obelisk-511505-b2` has no OAuth clients/Auth Platform setup; no duplicate project created | `google/CLOUD-OAUTH-DISCOVERY-20261014.md` |
| Monitoring | Real synthetic HTTP monitor incident and recovery, provider sends and exact receiving Inbox rows verified; existing incidents retained | `hosting/UPTIMEROBOT-DRILL-20261014.md` |
| Powers UI | Committed `5c57fbe`: read-only, fail-closed inventory/Undo presentation and adapter boundary; unavailable authority never grants an item or reveals a Tactical hint | `powers/README.md`, exact source hashes and labeled local fixtures |
| Website | Committed payload at `599dcf9882485983340e19b4063d0b85f8eb0883` tested in three local engines; backend/public release not asserted | `website/summary.json` and engine reports |

Paths above are relative to `docs/v5.2/provider-evidence/20261014/` unless the full prefix is shown.
Earlier observations are retained and explicitly superseded by subsequent provider receipts.

## Exact website artifact and checks

- Source `599dcf9882485983340e19b4063d0b85f8eb0883`; generated bundle
  `745d305d6ffb63e6f9f79094ff4e96f474b77402a0039bbc84fef9db16f75935`, 158 files / 3,625,433 bytes.
- Chromium, Firefox and WebKit: **890 assertions each, 0 failures**, same immutable artifact,
  desktop/tablet/390/320px, synthetic fixtures and guest paths. These are local engine passes,
  not physical browser/device or real account/game acceptance.
- Website/powers unit regression: **270 pass / 0 fail / 5 skip**. The five skips require an owned
  PostgreSQL/Redis integration lab; no staging/live database was substituted.
- Axe: **131 automated checks pass**, 112 views retain incomplete/manual findings (including
  image/gradient contrast). No physical VoiceOver/TalkBack claim.
- Sol's 85 targeted unit tests overlap the regression; its 185 five-theme fixture checks and
  20 labeled screenshots are separate local presentation evidence, not enabled powers.
- The initial missing local `pg` dependency and missing Chromium executable were real failed
  setup attempts, corrected by installing dependencies only in this isolated checkout. The
  zero-check launch attempt and logs remain locally retained; they are not counted as passes.

## Actual public/staging state and release holds

`megaxo.online` still serves Hostinger parking HTML. Hostinger snapshot `188085401` and the full
three-record pre-change zone were recorded; no DNS write occurred. `api.megaxo.online` has no DNS
record. HTTPS CLI to `core.megaxo.online/livez` returned 404 with certificate verification intact;
this establishes a TLS response, not signed Core readiness. CLI V4 `/livez` returned 200, while
UptimeRobot's legacy regional checks still report timeout incidents. Their history was not erased.

The earlier staging PID/frontend observations are superseded by the 14 October 17:41:47 UTC
restart: PID `3486476`, entry SHA-256
`f73e8a0c8d49ccfe6666583d8a2b0f4aa055a151cf2d6f1d7df3d715b8740c69`.
The archive checkout still cannot report a Git HEAD; no whole-backend source SHA was invented.
Independent HTTPS and host-file probes agree on frontend `ad847dea17c8becc2ac4f3dbbd2654e05c379fe4` /
`d9e281c01003bf61082692258297fbeea692790f55daeaa19f63c0ae0cbdae31` / 160 files / 3,685,921 bytes.
Both `/livez` and `/readyz` return 200 and ready. The earlier 152-file bundle is historical.
Main's deployment and temporary first-deploy failure are retained in its separate receipt.

The [Main integration handoff](CODEX-PROVIDER-INTEGRATION-HANDOFF-20261014.md) lists exact inputs:
aligned `.xoxo` signed AAB/IPA and hashes; backend source/boot/schema/features; secure staging
accounts/OTP transport; actual powers/consent/counter routes; real OAuth and callback implementation;
Resend flows; production API/WSS/cookie/CSRF contract; Main's technical publication switch.
Existing root rewrites do not connect website API/OAuth/WSS to a verified production backend.

Remaining source/integration gaps: web OAuth callback is a redirect stub, native billing and
production API configuration remain unverified, and adult-only public account wording conflicts
with the owner's teen/general eligibility plan. Main subsequently added native ad bridges and
the powers adapter; the earlier claim that all ad hosts were unwired is superseded for that source
slice, without implying device/SSV/production acceptance.
The public/in-product research choice must be wired before day-one optional research can be enabled.

## Provider-only conditions and current owner inputs

- Play's new Personal account requires a genuine closed test with 12 continuously opted-in testers
  for 14 days before production access. No tester, opt-in, elapsed day, test release or submission
  has been fabricated. Creation also needs the account holder's policy/signing/export declarations.
- Owner confirmed existing Apple Individual legal details, authorized use of existing contact
  details for EU preparation, and supplied a private address-proof document for Apple. Codex
  explained why planned IAP/advertising/business activity supports Trader preparation. Final
  provider legal certification and any contact verification challenge remain unfinished. No
  private address, phone, document path, financial data or government identifier is recorded here.
- Owner approved USD base prices: 100 Crowns $0.99, 525 $4.99, 1,100 $9.99, Remove Ads $3.99;
  localized amounts come from the stores. All four Apple base prices were reported saved in
  the existing draft records. This is not approval for a real test charge, new plan or live sale;
  availability remains unconfigured and provider approval remains pending.
- Paid Apps Agreement is New; banking/tax/legal acceptance remains unfinished. No signed release
  build has been uploaded. **Neither store has a release submitted for review.**
- Vercel remains Hobby for the currently noncommercial project. No current paid upgrade is added
  as a base-game blocker. Commercial ads/purchases require permitted hosting before activation;
  no Hostinger hosting subscription/site exists in the read-only inventory. No billing change.

## Independent CI result — do not hide the red lane

At SHA `599dcf9`, 18 PR checks passed; **Android failed** in
[`Assert original offline permission boundary and exact bundle`](https://github.com/oculusrex14/Mega-XO/actions/runs/38604719874/job/115992539235).
Both debug APK builds succeeded; the assertion printed `android.permission.INTERNET` then exited 1,
and emulator acceptance was skipped. The native manifest explains this permission as needed for
owner-authorized local LAN; the workflow still rejects any INTERNET permission. Main must reconcile
the intended flavor boundary and prove private-LAN restrictions, not simply loosen a security gate.
Codex did not edit native permissions, workflow checks, grants or game authority to make CI green.

Rollback: reject/revert the scoped frontend commit; retain provider records and monitoring history.
Before any future DNS change use the recorded zone/snapshot, and coordinate Core single-writer
authority with Main. No staging credentials, backups, account state or V4 recovery were overwritten.


## Superseding checkpoint — 15 October 2026

- Main advanced V5.2 to `efeba70`, including the post-review power/consent fixes and forward-only
  migration 0053. Codex merged this into its isolated branch without resetting or rebasing Main.
- Independent HTTPS probes now identify staging frontend `3752383c4f4f8343ad6aeb00d2434beec3ef96f6`,
  bundle `17b1d88e423d2aa4727a086b5908c7e8317b7594bcb7f04ec89a7a06c877bfb8`, 160 files /
  3,688,654 bytes. `/livez` and `/readyz` return 200 and ready. This supersedes the earlier
  `ad847de` frontend probe; the original local engine reports retain their own exact source.
- Main's production candidate is built from `a3dc0c6058757143b3773434ff846a77c5a4b339`, image
  `sha256:d6a9ab9846d59c47df8334b987806e21d30f3d702d1c2556b49256d39ed0f2f0`. Its rehearsal
  is non-serving. V4 remains the sole live writer; this does not authorize a DNS/authority switch.
- Main corrected the historical Android CI permission assertion; the red result recorded above
  is historical, not the current branch status. Current V5.2 CI checks observed by Codex are green.
- Apple app, membership and IAP pricing receipts are now preserved in follow-up PR #15. Main's
  final-report references to unavailable console access/paid membership predate this provider
  packet. Paid membership is verified; distributable signing and aligned binaries still need Main.
- The new local Friends regression proves an error-versus-guest rendering defect and fixes it.
  The earlier apparent loading symptom was not reproduced as indefinite; it remains an observation
  requiring a timed deployed recheck. See `provider-evidence/20261015/website/FRIENDS-ACCOUNT-RETRY.md`.


### Provider handoff state at 15 October continuation

Apple's Business page currently shows DSA **In Review** (classification and submitting actor not
verified). The unchanged Individual legal-entity save attempt reached account-holder MFA; no
address proof or Paid Apps Agreement was submitted. The Mac was locked when attempting to present
the exact tab. Owner unlock and private Apple two-factor completion are pending. The registered
app/IAP drafts and approved prices remain preserved; no submission or sale is inferred.

The saved disposable staging A fixture reached verification rather than a linked profile. No OTP
was retrieved/submitted and no verified account was claimed. The normal private verification
handoff is still required before authenticated two-actor browser acceptance.

Follow-up PR #15 is the reviewable integration packet. Friends fix `d582dfe` and all sanitized
receipts are pushed on `codex/v52-provider-release`; Main's active checkout and production remain
untouched. No local source or evidence is intentionally left uncommitted.
