'use strict';
/**
 * Moderated New-User Study Protocol: Unprompted Board Routing Comprehension.
 * Task B07.08 Governance.
 * 
 * CORE CONTRACT & HONESTY INVARIANT:
 * - Comprehension cannot and must not be fabricated.
 * - Preparation of this protocol, scoring rubric, and environment setup DOES NOT mark task done.
 * - The task remains BLOCKED until real human participants are recruited and tested in a moderated setting.
 */

const fs = require('node:fs');
const path = require('node:path');

const USER_STUDY_PROTOCOL = {
  schemaVersion: 1,
  taskId: 'B07.08',
  title: 'Moderated New-User Study: Unprompted Next-Board Routing Comprehension',
  targetAcceptanceCriteria: {
    minimumParticipantCohort: 20,
    targetUnpromptedComprehensionRatePct: 80, // >= 80% unprompted next-board routing target
    evaluationWindowTurns: 5,                // First 5 moves per participant
    prerequisiteStatus: 'BLOCKED',
    prerequisiteBlocker: 'No human participants recruited or tested; actual user comprehension cannot be fabricated.'
  },
  taskDesign: {
    objective: 'Determine whether novice players deduce the Ultimate Tic-Tac-Toe routing rule (the cell selected in the local mini-board determines the active mini-board for the opponent\'s subsequent turn) without explicit coaching or hints.',
    targetRule: 'Move at (b, c) forces the opponent\'s next move to mini-board c, provided mini-board c is open and undecided.',
    rubric: {
      perfect: {
        score: 1.0,
        description: 'Participant unpromptedly selects and executes legal move in the dictated active mini-board on first interaction without guidance.'
      },
      partial: {
        score: 0.5,
        description: 'Participant initially taps a disabled mini-board, observes UI constraint indicator (active border highlight / subtle shake), and immediately selects the correct board without verbal intervention.'
      },
      failure: {
        score: 0.0,
        description: 'Participant expresses confusion, requires facilitator explanation, or relies on tutorial hint/continue button.'
      }
    }
  },
  setupInstructions: {
    facilitatorScript: 'Welcome. Today you will be trying Mega XO. Your goal is to align three mini-boards in a row to win the overall match. Please take your first five moves against the computer opponent as you would normally play.',
    deviceConfiguration: 'Native iOS WKWebView or Android WebView test build running on reference hardware, initialized in clean state (no prior local storage or cached saves).',
    moderatorRole: 'Strictly observational. Do not offer unsolicited tips, point at active boards, or explain the destination rule during the 5-move evaluation window.'
  },
  privacyAndEthics: {
    piiCollected: false,
    piiGuarantee: 'Zero participant names, emails, biometrics, camera recordings, or device serials are recorded or transmitted.',
    anonymization: 'Participants assigned randomized tokens (e.g., P-01 through P-20).',
    dataRetention: 'Anonymized scoring tallies stored locally in docs/v5.1/bot-ai/evidence/study-scores.json; no telemetry sent to third parties.',
    voluntaryParticipation: 'Participants may withdraw at any time without penalty.'
  },
  currentStatusLedger: {
    status: 'BLOCKED',
    completedSessions: 0,
    recordedParticipants: 0,
    measuredScore: null,
    conclusion: 'UNMET_PREREQUISITE: Requires real human participant recruitment and moderated evaluation sessions.'
  }
};

function getStudyProtocol() {
  return USER_STUDY_PROTOCOL;
}

if (require.main === module) {
  console.log('=== Mega XO V5.1 Moderated User Study Protocol (B07.08) ===');
  console.log('Task:                     ' + USER_STUDY_PROTOCOL.taskId);
  console.log('Target Criteria:          >= ' + USER_STUDY_PROTOCOL.targetAcceptanceCriteria.targetUnpromptedComprehensionRatePct + '% unprompted routing comprehension');
  console.log('Minimum Cohort:           ' + USER_STUDY_PROTOCOL.targetAcceptanceCriteria.minimumParticipantCohort + ' novice participants');
  console.log('Current Status:           ' + USER_STUDY_PROTOCOL.currentStatusLedger.status);
  console.log('Exact Blocker:            ' + USER_STUDY_PROTOCOL.targetAcceptanceCriteria.prerequisiteBlocker);
  console.log('Privacy Protections:      ZERO PII collected, anonymous tokens P-01..P-20 only.');
  console.log('Done State Claim:         PROHIBITED (Preparation does not mark task done).');
}

module.exports = { getStudyProtocol, USER_STUDY_PROTOCOL };
