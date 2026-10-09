'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {RELEASE_FORMAT,RUNTIME_FORMAT,compareVersions,plan,cli}=require('../scripts/v5/release-compatibility.js');
const sha1='a'.repeat(40),sha2='b'.repeat(40);
const previous=()=>({format:RELEASE_FORMAT,version:'5.4.0',sourceSha:sha1,
  authority:'postgresql',schemaMin:35,schemaMax:40,realtimeProtocol:'realtime/v1'});
const target=()=>({...previous(),version:'5.5.0',sourceSha:sha2});
const runtime=()=>({format:RUNTIME_FORMAT,environment:'production',store:'postgresql',
  schemaVersion:37,realtimeProtocol:'realtime/v1',oldV4WriterFenced:true,
  firstPostImportApplicationWrite:true,authorityEpoch:2,
  evidenceReference:'evidence:phase22/pg-authority'});
const check=(modify)=>assert.throws(modify,/V5_COMPATIBILITY_REFUSED/);

test('forward compatible PostgreSQL deployment is only a planning result, not a release approval',()=>{
  const result=plan({current:previous(),target:target(),runtime:runtime(),mode:'forward'});
  assert.equal(result.result,'COMPATIBLE_CONTRACTS_ONLY');
  assert.equal(result.authorizesDeployment,false);
  assert.equal(result.version,'5.5.0');
  assert.ok(result.mandatoryNextGates.length>=4);
});

test('post-import application writes never permit old SQLite authority or losing V4 fence',()=>{
  check(()=>plan({current:previous(),target:target(),runtime:{...runtime(),store:'sqlite-v4'},mode:'forward'}));
  check(()=>plan({current:previous(),target:target(),runtime:{...runtime(),oldV4WriterFenced:false},mode:'forward'}));
  check(()=>plan({current:previous(),target:target(),runtime:{...runtime(),authorityEpoch:0},mode:'forward'}));
  check(()=>plan({current:previous(),target:{...target(),authority:'sqlite-v4'},runtime:runtime(),mode:'forward'}));
});

test('P17 does not authorize the initial V4 to PostgreSQL production cutover',()=>{
  check(()=>plan({target:target(),runtime:{...runtime(),store:'sqlite-v4',firstPostImportApplicationWrite:false},mode:'forward'}));
  check(()=>plan({target:target(),runtime:runtime(),mode:'forward'}));
  assert.equal(plan({target:target(),runtime:{...runtime(),environment:'staging'},mode:'forward'}).authorizesDeployment,false);
});

test('rejects schema incompatibility in either deploy or rollback target',()=>{
  check(()=>plan({current:previous(),target:{...target(),schemaMin:38},runtime:runtime(),mode:'forward'}));
  check(()=>plan({current:{...previous(),schemaMax:36},target:target(),runtime:runtime(),mode:'forward'}));
  check(()=>plan({current:previous(),target:{...target(),schemaMax:20},runtime:runtime(),mode:'forward'}));
});

test('wire protocol and source/release IDs are explicit and immutable',()=>{
  check(()=>plan({current:previous(),target:{...target(),realtimeProtocol:'realtime/v2'},runtime:runtime(),mode:'forward'}));
  check(()=>plan({current:previous(),target:{...target(),sourceSha:'notsha'},runtime:runtime(),mode:'forward'}));
  check(()=>plan({current:previous(),target:{...target(),format:'mega-v5-source-candidate/v1'},runtime:runtime(),mode:'forward'}));
  check(()=>plan({current:previous(),target:{...target(),fakeReady:true},runtime:runtime(),mode:'forward'}));
  check(()=>plan({current:previous(),target:{...target(),version:'v5.5'},runtime:runtime(),mode:'forward'}));
  check(()=>plan({current:previous(),target:{...target(),version:previous().version},runtime:runtime(),mode:'forward'}));
});

test('rollback only targets an older version whose schema and wire still work',()=>{
  const next=target(),old=previous();
  const result=plan({current:next,target:old,runtime:runtime(),mode:'rollback'});
  assert.equal(result.mode,'rollback');
  assert.equal(result.authorizesDeployment,false);
  check(()=>plan({current:old,target:next,runtime:runtime(),mode:'rollback'}));
  check(()=>plan({target:old,runtime:runtime(),mode:'rollback'}));
  check(()=>plan({current:next,target:{...old,schemaMax:36},runtime:runtime(),mode:'rollback'}));
});

test('semantic version ordering preserves prerelease monotonicity',()=>{
  assert.ok(compareVersions('5.1.0-dev.9','5.1.0-beta.1')<0);
  assert.ok(compareVersions('5.1.0-rc.2','5.1.0-rc.10')<0);
  assert.ok(compareVersions('5.1.0-rc.10','5.1.0')<0);
  assert.ok(compareVersions('5.1.1','5.1.0')>0);
  check(()=>compareVersions('5.01.0','5.1.0'));
  check(()=>compareVersions('5.1.0-rc.01','5.1.0-rc.1'));
});

test('local contract-only CLI never accesses arbitrary files or allows unchecked deployment',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mega-compat-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'.artifacts'));
  fs.writeFileSync(path.join(root,'.artifacts/runtime.json'),JSON.stringify(runtime()));
  fs.writeFileSync(path.join(root,'.artifacts/current.json'),JSON.stringify(previous()));
  fs.writeFileSync(path.join(root,'.artifacts/target.json'),JSON.stringify(target()));
  const flags=['--runtime','.artifacts/runtime.json','--target','.artifacts/target.json',
    '--current','.artifacts/current.json','--mode','forward'];
  assert.equal(cli(flags,root).authorizesDeployment,false);
  check(()=>cli([...flags,'--mode','forward'],root));
  check(()=>cli(['--runtime','/etc/passwd','--target','.artifacts/target.json','--mode','forward'],root));
  check(()=>cli(['--runtime','.artifacts/runtime.json','--target','../target.json','--mode','forward'],root));
});
