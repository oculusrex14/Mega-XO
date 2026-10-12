# P21 offline practice

P21-K180 defines an optional, guest-only offline copy for the browser site. Settings offers explicit save/remove controls. Importing `apps/web/offline.js`, reading its state, or visiting a page does not register a worker, preload files, make a network request, or read account data. Browser acceptance is pending the exact packaged build; no production or physical installation is claimed.

## Manifest and integrity

`scripts/p21/offline-worker.cjs` exports `createOfflineWorker({version, assets, navigations, fallback})`. The generated standalone worker embeds that manifest. `version` is a safe identifier; `assets` contains at most 160 entries of `{url, sha256}`, where each URL is a plain root-relative static path and each digest is a 64-character SHA-256 hex value. The three route mappings and the fallback must point to documents also present in `assets`. Dynamic, private, account, profile, authentication, API, callback, query-bearing, and cross-origin paths are rejected from the static allowlist.

`scripts/p21/build-web.js` generates the hashes from the exact packaged static bytes and emits `/offline-sw.js`, install metadata and eight explicitly allowlisted browser icons. Its manifest records every cacheable URL/digest and the version. The offline documents are `/game`, `/offline` and `/how-to-play`; account, profile, settings, friends, challenge and legacy launcher HTML are excluded. The worker fetches each listed asset with `cache: 'reload'`, `credentials: 'omit'`, and `redirect: 'error'`; it verifies a successful same-origin response, rejects redirects, `no-store` or `private` cache policy, and checks every SHA-256 digest before storage. The combined verified body limit is 5,900,000 bytes. A failed candidate cache is deleted while prior version caches remain. Activation rechecks the new cache before deleting other caches under the `mega-xoxo-web-offline-v1:` namespace.

## Request and data rules

| Request | Offline behavior |
| --- | --- |
| Exact listed static `GET`, no query | Recheck the cached bytes against the manifest digest before serving. On a miss or mismatch, return only a freshly verified network response and do not overwrite the existing cache. |
| Exact mapped guest navigation, no query | Recheck and serve its verified static document. |
| Unknown navigation | Keep it network-only; if network access fails, return the verified guest fallback with status `503` and `Cache-Control: no-store`. |
| API, account, profile, authentication, callback, unknown, or query-bearing request | Network-only. Never add its response to CacheStorage or invent a successful API result. |
| Cross-origin or non-`GET` request | Leave to the browser/network unchanged. |

The worker does not record request URLs, headers, cookies, or response bodies. It never calls `skipWaiting()` or `clients.claim()`: an update waits for existing controlled tabs to close so one tab does not mix static versions. A new install or update failure leaves the previous verified cache intact. `removeOffline()` unregisters only the matching root `/offline-sw.js` worker and removes only this feature's namespaced caches; other root workers, caches, account preferences, and local match state are outside its scope.

## Client API

`getOfflineState()` is a local read-only check with the result shape `{status, canRemove, version?, message?}`. Status is one of `unavailable`, `absent`, `ready`, `waiting`, or `conflict`; `canRemove` is true only when this feature owns a root worker or has its namespaced cache. It does not register or contact a server. An owned worker with missing verified files reports `absent` while remaining removable, so the user can remove it and explicitly prepare again. `prepareOffline()` requires an explicit UI action, secure context, Service Worker support, and CacheStorage. It refuses to replace a different root worker, registers only `/offline-sw.js` with scope `/` and `updateViaCache: 'none'`, and returns a bounded result with `reloadRequired`. A first install asks the user to reload manually; it never reloads the page itself. `removeOffline()` only removes this feature's matching worker/cache namespace and reports an unsuccessful unregister without deleting its cache.

## Validation and release state

Run the focused test with:

```sh
node --test tests/v5-p21-offline.test.js
```

The 18 focused tests run the generated worker in a VM with fake fetch, CacheStorage, and Web Crypto; they include mixed private/shared responses, integrity and cache-policy failures, an injected quota error, version activation, offline fallback, client opt-in/removal behavior and missing-cache recovery. The build test checks actual packaged digests, guest-only documents and version changes. These tests verify implementation boundaries; browser acceptance must use the exact parent-built bundle. No provider, deployment, DNS, indexing, native, or production authority is changed by this implementation.

To revert this source slice, Main can revert its integration commit and rebuild the preceding static artifact. Installed workers also need a tested retirement response at `/offline-sw.js` before any later deployment removes that endpoint; a server-side rollback alone cannot clear copies already saved by browsers. There is no deployed or installed production worker today. Players can remove their local copy using Settings; this preserves their local practice save and other app preferences.

The lifecycle approach follows the browser's normal waiting-update model and secure-context requirement described by [MDN's Service Worker guide](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers) and [register() reference](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register). Browser test behavior should account for the [Playwright service-worker test notes](https://playwright.dev/docs/service-workers).
