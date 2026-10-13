'use strict';
/* Test-only child. The parent supplies an owned loopback database and kills this actual process. */
const {Client}=require('pg');const C=require('../../packages/learning/capture.js');
(async()=>{const u=new URL(process.env.CAPTURE_CRASH_URL);if(!['localhost','127.0.0.1','::1'].includes(u.hostname)||!u.pathname.startsWith('/v5_test_p05lab_'))throw Error('NOT_OWNED_TEST');
 const db=new Client({connectionString:u.toString()});await db.connect();const j=(await db.query("SELECT * FROM learning.claim('killed-worker',1,1000)")).rows[0];if(!j)throw Error('NO_JOB');
 if(process.env.CAPTURE_CRASH_PHASE==='uncommitted-seal'){
  const p=(await db.query('SELECT learning.project($1) AS value',[j.capture_id])).rows[0].value;
  const body=C.stable(C.seal(p.source,p).payload);await db.query('BEGIN');await db.query("SELECT learning.finish($1,'killed-worker',$2,$3,$4)",[j.capture_id,j.lease_token,body,p.sourceToken]);
 }
 process.send({ready:true,captureId:j.capture_id});setInterval(()=>{},1000);
})().catch(()=>{process.send?.({error:true});process.exit(1);});
