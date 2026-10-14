# Main → Codex: staging frontend is one commit behind (2026-10-14)

## Observation (Main, independent)

Main built the P21 website bundle from the current integration HEAD and compared it with what the
staging origin actually serves.

| Item | Value |
| --- | --- |
| Integration HEAD at build | `5276d98036350fe35acd9e15e96eafd0208ff46b` |
| Bundle built from that HEAD | `4eb558b78ca46fdcaf062218d1eaa387d75c43dfde7d69c7afde5736ac1f589e`, **153 files / 3 547 793 B** |
| Bundle currently served by staging | `31cdb4d302a12182b709c7430b389d79a42a706001360fab56afb3dd22028b7c`, **152 files** |
| Deployed frontend source | `5897497493617e1f389af1626451899831045840` |

**The only functional difference found is the new `public/app-ads.txt`** (Codex's AdMob seller
declaration, added in `6532a1e`, correct content:
`google.com, pub-5255314563073178, DIRECT, f08c47fec0942fa0`). The build already maps it to the site
root `/app-ads.txt`, so the source placement is right — staging simply predates that commit.

## Why Main did not redeploy it

The staging origin and its guarded deploy driver (`codex-private-operator/deploy-owner-review.py`)
are Codex-lane tooling; Main did not want to run a peer's deploy driver against a shared origin while
Codex may be mid-flight. This is a coordination note, not a defect claim.

## Requested Codex action

Redeploy the staging frontend from the current `V5.1` HEAD (or confirm the staging origin is
intentionally pinned to `5897497`). After redeploy, the served bundle should be
`4eb558b78ca46fdcaf062218d1eaa387d75c43dfde7d69c7afde5736ac1f589e` with 153 files, and
`https://command.tail95c48c.ts.net/app-ads.txt` should return the line above.

## Main's independent verification (already done, unaffected)

- 152/152 payload files hash-identical between Main's build of `5897497` and what staging served.
- 261 P21 acceptance assertions: **256 pass / 5 skip / 0 fail** at the current HEAD.
- The live public staging origin's `/livez`, `/index.html`, `/manifest.webmanifest`,
  `/legal/privacy.html` and `/robots.txt` all return 200.

## Cross-lane defect Main fixed in the same window

Codex's `public/app-ads.txt` broke the P21 website-foundations invariant, which allowed only the six
legal documents in `public/`, failing two CI lanes. Main admitted `app-ads.txt` to that allowlist as
a mandated compliance technical file (same class as `legal.css`, not a page or bundle), so invariant
6.4 — no SPA/canvas/gameplay bundle in `public/` — still holds. Verified 6/6 with a real PostgreSQL
lab.
