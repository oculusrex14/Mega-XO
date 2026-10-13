'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const D=require('../packages/learning/connection.js'),R=require('../packages/learning/release-gate.js'),C=require('../packages/learning/capture.js');
const env={CAPTURE_PG_URL:'postgres://capture_runtime@127.0.0.1:5432/capture_test',CAPTURE_ENV:'test',CAPTURE_DISPOSABLE_LOOPBACK:'1'};
test('exact capture role, bounded direct pool and explicit disposable loopback only',()=>{
 assert.equal(D.configFromEnvironment(env,'capture_runtime').pg.ssl,false);
 for(const extra of [{CAPTURE_PG_URL:'postgres://core_runtime@127.0.0.1:5432/capture_test'}, {CAPTURE_ENV:'production'}, {CAPTURE_POOL_MAX:'100'}, {CAPTURE_PG_URL:env.CAPTURE_PG_URL+'?options=-c%20role=core_runtime'}, {CAPTURE_DISPOSABLE_LOOPBACK:'0'}, {CAPTURE_ENV:'staging'}])assert.throws(()=>D.configFromEnvironment({...env,...extra},'capture_runtime'));
});
test('every checkout verifies real role, not caller claims; unsafe session is destroyed',async()=>{
 let bad=false,destroyed=0,probes=0;const expected={actor:'capture_runtime',login:'capture_runtime',db:'capture_test',learning_access:true};
 class Pool{on(){}async connect(){return {query:async(s)=>{if(s.includes('pg_roles')){probes++;return {rows:[{...expected,rolsuper:bad}]};}return {rows:[]};},release:kill=>{if(kill)destroyed++;}};}async end(){}}
 const db=await D.createConnection(env,'capture_runtime',{Pool});await db.query('SELECT 1');await db.query('SELECT 1');assert.equal(probes,2);bad=true;await assert.rejects(db.query('SELECT 1'),/CAPTURE_DATABASE_ROLE_DENIED/);assert.equal(destroyed,1);await db.end();
});
test('private key loader rejects publicly readable, malformed and symlinked keys',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capture-keys-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const f=path.join(dir,'key');fs.writeFileSync(f,Buffer.alloc(32,5),{mode:0o600});assert.equal(D.readKey(f).length,32);fs.symlinkSync(f,path.join(dir,'link'));assert.throws(()=>D.readKey(path.join(dir,'link')));fs.chmodSync(f,0o644);assert.throws(()=>D.readKey(f),/PRIVATE_KEY/);
});
test('day-one gate refuses absent, stale, disabled, wrong-source and unproved external receipts',()=>{
 const sourceCommit='a'.repeat(40),now=Date.now(),configuration={enabled:true,rulesHash:C.RULES_HASH,environment:'staging',policyVersion:'test',privacyEpoch:0};
 const receipt={sourceCommit,rulesHash:C.RULES_HASH,environment:'staging',policyVersion:'test',privacyEpoch:0,checkedAt:new Date(now).toISOString(),evidence:Object.fromEntries(R.REQUIRED.map(k=>[k,{status:'PASS',artifact:'synthetic-unit-test-only'}]))};
 const args={sourceCommit,configuration,receipt,metrics:{pending:0,quarantined:0,expiredUnpurged:0,sealed:1},now};
 assert.equal(R.assess(args).result,'RECEIPTS_READY_FOR_MAIN_REVIEW');assert.equal(R.assess(args).productionAuthorized,false);
 for(const delta of [{receipt:null},{configuration:{...configuration,enabled:false}},{sourceCommit:'b'.repeat(40)},{metrics:{...args.metrics,pending:1}},{receipt:{...receipt,checkedAt:'2020-01-01'}},{receipt:{...receipt,privacyEpoch:3}}])assert.equal(R.assess({...args,...delta}).result,'BLOCKED');
});
