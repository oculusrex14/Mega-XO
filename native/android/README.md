# Android Mega XO (P20 co-development)

This is an actual Android application target, not a WebView loading the deferred website. It packages the existing allowlisted Mega XO HTML/CSS/JS client at build time and serves it exclusively from AndroidX WebViewAssetLoader's HTTPS app-assets origin. Local bot/practice play needs no network.

## Build

With Android SDK 35, JDK 17, Node 24 and Gradle 8.13 installed, from `native/android` run:

```sh
gradle :app:assembleDebug
```

The `generateMegaClient` task runs `scripts/v5/build-client.js` from the repository root. The generated bundle is a build output, never committed. `app/build/outputs/apk/debug/app-debug.apk` is the unsigned-development/testing artifact (Gradle debug-signed).

The temporary `online.megaxo.prototype` application ID is **not** an approved Play package or signing identity. No live OAuth, backend, store, ad or permission surfaces are configured by this commit. Real package/signing identifiers must be verified from authorized provider configuration before release. A Gradle wrapper binary and signed AAB remain separate follow-up requirements.

## Trust boundary

- Main frame: only `https://appassets.androidplatform.net/assets/mega/*` is rendered internally.
- All HTTPS/HTTP remote subresources and unknown app-assets paths are refused. Only user-initiated external HTTPS links open in a system handler.
- All `/api/*` requests currently return `503 ONLINE_UNAVAILABLE`, without fabricated sessions or grants, pending P05/P20-03 authenticated transport.
- No JS bridge exists yet: no `addJavascriptInterface`, ID tokens, payment receipts, ad completion, or native notifications are simulated.
- Local assets are signed as part of the APK; server authority, secrets and test code are omitted by the shared deterministic bundle builder.

Keep the WebView security policy when the native API bridge is added; only a typed, main-frame, origin-allowlisted authenticated transport may replace the current fail-closed API response.
