'use strict';
/**
 * VoiceOver & Assistive Technology Accessibility Architecture & Status Audit.
 * 
 * CORE CONTRACT:
 * - Source grep counts, AST scans, and automated axe audits are static syntax checks ONLY.
 * - They do NOT constitute an accessibility acceptance.
 * - Actual screen reader acceptance requires an interactive user listening to speech synthesis
 *   utterance queues, evaluating board coordinate mental models (b:0..8, c:0..8), testing aria-live
 *   timing during rapid bot moves, and verifying modal focus restoration.
 * - Diagnostic mode is strictly READ-ONLY (no toggling user settings or triggering OS prompts).
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { REPO_ROOT } = require('./common.cjs');

function checkVoiceOverState() {
  let isRunning = false;
  try {
    const pids = execSync('pgrep -x VoiceOver', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    isRunning = pids.length > 0;
  } catch {
    isRunning = false;
  }
  return {
    voiceOverActive: isRunning,
    diagnosticMode: 'READ_ONLY',
    userPreferencesModified: false,
    systemPromptsTriggered: false
  };
}

function auditAccessibilityArchitecture() {
  const voState = checkVoiceOverState();
  const indexPath = path.join(REPO_ROOT, 'index.html');
  const appPath = path.join(REPO_ROOT, 'src/app.js');

  const syntaxChecks = [];

  if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(indexPath, 'utf8');
    syntaxChecks.push({
      id: 'A11Y-LANDMARK-MAIN',
      file: 'index.html',
      description: 'Main landmark for jump navigation',
      present: html.includes('<main') || html.includes('role="main"')
    });
    syntaxChecks.push({
      id: 'A11Y-LIVE-REGION',
      file: 'index.html',
      description: 'Live region container for opponent move narration',
      present: html.includes('aria-live') || html.includes('role="status"')
    });
  }

  if (fs.existsSync(appPath)) {
    const appJs = fs.readFileSync(appPath, 'utf8');
    syntaxChecks.push({
      id: 'A11Y-CELL-LABELS',
      file: 'src/app.js',
      description: 'Aria labels on board cells',
      present: appJs.includes('aria-label') || appJs.includes('ariaLabel')
    });
    syntaxChecks.push({
      id: 'A11Y-DIALOG-MODAL',
      file: 'src/app.js',
      description: 'Sheet modal attributes & focus handling',
      present: appJs.includes('role="dialog"') || appJs.includes('aria-modal')
    });
  }

  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    methodologyDistinction: {
      axeAndGrepSufficient: false,
      reason: 'Automated tools (axe) and source grep scans evaluate static DOM markup only. They cannot measure speech synthesis timing, aria-live utterance queue collisions, or rotor navigation comprehension.'
    },
    systemDiagnostics: voState,
    architecturalSyntaxReadinessOnly: {
      status: 'SYNTAX_INSPECTED',
      note: 'These static indicators verify markup scaffolding only; they DO NOT constitute screen reader acceptance.',
      checks: syntaxChecks
    },
    actualScreenReaderAcceptance: {
      status: 'UNMEASURED_PENDING_MODERATED_VOICEOVER_SESSION',
      prerequisiteBlocker: 'Interactive human VoiceOver evaluation with physical gesture/rotor navigation not conducted. Acceptance cannot be claimed from code presence alone.',
      acceptancePassed: false
    }
  };
}

if (require.main === module) {
  const audit = auditAccessibilityArchitecture();
  console.log('=== Mega XO Screen Reader & VoiceOver Diagnostic Audit ===');
  console.log('System VoiceOver Running:     ' + audit.systemDiagnostics.voiceOverActive);
  console.log('Automated / Grep Acceptance:  PROHIBITED (Static scans are syntax checks only)');
  console.log('Architectural Markup Scans:   ' + audit.architecturalSyntaxReadinessOnly.checks.filter(c => c.present).length + '/' + audit.architecturalSyntaxReadinessOnly.checks.length + ' present');
  console.log('Actual Screen Reader Status:  ' + audit.actualScreenReaderAcceptance.status);
  console.log('Prerequisite Blocker:         ' + audit.actualScreenReaderAcceptance.prerequisiteBlocker);
}

module.exports = { auditAccessibilityArchitecture, checkVoiceOverState };
