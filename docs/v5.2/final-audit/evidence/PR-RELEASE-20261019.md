# PR integration and device release evidence — 19 October 2026

This record supersedes earlier claims that the first board hotfix passed physical iOS acceptance,
or that the downloadable APK already contained PR40. Deployment completion is recorded separately
below once its release gates pass; a working UI or successful compilation alone is insufficient.

## Reviewed changes

| Change | Review and correction | Result |
| --- | --- | --- |
| PR39, stable gameplay DOM | Main source/caller review; fixed malformed regression fixtures in `02798d2`; expanded CI to WebKit presentation | Merged into takeover lane; original physical iPhone test FAILED |
| Mobile viewport follow-up `db6ea37` | Preserve a visible board through status reflow and deferred WebKit adjustment; cancel on user scroll/zoom/input; retain keyboard focus | Owner physical iPhone Chrome retest PASSED, including bot replies and normal scrolling |
| PR40, Android email recovery | Luna independent review; revoked old credentials stay fenced while a fresh email exchange is allowed; bounded OTP/public errors | Merged; new signed APK required |
| PR41, APK response counts | Luna found failed-stream counting; `9a4bb25` adds actual HTTP success/error/abort tests and request-specific optional cookie consent | Merged; aggregate responses are distinct from opted-in browser estimates and installations |
| Deploy recovery `726cd7f` | Carry host launcher/inventory/dependencies into staging before swap; validate; recover partial swap/restart/readiness failure; preserve archive | GitHub executor fixtures passed; Sol independent review requested |

GitNexus has no Mega-XO index in this workspace. Reviews used direct source/caller tracing rather
than treating an absent graph as evidence of safety. Tests run on GitHub Actions; a single bounded
stream diagnostic and the deployment worker's partial-swap executor smoke ran locally.

## Production proxy configuration repair

The exact APK device test found `UNTRUSTED_PROXY_ASSERTION` from native email. The public AdMob
callback exhibited the same rejection. Live source remained `30565fbc1730ed9ee9b2a0cc3acb6e63793b8a9a`.

Verified causes: the live trusted-proxy setting was absent, while Caddy connected from
`172.18.0.2`; the V5 proxy secret differed from Caddy's existing mounted key. Caddy's actual process
environment matched its mounted key, and its Caddyfile referenced that environment variable.
All comparisons were boolean-only; no values were printed or committed.

Sol approved this specific config-only repair independently from the pending candidate deploy.
The existing Caddy key was copied into a regular mode-0600 V5 host-managed file; the previous
secrets were preserved. The provider environment now sets `MEGA_PROXY_SECRET_FILE` and
`MEGA_TRUSTED_PROXIES=172.18.0.2/32,127.0.0.1/32,::1/128`. It does not trust the entire Docker subnet.
The environment backup is
`/opt/mega-xo-v5-production/secrets/provider-signin.env.pre-proxy-fix-20261019`.

After restart: `/readyz` returned HTTP 200 with `ready:true`; malformed public SSV reached
`INVALID_SSV_PAYLOAD` instead of proxy rejection; a direct wrong-key proxy assertion remained
`UNTRUSTED_PROXY_ASSERTION`. This proves admission routing, not AdMob reward acceptance or approval.
Config rollback restores the backed-up environment and restarts the same V5 PostgreSQL authority.

## Android artifact

- Package: `online.megaxo.game`; version `1.0.4`; versionCode `5`; min SDK 28; target SDK 35.
- APK size: 23,996,435 bytes.
- SHA-256: `eb0f519cf492b2fe18928cc0dd3d97f5cf467e4322d73aaa97439375458bd675`.
- Signing certificate SHA-256: `961cc05474570e60584a14142bb0e3d645804bcb4c168862a6945e4175329337`.
- Embedded 107-file client bundle: `756ed65652a48c7a50b11cb6ebb0413e71d0cc758f5f0c225429162d665d2e27`.
- Build source: `db6ea37df207d53430aa10cb4170e916362da5a2`; subsequent integration changes do not alter native/client inputs.
- Pinning commit: `e011653c72ee7172b45b6bbbdbea484ec27a4578`.
- Same signing lineage and package; `adb install -r` upgraded the connected physical Android.
- Google entry enabled; unsupported Apple entry hidden; API origin is `https://megaxo.online`.
- Direct-APK purchase actions route to the website store; paid purchase settlement is a separate gate.

Physical Android: existing email login passed after proxy correction; linked profile/friends loaded;
force-stop/relaunch restored sign-in and linked profile access. Logout/relogin and final live-download
verification are recorded in the completion entry. No real charge or production ad click was made.

## CI and acceptance

- Focused hotfix contracts: [GitHub run 39172911414](https://github.com/oculusrex14/Mega-XO/actions/runs/39172911414), PASS on `e011653`.
- Failed run 39172553608 is retained: its successful-stream test checked before the server's EOF/
  completion callback. `102c228` waits for actual completion with a test deadline; the success,
  failed-read and aborted-transfer assertions remain enforced.
- Every explicitly named focused test file must exist before Node's test runner is invoked.
- Chromium/WebKit presentation includes repeated bot replies with normal motion settings; all three
  engines retain realtime tests. Full final-candidate results belong in the completion entry.
- Physical iPhone initial preview `e7a0729`: owner reported drift. Revised preview `db6ea37`,
  `/game?mode=bot&check=2`: owner replied “Stable now; normal scrolling works”.

## Remaining launch work, not certified by this release

Ads remain off. AdMob account access and existing units are confirmed, but SSV console setup,
reward mapping, consent/test-ad acceptance and app serving review are not complete. A malformed
probe reaching the API is not a rewarded-ad test. Native-store billing/product/submission work,
real provider purchase/restore/refund acceptance, the full cross-device multiplayer matrix,
SEO/search-console work and full audit reconciliation retain their gates in the completion plan.

Credential rotation is explicitly deferred by the owner: **to be done when owner prompts it**.
No key was rotated during the proxy repair. The overall launch goal remains incomplete.

## Completion entry

Pending final integrated CI, independent approval, V5.2 merge and verified Oracle deployment.

## Addendum — synthetic WebKit anchor failure and fix (2026-10-19, ~04:45 IST)

The release head `7803f60` was green everywhere except one of 937 presentation checks:
`P21-BROWSER-TOUCH-BOT-REPEATED-ANCHOR` on desktop WebKit. The synthetic run held the anchor
through the first move plus bot reply, then desktop WebKit applied a one-time deferred scroll
after the second move's render (`703.09 → 156.09`, then stable). The real iPhone had already
passed on `db6ea37`, so this is a synthetic-engine timing gap, but the code fix is proper either
way: commit `09d422b` extends the render correction over three bounded animation frames (still
cancelling instantly on user scroll/zoom/input) and captures the pre-tap position from
`touchstart` as well, because some WebKit tap sequences skip pointer events. The repeated-move
QA now measures after the correction window settles.

Owner re-verification on the physical iPhone is pending for the final build; the fresh preview is
served at `http://192.168.0.9:4200/game?mode=bot&check=3`. Sol's final deploy verdict is pending
until its usage window resets (~08:41 IST); deployment holds for that review per the standing
two-reviewer order. CI on `09d422b` is the exact-head validation.

## Addendum 2 — root cause of the synthetic WebKit failure (2026-10-19, ~05:35 IST)

Running the real QA harness locally on desktop WebKit reproduced and then cleared the failure,
which let the defect be fixed from evidence instead of guesses:

1. With only the three-frame correction window, the full harness failed both touch checks with a
   jump to `scrollY 0` on the first tap. Tracing showed the stabilization anchor seeded at mount
   time (board at `691px` while the page was at the top) was being enforced against every later
   render: the correction itself scrolled the page to satisfy a stale position.
2. Fix `8cf46aa`: stabilization now undoes only small unexplained drifts (≤120px, the engine-jump
   class) and re-baselines on larger changes, so navigation, layout collapse and programmatic
   scrolls always belong to the user. Combined with the extended correction window and
   gesture-gated quiet logic, a simulated late engine scroll is corrected and a simulated user
   drag is respected (verified in `.scratch/webkit-anchor-repro.cjs`, which also caught that an
   earlier repro validated a stale bundle — the harness itself is the evidence of record).
3. Full local WebKit QA on `a9e5770` + the threshold: **PASS, 937 checks, 0 failures**
   (`tests-output/p21-web/5c1146f5885e/webkit/…/browser-qa.json`). The focused unit suite passes
   10/10. Physical-iPhone re-check on the final build remains the owner's acceptance step; the
   preview serves the fixed build.
