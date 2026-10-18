# Direct APK download analytics — V5.2

**Scope:** first-party Android APK requests at `https://megaxo.online/downloads/android/<pinned-file>.apk`, served by the Oracle V5 production Node server through Caddy. Tracking is **not** a click event, not an Android install receipt, not a Play Store install and not an account conversion.

## What is counted

| Metric | Stored PostgreSQL key in `ops.rate_buckets` | Meaning |
| --- | --- | --- |
| Total APK responses | `apkdl:total` | Successfully streamed GET response completions since this feature was deployed |
| Estimated distinct download browsers | `apkdl:unique` | Number of new verified first-party anonymous download-cookie identities seen |
| Total by APK release | `apkdl:version:<versionCode>:total` | Successful GET responses for the pinned manifest release |
| Estimated distinct by release | `apkdl:version:<versionCode>:unique` | First response of this release by each observed anonymous browser |
| Daily responses | `apkdl:day:<YYYY-MM-DD>:total` | Successful GET responses on the UTC day |
| Daily first-time browsers | `apkdl:day:<YYYY-MM-DD>:unique-new` | Browser identities first observed overall on that UTC day |
| Daily per-release responses | `apkdl:day:<YYYY-MM-DD>:version:<versionCode>:total` | Successful release responses on the UTC day |
| Daily first-time browsers for release | `apkdl:day:<YYYY-MM-DD>:version:<versionCode>:unique-new` | First release responses by browser identities on that day |

**This is estimated unique browsers, not unique people/devices and not confirmed installations.** Two humans sharing a browser count as one; a person using multiple browsers or clearing cookies may count multiple times. Download managers blocking cookies and adversarial/bot requests can bias results. The cookie is random and signed, only placed on an eligible actual APK GET; the server stores just an HMAC-derived hash for deduplication. No email, profile ID, exact IP address, fingerprint or full user-agent is persisted by this feature, and nothing is joined to identity/game/advertising events.

Cookie `mx_apk_dl` is first party, `Secure; HttpOnly; SameSite=Lax; Path=/downloads/android/`, expires after 365 days. Pseudonymous deduplication buckets expire after 400 days; stored aggregate lifetime totals do not expire. A returning browser after expiry is classified as a new browser. This is deliberately a bounded-retention estimate. No counters are reconstructed from old web logs; day 1 is when this instrumented server version is deployed.

## Private operations reporting

Use a **private, authorized SQL connection** to the V5 PostgreSQL database. **Never expose these queries through the public website, `/opsz`, or a new unprotected API endpoint.**

Lifetime totals:

```sql
SELECT bucket_id, hits
FROM ops.rate_buckets
WHERE bucket_id IN ('apkdl:total', 'apkdl:unique')
ORDER BY bucket_id;
```

Per-version lifetime totals:

```sql
SELECT bucket_id, hits
FROM ops.rate_buckets
WHERE bucket_id LIKE 'apkdl:version:%'
ORDER BY bucket_id;
```

Today's daily counts (replace date with current UTC date):

```sql
SELECT bucket_id, hits
FROM ops.rate_buckets
WHERE bucket_id LIKE 'apkdl:day:2026-10-19:%'
ORDER BY bucket_id;
```

`hits` values are cumulative counts per explicit bucket; a missing bucket means zero since activation. Do not sum distinct-browser totals across versions: one browser can download multiple releases.

## Safety and rollout

- `loadWebArtifact()` verifies the APK path, SHA-256 and size against the generated bundle manifest. Only that exact APK path is instrumented; `/api/download` store/chooser redirects, `HEAD` probes, stale filenames, missing artifacts, crawlers and prefetch do not count.
- The `finish` listener records a successful file-stream response (as observed by Node), **after** it has been sent to the HTTP response. An interrupted stream should not count; a network loss after the server finishes may still count.
- Insertion and increments are one PostgreSQL transaction using `api_runtime`'s existing `ops.rate_buckets` grants and a dedicated auto-minted mode-0600 `apk-download.secret` (independent of OTP and proxy secrets); no migration, Core, API identity, mail, Redis, worker grant or native app change is needed.
- Analytics database failures are logged as `apk.metrics_write_failed` (constant error code only; no cookies, identifiers or IPs) and do not fail or delay a completed download.
- Before shipping, run `node --test tests/v52-apk-download-tracker.test.js tests/v5-p21-download.test.js tests/v51-v5-production-server.test.js` and all web static/build checks. Perform a real browser download from the deployed artifact; confirm first GET increments both totals, repeat with same cookie increments only total, second browser increments unique; `HEAD` and redirects do not. Confirm file digest/size, 200 GET, Caddy proxy headers and unchanged Android installation.
- Record deployed source/bundle hash and an independent rollback point. The privacy-policy disclosure and the handler must deploy together to the Oracle V5 production stack (not Vercel). Do not record historic downloads as if this counter existed before deployment.
