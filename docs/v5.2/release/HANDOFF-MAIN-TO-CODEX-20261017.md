# HANDOFF — Main lane → Codex lane (2026-10-17)

**Purpose:** stop the two lanes from treading on each other. You (Codex) have been told the branch/PR
workflow wasn't used by either of us. This document states exactly what Main did, what state the repo
and production are in, and what I need from you.

**Read this first if you are about to edit:** `src/community.js`, `src/app.js`, `apps/web/pages.js`,
`src/party-ui.js`, `src/styles.css`, `docs/p21-web/ANNOTATION-IMPLEMENTATION-RECEIPT-*.md`. These are
the files both lanes have already edited (§4). Claim a file before editing it.

---

## 1. Current state (facts, verified)

| Thing | Value |
| --- | --- |
| `origin/V5.2` | the default branch, the single integration candidate (tip moves as docs land; re-resolve with `git rev-parse origin/V5.2` — this handoff itself is one such commit) |
| Working dir `/Users/oculus/Downloads/Test XO` | on `V5.2`, **0 uncommitted**, in sync with origin at handoff time |
| `main` | **does not exist** on origin — V5 is not promoted (correct) |
| `V4.1` | `455b8ec`, untouched — shipped v4.1.2 production lane |
| Other remote heads | `V5.1`, 2 × `preserve/v51-*` (deliberate archives) |
| Open PRs | **0** |
| CI | path-filtered workflows green at handoff time (gameplay capture, P15, P18, P19, PostgreSQL integration, release engineering) |
| Production `megaxo.online` | live, `/livez` ok, **but serving a ~Oct 15 build** (§5) |

Both lanes commit **directly to `V5.2`**, interleaved by time, as the same git identity
(`Main Agent <main-agent@megaxo.online>`). There are no per-lane branches and no PRs. History is
linear (two `ort` merges, no resets, no force-push).

---

## 2. What Main did (the annotation-lane review + integration)

The Codex lane handed off "13 commits based on `d6086a2`". The actual delta from Main's own last
verified head (`521e957`) was **57 commits**. Main reviewed the full delta and authored **9 fixes**,
all pushed to `V5.2`:

| # | Fix | Commit | What was broken (reproduced) |
| --- | --- | --- | --- |
| 1 | Polar `v1,` signature comma-list parsing | `811c349` | doc claimed comma-separated support; the regex only matched whitespace-separated |
| 2 | Migration fixture inserts name their columns | `20cc65c` | `8b8d811` grew `identities`/`signin_attempts`; positional INSERT aborted the **P18 V4→PG import proof** |
| 3 | Production email signup/verify write names its columns | `18035c2` | same schema growth broke `server/production/email-auth.js` — **every email signup/link/verify aborted** |
| 4 | Guard test: positional INSERTs vs schema | `1170a36` | preventive; catches the #2/#3 class when reintroduced |
| 5 | Repair two stale web test fixtures | `c1632d1` | lane added `apps/web/store.js` (imported by `app.js`); the `v5-p21-account-web` sandbox didn't spread it → 7 × `WEB_PRODUCT_IDS is not defined`; sponsors redesign left `v52-public-annotations` asserting dead markup |
| 6 | Align three frozen-contract tests | `716c5b1` | `f02f3ec` added the crown-banked `purchase` surface (pre-existing drift); `8b8d811` added the owner-decided Google `email` scope |
| 7 | Escape apostrophes in `src/community.js` | `2616d68` | raw `couldn't`/`We'll` inside single-quoted strings → the file **failed to parse**, `MegaCommunity` never loaded, browser client never reached the guest control (the real cause of the `v52-bot-tutorial` `[data-c="guest"]` timeout) |
| 8 | Mega Pass action no longer advertises a purchase hook when unavailable | `bd02ae1` | P21 browser QA `P21-BROWSER-SYNTHETIC-STORE-UNAVAILABLE` found 1 purchase action → 2 failures |
| 9 | API body ceiling = largest route contract; oversize drains not resets | `7bedd6c` | `5c37ed6` capped every body at 100 KiB so the native 300000 contract was unreachable (a legit 200 KiB body → 413) and overflow `req.destroy()` → client saw `ECONNRESET` |

Plus two preventive gates in that set: `tests/v5-schema-insert-drift.test.js` (#4) and the
legacy-script `node --check` loop added to `v35-validation.yml` (#7).

**Main's review records (pushed docs):**
- `docs/v5.2/release/V52-ANNOTATION-LANE-REVIEW-20261017.md`
- `docs/v5.2/release/V52-ANNOTATION-LANE-INTEGRATION-20261017.md`

**Also verified by Main on the lane (not owned, just checked):** migrations 0058–0060 apply cleanly
on disposable PG16 with conformance `--verify` ok and 60/60 checksums; provider-callback IP limiter
fails closed; spectator boards are structurally read-only; the member projection honours
`stats_visibility`; the Polar v1 change is fail-closed.

**Main also committed the Codex lane's unpushed work** at the owner's request: `ff14910` (sponsors
asset allowlist + review-server env) and the merge `4cb6821`. Main did **not** author or review those
16 app-UI commits.

---

## 3. What Codex did (per your own receipt)

`docs/v5.2/release/APP-UI-ANNOTATION-EXECUTION-RECEIPT-20261017.md` records APP-001…APP-022 across
`d1f3f2b`, `2c93938`, `64107ce`, `6587778`, `43ba35b`, `9013032`, `bd7e364`, `01e1e42`, `32d70fd`,
`825cb31`, `c7f08b0`, `3d6bacc`, `fe6a923`, with a new in-repo parse gate
(`tests/v5-client-bundle.test.js`, 34 scripts) and the review server on 4197. Your receipt already
notes the `2616d68` reconciliation — thank you, that is the correct call.

---

## 4. Overlap — measured, and currently NOT lossy

Files edited by **both** lanes: `apps/web/pages.js`, `docs/p21-web/ANNOTATION-IMPLEMENTATION-RECEIPT-20261017.md`,
`src/app.js`, `src/community.js`, `src/icons.js`, `src/party.css`, `src/party-ui.js`, `src/styles.css`.

Main checked every one at HEAD:
- Main's markers present: `MEGA PASS`, `Retry store check`, `pg-sponsor-preferences-panel`,
  the gated `passAvailable ? ' data-store-action` in `apps/web/pages.js`; escaped apostrophes in
  `src/community.js`.
- Codex's markers present: the full `pg-sponsor-enquiry` block (all 5 added lines) and the theme work.

**Nothing has been clobbered yet.** The risk is real but has not landed — because Codex merged
`origin/V5.2` in (`4dc164f`) before continuing, and Main merged `origin/V5.2` back (`4cb6821`).
Linear `git log` + two `ort` merges is why it survived.

Dangling-commit sweep: `git fsck` shows orphaned commits (e.g. `e80138fc`, `df8755a4`, `a60ec54a`,
`e09cc5a8`), but **every one is content-present on V5.2 under a different SHA** (rebased copies —
checked by commit subject). No genuine work is lost.

---

## 5. Production — the new website is NOT deployed

`https://megaxo.online` (Caddy, `via: 1.1 Caddy`) serves the P21 bundle from **~Oct 15**:

| Marker | Live | V5.2 build |
| --- | --- | --- |
| `Discover our supporters` (sponsors) | present | present |
| `MEGA PASS` / `data-mega-pass` / `mega-pass.webp` | **absent** | present |
| store error shell (`Retry store check`) | **absent** | present |
| served `/pages.js` bytes | 82009 | 88473 |

Live endpoint checks from the handoff's own "after deploy" list:
- `/api/monetization/status` (guest) → **404** (handoff expects 401 `AUTH_REQUIRED`)
- `/api/monetization/{polar,cashfree}/webhook` → **404**
- `/livez` ok; `/opsz` → `{"ok":false}`

So: the site is live and healthy, but running **pre-annotation code**. Nothing Main fixed or Codex
built is deployed.

---

## 6. Process change — OWNER-APPROVED (effective now)

The owner has approved this switch for all future work. Both lanes stop committing directly to the
integration branch:

1. **Codex branch:** a single general-purpose **`codex`** branch for *all* Codex work (not
   app-UI-only); open a PR targeting `V5.2`.
2. **Main branch:** `main/integration` for Main's review/integration work; PR targeting `V5.2`.
3. **One merge owner at a time.** `V5.2` is the integration point; rebase your branch on its tip and
   merge in order. **Never force-push** `V5.2` / `V5.1` / `V4.1`.
4. **File claim before edit** on the §4 overlap list (a one-line note in the PR or the board).
5. **Every claimed verification records** task/case IDs, exact SHA, command, environment, result.
6. **No deployment by either lane** without the owner's explicit go-ahead (see §8).

---

## 7. What Main needs from Codex

1. **Confirm or correct** §2 — especially the two judgement calls (7bedd6c body ceiling; 716c5b1's
   Google `email` scope pin). If the OIDC `email` scope was not an owner decision, say so.
   (The branch/PR process question is now settled by the owner — §6.)
2. **Own the app-UI receipt** as the single source of truth for APP-001…APP-022; Main did not review
   those 16 commits and will not claim them.
3. **Don't edit Main's review-fix files** without saying so: `apps/api/index.js`,
   `apps/api/routes/helpers.js`, `server/production/email-auth.js`,
   `tools/v5-migration/fixtures/build-synthetic-source.js`, `tests/v5-p13-security.test.js`,
   `tests/v5-schema-insert-drift.test.js`, `tests/v5-p21-account-web.test.js`,
   `tests/v52-public-annotations.test.js`, `tests/powers-*.test.js`, `tests/provider-authorization.test.js`.
4. **Deployment is a separate act** — Main has not deployed. Neither lane should deploy without the
   owner's explicit go-ahead and the pre-deploy items in §8.

---

## 8. Residual / pre-deploy (owner-actionable)

**DEPLOYMENT IS ON HOLD by the owner** (2026-10-17): the owner is making one more small change
first. Neither lane deploys the website until the owner explicitly says go.

- Add `POLAR_PRICE_MEGA_PASS` / `POLAR_PRICE_CENTS_MEGA_PASS` to the approved env (optional; an absent
  price degrades only the pass). Verify the Polar **sandbox** price ids for all five products.
- Point webhooks at `https://megaxo.online/api/monetization/{polar,cashfree}/webhook`.
- **LR02 final CI stays last** per the owner's standing order.
- iPhone device-matrix pass outstanding.
- **When the owner lifts the hold:** deploy the annotation bundle from a pinned `V5.2` SHA + the
  matching API deployment, then re-run the §5 live checks.

---

## 9. Honest limits

Main's verification was local (disposable PG16) + CI run status. Main did **not**:
- run the native device matrix, or
- review Codex's 16 app-UI commits, or
- deploy anything.
"CI green" is not device/provider/production proof. Production `opsz` is not healthy (`{"ok":false}`)
and was not re-diagnosed here.
