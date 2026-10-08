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
