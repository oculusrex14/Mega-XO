#!/usr/bin/env node
'use strict';

/**
 * Run already-existing P04/P05 REAL-service acceptance suites on a caller-owned
 * disposable LOOPBACK PostgreSQL 16 instance only. This reuses the P04/P05
 * guarded service factories and SQL migrations; it does not test real Vercel,
 * Oracle, Neon staging, provider credentials or production players.
 *
 * No live network target, raw TAP / user data or connection string is stored
 * in the public report. Failure and skipped/zero assertions fail the job.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SUITES = Object.freeze([
  Object.freeze({
    id: 'pg-services-social-economy',
    file: 'tests/v5-p04-services.test.js',
    areas: Object.freeze(['account', 'social', 'cloud-save', 'settlement', 'receipt']),
    cases: Object.freeze(['A09','A10','A11','A12'])
  }),
  Object.freeze({
    id: 'pg-session-actor-coherence',
    file: 'tests/v5-p05-integration.test.js',
    areas: Object.freeze(['native-browser-actor', 'revocation', 'refresh']),
    cases: Object.freeze(['A12','A13','A14'])
  })
]);

function refuse(reason) { throw new Error('P18_DISPOSABLE_REFUSED: ' + reason); }
function boundedLoopbackEnvironment(env) {
  if (!env || env.V5_PG_DISPOSABLE !== '1' || env.V5_PG_REQUIRED !== '1' ||
      env.V5_TARGET !== 'test' || env.V5_MIGRATE_ALLOW_INSECURE_LOOPBACK !== '1') {
    refuse('explicit owned synthetic PostgreSQL harness markers required');
  }
  let address;
  try { address = new URL(env.V5_PG_URL); } catch { refuse('loopback PostgreSQL URL required'); }
  if (!['postgres:', 'postgresql:'].includes(address.protocol) ||
      !['127.0.0.1','localhost','[::1]'].includes(address.hostname) ||
      address.pathname !== '/postgres' || address.search || address.hash) {
    refuse('only disposable loopback PostgreSQL control database is permitted');
  }
  for (const key of ['DATABASE_URL', 'NEON_DATABASE_URL', 'PRODUCTION_DATABASE_URL',
    'VERCEL_TOKEN', 'SMTP_PASSWORD', 'GOOGLE_APPLICATION_CREDENTIALS']) {
    if (env[key]) refuse('provider or production environment variable is prohibited');
  }
  return address;
}
function parseTap(text, id) {
  if (typeof text !== 'string' || text.length > 32_000_000) refuse('unbounded test output: ' + id);
  const count = label => {
    const matches = [...text.matchAll(new RegExp('^# ' + label + ' (\\d+)$', 'gm'))];
    return matches.length === 1 ? Number(matches[0][1]) : null;
  };
  const pass=count('pass'),fail=count('fail'),skipped=count('skipped'),total=count('tests');
  if ([pass,fail,skipped,total].some(v => !Number.isSafeInteger(v)) ||
      pass < 1 || fail !== 0 || skipped !== 0 || total < pass) {
    refuse('missing, failed, skipped or zero-coverage PG tests: ' + id);
  }
  return {pass,fail,skipped,total};
}
function run({root=process.cwd(),env=process.env,spawn=spawnSync}={}) {
  boundedLoopbackEnvironment(env);
  const reports=[];
  for(const spec of SUITES){
    const file=path.join(root,spec.file);
    const status=fs.statSync(file);
    if(!status.isFile() || status.size===0) refuse('owned test suite missing: ' + spec.id);
    const result=spawn(process.execPath,
      ['--test', '--test-reporter=tap','--test-force-exit','--test-concurrency=1',spec.file],
      {
        cwd:root,encoding:'utf8',timeout:300000,maxBuffer:32_000_000,
        env:{
          PATH:env.PATH,HOME:env.HOME,CI:'true',NODE_ENV:'test',
          V5_PG_URL:env.V5_PG_URL,V5_PG_DISPOSABLE:'1',V5_PG_REQUIRED:'1',
          V5_TARGET:'test',V5_MIGRATE_ALLOW_INSECURE_LOOPBACK:'1'
        }
      });
    if(result.status!==0 || result.signal || result.error) {
      refuse('real PostgreSQL service suite failed or timed out: ' + spec.id);
    }
    const counts=parseTap(result.stdout,spec.id);
    const bytes=fs.readFileSync(file);
    reports.push({suiteId:spec.id,file:spec.file,
      sourceSha256:crypto.createHash('sha256').update(bytes).digest('hex'),
      casesCoveredAsFixtures:[...spec.cases],assertionCounters:counts,status:'DISPOSABLE_SERVICE_TEST_PASSED'});
  }
  return {
    format:'mega-v5-p18-disposable-service-evidence/v1',
    executionLevel:'REAL_POSTGRESQL_DISPOSABLE_SYNTHETIC',
    serviceEndpointClass:'OWNED_LOOPBACK_ONLY',
    providerEffects:'NOT_CONNECTED',
    g18Accepted:false,
    liveStagingVerified:false,
    suites:reports,
    note:'Real P04/P05 SQL-backed service tests executed on disposable PG16; not proof of Vercel/Core/worker staging integration'
  };
}
function list(){
  return {format:'mega-v5-p18-disposable-plan/v1',
    executionStatus:'NOT_EXECUTED',g18Accepted:false,
    suites:SUITES.map(s=>({id:s.id,file:s.file,cases:[...s.cases],areas:[...s.areas]}))};
}
if(require.main===module){
  try {
    const mode=process.argv[2];
    if(process.argv.length!==3 || !['--list','--run'].includes(mode)) {
      refuse('usage: disposable-service-journeys.js --list|--run');
    }
    const result=mode==='--list'?list():run();
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  }catch(err){process.stderr.write(err.message+'\n');process.exitCode=2;}
}
module.exports={SUITES,boundedLoopbackEnvironment,parseTap,run,list};
