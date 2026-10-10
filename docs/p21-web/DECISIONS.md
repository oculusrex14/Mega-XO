# P21 Web decisions and issues

| ID | Decision | Basis / implication | Status |
|---|---|---|---|
| P21-D001 | Branch `V5.1` from `V5-platform`, not `main` | On 2026-10-10 `V5-platform` is 454 commits ahead / 2 behind main; preserve integration work; no merge/deploy | ACCEPTED |
| P21-D002 | Generated Image 1 is the exact-look **visual** authority, with owner-uploaded emblem source as brand-art authority | Keep background mountains, cards, hero composition; don't rebuild a screenshot as one image | ACCEPTED |
| P21-D003 | Keep game economics/tiers/themes/server authority from approved product contracts | Screenshot contains old illustrative statistics, “Diamond II”, older season date | ACCEPTED |
| P21-D004 | Namespace `mx-web` theme tokens separately | Preserve four existing game theme contracts | ACCEPTED |
| P21-D005 | Exact master references are versioned in Git | Reference PNG blobs archived in `assets/p21/reference/` (`a158389`); SHA-256 matches the uploaded originals | ACCEPTED |
| P21-D006 | Brand is officially **Mega XOXO** for web, Android, iOS and customer-facing copy | Owner confirmed 2026-10-10 due to conflicting use of Mega XO; reference screenshot still depicts original design | ACCEPTED |
| P21-D007 | New website frontend deploys to Vercel, reuses V5 API, Game Core and single identity/data authority | No new SQLite writer, parallel identity, experimental premium currency policy, or unverified production DNS | PLANNED |
| P21-D008 | Phase 1 is complete only after vectors, approved lockup, source artwork, previews and accessibility QA | Code/design token existence is not final artwork approval | ACCEPTED |

| P21-D009 | The four logos map to the existing themes, with alpha PNG masters, 768px WebP, and 256px emblem crops | `assets/p21/logos/`; code retains the original appearance IDs; native bundle explicitly allowlists eight WebPs | ACCEPTED |
| P21-D010 | Preserve immutable package IDs, identity keys, signing labels, domains, migrations and historic V5 acceptance records | App Store / Google Play display metadata, official store titles and OAuth consent names must be reviewed independently before release | ACCEPTED |

## Outstanding
- Release/store-provider branding: verify Google Play / Apple listing names, OAuth consent-screen names, email sender configuration and screenshots with authorized owner; no bundle/package ID mutation.
- Run and record browser and native CI on V5.1; don't infer device/store approval from source commits.
- Clean unlettered PNG/WebP background now implemented; independently editable scene layers remain open. Compare actual website before further 3D/video production.
- Verify actual V5 web API/realtime callback endpoints before application wiring.
- Do not deploy V5.1 or treat original V5 “deferred P21” ledger as retroactively changed.

## 2026-10-11 website implementation

| ID | Decision | Basis / implication | Status |
|---|---|---|---|
| P21-D011 | Use static ESM/DOM/CSS for this isolated cinematic frontend | Existing game is framework-free; pure rules and retained assets remain unchanged. Smaller dependency surface; Vercel configuration is static. Earlier React/Vite/Next wording was provisional. | IMPLEMENTED |
| P21-D012 | Present true guest state and a clearly labeled practice board | Screenshot balances, Diamond II, season dates and clocks are illustrative, not player data. No fabricated service state or action outcome. | IMPLEMENTED |
| P21-D013 | Route online/account actions to retained client while live V5 integration is open | No new credential collection or identity/economic writer. Local practice grants nothing and does not alter account state. | IMPLEMENTED / ONLINE OPEN |
| P21-D014 | Retain generated PNG masters, optimized WebPs and self-hosted licensed fonts | Four generated still illustrations plus procedural DOM/SVG art reproduce the static composition; no 3D/video/audio asset claim. | IMPLEMENTED / EXTENDED PACK OPEN |
| P21-D015 | Automated presentation results are Chromium/local evidence | 27 route designs, 4 viewport matrix, keyboard/board/theme checks and axe; actual device/providers/production remain separate. | TESTED_LOCAL |

Code checkpoint and acceptance levels: [IMPLEMENTATION-AND-READINESS.md](IMPLEMENTATION-AND-READINESS.md).
