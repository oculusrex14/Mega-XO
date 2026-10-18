# Direct APK download analytics — V5.2

**Scope:** first-party Android APK requests at `https://megaxo.online/downloads/android/<pinned-file>.apk`, served by the Oracle V5 production Node server through Caddy. Tracking is **not** a click event, not an Android install receipt, not a Play Store install and not an account conversion.

## What is counted

| Metric | Stored PostgreSQL key in `ops.rate_buckets` | Meaning |
| --- | --- | --- |
| Server-completed APK responses | `apkdl:total` | Eligible completed GET responses since deployment, including retries; opt-in is not required |
| Participating browsers | `apkdl:unique` | Estimated new opted-in browser identities; only requests with explicit `metrics=1` participate |
| Responses by APK release | `apkdl:version:<versionCode>:total` | Eligible completed GET responses for the pinned manifest release, including retries |
| Participating browsers by release | `apkdl:version:<versionCode>:unique` | First opted-in response of this release by each observed participating browser |
| Daily responses | `apkdl:day:<YYYY-MM-DD>:total` | Eligible completed GET responses on the UTC day |
| Daily new participating browsers | `apkdl:day:<YYYY-MM-DD>:unique-new` | Opted-in browser identities first observed overall on that UTC day |
| Daily per-release responses | `apkdl:day:<YYYY-MM-DD>:version:<versionCode>:total` | Eligible completed release responses on the UTC day |
| Daily new participating browsers for release | `apkdl:day:<YYYY-MM-DD>:version:<versionCode>:unique-new` | First opted-in release responses by participating browsers on that day |

The download panel's **“Help count unique downloads (optional)”** checkbox is off by default and applies only to that APK request. It is a separate choice from optional game-usage telemetry and research-data collection. Unchecked requests still add eligible server-completed response totals, including retries, but do not parse or persist a browser identity; if an old download cookie is sent, the server clears it. Checking the box adds `?metrics=1` to that request and permits the download-only cookie and deduplication hash. The APK remains available either way.

`HEAD` probes do not count. The APK route currently ignores `Range` and returns the full file with HTTP 200, not a partial 206 response; a repeated or retried GET counts another response only if its full source stream completes. Each such response increments totals, while the opted-in participating-browser estimate is deduplicated by cookie.

**“Participating browsers” is an estimate for opted-in requests only, not unique people/devices and not confirmed installations.** Two humans sharing a browser may count as one; a person using multiple browsers, concurrent first requests, or clearing cookies may count multiple times. Download managers that block cookies and adversarial/bot requests can bias results. The cookie is random and signed, only set on an opted-in eligible APK GET; the server stores just an HMAC-derived hash for deduplication. No email, profile ID, exact IP address, fingerprint or full user-agent is persisted by this feature, and nothing is joined to identity/game/advertising events.

Cookie `mx_apk_dl` is first party, `Secure; HttpOnly; SameSite=Lax; Path=/downloads/android/`, and expires after at most 365 days. Pseudonymous deduplication hashes and daily aggregate buckets expire within 400 days; cumulative aggregate response and participating-browser totals do not expire. A returning browser after deduplication expiry may be classified as new. No counters are reconstructed from old web logs; day 1 is when this instrumented server version is deployed.

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
- A response counts only when the source file stream emits `end`, the HTTP status is 200, no stream error occurred, and the response did not close before writable completion. This is server-side completion, not proof the browser received or installed the APK; a network loss after Node finishes may still count.
- Insertion and increments are one PostgreSQL transaction using `api_runtime`'s existing `ops.rate_buckets` grants and a dedicated auto-minted mode-0600 `apk-download.secret` (independent of OTP and proxy secrets); no migration, Core, API identity, mail, Redis, worker grant or native app change is needed.
- Analytics database failures are logged as `apk.metrics_write_failed` (constant error code only; no cookies, identifiers or IPs) and do not fail or delay a completed download.
- Before shipping, use the owner-approved CI flow and perform a real browser download from the deployed artifact. Confirm an unchecked GET increments only response totals and clears any old cookie; an opted-in GET increments totals and the participating-browser estimate; a retry with the same cookie increments only totals; `HEAD`, redirects, stream errors and client aborts do not record a completed response. Confirm file digest/size, 200 GET, Caddy proxy headers and unchanged Android installation.
- Record deployed source/bundle hash and an independent rollback point. The privacy-policy disclosure and the handler must deploy together to the Oracle V5 production stack (not Vercel). Do not record historic downloads as if this counter existed before deployment.
