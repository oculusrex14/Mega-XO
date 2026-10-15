# Local-shell connection-state correction — 15 October 2026

Source checkpoint: provider branch `codex/v52-provider-release` at
`9acdf1c67e08d23a0ff71bb776797dc1f85abd4b`, with the uncommitted connectivity patch described here.
Local environment: macOS arm64, Node `v26.8.2`. No provider, account, deployment, production writer,
image file or other worktree was changed. No UI captures were taken.

## Cause and resulting behavior

The generated native bundle has no same-origin account service. Without `window.MegaNativeApi`, the
shared account client nevertheless selected its browser cookie transport. Startup `NET.profile()`
and the identity bootstrap therefore fetched `/api/*` from a static asset server or offline native
origin. The failed fetch/HTML response became a misleading “Connection interrupted” home banner.

- The native bundle builder now inserts
  `<meta name="mega-account-transport" content="native">` into its generated game entry only. The
  original web/P21 HTML and legal pages remain unmarked.
- A marked shell without the native API bridge starts in explicit `local` connection state. Account
  session requests and attempted online reads/writes fail with `ONLINE_NOT_CONFIGURED` before any
  cookie fetch. No account, CSRF value or successful online operation is invented.
- The app does not poll online state or show an outage banner in that explicit local state. Choosing
  online play says: “Online services are not configured in this local build. Bot and Pass & Play are
  available.” Private/LAN routing keeps its existing path before the online-readiness check.
- A configured native bridge takes precedence over the marker. Request failures and initial native
  session/profile failures remain visible; there is no cookie fallback after native failure. A
  bridge appearing after startup can recover through the ordinary session path.
- Unmarked browser/P21 pages retain their cookie/CSRF bootstrap, authenticated requests, retry keys,
  auth-loss reporting and genuine outage behavior. No decision is inferred from localhost, URL path,
  HTTP status or a failed request.

The marker describes the account transport of the packaged client. It does not establish an online
provider configuration or prove that a bridge was installed correctly in a signed native artifact.
Actual native/network failures with a published bridge remain failures rather than local successes.

## Executed verification

**PASS: 84 tests, 0 fail, 0 skip.**

```
node --test tests/v52-local-connectivity.test.js tests/v5-client-bundle.test.js tests/v5-native-online-target.test.js tests/v5-p21-account-web.test.js tests/v5-p21-friends.test.js tests/static-ui.test.js
```

The seven new connectivity regressions execute the shared account client and actual app connectivity
handlers with synthetic hosts. They cover no-bridge static/native mode and zero fetches, configured
native errors, bootstrap errors, late bridge availability, unchanged cookie/CSRF requests, real web
and auth failures, and local startup polling. Packaging tests verify the generated marker and ensure
the source web index/legal pages are not marked.

**PASS: 31 tests, 0 fail, 0 skip.**

```
node --test tests/v5-native-foundations.test.js
```

These include an actual local allowlist build and source/boundary checks; they are not signed-device
or provider acceptance. Combined executed result: **115 pass / 0 fail / 0 skip**.
`git diff --check` also passed. No extra application changes were necessary after the tests.

## Integration and remaining steps

Read-only, temporary-file `git merge-file -p` checks used the provider HEAD as base, this working
patch as ours and each target below as theirs. Each changed tracked file produced exit 0 and zero
conflict markers against both targets:

- `origin/V5.2` at `59b65b0b26399d31f8ee55ac119a550a6c4a4519`;
- native match UI commit `bd00447d03e4596e38b4fae34e8a41ffc0399488`.

`src/app.js` contains newer powers/UI work on those targets; the connectivity hunks are separate and
merged cleanly in the temporary check. The account client, builder and existing bundle test were
unchanged upstream. The new test path was absent on both targets. This is merge feasibility, not a
claim that the merged source was executed. Preserve newer powers/UI code; do not replace the full
app file with the older provider version. Root owns review, commit, push and any later integration.

The already served `http://127.0.0.1:4186/capture/` artifact predates the marker. It must be regenerated
from reviewed source and the static copy replaced/reloaded before the visible fix can be checked.
That rebuild, browser check and any signed native recapture remain outstanding; marketing captures
are deferred by the owner. No existing page or artifact was presented as fixed during this audit.

Rollback: revert the bounded connectivity patch and regenerate the native bundle; no data migration
or authority change is involved. Existing local saves and provider work remain intact.

## Follow-up visible verification after recovery

Root committed the recovered patch, reconciled it with Main and pushed the provider branch. The
merged source `1776aaa55e5b0aaa30259c5aa8abc0680f4ee310` produced an isolated allowlisted bundle with
hash `1d5d355aad1b10afca82806ba93de69161afe55b0a1b50c3c4dda370c10f5790`.
In a real CUA browser session at `http://127.0.0.1:4189/bundle-index.html`, the guest home rendered
without the outage banner: `#networkStatus.hidden === true`, computed display `none`. The screenshot
`local-home-no-outage.jpg` records that local QA result. No account credential, injected account
success, live provider or production service was used. Configured-native/browser genuine-error
behavior remains covered by the tests above. The old deferred capture artifact at port 4186 was not
replaced. Signed-device and deployed-build acceptance remain separate.
