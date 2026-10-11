'use strict';
/**
 * Native Host Launch & DebugRenderProbe Observation Tool.
 * 
 * Provides exact commands and diagnostics for:
 * 1. Unsigned iOS Simulator compilation, installation, launch, and log streaming.
 * 2. Native bundled Worker / WASM / CacheStorage support evaluation across offline hosts:
 *    - Android appassets HTTP (WebViewAssetLoader): secure origin, supports Worker/WASM/CacheStorage.
 *    - iOS file origin (loadFileURL): WebKit file origin restricts Worker, fetch, and CacheStorage by default.
 * 3. Runtime code inventory: 11.9 MiB extra optional immutable ORT 1.23.2 fixed paths.
 * 4. Stamping condition: Cannot stamp native WASM without ready optional runtime and real trainer weights.
 *    Researcher pack catalog has NONE public.
 * 5. Android MegaNativeRenderProbe observation via adb logcat.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { REPO_ROOT, inspectHardwareInventory } = require('./common.cjs');

function getNativeHostArchitectureReport() {
  const hardware = inspectHardwareInventory();
  const booted = hardware.bootedSimulators;
  const targetUdid = booted.length > 0 ? booted[0].udid : '<BOOTED_SIMULATOR_UDID>';

  return {
    schemaVersion: 1,
    evaluatedAt: new Date().toISOString(),
    offlineHostSupport: {
      android: {
        hostType: 'Android WebView',
        entryPoint: 'https://appassets.androidplatform.net/assets/mega/bundle-index.html',
        originType: 'Virtual secure HTTPS origin via WebViewAssetLoader',
        workerSupport: 'SUPPORTED (Secure origin allows standard Web Worker instantiation)',
        wasmSupport: 'SUPPORTED (Streaming compilation and instantiation functional under appassets HTTPS)',
        cacheStorageSupport: 'SUPPORTED (window.caches accessible on secure origin)',
        probeMechanism: 'MegaNativeRenderProbe via adb logcat -d -s MegaXOStartup:I',
        expectedProbeOutput: 'READY game_initialized=true nav=5'
      },
      ios: {
        hostType: 'iOS WKWebView',
        entryPoint: 'file:///.../MegaClient/bundle-index.html via loadFileURL',
        originType: 'Local file:// scheme',
        workerSupport: 'RESTRICTED_BY_WEBKIT: In standard WebKit, file:// origins throw SecurityError on new Worker() unless allowFileAccessFromFileURLs is enabled or a custom WKURLSchemeHandler is used.',
        wasmSupport: 'RESTRICTED_STREAMING: WebAssembly.instantiateStreaming requires CORS/fetch, which file:// denies. ArrayBuffer instantiation works if bytes can be read.',
        cacheStorageSupport: 'RESTRICTED: window.caches is generally unavailable or throws in file:// origins in WebKit.',
        offlineDenyRule: 'MegaXOOfflineNetworkDenyV1 blocks ^https?:// (remote downloads blocked)',
        probeMechanism: 'Console/OSLog unified logging via xcrun simctl spawn log stream',
        expectedProbeFilter: 'processImagePath contains "MegaXO" or subsystem contains "MegaXO"'
      }
    },
    runtimeAndWeightsReadiness: {
      optionalRuntimeOrt1232: {
        sizeBytes: 12483541,
        sizeFormatted: '11.9 MiB extra',
        status: 'OPTIONAL_IMMUTABLE_FIXED_PATHS',
        path: '/src/bot/ort-1.23.2/',
        allowlistAddedByParent: true
      },
      researcherPacks: {
        publicCatalog: 'EMPTY',
        privateCandidatePacks: 'NONE_PUBLIC',
        status: 'UNSHIPPED'
      },
      nativeWasmStampStatus: {
        stamped: false,
        status: 'PENDING_REAL_RUNTIME_AND_TRAINED_WEIGHTS',
        contractRule: 'Cannot stamp native WASM without ready optional runtime fixture (ORT 1.23.2) and real model pack fixture with REAL trainer weights.'
      }
    },
    parentExecutionCommands: {
      iosSimulator: {
        step1_compileUnsignedApp: 'xcodebuild -project native/ios/MegaXO.xcodeproj -scheme MegaXO -configuration Debug -sdk iphonesimulator -derivedDataPath .artifacts/v51/native-ios CODE_SIGNING_ALLOWED=NO build',
        step2_installToSimulator: `xcrun simctl install "${targetUdid}" .artifacts/v51/native-ios/Build/Products/Debug-iphonesimulator/MegaXO.app`,
        step3_launchApp: `xcrun simctl launch "${targetUdid}" online.megaxo.prototype`,
        step4_observeLogs: `xcrun simctl spawn "${targetUdid}" log stream --predicate 'processImagePath contains "MegaXO" or subsystem contains "MegaXO"' --style compact`,
        step5_verifyFirstLaunch: `xcrun simctl io "${targetUdid}" screenshot .artifacts/v51/ios-launch.png && swift scripts/v5/verify-ios-launch.swift .artifacts/v51/home-before.png .artifacts/v51/ios-launch.png`
      },
      androidEmulator: {
        step1_installApk: 'adb install -r native/android/app/build/outputs/apk/debug/app-debug.apk',
        step2_launchApp: 'adb shell am start -W -n online.megaxo.prototype/.MegaXOActivity',
        step3_observeRenderProbe: 'adb logcat -d -s MegaXOStartup:I',
        step4_verifyGameplayCdp: 'adb forward tcp:9222 "localabstract:webview_devtools_remote_$(adb shell pidof online.megaxo.prototype)" && node scripts/v5/native-smoke-gameplay.cjs'
      }
    },
    physicalDeviceStatus: {
      android: 'No physical Android device detected in adb devices (status EMPTY); exact cause UNCONFIRMED (cable, USB debugging, or authorization unverified).',
      ios: 'Physical iPhone paired but connection cannot be established (status unavailable); exact cause UNCONFIRMED (cable, pairing, lock status, or Developer Mode unverified; not stated as fact).'
    }
  };
}

if (require.main === module) {
  const report = getNativeHostArchitectureReport();
  console.log('=== Mega XO V5.1 Native Host Launch & Probe Specification ===');
  console.log('\n[1] Offline Host Support:');
  console.log('  Android (appassets):  ' + report.offlineHostSupport.android.workerSupport);
  console.log('  iOS (loadFileURL):    ' + report.offlineHostSupport.ios.workerSupport);
  console.log('\n[2] Native WASM Stamping:');
  console.log('  Status:               ' + report.runtimeAndWeightsReadiness.nativeWasmStampStatus.status);
  console.log('  Contract Invariant:   ' + report.runtimeAndWeightsReadiness.nativeWasmStampStatus.contractRule);
  console.log('\n[3] Physical Devices:');
  console.log('  Android:              ' + report.physicalDeviceStatus.android);
  console.log('  iOS:                  ' + report.physicalDeviceStatus.ios);
  console.log('\n[4] Parent Launch Commands for iOS Simulator:');
  for (const [k, v] of Object.entries(report.parentExecutionCommands.iosSimulator)) {
    console.log(`  ${k}: ${v}`);
  }
}

module.exports = { getNativeHostArchitectureReport };
