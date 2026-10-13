'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Pool}=require('pg');
const lab=require('./v5-pg-lab.js'),C=require('../packages/learning/capture.js'),{createCaptureWorker}=require('../packages/learning/worker.js');
lab.installCleanup(test);
test('DC04/DC08 terminal fingerprints, forged history, unplayed voids and retention remain fail-closed',async t=>{
 if(!await lab.boot(t))return;const db=await lab.createDatabase('capture_integrity',{runtimeRoles:[...lab.RUNTIME_ROLES,'capture_runtime','capture_privacy','capture_exporter']});await lab.seedActors(db);
 const admin=await lab.adminClient(db);t.after(()=>admin.end());
 await admin.query("UPDATE learning.policy SET enabled=true,policy_version='test',approval_ref='test',encryption_ref='test',choice_ref='test',capture_after='epoch',retention_days=1,export_retention_days=10,backup_retention_days=1,source_commit=$1,rules_hash=$2,environment='test'",['a'.repeat(40),C.RULES_HASH]);
 const pools={};for(const role of ['capture_runtime','capture_privacy','capture_exporter']){const u=new URL(lab.dbUrl(db));u.username=role;u.password='';pools[role]=new Pool({connectionString:u.toString()});t.after(()=>pools[role].end());}
 const cap=pools.capture_runtime,privacy=pools.capture_privacy,exp=pools.capture_exporter,worker=createCaptureWorker(cap,{workerId:'integrity'});
 let now=Date.now();const core=await lab.coreFor(db,{clock:()=>now,random:()=>0.1});t.after(()=>core.close());
 const run=(a,k,c,scope='player')=>core.run({actor:a,scope},k,c);
 async function play(id,{offeredOnly=false}={}){
  const offer=await run('matchmaker',id+'q',{type:'queue',id,a:'svc_alice',b:'svc_bob',mode:'casual',turnSeconds:30},'matchmaker');
  if(offeredOnly){await run('operator',id+'void',{type:'void',id,reason:'synthetic-unplayed'},'operator');}
  else{for(const a of ['svc_alice','svc_bob'])await run(a,id+a,{type:'accept',id,termsHash:offer.termsHash});const view=await core.readMatch('svc_alice',id);now+=1000;await run(view.symbols.X,id+'m',{type:'move',id,revision:0,move:{b:4,c:4}});await run('svc_alice',id+'r',{type:'resign',id});}
  return (await admin.query('SELECT capture_id FROM learning.captures WHERE source_id=$1',[id])).rows[0].capture_id;
 }
 await t.test('DB refuses fabricated move history even with a valid lease and source digest',async()=>{
  const cid=await play('bound');const job=(await cap.query("SELECT * FROM learning.claim('manual',1,30000)")).rows[0];const p=(await cap.query('SELECT learning.project($1) AS value',[cid])).rows[0].value;
  const body=C.seal(p.source,p).payload;body.moves[0].b=0;
  await assert.rejects(cap.query("SELECT learning.finish($1,'manual',$2,$3,$4)",[cid,job.lease_token,C.stable(body),p.sourceToken]),/CAPTURE_PAYLOAD_HISTORY_MISMATCH/);
  const valid=C.stable(C.seal(p.source,p).payload);await cap.query("SELECT learning.finish($1,'manual',$2,$3,$4)",[cid,job.lease_token,valid,p.sourceToken]);
  await assert.rejects(cap.query('SELECT learning.project_unfenced($1)',[cid]),e=>e.code==='42501');
  const runId='00000000-0000-4000-8000-000000000007';await exp.query('SELECT learning.begin_export($1,$2,$3,0)',[runId,'test-key','gameplay-opening6-v1-20261013']);await exp.query('SELECT learning.export_member($1,$2)',[runId,cid]);
  const bounded=(await admin.query('SELECT r.expires_at<=c.expires_at AS ok FROM learning.export_runs r CROSS JOIN learning.captures c WHERE r.run_id=$1 AND c.capture_id=$2',[runId,cid])).rows[0];assert.equal(bounded.ok,true,'exports cannot outlive a member capture');
 });
 await t.test('otherwise legal source timing change after settlement is detected before first archive',async()=>{
  const cid=await play('changed');await admin.query("UPDATE match.matches SET move_timings=jsonb_set(move_timings::jsonb,'{0,ms}','2000')::json WHERE match_id='changed'");
  const r=await worker.tick();assert.equal(r.quarantined,1);assert.equal(r.errors.CAPTURE_INTENT_SOURCE_CHANGED,1);assert.equal((await admin.query('SELECT intent_source_token IS NOT NULL AS bound FROM learning.captures WHERE capture_id=$1',[cid])).rows[0].bound,true);
 });
 await t.test('voided unaccepted offer is explicitly excluded, not corrupt or a fabricated game',async()=>{
  await play('unplayed',{offeredOnly:true});const r=await worker.tick();assert.equal(r.excluded,1,JSON.stringify(r));assert.equal(r.quarantined,0);
 });
 await t.test('old backfill cannot restart retention; expiry clears all private linkage and source hashes',async()=>{
  now=Date.now()-3*86400000;const cid=await play('aged');assert.equal((await worker.tick()).claimed,0);
  const expiry=(await admin.query('SELECT expires_at<clock_timestamp() AS expired FROM learning.captures WHERE capture_id=$1',[cid])).rows[0];assert.equal(expiry.expired,true);
  await privacy.query('SELECT learning.erase(500)');const r=(await admin.query('SELECT state,source_id,payload,intent_source_token FROM learning.captures WHERE capture_id=$1',[cid])).rows[0];assert.deepEqual(r,{state:'purged',source_id:null,payload:null,intent_source_token:null});
 });
});
