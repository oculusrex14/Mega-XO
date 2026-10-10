# P21 Web decisions and issues

| ID | Decision | Basis / implication | Status |
|---|---|---|---|
| P21-D001 | Branch `V5.1` from `V5-platform`, not `main` | On 2026-10-10 `V5-platform` is 454 commits ahead / 2 behind main; preserve integration work; no merge/deploy | ACCEPTED |
| P21-D002 | Generated Image 1 is the exact-look **visual** authority, with owner-uploaded emblem source as brand-art authority | Keep background mountains, cards, hero composition; don't rebuild a screenshot as one image | ACCEPTED |
| P21-D003 | Keep game economics/tiers/themes/server authority from approved product contracts | Screenshot contains old illustrative statistics, “Diamond II”, older season date | ACCEPTED |
| P21-D004 | Namespace `mx-web` theme tokens separately | Preserve four existing game theme contracts | ACCEPTED |
| P21-D005 | Art originals tracked with immutable checksums; source binary upload must be verified before claiming Git archival | Source files mounted in conversation; repo text operations do not prove raw image transfer | OPEN |
| P21-D006 | Official wordmark spelling: MEGA XO vs artwork’s MEGA XOXO | Existing site and product say Mega XO; uploaded artwork shows MEGA XOXO. Must approve a new lockup or keep artistic artwork separately | AWAITING OWNER |
| P21-D007 | New website frontend deploys to Vercel, reuses V5 API, Game Core and single identity/data authority | No new SQLite writer, parallel identity, experimental premium currency policy, or unverified production DNS | PLANNED |
| P21-D008 | Phase 1 is complete only after vectors, approved lockup, source artwork, previews and accessibility QA | Code/design token existence is not final artwork approval | ACCEPTED |

## Outstanding
- Supply approval for MEGA XO header wordmark vs logo artwork’s MEGA XOXO.
- Transfer exact PNG originals into Git repository via binary-capable path; link SHA and commit.
- Produce first clean unlettered layered background using reference image as visual target; compare for fidelity before further 3D/video production.
- Verify actual V5 web API/realtime callback endpoints before application wiring.
- Do not deploy V5.1 or treat original V5 “deferred P21” ledger as retroactively changed.
