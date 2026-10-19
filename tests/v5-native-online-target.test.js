'use strict';
/* P20-03 authenticated online target — offline, deterministic boundary + lifecycle proofs.
 *
 * Every assertion here reads the checked-in native/JS source or drives the real shared client
 * against a local stub. Nothing in this file contacts a provider, a device, the live staging origin
 * or the public API, so it is safe to run anywhere and can never pass because of network state.
 *
 * What is pinned:
 *   1. both product flavors' effective permission sets, straight from the manifests;
 *   2. the offline flavor remaining a real network-denial build (not a comment);
 *   3. the transport's refusals: no cookie header, no arbitrary host, no non-https, and no
 *      client-supplied Authorization on the game surface;
 *   4. the platform vault being the only place a refresh credential is ever persisted;
 *   5. the frozen cookie-free native route shape (method/path/bearer/no-cookie), asserted against a
 *      local stub that records exactly what the client sends;
 *   6. the session lifecycle: refresh on expiry, 401-on-refresh treated as terminal revocation,
 *      never a JS-supplied token, and the WebView's /api/* remaining blocked in BOTH flavors.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const ANDROID = 'native/android/app/src/main/java/online/megaxo/prototype';
const activity = read(`${ANDROID}/MegaXOActivity.kt`);
const transport = read(`${ANDROID}/MegaNativeHttpClient.kt`);
const vault = read(`${ANDROID}/MegaSecureSessionVault.kt`);
const session = read(`${ANDROID}/MegaNativeSessionManager.kt`);
const apiBridge = read(`${ANDROID}/MegaNativeApiBridge.kt`);
const gradle = read('native/android/app/build.gradle.kts');
const baseManifest = read('native/android/app/src/main/AndroidManifest.xml');
const onlineManifest = read('native/android/app/src/online/AndroidManifest.xml');
const accountClient = read('src/account-client.js');
const community = read('src/community.js');
const iosHttp = read('native/ios/MegaXO/MegaNativeHTTP.swift');
const iosSession = read('native/ios/MegaXO/MegaNativeSession.swift');
const iosApp = read('native/ios/MegaXO/MegaXOApplication.swift');
const iosApi = read('native/ios/MegaXO/MegaIOSApiBridge.swift');

/* ------------------------------------------------------------------ flavors */

test('online flavor restores exactly INTERNET and ACCESS_NETWORK_STATE, and nothing else', () => {
  // The online overlay must REPLACE the two network removals and must not re-add AD_ID, which the
  // base manifest keeps removed for both flavors.
  assert.match(onlineManifest, /android\.permission\.INTERNET"\s+tools:node="replace"\s*\/>/);
  assert.match(onlineManifest, /android\.permission\.ACCESS_NETWORK_STATE"\s+tools:node="replace"\s*\/>/);
  assert.doesNotMatch(onlineManifest.replace(/<!--[\s\S]*?-->/g, ''), /AD_ID/,
    'the overlay must not redeclare the advertising id removal it does not own');
  const declared = [...onlineManifest.matchAll(/android:name="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(declared.sort(), [
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.INTERNET'
  ]);
  // The overlay adds no activity, provider, service or receiver: network access is the whole delta.
  assert.doesNotMatch(onlineManifest, /<(activity|service|receiver|provider|application)\b/);
});

test('offline flavor stays the default artifact with a LAN-only network posture', () => {
  // The owner-authorised LAN-local room host needs the network permissions; the advertising id
  // stays removed and cleartext stays denied by default with a loopback-only exception.
  assert.match(baseManifest, /android\.permission\.INTERNET"\s*\/>/);
  assert.doesNotMatch(baseManifest, /android\.permission\.INTERNET"\s+tools:node="remove"/);
  assert.match(baseManifest, /com\.google\.android\.gms\.permission\.AD_ID"\s+tools:node="remove"\s*\/>/);
  assert.match(baseManifest, /android:usesCleartextTraffic="false"/);
  assert.match(baseManifest, /android:allowBackup="false"/);
  assert.doesNotMatch(baseManifest, /usesCleartextTraffic="true"/);
  // The flavor switch itself: offline is one of two declared flavors with MEGA_ONLINE_TARGET=false,
  // and the release guard still refuses an unregistered package / unsigned bundle.
  assert.match(gradle, /create\("offline"\)[\s\S]*?MEGA_ONLINE_TARGET", "false"/);
  assert.match(gradle, /create\("online"\)[\s\S]*?MEGA_ONLINE_TARGET", "true"/);
  assert.match(gradle, /megaApplicationId/);
});

test('the authenticated origin is opt-in per build and never bakes in a host by default', () => {
  assert.match(gradle, /providers\.gradleProperty\("megaApiOrigin"\)/);
  // Empty default: no property means no origin, so MegaNativeHttpClient stays unconfigured.
  assert.match(gradle, /providers\.gradleProperty\("megaApiOrigin"\)\.orNull \?: ""/);
  // Only an absolute, credential-free, path-free, query-free HTTPS origin is accepted.
  assert.match(gradle, /require\(apiOrigin\.isEmpty\(\) \|\| Regex\("\^https:\/\/\[A-Za-z0-9\.\-\]\+\(\?::\[0-9\]\{1,5\}\)\?\$"\)/);
  assert.match(gradle, /buildConfigField\("String", "MEGA_API_ORIGIN"/);
  // The origin is only honoured by an online-flavor activity that also has the flag set.
  assert.match(activity, /BuildConfig\.MEGA_ONLINE_TARGET && BuildConfig\.MEGA_API_ORIGIN\.isNotEmpty\(\)/);
  /* MXA-REL-002 (owner directive 2026-10-17): the shipped defaults ARE the production origin —
   * commit 519d04e baked https://megaxo.online into the pbxproj so a default build targets the
   * real API. The opt-in gradle path above still covers Android override builds. */
  assert.match(read('native/ios/MegaXO.xcodeproj/project.pbxproj'), /MEGA_API_ORIGIN = "https:\/\/megaxo\.online"/);
  assert.match(read('native/ios/MegaXO/Info.plist'), /<key>MegaApiOrigin<\/key><string>\$\(MEGA_API_ORIGIN\)<\/string>/);
  assert.match(iosApp, /MegaApiOrigin"\) as\? String\) \?\? ""/);
});

/* ---------------------------------------------------------------- transport */

test('transport refuses cookies, arbitrary hosts, non-https and client-supplied bearer', () => {
  // Origin is validated once, at construction: https, no credentials, no path, no query, no ref.
  assert.match(transport, /require\(url\.protocol == "https" && url\.userInfo == null/);
  assert.match(transport, /url\.query == null && url\.ref == null/);
  // The request URL is always the configured host plus an allowlisted path, re-checked at send.
  assert.match(transport, /val url = URL\(host, path\)/);
  assert.match(transport, /require\(url\.host == host\.host && url\.protocol == "https"\)/);
  // Redirects are never followed; a 30x is a failure, not a hop.
  assert.match(transport, /conn\.instanceFollowRedirects = false/);
  assert.match(transport, /status in 200\.\.599 && status !in 300\.\.399/);
  // No Cookie header is ever composed anywhere in the transport.
  assert.doesNotMatch(transport, /setRequestProperty\(\s*"Cookie"/i);
  assert.doesNotMatch(transport, /CookieManager|CookieStore|java\.net\.CookieHandler/);
  // The game surface takes its bearer from the installed session only; the caller passes no
  // Authorization value and cannot name one.
  assert.match(transport, /fun request\(\s*path: String, method: String, body: String\?, operationKey: String\?,/);
  assert.match(transport, /val token = accessToken/);
  assert.match(transport, /if \(origin == null \|\| token == null\)/);
  assert.match(transport, /transmit\(path, method, body, "Bearer \$token", operationKey, complete\)/);
  // Both boundaries share the allowlist policy, including the existing search/rank queries.
  assert.match(transport, /MegaNativeWirePolicy\.acceptsPath\(path\)/);
  assert.match(apiBridge, /MegaNativeWirePolicy\.acceptsPath\(path\)/);
});

test('the cookie-free native route set is closed and re-validated at the transport', () => {
  const declared = [...transport.matchAll(/"(\/api\/account\/native\/[a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(declared.sort(), [
    '/api/account/native/challenge',
    '/api/account/native/email',
    '/api/account/native/logout',
    '/api/account/native/refresh',
    '/api/account/native/token'
  ]);
  assert.match(transport, /path !in nativePaths/);
  assert.match(transport, /if \(path !in nativePaths \|\| body\.toByteArray\(\)\.size > maxBodyBytes/);
  // No operation key is invented for a credential exchange.
  assert.match(transport, /transmit\(path, "POST", body, bearer\?\.let \{ "Bearer \$it" \}, null, complete\)/);
  // The transport never invents a body-limit escape or an unbounded response.
  assert.match(transport, /require\(output\.size\(\) \+ n <= maxResponseBytes\) \{ "RESPONSE_TOO_LARGE" \}/);
});

/* --------------------------------------------------------------------- vault */

test('the platform vault is the only persistence for the refresh credential', () => {
  assert.match(vault, /AndroidKeyStore/);
  assert.match(vault, /AES\/GCM\/NoPadding/);
  assert.match(vault, /setKeySize\(256\)/);
  assert.match(vault, /store\.deleteEntry\(alias\)/);
  // Keystore ciphertext only; the session manager is the single writer and single reader.
  /* A save failure answers UNAVAILABLE only while its rotation generation is current; a
   * stale reply must never answer a newer gate, and a stale 401 never revokes. */
  assert.match(session, /if \(!stale\) main\.post \{ complete\(Outcome\.UNAVAILABLE\) \}/);
  assert.match(session, /if \(stale\) return/);
  assert.match(session, /vault\.loadRefreshCredentialOrNull\(\)/);
  /* A save failure answers UNAVAILABLE only while its rotation generation is current; a
   * stale reply must never answer a newer gate, and a stale 401 never revokes. */
  assert.match(session, /if \(!stale\) main\.post \{ complete\(Outcome\.UNAVAILABLE\) \}/);
  assert.match(session, /if \(stale\) return/);
  // Vault I/O runs on the session's own bounded executor, never on the UI thread that WebView
  // callbacks arrive on; every completion is posted back to the main thread. The pool is bounded
  // (not single-thread) so one stalled Keystore read cannot park the queue, and the rotation and
  // restore watchdogs bound every caller to one honest outcome even if a vault op never returns.
  assert.match(session, /megaxo-session-watchdog/);
  assert.match(session, /finishRotation\(generation, Outcome\.UNAVAILABLE\)/);
  assert.match(session, /if \(generation != rotationGeneration\) return/);
  assert.match(session, /private val io = Executors\.newFixedThreadPool\(2\)/);
  assert.match(session, /io\.execute \{/);
  // The access token is memory-only; it is never written to prefs, a file or JS.
  assert.match(session, /transport\.installVerifiedAccessToken\(access\)/);
  assert.doesNotMatch(session, /SharedPreferences|writeText|FileOutputStream|localStorage/);
  // The vault is not reachable from the bridge or from JS.
  assert.doesNotMatch(apiBridge, /vault|saveRefreshCredential/);
  assert.doesNotMatch(accountClient, /refreshToken/);
  assert.doesNotMatch(community, /refreshToken/);
  // iOS parity: device-only, non-synchronizing Keychain item.
  /* A save failure answers UNAVAILABLE only while its rotation generation is current; a
   * stale reply must never answer a newer gate, and a stale 401 never revokes. */
  assert.match(session, /if \(!stale\) main\.post \{ complete\(Outcome\.UNAVAILABLE\) \}/);
  assert.match(session, /if \(stale\) return/);
  assert.match(read('native/ios/MegaXO/MegaNativeSecretVault.swift'), /kSecAttrAccessibleWhenUnlockedThisDeviceOnly/);
});

/* ---------------------------------------------------- frozen native contract */

test('native credential requests carry bearer, no cookie, and the frozen grant bodies', () => {
  // Provider grant: the /native/token body IS the finish request; there is no separate finish hop.
  assert.match(session, /put\("provider", provider\)\s*\n\s*\.put\("state", state\)\s*\n\s*\.put\("idToken", idToken\)/);
  assert.match(session, /transport\.authRequest\("\/api\/account\/native\/token", null, body\)/);
  // Refresh grant: exactly {grant:'refresh_token', refreshToken} per validateNativeTokenGrant.
  assert.match(session, /\.put\("grant", "refresh_token"\)\s*\n\s*\.put\("refreshToken", stored\)/);
  assert.match(session, /transport\.authRequest\("\/api\/account\/native\/refresh", null, body\)/);
  // The refresh grant IS the credential, so an expired access token is deliberately not presented.
  assert.doesNotMatch(session, /authRequest\("\/api\/account\/native\/refresh", [^n]/);
  // Logout presents the current access token and is best-effort; local teardown happens anyway.
  assert.match(session, /transport\.authRequest\("\/api\/account\/native\/logout", token, body\)/);
  // 512 is the frozen MAX_REFRESH_TOKEN_LENGTH, not a locally chosen number.
  assert.match(session, /const val MAX_REFRESH_TOKEN_LENGTH = 512/);
  assert.match(read('packages/contracts/access-dto.js'), /MAX_REFRESH_TOKEN_LENGTH = 512/);
  // iOS parity for the same four routes and the same grant bodies.
  assert.match(iosHttp, /"\/api\/account\/native\/challenge", "\/api\/account\/native\/email", "\/api\/account\/native\/token",/);
  assert.match(iosHttp, /"\/api\/account\/native\/refresh", "\/api\/account\/native\/logout"/);
  assert.match(iosSession, /"grant": "refresh_token", "refreshToken": stored/);
  assert.doesNotMatch(iosHttp, /setValue\(.*forHTTPHeaderField: "Cookie"/);
});

test('the client validates the frozen response shape and fails closed', () => {
  const fields = ['accessToken', 'refreshToken', 'expiresIn', 'actorId'];
  for (const field of fields) assert.ok(session.includes(`"${field}"`), `reads ${field}`);
  // Strict: an unparseable or short access token is refused, never stored.
  assert.match(session, /if \(access\.isEmpty\(\) \|\| access\.length !in 24\.\.8192/);
  assert.match(session, /complete\(Outcome\.INVALID\); return/);
  // An ABSENT refreshToken keeps the stored credential; it never clears it.
  assert.match(session, /val refresh = issuedRefresh\.takeIf \{ it\.isNotEmpty\(\) \} \?: heldRefresh/);
  // expiresIn is validated when present and only defaulted to the documented TTL when absent.
  assert.match(session, /if \(parsed\.has\("expiresIn"\)\)/);
  assert.match(session, /if \(seconds !in 30\.\.86400\) \{ complete\(Outcome\.INVALID\); return \}/);
  assert.match(session, /const val DEFAULT_ACCESS_TTL_SECONDS = 300/);
  // iOS mirrors the same rules.
  assert.match(iosSession, /let access = object\["accessToken"\] as\? String,\n\s+Self\.isCompactJWS\(access\)/);
  assert.match(iosSession, /issued\.isEmpty \? \(held\?\.refreshToken/);
  assert.match(iosSession, /static let defaultAccessTTL: TimeInterval = 300/);
});

test('refresh is single-flight and a 401 is terminal revocation', () => {
  assert.match(session, /if \(refreshing\) \{ pendingRefresh\.add\(complete\); return \}/);
  assert.match(session, /waiters\.forEach \{ it\(outcome\) \}/);
  /* The 401 terminal path is generation-fenced: a STALE reply can neither revoke the
   * family nor answer the current rotation gate. */
  assert.match(session, /if \(status == 401 && rotating\) \{/);
  assert.match(session, /if \(stale\) return/);
  // Revocation wipes the vault and drops the in-memory token; it cannot leave a live-looking session.
  assert.match(session, /private fun revokeEverything\(\)[\s\S]*?vault\.clear\(\)/);
  assert.match(session, /runCatching \{ vault\.clear\(\) \}/);
  // iOS parity.
  assert.match(iosSession, /if refreshing \{[\s\S]*?pendingRefresh\.append\(continuation\)/);
  /* The 401 terminal path is generation-fenced: a STALE reply can neither revoke the
   * family nor answer the current rotation gate. */
  assert.match(session, /if \(status == 401 && rotating\) \{/);
  assert.match(session, /if \(stale\) return/);
});

test('the WebView cannot reach the API in either flavor and JS never supplies the bearer', () => {
  // The interception still parks every /api/* request on the fail-closed ONLINE_UNAVAILABLE answer.
  assert.match(activity, /if \(url\.path\?\.startsWith\("\/api\/"\) == true\) return unavailable\(\)/);
  assert.match(activity, /ONLINE_UNAVAILABLE/);
  assert.doesNotMatch(activity, /\.addJavascriptInterface\s*\(/);
  // The bridge takes a path/method/body/key and nothing that could carry a credential.
  assert.match(apiBridge, /command\.optString\("path", ""\)/);
  assert.match(apiBridge, /command\.optString\("method", "GET"\)\.uppercase\(\)/);
  assert.doesNotMatch(apiBridge, /optString\("token"|optString\("authorization"|optString\("cookie"/i);
  // Its injected surface has no token parameter either.
  assert.match(apiBridge, /request: \(path, method, body, key\) => call\('request', \{path, method, body, key\}\)/);
  assert.doesNotMatch(apiBridge, /getCredential/);
  // Origin-scoped, main-frame only, pinned to the exact signed entry document.
  assert.match(apiBridge, /WebViewCompat\.addWebMessageListener\(/);
  assert.match(apiBridge, /isMainFrame && origin\.scheme == "https"/);
  assert.match(apiBridge, /view\.url == entryUrl/);
  assert.match(apiBridge, /addDocumentStartJavaScript/);
});

test('the native provider exchange keeps the ID token out of JavaScript', () => {
  assert.match(apiBridge, /adapter\.credential\(providerName, issued\.optString\("nonce", ""\)\)/);
  assert.match(apiBridge, /session\.signIn\(/);
  assert.match(apiBridge, /session\.challenge\(providerName, intent\)/);
  // Only a boolean outcome crosses back to the page; the reply object carries no provider token.
  assert.match(apiBridge, /send\(reply, id, JSONObject\(\)\s*\n\s*\.put\("ok", outcome == MegaNativeSessionManager\.Outcome\.OK\)\s*\n\s*\.put\("outcome", outcome\.name\)\)/);
  const replies = [...apiBridge.matchAll(/send\(reply, id, JSONObject\(\)([\s\S]*?)\)\)/g)].map(m => m[1]);
  assert.ok(replies.length >= 3, 'the bridge replies are enumerable');
  for (const reply of replies) assert.doesNotMatch(reply, /"idToken"/, 'no reply to the page carries a provider token');
  // The provider is advertised only when this build actually compiled its adapter.
  assert.match(activity, /manager\.providerAdapters = if \(identityBridge != null\) setOf\("google"\) else emptySet\(\)/);
  assert.match(session, /fun nativeProviders\(\): List<String> = listOf\("google"\)\.filter \{ transport\.isConfigured\(\) && providerAdapters\.contains\(it\) \}/);
  // A server-issued nonce is required; none is ever generated locally.
  assert.match(session, /transport\.authRequest\("\/api\/account\/native\/challenge", null, body\)/);
  assert.doesNotMatch(session, /randomUUID|SecureRandom|Math\.random/);
  // iOS parity.
  assert.match(iosApi, /guard let idToken = await apple\.credential\(nonce: challenge\.nonce\)/);
  assert.match(iosApi, /reply\(\["ok": outcome == \.ok, "outcome": outcome\.rawValue\], nil\)/);
  assert.match(read('native/ios/MegaXO/MegaIOSIdentityBridge.swift'), /func credential\(nonce: String\) async -> String\?/);
});

/* ----------------------------------------------------------------------- CI */

test('CI compiles and asserts BOTH flavors, and exercises the offline artifact on the emulator', () => {
  const workflow = read('.github/workflows/v5-native.yml');
  // Both artifacts are compiled and their EFFECTIVE permission sets asserted, not our intent.
  assert.match(workflow, /:app:assembleOfflineDebug :app:assembleOnlineDebug/);
  assert.match(workflow, /app-offline-debug\.apk/);
  assert.match(workflow, /app-online-debug\.apk/);
  assert.match(workflow, /for permission in android\.permission\.INTERNET android\.permission\.ACCESS_NETWORK_STATE; do/);
  // INTERNET/ACCESS_NETWORK_STATE are deliberately present in BOTH flavors now: the
  // owner-authorised LAN-local room host needs them (NsdManager refuses without INTERNET, and
  // removing it made the host crash on start). Assert the property that still matters instead:
  // the advertising ID permission stays removed from both, so no ad SDK can track.
  assert.match(workflow, /Advertising ID permission must be removed from/);
  assert.doesNotMatch(workflow, /Offline P20 host unexpectedly has network or advertising ID permissions/);
  // The new suite cannot silently stop running.
  assert.match(workflow, /node --test tests\/v5-native-foundations\.test\.js tests\/v5-native-online-target\.test\.js/);
  assert.match(workflow, /'tests\/v5-native-online-target\.test\.js'/);
  // The emulator smoke still drives the OFFLINE build, whose whole point is that it has no network.
  assert.match(workflow, /APK_PATH="\$RUNNER_TEMP\/mega-apk\/app-offline-debug\.apk"/);
  assert.doesNotMatch(workflow, /apk\/debug\/app-debug\.apk/);
});

/* -------------------------------------------------- association / continuity */

test('association files match the BUILT app ids, and the Android fingerprint is the REAL upload certificate', () => {
  const wellKnown = require('../apps/api/routes/well-known.js');
  const write = () => {
    const out = { status: 0, headers: {}, body: '' };
    return {
      out,
      res: {
        writeHead(status, headers) { out.status = status; out.headers = headers; },
        end(body) { out.body = body; }
      }
    };
  };
  // Android: the package is the built application id - the owner-requested permanent id - and the
  // fingerprint is the REAL SHA-256 of the owner-held upload certificate that the artifacts built on
  // this machine are signed with (96:1C:C0:54...). It is deliberately no longer an all-zero
  // placeholder: a placeholder associates nothing, and the owner chose this id. Once the first AAB is
  // uploaded, Play App Signing's own certificate fingerprint must be ADDED, not swapped in.
  const links = write();
  wellKnown.getAssetLinks({}, {}, links.res);
  const statements = JSON.parse(links.out.body);
  /* Audit MXA-REL-001 (2026-10-17): the association now carries TWO statements - the built
   * default id online.megaxo.xoxo AND the store-bound release id online.megaxo.game that the
   * website distributes (same owner upload key). One statement per application id. */
  assert.equal(statements.length, 2);
  assert.deepEqual(statements[0].relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(statements[0].target.namespace, 'android_app');
  assert.equal(statements[0].target.package_name, 'online.megaxo.xoxo');
  assert.match(statements[0].target.package_name, /^online\.megaxo\.xoxo$/);
  assert.equal(statements[1].target.namespace, 'android_app');
  assert.equal(statements[1].target.package_name, 'online.megaxo.game');
  assert.deepEqual(statements[1].target.sha256_cert_fingerprints,
    ['96:1C:C0:54:74:57:0E:60:58:4A:14:14:2B:B0:E3:D6:45:80:4B:CB:4C:16:88:62:A6:94:5E:41:75:32:93:37']);
  assert.deepEqual(statements[0].target.sha256_cert_fingerprints,
    ['96:1C:C0:54:74:57:0E:60:58:4A:14:14:2B:B0:E3:D6:45:80:4B:CB:4C:16:88:62:A6:94:5E:41:75:32:93:37']);
  // The all-zero placeholder must be gone: publishing it would associate nothing at all.
  assert.doesNotMatch(links.out.body, /00:00:00:00:00:00:00:00:00:00/);
  // iOS: the bundle id is the built PRODUCT_BUNDLE_IDENTIFIER, and TEAMID stays a literal
  // placeholder until the owner's Apple Team ID exists.
  const apple = write();
  wellKnown.getAppleAppSiteAssociation({}, {}, apple.res);
  const association = JSON.parse(apple.out.body);
  const declared = association.applinks.details.flatMap(detail => detail.appIDs)
    .concat(association.webcredentials.apps);
  assert.ok(declared.length > 0);
  for (const appId of declared) assert.equal(appId, 'TEAMID.online.megaxo.xoxo');
  // The association ids must be exactly the ids the native projects actually build.
  assert.match(read('native/android/gradle.properties'), /megaApplicationId=online\.megaxo\.xoxo/);
  assert.match(read('native/ios/MegaXO.xcodeproj/project.pbxproj'),
    /PRODUCT_BUNDLE_IDENTIFIER = online\.megaxo\.xoxo/);
  // Both routes answer as JSON and stay cacheable; neither is a private account response.
  assert.equal(links.out.status, 200);
  assert.match(links.out.headers['Content-Type'], /application\/json/);
  assert.equal(apple.out.status, 200);
  assert.match(apple.out.headers['Content-Type'], /application\/json/);
});

/* --------------------------------------------------- live client behaviour */

/** Boots the real shared account client against a stub native host that records every call. */
function nativeClient(host) {
  const calls = [];
  const sandbox = {
    console,
    AbortController, Headers, URL, URLSearchParams, Date, setTimeout, clearTimeout, setInterval, clearInterval,
    crypto, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    navigator: { onLine: true },
    document: { dispatchEvent() {}, hidden: false },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {},
    fetch: (...args) => { calls.push({ kind: 'fetch', url: String(args[0]) }); throw Error('NETWORK_FORBIDDEN_IN_NATIVE_TEST'); },
    MegaNativeApi: {
      session: async () => host.session(),
      refresh: async () => { calls.push({ kind: 'refresh' }); return host.refresh(); },
      signOut: async allDevices => { calls.push({ kind: 'signOut', allDevices }); return host.signOut(allDevices); },
      signIn: async (provider, intent) => { calls.push({ kind: 'signIn', provider, intent }); return host.signIn(provider, intent); },
      request: async (path, method, body, key) => {
        calls.push({ kind: 'request', path, method, body, key });
        return host.request(path, method, body, key);
      }
    }
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(accountClient, context, { filename: 'src/account-client.js' });
  const account = vm.runInContext('MegaAccount', context);
  return { calls, account, state: () => account.peek() };
}

const profile = { id: 'actor-one', tag: 'MEGA-TEST0001', username: 'tester', displayName: 'Tester', providers: ['email', 'google'] };

test('the shared client routes every API call through the native host, never global fetch', async () => {
  const seen = [];
  const client = nativeClient({
    session: () => ({ ok: true, linked: true, online: true, actorId: 'actor-one', expiresAt: Date.now() + 300000, providers: ['google'] }),
    refresh: () => ({ ok: true }),
    signOut: () => ({ ok: true }),
    signIn: () => ({ ok: true }),
    request: (path, method) => {
      seen.push({ path, method });
      return path === '/api/account/profile'
        ? { ok: true, status: 200, data: profile }
        : { ok: true, status: 200, data: { revision: 4 } };
    }
  });
  const session = await client.account.session();
  assert.equal(session.linked, true);
  assert.equal(session.profile.id, 'actor-one');
  assert.equal(session.csrf, null, 'a native session has no CSRF token to publish');
  assert.deepEqual(seen, [{ path: '/api/account/profile', method: 'GET' }]);
  assert.deepEqual(client.calls.filter(c => c.kind === 'fetch'), [], 'no cookie fetch may be attempted in a native host');
  // Native provider capability is republished for the account UI, never invented by JS.
  assert.equal(session.providers.google.native, true);
  assert.equal(session.providers.google.web, false);
});

test('a linked native session refreshes on expiry before the next authenticated call', async () => {
  /* The REAL host owns credentials and republishes the rotated expiry: the session manager
   * installs the renewed access token + expiresAt before answering refresh (MegaNativeSessionManager),
   * so session() observes the post-rotation truth. A host that kept advertising a dead expiry
   * would be a host bug; the client must not paper over it with an invented lifetime. */
  let hostExpiresAt = Date.now() - 1000;
  const client = nativeClient({
    session: () => ({ ok: true, linked: true, online: true, actorId: "actor-one", expiresAt: hostExpiresAt, providers: [] }),
    refresh: () => { hostExpiresAt = Date.now() + 300000; return Promise.resolve({ ok: true }); },
    signOut: () => ({ ok: true }),
    signIn: () => ({ ok: true }),
    request: () => ({ ok: true, status: 200, data: profile })
  });
  await client.account.session();
  const order = client.calls.filter(c => c.kind === 'refresh' || c.kind === 'request').map(c => c.kind);
  assert.deepEqual(order, ['refresh', 'request'],
    'the expired session rotates exactly once, and always before the call it authorises');
  // The adapter republishes the rotated expiry, so an immediately following call does not rotate again.
  await client.account.request('/api/account/save', { revision: 1 });
  assert.equal(client.calls.filter(c => c.kind === 'refresh').length, 1,
    'a rotated session is not re-rotated for every subsequent call');
});

test('terminal revocation drops the session and reports the auth state, not an outage', async () => {
  const client = nativeClient({
    session: () => ({ ok: true, linked: true, online: true, actorId: 'actor-one', expiresAt: Date.now() - 1, providers: [] }),
    refresh: () => ({ ok: false, error: 'REVOKED' }),
    signOut: () => ({ ok: true }),
    signIn: () => ({ ok: true }),
    request: () => ({ ok: true, status: 200, data: profile })
  });
  await assert.rejects(() => client.account.session(), error => error.message === 'REVOKED');
  assert.equal(client.state(), null, 'a revoked session is dropped, never half-held');
  assert.equal(client.account.connectivity().state, 'auth', 'revocation is an auth state, not degraded');
  assert.equal(client.calls.filter(c => c.kind === 'fetch').length, 0);
});

test('sign-out goes through the native host and clears the published session', async () => {
  const client = nativeClient({
    session: () => ({ ok: true, linked: true, online: true, actorId: 'actor-one', expiresAt: Date.now() + 300000, providers: [] }),
    refresh: () => ({ ok: true }),
    signOut: () => ({ ok: true }),
    signIn: () => ({ ok: true }),
    request: () => ({ ok: true, status: 200, data: profile })
  });
  await client.account.session();
  assert.equal(await client.account.logout(true), true);
  assert.equal(client.state(), null);
  const call = client.calls.find(c => c.kind === 'signOut');
  assert.equal(call.allDevices, true);
  assert.equal(client.calls.filter(c => c.kind === 'fetch').length, 0, 'logout must not fall back to the cookie route');
});

test('a failing native sign-out surfaces rather than claiming the user is signed out', async () => {
  const client = nativeClient({
    session: () => ({ ok: true, linked: false, online: true, actorId: null, expiresAt: 0, providers: [] }),
    refresh: () => ({ ok: false }),
    signOut: () => ({ ok: false, error: 'SERVICE_UNAVAILABLE' }),
    signIn: () => ({ ok: true }),
    request: () => ({ ok: true, status: 200, data: profile })
  });
  await assert.rejects(() => client.account.logout(true), error => error.message === 'SERVICE_UNAVAILABLE');
  // allDevices is retried without the field before the failure is reported: best-effort means the
  // field is never the reason a sign-out fails.
  assert.equal(client.calls.filter(c => c.kind === 'signOut').length, 2);
});

test('the game UI signs in natively without an ID token ever entering the page scope', () => {
  const nativeBranch = community.slice(community.indexOf('window.MegaNativeApi&&typeof window.MegaNativeApi.signIn'));
  assert.ok(nativeBranch.length > 0, 'the native sign-in branch exists');
  const branch = nativeBranch.slice(0, nativeBranch.indexOf('else if'));
  assert.match(branch, /window\.MegaNativeApi\.signIn\(provider,intent\)/);
  assert.doesNotMatch(branch, /idToken/, 'the native branch never handles a provider ID token');
  assert.doesNotMatch(branch, /getCredential/, 'the native branch never calls the JS identity bridge');
  // The JS identity bridge remains the fallback for a build that compiled no native exchange.
  assert.match(nativeBranch, /window\.MegaNativeIdentity&&session\?\.providers\?\.\[provider\]\?\.native/);
});
