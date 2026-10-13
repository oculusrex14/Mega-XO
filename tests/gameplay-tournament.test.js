'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Pool}=require('pg');
const lab=require('./v5-pg-lab.js'),C=require('../packages/learning/capture.js'),G=require('../src/game.js');
const {createTournamentService}=require('../packages/services/tournaments.js');
const {createCaptureWorker}=require('../packages/learning/worker.js');
const {source}=require('./helpers/gameplay-fixture.js');
lab.installCleanup(test);
test('DC07 real tournament commands preserve four attempts through swaps, pause, resume and repository replacement',async t=>{
 if(!await lab.boot(t))return;
 const db=await lab.createDatabase('capture_tournament',{runtimeRoles:[...lab.RUNTIME_ROLES,'capture_runtime']});await lab.seedActors(db);
 const admin=await lab.adminClient(db);t.after(()=>admin.end());
 await admin.query("UPDATE learning.policy SET enabled=true,policy_version='test',approval_ref='synthetic',encryption_ref='synthetic',choice_ref='synthetic',capture_after='epoch',retention_days=7,export_retention_days=1,backup_retention_days=7,source_commit=$1,rules_hash=$2,environment='test'",['a'.repeat(40),C.RULES_HASH]);
 const u=new URL(lab.dbUrl(db));u.username='capture_runtime';u.password='';const cap=new Pool({connectionString:u.toString()});t.after(()=>cap.end());
 const worker=createCaptureWorker(cap,{workerId:'tournament-test',batchSize:20});
 let now=Date.now(),seq=0;const service=createTournamentService({pool:lab.poolsFor(db).core,now:()=>now});t.after(()=>service.close());
 const send=(actor,cmd)=>service.run({actor,scope:'player',name:actor},'cap-tour-'+(++seq),cmd);
 const host='svc_alice',guest='svc_bob';let room=await send(host,{type:'create',name:'Synthetic Capture Cup',format:'duel',clock:120,increment:1});
 const id=room.id,version=room.rulesVersion;
 room=await send(guest,{type:'join',id});for(const actor of [host,guest])room=await send(actor,{type:'ready',id,value:true,rulesVersion:version});
 room=await send(host,{type:'start',id});
 let draw;for(let n=1;n<1000;n++){const s=source(n);if(s.reason==='draw'){draw=s;break;}}assert.ok(draw);
 const mappings=[];
 for(let attempt=0;attempt<4;attempt++){
  let f=room.fixtures[0];now=Math.max(now,f.opens)+1;
  for(const actor of f.players)room=await send(actor,{type:'matchReady',id,fixture:f.id});
  f=room.fixtures[0];mappings.push([...f.players]);assert.equal(f.status,'PLAYING');
  const moves=attempt<3?draw.moves:[{b:4,c:4},{b:4,c:0}];
  for(let i=0;i<moves.length;i++){now+=1000;const actor=f.players[f.state.turn==='X'?0:1];room=await send(actor,{type:'move',id,fixture:f.id,revision:i,move:{b:moves[i].b,c:moves[i].c}});f=room.fixtures[0];}
  if(attempt===2){assert.equal(room.status,'PAUSED');room=await send(host,{type:'resume',id});assert.equal(room.fixtures[0].attempt,0,'canonical counter resets; capture identity must not');}
  if(attempt===3)room=await send(f.players[0],{type:'resign',id,fixture:f.id});
  // Collection worker deliberately offline through ALL history writes/deletes/reinsertions.
 }
 assert.equal(room.status,'COMPLETE');
 const pending=(await admin.query("SELECT capture_id,source_attempt FROM learning.captures WHERE source_kind='fixture' ORDER BY source_attempt")).rows;
 assert.equal(pending.length,4);assert.deepEqual(pending.map(x=>x.source_attempt),[1,2,3,4]);
 const result=await worker.tick();assert.equal(result.sealed,4,JSON.stringify(result));
 const rows=(await admin.query("SELECT payload,payload_sha256 FROM learning.captures WHERE source_kind='fixture' ORDER BY source_attempt")).rows;
 for(let i=0;i<rows.length;i++){const p=JSON.parse(rows[i].payload);C.validate(p,rows[i].payload_sha256);assert.equal(p.game.reason,i<3?'draw':'resign');assert.equal(p.moves.length,i<3?draw.moves.length:2);assert.equal(p.game.boardWinner,i<3?'DRAW':null);assert.ok(p.qualityFlags.includes('HISTORY_ONLY'));
  const subjects=(await admin.query('SELECT actor_id,symbol FROM learning.capture_subjects WHERE capture_id=$1 ORDER BY seat',[pending[i].capture_id])).rows;assert.deepEqual(subjects.map(s=>s.actor_id),mappings[i]);assert.deepEqual(subjects.map(s=>s.symbol),['X','O']);
 }
 const replacement=createTournamentService({pool:lab.poolsFor(db).core,now:()=>now});try{const restored=await replacement.getRoom(id);assert.equal(restored.fixtures[0].history.length,4);await replacement.saveRoom(restored);}finally{await replacement.close();}
 assert.equal((await worker.tick()).claimed,0);assert.equal((await worker.reconcile({kind:'fixture',audit:true})).scanned,1);
 assert.equal((await worker.metrics()).quarantined,0);
});
