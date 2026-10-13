'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Pool,Client}=require('pg');
const {fork,execFileSync}=require('node:child_process'),{once}=require('node:events'),path=require('node:path'),fs=require('node:fs').promises,os=require('node:os'),crypto=require('node:crypto');
const lab=require('./v5-pg-lab.js'),C=require('../packages/learning/capture.js'),P=require('../packages/learning/privacy.js'),X=require('../packages/learning/exporter.js');
const {createConnection}=require('../packages/learning/connection.js'),{createCaptureWorker}=require('../packages/learning/worker.js');
lab.installCleanup(test);
const roles=['capture_runtime','capture_privacy','capture_exporter'];
test('DC05/DC08 actual killed-worker rollback, private export lineage and restored deletion journal',async t=>{
 if(!await lab.boot(t))return;
 const db=await lab.createDatabase('capture_recovery',{runtimeRoles:[...lab.RUNTIME_ROLES,...roles]});await lab.seedActors(db);
 let admin=await lab.adminClient(db);t.after(()=>admin.end());
 const urls=Object.fromEntries(roles.map(role=>{const u=new URL(lab.dbUrl(db));u.username=role;u.password='';return [role,u.toString()];}));
 const cap=await createConnection({CAPTURE_PG_URL:urls.capture_runtime,CAPTURE_ENV:'test',CAPTURE_DISPOSABLE_LOOPBACK:'1'},'capture_runtime');t.after(()=>cap.end());
 const privacy=new Pool({connectionString:urls.capture_privacy}),exp=new Pool({connectionString:urls.capture_exporter});t.after(()=>privacy.end());t.after(()=>exp.end());
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capture-pg-private-'));await fs.chmod(dir,0o700);t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await admin.query("UPDATE learning.policy SET enabled=true,policy_version='synthetic-not-live',approval_ref='test',encryption_ref='test',choice_ref='test',capture_after='epoch',retention_days=7,export_retention_days=1,backup_retention_days=7,source_commit=$1,rules_hash=$2,environment='production'",['a'.repeat(40),C.RULES_HASH]);
 // This disposable DB explicitly marks synthetic fixtures as human solely to exercise export
 // selection. It is not evidence of real human collection or a production connection.
 await admin.query("INSERT INTO learning.subject_classes VALUES('svc_alice','human','synthetic-export-test'),('svc_bob','human','synthetic-export-test')");
 let now=Date.now();const core=await lab.coreFor(db,{clock:()=>now,random:()=>0.1});t.after(()=>core.close());
 const run=(a,k,c,scope='player')=>core.run({actor:a,scope},k,c);
 async function play(id){const offer=await run('matchmaker',id+'q',{type:'queue',id,a:'svc_alice',b:'svc_bob',mode:'casual',turnSeconds:30},'matchmaker');for(const a of ['svc_alice','svc_bob'])await run(a,id+a,{type:'accept',id,termsHash:offer.termsHash});let v=await core.readMatch('svc_alice',id);for(let i=0;i<8;i++){now+=1000;const move=require('../src/game.js').legal(v.state)[i%require('../src/game.js').legal(v.state).length];const r=await run(v.symbols[v.state.turn],id+'m'+i,{type:'move',id,revision:i,move});v.state=r.state;}await run('svc_alice',id+'r',{type:'resign',id});}
 const worker=createCaptureWorker(cap,{workerId:'replacement'});
 for(const phase of ['claimed','uncommitted-seal']){
  await play('crash-'+phase);
  const child=fork(path.join(__dirname,'helpers/gameplay-crash-child.cjs'),[],{env:{...process.env,CAPTURE_CRASH_URL:urls.capture_runtime,CAPTURE_CRASH_PHASE:phase},stdio:['ignore','ignore','ignore','ipc']});
  const timeout=setTimeout(()=>child.kill('SIGKILL'),15000);const [message]=await once(child,'message');assert.equal(message.ready,true);const closed=once(child,'exit');child.kill('SIGKILL');await closed;clearTimeout(timeout);
  assert.equal((await admin.query('SELECT state FROM learning.captures WHERE capture_id=$1',[message.captureId])).rows[0].state,'pending','a killed uncommitted archive must roll back');
  await new Promise(r=>setTimeout(r,1100));assert.equal((await worker.tick()).sealed,1);
 }
 const opts={directory:dir,key:crypto.randomBytes(32),keyId:'test-key',pseudonymKey:crypto.randomBytes(32),splitSeed:'gameplay-opening6-v1-20261013',privacyEpoch:0,positions:true};
 const out=await X.exportDataset(exp,opts);let count=0;for await(const r of X.readDataset(exp,{...opts,...out}))count++;assert.ok(count>=1);assert.equal((await exp.query('SELECT learning.export_status($1) AS value',[out.runId])).rows[0].value.state,'ready');
 await privacy.query("SELECT learning.suppress('svc_alice','user-choice')");
 await assert.rejects(async()=>{for await(const _ of X.readDataset(exp,{...opts,...out})){}},/CAPTURE_EXPORT_REVOKED/);
 await privacy.query('SELECT learning.erase(500)');assert.equal((await X.purgeRevoked(exp,dir)).purged,1);
 const journal={file:path.join(dir,'privacy.mxojournal'),key:crypto.randomBytes(32),keyId:'journal-key'};
 const receipt=await P.exportPrivacyJournal(privacy,journal);
 const target=await lab.createDatabase('capture_restored',{runtimeRoles:[...lab.RUNTIME_ROLES,...roles]});const tu=new URL(lab.dbUrl(target));tu.username='capture_privacy';tu.password='';const restore=new Pool({connectionString:tu.toString()});t.after(()=>restore.end());
 const r=await P.replayPrivacyJournal(restore,{...journal,...receipt,requiredEpoch:receipt.epoch,isolatedRestore:true});assert.equal(r.enabled,false);assert.ok(r.entries>=3);
 const targetAdmin=await lab.adminClient(target);try{assert.equal((await targetAdmin.query("SELECT count(*)::int AS n FROM learning.suppressions WHERE actor_id='svc_alice'")).rows[0].n,1);assert.equal((await targetAdmin.query('SELECT count(*)::int AS n FROM learning.erasure_tombstones')).rows[0].n,2);}finally{await targetAdmin.end();}
});

test('DC10 committed capture intent survives actual isolated PostgreSQL container restart',async t=>{
 const id=process.env.CAPTURE_TEST_PG_CONTAINER;
 if(!id){t.skip('owned GitHub service-container restart hook not configured; Main must run staging restart');return;}
 assert.equal(process.env.CI,'true');assert.equal(process.env.V5_PG_DISPOSABLE,'1');assert.match(id,/^[a-f0-9]{12,64}$/);
 if(!await lab.boot(t))return;const db=await lab.createDatabase('capture_restart',{runtimeRoles:[...lab.RUNTIME_ROLES,'capture_runtime']});await lab.seedActors(db);
 const admin=await lab.adminClient(db);await admin.query("UPDATE learning.policy SET enabled=true,policy_version='test',approval_ref='test',encryption_ref='test',choice_ref='test',capture_after='epoch',retention_days=7,export_retention_days=1,backup_retention_days=7,source_commit=$1,rules_hash=$2,environment='test'",['a'.repeat(40),C.RULES_HASH]);
 let now=Date.now();const core=await lab.coreFor(db,{clock:()=>now,random:()=>0.1});
 const run=(a,k,c,scope='player')=>core.run({actor:a,scope},k,c);
 const offer=await run('matchmaker','restart-q',{type:'queue',id:'restart',a:'svc_alice',b:'svc_bob',mode:'casual',turnSeconds:30},'matchmaker');for(const a of ['svc_alice','svc_bob'])await run(a,'restart-'+a,{type:'accept',id:'restart',termsHash:offer.termsHash});await run('svc_alice','restart-end',{type:'resign',id:'restart'});
 assert.equal((await admin.query("SELECT count(*)::int AS n FROM learning.captures WHERE state='pending'")).rows[0].n,1);
 await core.close();await lab.closeDatabasePools(db);await admin.end();
 execFileSync('docker',['restart',id],{stdio:'ignore',timeout:60000});
 for(let i=0;;i++){try{const c=await lab.adminClient(db);await c.end();break;}catch(e){if(i>=40)throw e;await new Promise(r=>setTimeout(r,250));}}
 const u=new URL(lab.dbUrl(db));u.username='capture_runtime';u.password='';const p=new Pool({connectionString:u.toString()});try{const result=await createCaptureWorker(p,{workerId:'post-restart'}).tick();assert.equal(result.sealed,1,JSON.stringify(result));}finally{await p.end();}
});
