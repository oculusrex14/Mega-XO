#!/usr/bin/env node
'use strict';

/**
 * P18 staging evidence ingestion. A structurally valid upload is NOT proof:
 * observed provider state, staging execution and run provenance must still be
 * independently reviewed by the integration owner before G18 is accepted.
 * We never ask for provider credentials or write to live environments.
 */
const fs = require('node:fs');
const path = require('node:path');
const { TASKS, plan, loadSource } = require('./acceptance-registry.js');
const { inspect, load } = require('./staging-isolation.js');

const FORMAT = 'mega-v5-p18-staging-observations/v1';
const SHA = /^[a-f0-9]{40}$/;
const EVIDENCE_REF = /^(?:artifact:\/\/[a-zA-Z0-9._/-]{6,180}|https:\/\/github\.com\/oculusrex14\/Mega-XO\/actions\/runs\/[0-9]{4,16}|docs\/v5\/evidence\/[a-z0-9._/-]{6,140}\.json)$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
function refuse(message) { throw new Error('P18_EVIDENCE_REFUSED: ' + message); }
function exactObject(value, keys, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    refuse('unapproved/missing fields in ' + context);
  }
}
function scanSensitive(value, depth=0) {
  if (depth > 10) refuse('record too deeply nested');
  if (value && typeof value === 'object') {
    for (const [key, field] of Object.entries(value)) {
      if (/(?:token|password|secret|cookie|authorization|emailAddress|rawReceipt|rawActor|providerPrivateKey|accessKey)/i.test(key)) {
        refuse('credential or personal data field is forbidden');
      }
      scanSensitive(field,depth+1);
    }
  }
}
function validateEvidenceRef(ref) {
  if (typeof ref !== 'string' || !EVIDENCE_REF.test(ref) ||
      ref.includes('..') || ref.includes('//..')) refuse('untrusted or missing evidence reference');
}
function validateOneTask(entry,spec,expectedSha) {
  exactObject(entry,['taskId','status','level','sourceSha','observedAtUtc','runId','proofs','caseResults'],'task evidence');
  if (entry.taskId !== spec.taskId || entry.level !== spec.evidenceLevel ||
      entry.sourceSha !== expectedSha) refuse('task/source/evidence-level mismatch');
  if (!['NOT_RUN','OBSERVED_PASS','OBSERVED_FAIL'].includes(entry.status)) refuse('unsupported task result');
  if (!Array.isArray(entry.caseResults) || entry.caseResults.length !== spec.caseIds.length) {
    refuse('incomplete per-case observations');
  }
  const seen=new Set();
  for (const item of entry.caseResults) {
    exactObject(item,['caseId','status'],'case observation');
    if (!spec.caseIds.includes(item.caseId) || seen.has(item.caseId)) refuse('unexpected/duplicate acceptance case');
    if (!['NOT_RUN','OBSERVED_PASS','OBSERVED_FAIL'].includes(item.status)) refuse('unrecognized case result');
    seen.add(item.caseId);
  }
  if (entry.status==='NOT_RUN') {
    if (entry.observedAtUtc !== null || entry.runId !== null ||
        !Array.isArray(entry.proofs) || entry.proofs.length !== 0 ||
        entry.caseResults.some(item=>item.status!=='NOT_RUN')) {
      refuse('unexecuted task cannot contain passing observations or evidence');
    }
    return {taskId:entry.taskId,classification:'NOT_EXECUTED',missingKinds:[...spec.requiredEvidence]};
  }
  if (typeof entry.observedAtUtc !== 'string' || !TIME.test(entry.observedAtUtc) ||
      !Number.isFinite(Date.parse(entry.observedAtUtc)) ||
      !Number.isSafeInteger(entry.runId) || entry.runId < 1) {
    refuse('observed result requires actual timestamp and unique run ID');
  }
  if (!Array.isArray(entry.proofs)) refuse('evidence dimensions must be an array');
  const byKind=new Set();
  for (const proof of entry.proofs) {
    exactObject(proof,['kind','ref'],'evidence dimension');
    if (!spec.requiredEvidence.includes(proof.kind) || byKind.has(proof.kind)) {
      refuse('unexpected or duplicated evidence dimension');
    }
    validateEvidenceRef(proof.ref);
    byKind.add(proof.kind);
  }
  const missingKinds=spec.requiredEvidence.filter(kind=>!byKind.has(kind));
  if (entry.status==='OBSERVED_PASS') {
    if (missingKinds.length) refuse('claimed pass lacks required evidence kinds');
    if (entry.caseResults.some(item=>item.status!=='OBSERVED_PASS')) {
      refuse('task pass hides failed or unexecuted acceptance case');
    }
  } else if (!entry.caseResults.some(item=>item.status==='OBSERVED_FAIL')) {
    refuse('failed task needs at least one failed acceptance case');
  }
  return {taskId:entry.taskId,
    classification:entry.status==='OBSERVED_PASS' ? 'CLAIMED_PASS_REQUIRES_INDEPENDENT_REVIEW' : 'OBSERVED_FAILURE',
    missingKinds};
}
function evaluate(record,root,expectedSha) {
  if (typeof expectedSha !== 'string' || !SHA.test(expectedSha)) refuse('exact source SHA required');
  scanSensitive(record);
  exactObject(record,['format','sourceSha','environment','stageNeonProjectId','stageNeonBranchId',
    'stageNeonEndpointId','stageDatabase','providerEffectsDisabled','tasks'],'staging observation');
  if (record.format!==FORMAT || record.sourceSha!==expectedSha || record.environment!=='staging') {
    refuse('wrong format, source or environment');
  }
  if (record.providerEffectsDisabled!==true) refuse('staging provider/email effects not disabled');
  const isolation=inspect(load(root));
  if (isolation.stageExecutionAuthorized!==false || isolation.g18Accepted!==false) {
    refuse('static inventory must never authorize stage execution');
  }
  const staging=load(root).staging;
  if (record.stageNeonProjectId!==staging.projectId ||
      record.stageNeonBranchId!==staging.branchId ||
      record.stageNeonEndpointId!==staging.endpointId ||
      record.stageDatabase!==staging.database) {
    refuse('observed staging database does not match isolated inventory');
  }
  const expected=plan(loadSource(root)).tasks;
  if (!Array.isArray(record.tasks) || record.tasks.length!==expected.length) {
    refuse('must account for all five P18 tasks');
  }
  const summaries=record.tasks.map((entry,index)=>validateOneTask(entry,expected[index],expectedSha));
  const IDs=record.tasks.filter(entry=>entry.runId!==null).map(entry=>entry.runId);
  if (new Set(IDs).size!==IDs.length) refuse('task run evidence reused between independent tasks');
  const allClaimed=record.tasks.every(t=>t.status==='OBSERVED_PASS');
  return {
    format:'mega-v5-p18-acceptance-assessment/v1',
    sourceSha:expectedSha,
    environment:'staging',
    evidenceSubmitted:record.tasks.some(t=>t.status!=='NOT_RUN'),
    everyTaskClaimsPass:allClaimed,
    status: allClaimed ? 'ALL_PASS_CLAIMS_UNVERIFIED' : 'G18_EVIDENCE_INCOMPLETE',
    g18Accepted:false,
    requiresIndependentProviderAndExecutionReview:true,
    tasks:summaries,
    notClaimed:[
      'external provider/environment isolation verified',
      'live cross-service E2E execution',
      'physical native device acceptance',
      'production authority transfer or promotion'
    ]
  };
}
function readScoped(root,relative) {
  if (typeof relative!=='string' || !/^\.artifacts\/[a-z0-9][a-z0-9._-]{0,100}\.json$/.test(relative)) {
    refuse('input must be a bounded .artifacts JSON record');
  }
  const location=path.join(root,relative);
  const stat=fs.lstatSync(location);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size>196608) refuse('unsafe evidence file');
  return JSON.parse(fs.readFileSync(location,'utf8'));
}
function run(args,root=process.cwd()) {
  if (args.length!==4 || args[0]!=='--file' || args[2]!=='--sha') {
    refuse('usage: --file .artifacts/p18-observations.json --sha COMMIT');
  }
  return evaluate(readScoped(root,args[1]),root,args[3]);
}
if(require.main===module){
  try { process.stdout.write(JSON.stringify(run(process.argv.slice(2)),null,2)+'\n'); }
  catch(err) {process.stderr.write(err.message+'\n');process.exitCode=2;}
}
module.exports={FORMAT,validateEvidenceRef,validateOneTask,evaluate,readScoped,run};
