'use strict';
/* Actual canonical Core + owned disposable PostgreSQL only. No Redis dependency, simulated provider,
 * production endpoint or credentials. Test accounts are explicitly labelled test-fixture. */
const test=require('node:test'),assert=require('node:assert/strict'),{Pool}=require('pg');
const lab=require('./v5-pg-lab.js'),G=require('../src/game.js'),C=require('../packages/learning/capture.js');
const {createCaptureWorker}=require('../packages/learning/worker.js');
const {source}=require('./helpers/gameplay-fixture.js');
lab.installCleanup(test);
const roles=['capture_runtime','capture_exporter','capture_privacy'];
test('DC03-DC10 real PostgreSQL capture, replay, fencing, repair and privacy',async t=>{
 if(!await lab.boot(t))return;
 const db=await lab.createDatabase('capture',{runtimeRoles:[...lab.RUNTIME_ROLES,...roles]});
 await lab.seedActors(db);
 const admin=await lab.adminClient(db);t.after(()=>admin.end());
 const query=(sql,args=[])=>admin.query(sql,args);
 const val=async(sql,args=[])=>Object.values((await query(sql,args)).rows[0]||{})[0];
 const pools={};for(const role of roles){const u=new URL(lab.dbUrl(db));u.username=role;u.password='';pools[role]=new Pool({connectionString:u.toString(),max:2});t.after(()=>pools[role].end());}
 const cap=pools.capture_runtime,exp=pools.capture_exporter,privacy=pools.capture_privacy;
 const worker=createCaptureWorker(cap,{workerId:'capture-test'});
 let clock=Date.now();const core=await lab.coreFor(db,{clock:()=>clock,random:()=>0.1});t.after(()=>core.close());
 const run=(actor,key,cmd,scope='player')=>core.run({actor,scope},key,cmd);
 const count=()=>val('SELECT count(*)::int FROM learning.captures');
 const captures={};
 async function play(id,reason='resign',mode='casual',trajectory=null){
  let offered;if(mode.startsWith('direct'))offered=await run('svc_alice',id+'offer',{type:'offer',id,opponent:'svc_bob',terms:{rated:mode==='direct-rated',kind:'leaderboard',amount:40}});
  else offered=await run('matchmaker',id+'offer',{type:'queue',id,a:'svc_alice',b:'svc_bob',mode,turnSeconds:30},'matchmaker');
  for(const actor of ['svc_alice','svc_bob'])await run(actor,id+'accept'+actor,{type:'accept',id,termsHash:offered.termsHash});
  let view=await core.readMatch('svc_alice',id);
  const seq=trajectory||[{b:4,c:4},{b:4,c:0}];
  for(let i=0;i<seq.length;i++){clock+=100;const actor=view.symbols[view.state.turn];const res=await run(actor,id+'move'+i,{type:'move',id,revision:i,move:{b:seq[i].b,c:seq[i].c}});view.state=res.state;}
  if(!view.state.winner){if(reason==='timeout'){clock+=31000;await run('matchmaker',id+'end',{type:'timeout',id},'matchmaker');}
   else if(reason==='void')await run('operator',id+'end',{type:'void',id,reason:'synthetic test'},'operator');
   else {const cmd={type:'resign',id};await Promise.all([run('svc_alice',id+'end',cmd),run('svc_alice',id+'end',cmd)]);}}
  const cid=await val("SELECT capture_id FROM learning.captures WHERE source_kind='match' AND source_id=$1",[id]);
  if(cid)captures[id]=cid;return cid;
 }
 await t.test('additive migrations apply and reapply; policy disabled and exact-role denials',async()=>{
  assert.equal(lab.runMigrator(db).json.appliedCount,0);
  assert.equal((await worker.tick()).disabled,true);
  for(const role of ['api_runtime','core_runtime','worker_runtime',...roles]){
   const u=new URL(lab.dbUrl(db));u.username=role;u.password='';const p=new Pool({connectionString:u.toString()});
   try{await assert.rejects(p.query('SELECT * FROM learning.capture_subjects'),e=>e.code==='42501');if(roles.includes(role))await assert.rejects(p.query('SELECT * FROM economy.wallets'),e=>e.code==='42501');}finally{await p.end();}
  }
  await assert.rejects(query('UPDATE learning.policy SET enabled=true'),e=>e.code==='23514');
  assert.equal(await val("SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='learning' AND p.prosecdef AND NOT ('search_path=pg_catalog, learning, pg_temp'=ANY(p.proconfig))"),0);
  const deployed=(await cap.query('SELECT learning.configuration() AS value')).rows[0].value;
  assert.equal(deployed.sourceCommit,null,'disabled policy projects nullable deployed commit');
  await query("UPDATE learning.policy SET enabled=true,policy_version='test-only',approval_ref='synthetic-not-legal-approval',encryption_ref='synthetic-isolated-cluster',choice_ref='test-only',capture_after='1970-01-01',retention_days=7,export_retention_days=1,backup_retention_days=7,source_commit=$1,rules_hash=$2,environment='test'",['a'.repeat(40),C.RULES_HASH]);
  assert.equal((await cap.query('SELECT learning.configuration() AS value')).rows[0].value.sourceCommit,'a'.repeat(40),'database config binds exact deployed source');
 });
 await t.test('full board win and draw; adjudicated timeout/resign/void; queue/direct and retries',async()=>{
  let draw;for(let n=1;n<1000;n++){const s=source(n);if(s.reason==='draw'){draw=s;break;}}assert.ok(draw);
  await play('dc-line','line','casual',source(1).moves);
  await play('dc-draw','draw','casual',draw.moves);
  await play('dc-resign','resign','direct-unrated');await play('dc-timeout','timeout','ranked');await play('dc-void','void');await play('dc-direct','resign','direct-rated');
  assert.equal(await count(),6);assert.equal(await val("SELECT count(*)::int FROM ops.outbox WHERE kind='learning.capture'"),6);
  const result=await worker.tick();assert.equal(result.sealed,6,JSON.stringify(result));
  const rows=(await query("SELECT payload,payload_sha256 FROM learning.captures ORDER BY source_id")).rows;
  for(const row of rows){const p=JSON.parse(row.payload);C.validate(p,row.payload_sha256);assert.equal(p.provenance.population,'test-fixture');assert.ok(!row.payload.includes('svc_alice'));for(const position of C.positions(p))assert.equal(position.legalMask[position.observedAction],1);}
  assert.equal((await worker.tick()).claimed,0);
 });
 await t.test('transaction rollback leaves neither terminal source nor capture intent',async()=>{
  const before=await count();await query('BEGIN');await query("UPDATE match.matches SET match_id=match_id WHERE match_id='dc-line'");await query('ROLLBACK');assert.equal(await count(),before);
 });
 await t.test('exclusive kind-scoped claims, crash reclaim, stale fencing and transactional seal',async()=>{
  const cid=await play('dc-crash');await query("INSERT INTO ops.outbox(outbox_id,kind,payload,state,created_at,expires_at,next_at,lease_until,attempts) VALUES('dc-unrelated','email','{}','queued',now(),now()+interval '1 day',now(),'epoch',0)");
  const [a,b]=await Promise.all([cap.query('SELECT * FROM learning.claim($1,1,1000)',['dead-worker']),cap.query('SELECT * FROM learning.claim($1,1,1000)',['other-worker'])]);assert.equal(a.rows.length+b.rows.length,1);
  const old=(a.rows[0]||b.rows[0]);assert.equal(old.capture_id,cid);await query("UPDATE ops.outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE outbox_id=$1",['learning.capture:'+cid]);
  assert.equal((await worker.tick()).sealed,1);
  await assert.rejects(cap.query('SELECT learning.finish($1,$2,$3,$4,$5)',[cid,a.rows.length?'dead-worker':'other-worker',old.lease_token,'{}','bad']),/CAPTURE_STALE_LEASE/);
  assert.equal(await val("SELECT state FROM ops.outbox WHERE outbox_id='dc-unrelated'"),'queued');
 });
 await t.test('missing notification repaired; pending source cannot be pruned; drift quarantined',async()=>{
  const cid=await play('dc-repair');await query('DELETE FROM ops.outbox WHERE outbox_id=$1',['learning.capture:'+cid]);
  await assert.rejects(query("DELETE FROM match.matches WHERE match_id='dc-repair'"),/CAPTURE_SOURCE_STILL_REQUIRED/);
  const result=await worker.reconcile();assert.ok(result.repaired>=1);assert.equal((await worker.tick()).sealed,1);
  await query("UPDATE match.matches SET state_json=jsonb_set(state_json::jsonb,'{required}','8')::json WHERE match_id='dc-repair'");
  await worker.reconcile({audit:true});assert.equal(await val('SELECT state FROM learning.captures WHERE capture_id=$1',[cid]),'quarantined');
 });
 await t.test('source corruption is quarantined without raw source/error logging',async()=>{
  const cid=await play('dc-bad');await query("UPDATE match.matches SET revision=revision+1 WHERE match_id='dc-bad'");const r=await worker.tick();assert.equal(r.quarantined,1);assert.equal(await val('SELECT code FROM learning.rejections WHERE capture_id=$1',[cid]),'CAPTURE_INTENT_SOURCE_CHANGED');
 });
 await t.test('deletion request synchronously suppresses and invalidates export; erasure is irreversible',async()=>{
  const uuid='00000000-0000-4000-8000-000000000001';await exp.query('SELECT learning.begin_export($1,$2,$3,$4)',[uuid,'test-key','gameplay-opening6-v1-20261013',0]);
  const page=await exp.query('SELECT * FROM learning.export_page($1)',[uuid]);assert.ok(page.rows.length>0);await exp.query('SELECT learning.export_member($1,$2)',[uuid,page.rows[0].capture_id]);
  await query("INSERT INTO privacy.requests(request_id,actor_id,kind,state,requested_at,updated_at,policy_version) VALUES('dc-delete','svc_alice','deletion','requested',now(),now(),'test-only')");
  await assert.rejects(exp.query('SELECT * FROM learning.export_page($1)',[uuid]),/CAPTURE_EXPORT_REVOKED/);
  assert.equal((await cap.query('SELECT learning.project($1) AS value',[captures['dc-line']])).rows[0].value.suppressed,true);
  await privacy.query('SELECT learning.erase(100)');assert.equal(await val('SELECT count(*)::int FROM learning.capture_subjects'),0);assert.equal(await val('SELECT count(*)::int FROM learning.captures WHERE payload IS NOT NULL'),0);
  const id='f'.repeat(64);await privacy.query('SELECT learning.replay_erasure($1)',[id]);assert.equal(await val('SELECT count(*)::int FROM learning.erasure_tombstones WHERE capture_id=$1',[id]),1,'restore tombstone persists even when capture is absent');
  await privacy.query('SELECT learning.restore_watermark(100)');assert.equal((await worker.tick()).disabled,true);await assert.rejects(exp.query('SELECT learning.begin_export($1,$2,$3,$4)',[uuid,'test','seed',100]),/CAPTURE_EXPORT_PRIVACY_FENCE/);
 });
});
