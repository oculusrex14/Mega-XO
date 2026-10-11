'use strict';
/**
 * Actual Safari and MobileSafari Simulator Benchmark Runner.
 * 
 * CRITICAL SEPARATION CONTRACT:
 * - When simulator is requested, NEVER substitute desktop Playwright WebKit.
 * - Dispatches harness to booted iOS simulator MobileSafari via `xcrun simctl openurl`.
 * - Awaits actual MobileSafari client POST to loopback /api/results.
 * - Validates incoming client User-Agent contains Mobile/iPhone indicators.
 * - Records verified client UA, runId, and simulator OS separately.
 * - If simulator fails to report, records TIMEOUT honestly (no synthetic substitution).
 * - Documents desktop safaridriver as an explicit separate prerequisite.
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { createBenchmarkServer } = require('./server.cjs');
const { inspectHardwareInventory, getArtifactIdentity } = require('./common.cjs');

async function runSafariSimulatorBenchmark(options = {}) {
  const hardware = inspectHardwareInventory();
  const artifact = getArtifactIdentity();

  console.log('=== Mega XO V5.1 MobileSafari Simulator Benchmark Runner ===');
  console.log('Artifact Commit: ' + artifact.gitCommit);
  console.log('Rules SHA256:    ' + artifact.rulesSha256);

  const booted = hardware.bootedSimulators;
  console.log(`Detected ${booted.length} booted iOS simulator(s):`);
  for (const sim of booted) {
    console.log(`  - [${sim.name}] UDID: ${sim.udid} (${sim.runtime})`);
  }

  const server = createBenchmarkServer();
  const endpoint = await server.listen(0, '127.0.0.1');
  console.log(`Safe loopback server bound to: ${endpoint.origin}`);
  console.log(`Harness URL: ${endpoint.harnessUrl}`);

  let targetSim = null;
  if (options.udid) {
    targetSim = booted.find(b => b.udid === options.udid) || { udid: options.udid, name: 'Specified UDID' };
  } else if (booted.length > 0) {
    targetSim = booted[0];
  }

  const result = {
    schemaVersion: 1,
    executedAt: new Date().toISOString(),
    harnessUrl: endpoint.harnessUrl,
    mode: options.desktopSafari ? 'desktop-safari-driver' : 'ios-mobilesafari-simulator',
    targetSimulator: targetSim,
    physicalDevice: false,
    environmentDisclaimer: 'iOS Simulator MobileSafari execution; NOT physical iPhone reference hardware.',
    verifiedClientMetadata: null,
    telemetry: null,
    status: 'PENDING',
    error: null
  };

  try {
    if (options.desktopSafari) {
      console.log('\n--- Desktop Safari Mode (Requires safaridriver) ---');
      if (!hardware.profilingTools.safaridriverAvailable) {
        throw new Error('SAFARIDRIVER_UNAVAILABLE: /System/Cryptexes/App/usr/bin/safaridriver not found. Run `safaridriver --enable` as admin.');
      }
      console.log('Desktop Safari automation requires safaridriver authorization and explicit user session.');
      console.log('Waiting for desktop Safari client to open ' + endpoint.harnessUrl + ' ...');
      const telemetry = await server.waitForResult(30000);
      result.telemetry = telemetry;
      result.status = 'SUCCESS_DESKTOP_SAFARI';
    } else {
      if (!targetSim) {
        throw new Error('NO_BOOTED_SIMULATOR: No booted iOS simulator detected. Boot a simulator or supply --udid=<udid>.');
      }

      console.log(`\nLaunching MobileSafari in iOS Simulator: [${targetSim.name}] (${targetSim.udid})...`);
      const openCmd = `xcrun simctl openurl "${targetSim.udid}" "${endpoint.harnessUrl}"`;
      console.log(`Simulator Smoke Command: ${openCmd}`);
      execSync(openCmd, { timeout: 15000 });
      console.log('MobileSafari launched with loopback harness URL.');
      console.log('Awaiting verified MobileSafari client telemetry via loopback POST /api/results (up to 45s)...');

      // Validator: ensure the POST came from MobileSafari, NOT desktop or curl
      const validator = data => {
        const ua = data.environment?.userAgent || '';
        const isMobileOrSim = ua.includes('Mobile/') || ua.includes('iPhone') || ua.includes('iPad') || data.environment?.deviceClass?.includes('simulator');
        return isMobileOrSim;
      };

      try {
        const simTelemetry = await server.waitForResult(45000, validator);
        result.telemetry = simTelemetry;
        result.status = 'SUCCESS_SIMULATOR_TELEMETRY';
        result.verifiedClientMetadata = {
          runId: simTelemetry.runId,
          clientUserAgent: simTelemetry.environment?.userAgent,
          deviceClass: simTelemetry.environment?.deviceClass,
          simulatorOS: targetSim.runtime,
          reportedAt: simTelemetry.timestamp
        };
        console.log('\nVerified MobileSafari telemetry received successfully!');
        console.log(`  RunID:        ${simTelemetry.runId}`);
        console.log(`  Device Class: ${simTelemetry.environment?.deviceClass}`);
        console.log(`  Expert p50:   ${simTelemetry.corpusSummary?.statsMs?.p50}ms`);
        console.log(`  Expert p95:   ${simTelemetry.corpusSummary?.statsMs?.p95}ms`);
      } catch (waitErr) {
        result.status = 'TIMEOUT_WAITING_FOR_SIMULATOR_CLIENT';
        result.error = 'MobileSafari client did not complete or POST telemetry within 45s. Ensure simulator has finished booting and SpringBoard is responsive.';
        console.warn('\nWARNING: ' + result.error);
        console.warn('NOTE: Desktop Playwright substitution was NOT performed to avoid conflating simulator metrics.');
      }
    }
  } catch (err) {
    result.status = 'ERROR';
    result.error = err.message;
    console.error('Runner Error: ' + err.message);
  } finally {
    await server.close();
    console.log('Loopback server stopped.');
  }

  return result;
}

if (require.main === module) {
  const udidArg = process.argv.find(a => a.startsWith('--udid='))?.split('=')[1];
  const desktopArg = process.argv.includes('--desktop-safari');

  runSafariSimulatorBenchmark({ udid: udidArg, desktopSafari: desktopArg })
    .then(res => {
      console.log('\n--- Final Runner Result ---');
      console.log(JSON.stringify({
        executedAt: res.executedAt,
        mode: res.mode,
        status: res.status,
        targetSimulator: res.targetSimulator?.name || res.targetSimulator?.udid || 'none',
        hasTelemetry: !!res.telemetry,
        verifiedClientUA: res.verifiedClientMetadata?.clientUserAgent || null,
        error: res.error
      }, null, 2));
      if (res.status !== 'SUCCESS_SIMULATOR_TELEMETRY' && res.status !== 'SUCCESS_DESKTOP_SAFARI') {
        process.exitCode = 1;
      }
    })
    .catch(err => {
      console.error('Fatal Runner Exception:', err);
      process.exitCode = 1;
    });
}

module.exports = { runSafariSimulatorBenchmark };
