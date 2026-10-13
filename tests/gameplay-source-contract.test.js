'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Pool}=require('pg');
const lab=require('./v5-pg-lab.js'),C=require('../packages/learning/capture.js');
lab.installCleanup(test);
test('database projection decodes canonical text side columns without broadening roles',async t=>{
 if(!await lab.boot(t))return;
 const db=await lab.createDatabase('capture_projection',{runtimeRoles:[...lab.RUNTIME_ROLES,'capture_runtime']});await lab.seedActors(db);
 const admin=await lab.adminClient(db);t.after(()=>admin.end());
 await admin.query("UPDATE learning.policy SET enabled=true,policy_version='test',approval_ref='test',encryption_ref='test',choice_ref='test',capture_after='epoch',retention_days=7,export_retention_days=1,backup_retention_days=7,source_commit=$1,rules_hash=$2,environment='test'",['a'.repeat(40),C.RULES_HASH]);
 let now=Date.now();const core=await lab.coreFor(db,{clock:()=>now,random:()=>0.1});t.after(()=>core.close());
 const run=(actor,key,cmd,scope='player')=>core.run({actor,scope},key,cmd);
 const offered=await run('matchmaker','p-offer',{type:'queue',id:'projection',a:'svc_alice',b:'svc_bob',mode:'casual',turnSeconds:30},'matchmaker');
 for(const actor of ['svc_alice','svc_bob'])await run(actor,'p-accept-'+actor,{type:'accept',id:'projection',termsHash:offered.termsHash});
 let view=await core.readMatch('svc_alice','projection');now+=100;
 await run(view.symbols.X,'p-move',{type:'move',id:'projection',revision:0,move:{b:4,c:4}});
 await run('svc_alice','p-resign',{type:'resign',id:'projection'});
 const cid=(await admin.query("SELECT capture_id FROM learning.captures WHERE source_id='projection'")).rows[0].capture_id;
 const u=new URL(lab.dbUrl(db));u.username='capture_runtime';u.password='';const pool=new Pool({connectionString:u.toString()});t.after(()=>pool.end());
 // Direct assertion deliberately exposes the synthetic SQL contract failure, rather than letting
 // a worker's production-safe error redaction obscure the failed column/representation contract.
 const projection=(await pool.query('SELECT learning.project($1) AS value',[cid])).rows[0].value;
 const capture=C.seal(projection.source,projection);assert.equal(capture.payload.game.reason,'resign');assert.equal(capture.payload.moves.length,1);
});
