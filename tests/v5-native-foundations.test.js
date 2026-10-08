'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { build } = require('../scripts/v5/build-client.js');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Android and iOS hosts derive their assets from exactly one frozen allowlist', t => {
  const android = read('native/android/app/build.gradle.kts');
  const ios = read('native/ios/MegaXO.xcodeproj/project.pbxproj');
  assert.match(android, /scripts\/v5\/build-client\.js/);
  assert.match(ios, /scripts\/v5\/build-client\.js/);
  const config = JSON.parse(read('native/client/bundle.config.json'));
  assert.ok(config.client_scripts.includes('src/app.js'));
  assert.ok(config.client_scripts.includes('src/community.js'));
  assert.ok(!config.client_scripts.includes('src/authority.js'));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-native-source-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const result = build({ root, output });
  assert.equal(result.manifest.bundle_file, 'bundle-index.html');
  for (const file of result.manifest.files) {
    assert.ok(!file.path.includes('authority.js'));
    assert.ok(!file.path.startsWith('server/'));
    assert.ok(!file.path.startsWith('docs/'));
    assert.ok(!file.path.startsWith('tests/'));
  }
  for (const name of ['src/app.js', 'src/community.js', 'src/styles.css']) {
    assert.ok(fs.existsSync(path.join(output, name)));
  }
  assert.match(read('src/styles.css'), /paperclub/);
  assert.match(read('src/styles.css'), /afterhours/);
});

test('Android enforces local HTTPS app assets, no insecure file access and no injected bridge', () => {
  const code = read('native/android/app/src/main/java/online/megaxo/prototype/MegaXOActivity.kt');
  const manifest = read('native/android/app/src/main/AndroidManifest.xml');
  assert.match(code, /WebViewAssetLoader/);
  assert.match(code, /appassets\.androidplatform\.net/);
  assert.match(code, /allowFileAccess\s*=\s*false/);
  assert.match(code, /allowUniversalAccessFromFileURLs\s*=\s*false/);
  assert.match(code, /MIXED_CONTENT_NEVER_ALLOW/);
  assert.match(code, /ONLINE_UNAVAILABLE/);
  assert.doesNotMatch(code, /\.addJavascriptInterface\s*\(/);
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(manifest, /android:allowBackup="false"/);
});

test('iOS restricts the loaded signed file bundle and does not expose a bridge', () => {
  const swift = read('native/ios/MegaXO/MegaXOApplication.swift');
  const project = read('native/ios/MegaXO.xcodeproj/project.pbxproj');
  assert.match(swift, /loadFileURL\(entry, allowingReadAccessTo: root\)/);
  assert.match(swift, /standardizedFileURL\.resolvingSymlinksInPath/);
  assert.match(swift, /frame\.isMainFrame/);
  assert.match(swift, /navigationResponse\.isForMainFrame/);
  assert.match(swift, /navigationType == \.linkActivated/);
  assert.doesNotMatch(swift, /\.add\(.*name:/);
  assert.match(project, /CODE_SIGNING_ALLOWED = NO/);
  assert.match(project, /MegaClient/);
  assert.ok(fs.existsSync(path.join(root, 'native/ios/MegaXO.xcodeproj/xcshareddata/xcschemes/MegaXO.xcscheme')));
});

test('native host version IDs are explicit nonproduction placeholders and offline UI is preserved', () => {
  const gradle = read('native/android/gradle.properties');
  const project = read('native/ios/MegaXO.xcodeproj/project.pbxproj');
  assert.match(gradle, /megaApplicationId=online\.megaxo\.prototype/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = online\.megaxo\.prototype/);
  assert.doesNotMatch(read('native/android/app/src/main/java/online/megaxo/prototype/MegaXOActivity.kt'), /https:\/\/megaxo\.online/);
  assert.doesNotMatch(read('native/ios/MegaXO/MegaXOApplication.swift'), /https:\/\/megaxo\.online/);
});

test('device refresh credentials use nonexportable Android keys and ThisDeviceOnly iOS Keychain items', () => {
  const android = read('native/android/app/src/main/java/online/megaxo/prototype/MegaSecureSessionVault.kt');
  const ios = read('native/ios/MegaXO/MegaNativeSecretVault.swift');
  assert.match(android, /AndroidKeyStore/);
  assert.match(android, /AES\/GCM\/NoPadding/);
  assert.match(android, /store\.deleteEntry/);
  assert.match(ios, /kSecAttrAccessibleWhenUnlockedThisDeviceOnly/);
  assert.match(ios, /kSecAttrSynchronizable/);
  assert.match(ios, /clearForFreshInstallIfRequired/);
  assert.doesNotMatch(android, /addJavascriptInterface\s*\(/);
  assert.doesNotMatch(ios, /addScriptMessageHandler/);
});

test('Android bundle staging respects the generator protected-path refusal without disabling it', () => {
  const gradle = read('native/android/app/build.gradle.kts');
  assert.match(gradle, /gradle\.gradleUserHomeDir/);
  assert.match(gradle, /tasks\.register<Exec>\("stageMegaClient"\)/);
  assert.match(gradle, /tasks\.register<Sync>\("generateMegaClient"\)/);
  assert.match(gradle, /dependsOn\(stageMegaClient\)/);
});

test('real Google and Apple provider helpers are compiled, not stubbed or exported to web content', () => {
  const gradle = read('native/android/app/build.gradle.kts');
  const iosProject = read('native/ios/MegaXO.xcodeproj/project.pbxproj');
  assert.match(gradle, /MegaGoogleIdentity\.kt/);
  assert.match(gradle, /stageGoogleIdentitySource/);
  assert.match(gradle, /credentials:1\.6\.0/);
  assert.match(gradle, /googleid:googleid:1\.2\.1/);
  assert.match(iosProject, /MegaAppleIdentity\.swift in Sources/);
  assert.match(read('native/ios/MegaAppleIdentity.swift'), /ASAuthorizationAppleIDProvider/);
  assert.match(read('native/android/MegaGoogleIdentity.kt'), /CredentialManager/);
});

test('offline Android host has OS-level network-denial until native transport is integrated', () => {
  const manifest = read('native/android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android\.permission\.INTERNET" tools:node="remove"/);
  assert.match(manifest, /com\.google\.android\.gms\.permission\.AD_ID" tools:node="remove"/);
});

test('iOS blocks HTTP(S) subresources before loading signed local HTML', () => {
  const host = read('native/ios/MegaXO/MegaXOApplication.swift');
  assert.match(host, /WKContentRuleListStore\.default\(\)\.compileContentRuleList/);
  assert.match(host, /url-filter/);
  assert.match(host, /https\?/);
  assert.match(host, /webView\.configuration\.userContentController\.add\(rule\)/);
});

test('StoreKit2 implements backend-verified four-product evidence and consumable-safe restore', () => {
  const code = read('native/ios/MegaXO/MegaStoreKit.swift');
  const project = read('native/ios/MegaXO.xcodeproj/project.pbxproj');
  assert.match(project, /MegaStoreKit\.swift in Sources/);
  assert.match(code, /Product\.products\(for:/);
  assert.match(code, /\.appAccountToken\(token\)/);
  assert.match(code, /verified\.jwsRepresentation/);
  assert.match(code, /Transaction\.currentEntitlements/);
  assert.match(code, /transaction\.productID == removeAds/);
  assert.match(code, /serverDeliveryConfirmed/);
  assert.match(code, /Transaction\.unfinished/);
  assert.doesNotMatch(code, /grantCrowns|mintCrowns|localGrant/);
});

test('Android Play Billing 9 uses obfuscated actor binding and delegates all delivery/finalization', () => {
  const code = read('native/android/app/src/main/java/online/megaxo/prototype/MegaPlayBilling.kt');
  const gradle = read('native/android/app/build.gradle.kts');
  assert.match(gradle, /billing:9\.1\.0/);
  assert.match(code, /enablePendingPurchases/);
  assert.match(code, /queryProductDetailsAsync/);
  assert.match(code, /setObfuscatedAccountId/);
  assert.match(code, /purchase\.purchaseToken/);
  assert.match(code, /purchase\.purchaseState != Purchase\.PurchaseState\.PURCHASED/);
  assert.match(code, /it\.products\.contains\(mapping\["remove_ads"\]\)/);
  assert.match(code, /backendCommitted/);
  assert.doesNotMatch(code, /\.consumeAsync\(|\.acknowledgePurchase\(/);
});

test('native transport is bearer-only, host/path bound and refuses redirects', () => {
  const android = read('native/android/app/src/main/java/online/megaxo/prototype/MegaNativeHttpClient.kt');
  const ios = read('native/ios/MegaXO/MegaNativeHTTP.swift');
  assert.match(android, /URL\(host, path\)/);
  assert.match(android, /instanceFollowRedirects = false/);
  assert.match(android, /requestMethod = method/);
  assert.match(android, /Authorization", "Bearer/);
  assert.match(android, /host == null.*token == null/);
  assert.match(ios, /URLSessionConfiguration\.ephemeral/);
  assert.match(ios, /httpShouldSetCookies = false/);
  assert.match(ios, /NoRedirectDelegate/);
  assert.match(ios, /private var accessToken: String\?/);
  assert.match(ios, /Idempotency-Key/);
  assert.doesNotMatch(ios, /refreshCredential.*Authorization/);
});

test('Android UMP and Next-Gen ads never grant rewards or bypass SDK consent', () => {
  const code = read('native/android/app/src/main/java/online/megaxo/prototype/MegaAndroidAds.kt');
  const gradle = read('native/android/app/build.gradle.kts');
  assert.match(gradle, /user-messaging-platform:4\.0\.0/);
  assert.match(gradle, /ads-mobile-sdk:1\.4\.0/);
  assert.match(code, /requestConsentInfoUpdate/);
  assert.match(code, /loadAndShowConsentFormIfRequired/);
  assert.match(code, /consent\.canRequestAds/);
  assert.match(code, /ServerSideVerificationOptions\(actor, ticket\)/);
  assert.match(code, /rewardItem != "cosmetic_reward"/);
  assert.match(code, /rewardAmount != 1/);
  assert.doesNotMatch(code, /grantCredits|mintCrowns|setBalance/);
});

test('iOS UMP and GoogleMobileAds SDKs are pinned and enforce SSV-only rewards', () => {
  const project = read('native/ios/MegaXO.xcodeproj/project.pbxproj');
  const code = read('native/ios/MegaXO/MegaIOSAds.swift');
  assert.match(project, /MegaIOSAds\.swift in Sources/);
  assert.match(project, /swift-package-manager-google-mobile-ads\.git/);
  assert.match(project, /swift-package-manager-google-user-messaging-platform\.git/);
  assert.match(project, /version = "13\.2\.0"/);
  assert.match(code, /requestConsentInfoUpdate/);
  assert.match(code, /ConsentForm\.loadAndPresentIfRequired/);
  assert.match(code, /ServerSideVerificationOptions\(\)/);
  assert.match(code, /options\.userIdentifier = actor/);
  assert.match(code, /options\.customRewardText = ticket/);
  assert.match(code, /rewardAmount == 1/);
  assert.doesNotMatch(code, /grantCredit|mintCrowns|localReward/);
});

test('native CI includes actual emulator/simulator launch smoke separate from compiler checks', () => {
  const workflow = read('.github/workflows/v5-native.yml');
  assert.match(workflow, /android-emulator-smoke:/);
  assert.match(workflow, /reactivecircus\/android-emulator-runner@v2/);
  assert.match(workflow, /xcrun simctl install/);
  assert.match(workflow, /xcrun simctl io/);
  const android = read('scripts/v5/native-smoke-android.sh');
  assert.match(android, /adb install -r/);
  assert.match(android, /adb shell pidof/);
  assert.match(android, /screencap -p/);
});
