'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {boundedLoopbackEnvironment,parseTap,run,list}=require('../scripts/v5/p18/disposable-service-journeys.js');
const root=path.resolve(__dirname,'..');
function safe(){
 return {
   V5_PG_URL:'postgres://postgres@127.0.0.1:5432/postgres',
   V5_PG_DISPOSABLE:'1',V5_PG_REQUIRED:'1',V5_TARGET:'test',
   V5_MIGRATE_ALLOW_INSECURE_LOOPBACK:'1',
   PATH:process.env.PATH,HOME:process.env.HOME
 };
}
test('existing real PostgreSQL account/economy and P05 actor suites are registered',()=>{
 const p=list();
 assert.equal(p.executionStatus,'NOT_EXECUTED');
 assert.equal(p.g18Accepted,false);
 assert.equal(p.suites.length,5);
 assert.ok(p.suites.some(s=>s.cases.includes('A07')));
 assert.ok(p.suites.some(s=>s.cases.includes('A08')));
 assert.ok(p.suites.some(s=>s.cases.includes('A01')));
 assert.ok(p.suites.some(s=>s.cases.includes('A11')));
 assert.ok(p.suites.some(s=>s.cases.includes('A13')));
 assert.ok(p.suites.every(s=>s.file.startsWith('tests/v5-')));
});
test('never connect to actual Neon staging or production, or inherit provider credentials',()=>{
 for(const change of [
   env=>{env.V5_PG_URL='postgres://postgres@ep-real.neon.tech/staging';},
   env=>{env.V5_PG_URL='postgres://postgres@127.0.0.1:5432/mega_xo_v5_production';},
   env=>{env.V5_PG_DISPOSABLE='0';},
   env=>{env.V5_PG_REQUIRED='0';},
   env=>{env.V5_TARGET='production';},
   env=>{env.V5_MIGRATE_ALLOW_INSECURE_LOOPBACK='0';},
   env=>{env.DATABASE_URL='postgres://host/sensitive';},
   env=>{env.VERCEL_TOKEN='sensitive';},
   env=>{env.GOOGLE_APPLICATION_CREDENTIALS='/tmp/private.json';}
 ]){
   const v=safe();change(v);
   assert.throws(()=>boundedLoopbackEnvironment(v),/P18_DISPOSABLE_REFUSED/);
 }
 assert.ok(boundedLoopbackEnvironment(safe()));
});
test('TAP proof requires real pass count, no skips, no failures',()=>{
 const good='# tests 7\n# pass 7\n# fail 0\n# skipped 0\n';
 assert.deepEqual(parseTap(good,'synthetic'),{pass:7,fail:0,skipped:0,total:7});
 for(const bad of [
   '# tests 7\n# pass 7\n# fail 0\n# skipped 1\n',
   '# tests 7\n# pass 6\n# fail 1\n# skipped 0\n',
   '# tests 0\n# pass 0\n# fail 0\n# skipped 0\n',
   '# tests 3\n# pass 3\n# skipped 0\n',
   ''
 ])assert.throws(()=>parseTap(bad,'synthetic'),/P18_DISPOSABLE_REFUSED/);
});
test('synthetic injected runner verifies actual suite files and produces nonstaging claims only',()=>{
 let calls=0;
 const report=run({root,env:safe(),spawn:(_exe,args,opts)=>{
   calls++;
   assert.ok(args.includes('--test'));
   assert.equal(opts.env.V5_TARGET,'test');
   assert.equal(opts.env.DATABASE_URL,undefined);
   return {status:0,stdout:'# tests 4\n# pass 4\n# fail 0\n# skipped 0\n'};
 }});
 assert.equal(calls,5);
 assert.equal(report.suites.length,5);
 assert.equal(report.liveStagingVerified,false);
 assert.equal(report.g18Accepted,false);
 assert.ok(report.suites.every(s=>s.sourceSha256.length===64));
 assert.ok(report.suites.every(s=>s.caseSlicesExercisedInSyntheticFixtures.length>0));
});
test('zero-coverage or failing real subprocess is a hard failure, never mock-green',()=>{
 assert.throws(()=>run({root,env:safe(),spawn:()=>({status:0,stdout:'# tests 0\n# pass 0\n# fail 0\n# skipped 0\n'})}),/P18_DISPOSABLE_REFUSED/);
 assert.throws(()=>run({root,env:safe(),spawn:()=>({status:1,stderr:'',stdout:''})}),/P18_DISPOSABLE_REFUSED/);
});

test('P18 audit includes real SQL import, reconciliation, differential, account and actor suites',()=>{
 const ids=list().suites.map(s=>s.id);
 assert.deepEqual(ids,[
  'sqlite-snapshot-to-postgres-import',
  'postgres-per-actor-reconciliation',
  'sqlite-postgres-game-economy-parity',
  'pg-services-social-economy',
  'pg-session-actor-coherence'
 ]);
 assert.ok(ids.every((id)=>/^[a-z0-9-]+$/.test(id)));
});
