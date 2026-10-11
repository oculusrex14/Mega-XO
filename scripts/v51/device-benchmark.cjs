#!/usr/bin/env node
'use strict';
/**
 * Mega XO V5.1 Device & Browser Acceptance CLI.
 * 
 * Target-aware, reproducible benchmarking and diagnostic harness.
 * Commands:
 *   --inspect           Inspect actual physical hardware, simulators, toolchain, codesigning, and OS thermal
 *   --safari-smoke      Execute MobileSafari simulator smoke command (never substitutes desktop Playwright)
 *   --native-parity     Validate Android and iOS bundle allowlist parity and offline host architecture
 *   --voiceover-audit   Run VoiceOver & assistive technology read-only diagnostics
 *   --study-protocol    Display moderated new-user study protocol (B07.08) and exact blocker status
 *   --serve             Launch safe loopback harness server (127.0.0.1 ephemeral)
 *   --capture           Execute desktop harness and record dedicated evidence JSON with verified samples
 *   --all               Run all automated diagnostics and print comprehensive report
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const {
  REPO_ROOT,
  getArtifactIdentity,
  inspectHardwareInventory,
  getCanonicalCorpus,
  computeStats,
  PERFORMANCE_CONTRACTS
} = require('./device-benchmark/common.cjs');

const { createBenchmarkServer } = require('./device-benchmark/server.cjs');
const { checkNativeBundleParity } = require('./device-benchmark/native-parity-check.cjs');
const { auditAccessibilityArchitecture } = require('./device-benchmark/accessibility-voiceover-audit.cjs');
const { getStudyProtocol } = require('./device-benchmark/user-study-protocol.cjs');
const { runSafariSimulatorBenchmark } = require('./device-benchmark/safari-simulator.cjs');
const { getNativeHostArchitectureReport } = require('./device-benchmark/native-launch-probe.cjs');

function getOSThermalState() {
  if (process.platform === 'darwin') {
    try {
      const therm = execSync('pmset -g therm', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return {
        available: true,
        source: 'pmset -g therm',
        raw: therm
      };
    } catch {}
  }
  return {
    available: false,
    status: 'UNAVAILABLE_PENDING_NATIVE_INSTRUMENTATION',
    note: 'System thermal state requires native xctrace / PowerLog / IOKit instrumentation.'
  };
}

async function handleInspect() {
  const inventory = inspectHardwareInventory();
  const artifact = getArtifactIdentity();
  const thermal = getOSThermalState();

  const report = {
    schemaVersion: 1,
    checkedAt: inventory.checkedAt,
    artifactIdentity: artifact,
    hostPlatform: inventory.hostPlatform,
    physicalDevices: inventory.physicalDevices,
    codeSigning: inventory.codeSigning,
    bootedSimulators: inventory.bootedSimulators,
    profilingTools: inventory.profilingTools,
    nativeThermalState: thermal,
    unmetPrerequisites: [
      inventory.physicalDevices.android.prerequisiteBlocker,
      inventory.physicalDevices.ios.prerequisiteBlocker,
      inventory.codeSigning.prerequisiteBlocker
    ].filter(Boolean)
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function handleNativeParity() {
  const res = checkNativeBundleParity();
  console.log(JSON.stringify(res, null, 2));
  if (!res.allowlistParity.passed) process.exitCode = 1;
  return res;
}

async function handleVoiceOverAudit() {
  const res = auditAccessibilityArchitecture();
  console.log(JSON.stringify(res, null, 2));
  return res;
}

async function handleStudyProtocol() {
  const protocol = getStudyProtocol();
  console.log(JSON.stringify(protocol, null, 2));
  return protocol;
}

async function handleServe() {
  const server = createBenchmarkServer();
  const endpoint = await server.listen(0, '127.0.0.1');
  console.log(`Mega XO Benchmark Loopback Server active at:`);
  console.log(`  Origin:  ${endpoint.origin}`);
  console.log(`  Harness: ${endpoint.harnessUrl}`);
  console.log(`  Corpus:  ${endpoint.origin}/api/corpus`);
  console.log('\nPress Ctrl+C to stop.');
  await new Promise(() => {});
}

async function handleCapture() {
  console.log('Executing desktop benchmark harness to capture real runtime telemetry...');
  const server = createBenchmarkServer();
  const endpoint = await server.listen(0, '127.0.0.1');

  let playwright;
  try { playwright = require('playwright'); } catch {}

  const hardware = inspectHardwareInventory();
  const artifact = getArtifactIdentity();
  const thermal = getOSThermalState();
  let telemetry = null;
  let browserEngine = 'desktop-unknown';
  let benchmarkError = null;

  if (playwright) {
    let browser;
    try {
      browser = await playwright.webkit.launch({ headless: true });
      browserEngine = `desktop-webkit-${browser.version()}`;
    } catch {
      browser = await playwright.chromium.launch({ headless: true });
      browserEngine = `desktop-chromium-${browser.version()}`;
    }

    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(endpoint.harnessUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__BENCHMARK_RESULT__ || !!window.__BENCHMARK_ERROR__, { timeout: 60000 });
      benchmarkError = await page.evaluate(() => window.__BENCHMARK_ERROR__ || null);
      if (!benchmarkError) {
        telemetry = await page.evaluate(() => window.__BENCHMARK_RESULT__);
      }
    } catch (e) {
      benchmarkError = e.message;
    } finally {
      await browser.close();
    }
  } else {
    console.log(`Playwright not available. Waiting for external client to load ${endpoint.harnessUrl}...`);
    try {
      telemetry = await server.waitForResult(30000);
      browserEngine = 'desktop-external-browser';
    } catch (e) {
      benchmarkError = 'No client connected to loopback within timeout: ' + e.message;
    }
  }

  await server.close();

  // Strict validity check: FAIL CLI if error or invalid samples
  if (benchmarkError) {
    console.error('CAPTURE_FAILED: Benchmark reported fatal error: ' + benchmarkError);
    process.exitCode = 1;
    return null;
  }

  if (!telemetry || !telemetry.corpusSummary || !telemetry.corpusSummary.statsMs) {
    console.error('CAPTURE_FAILED: Telemetry payload missing corpusSummary statistics.');
    process.exitCode = 1;
    return null;
  }

  const stats = telemetry.corpusSummary.statsMs;
  if (!Number.isFinite(stats.p50) || !Number.isFinite(stats.p95) || stats.count === 0) {
    console.error('CAPTURE_FAILED: Telemetry contains non-finite or empty samples.');
    process.exitCode = 1;
    return null;
  }

  const rawSamples = telemetry.rawSamplesMs || [];
  if (rawSamples.length === 0 || !rawSamples.every(Number.isFinite)) {
    console.error('CAPTURE_FAILED: Raw samples contains non-finite or missing numeric data.');
    process.exitCode = 1;
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const evidenceDir = path.join(REPO_ROOT, 'docs/v5.1/bot-ai/evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const filename = `device-${timestamp}.json`;
  const evidencePath = path.join(evidenceDir, filename);

  const captureEvidence = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    evidenceFile: filename,
    deviceClass: 'desktop-browser',
    browserEngine,
    physicalDevices: false,
    environmentDisclaimer: 'Desktop browser automated execution; NOT physical Android or iPhone device measurements.',
    hardwareInventory: {
      androidPhysicalConnected: hardware.physicalDevices.android.detected,
      iosPhysicalConnected: hardware.physicalDevices.ios.detected,
      codeSigningIdentities: hardware.codeSigning.validIdentities,
      bootedSimulatorsCount: hardware.bootedSimulators.length
    },
    nativeThermalState: thermal,
    unmetPrerequisites: [
      'Physical Android: ' + hardware.physicalDevices.android.prerequisiteBlocker,
      'Physical iPhone: ' + hardware.physicalDevices.ios.prerequisiteBlocker,
      'Code Signing: ' + hardware.codeSigning.prerequisiteBlocker,
      'User Study: Moderated study blocked pending recruitment of >=20 novice human participants (Task B07.08)'
    ],
    artifactIdentity: artifact,
    contracts: PERFORMANCE_CONTRACTS,
    benchmarkResults: telemetry
  };

  fs.writeFileSync(evidencePath, JSON.stringify(captureEvidence, null, 2) + '\n');
  console.log(`\nSuccessfully captured verified benchmark evidence to:`);
  console.log(`  ${evidencePath}`);
  console.log(`Browser Engine: ${browserEngine}`);
  console.log(`Expert p50:     ${stats.p50}ms`);
  console.log(`Expert p95:     ${stats.p95}ms (Target: <1500ms: ${stats.p95 < 1500 ? 'PASS' : 'EXCEEDED'})`);
  console.log(`Canonical 9x:   ${telemetry.corpusSummary.positionsTested} positions tested`);
  return captureEvidence;
}

async function handleAll() {
  console.log('=== Mega XO V5.1 Full Device Acceptance & Audit Suite ===\n');

  console.log('1. Inspecting Hardware Toolchain & Inventory:');
  const hardware = await handleInspect();

  console.log('\n2. Auditing Native Allowlist Build Parity & Host Architecture:');
  const parity = await handleNativeParity();

  console.log('\n3. Auditing VoiceOver & Assistive Tech Architecture (Read-Only):');
  const a11y = await handleVoiceOverAudit();

  console.log('\n4. Reviewing Moderated User Study Protocol (Task B07.08):');
  const study = await handleStudyProtocol();

  console.log('\n5. Target Contracts Verification:');
  console.log('  Expert p95 Target:     < ' + PERFORMANCE_CONTRACTS.expertMaxP95Ms + 'ms');
  console.log('  Impossible p95 Target: < ' + PERFORMANCE_CONTRACTS.impossibleMaxP95Ms + 'ms');
  console.log('  Routing Comprehension: >= ' + PERFORMANCE_CONTRACTS.userStudyRoutingComprehensionMinPct + '% unprompted');

  console.log('\n=== Summary of Unmet Real-Hardware & Human Prerequisites ===');
  for (const block of hardware.unmetPrerequisites) {
    console.log('  [BLOCKED] ' + block);
  }
  console.log('  [BLOCKED] User Study: ' + study.targetAcceptanceCriteria.prerequisiteBlocker);
  console.log('  [UNMEASURED] Screen Reader: ' + a11y.actualScreenReaderAcceptance.prerequisiteBlocker);
}

async function main() {
  const arg = process.argv[2];
  if (!arg || arg === '--help' || arg === '-h') {
    console.log(`
Mega XO V5.1 Device & Browser Benchmark Tooling

Usage:
  node scripts/v51/device-benchmark.cjs [command]

Commands:
  --inspect           Detect physical hardware, iOS simulators, code signing, and OS thermal
  --safari-smoke      Execute MobileSafari simulator smoke command (no desktop substitution)
  --native-parity     Validate native bundle allowlist build parity & offline host architecture
  --native-probe      Output exact unsigned simulator launch, RenderProbe observation commands, and WASM readiness
  --voiceover-audit   Run VoiceOver & screen reader read-only diagnostics
  --study-protocol    Display moderated user study protocol (Task B07.08)
  --serve             Launch safe loopback HTTP server (127.0.0.1)
  --capture           Run desktop harness and write docs/v5.1/bot-ai/evidence/device-<timestamp>.json
  --all               Run full non-destructive audit suite
`);
    return;
  }

  switch (arg) {
    case '--inspect':
      await handleInspect();
      break;
    case '--safari-smoke':
      await runSafariSimulatorBenchmark();
      break;
    case '--native-parity':
      await handleNativeParity();
      break;
    case '--native-probe':
      console.log(JSON.stringify(getNativeHostArchitectureReport(), null, 2));
      break;
    case '--voiceover-audit':
      await handleVoiceOverAudit();
      break;
    case '--study-protocol':
      await handleStudyProtocol();
      break;
    case '--serve':
      await handleServe();
      break;
    case '--capture':
      await handleCapture();
      break;
    case '--all':
      await handleAll();
      break;
    default:
      console.error('Unknown option: ' + arg);
      process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('Fatal CLI Error: ' + err.stack || err.message);
  process.exitCode = 1;
});
