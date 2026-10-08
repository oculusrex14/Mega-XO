'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {candidate,verify,run,sha256,FILES} = require('../scripts/v5/release-source-candidate.js');
const root=path.resolve(__dirname,'..');
const fakeSha='b'.repeat(40);

test('candidate is grounded in checked-in schema, protocol and source asset hashes',()=>{
  const result=candidate(root,fakeSha);
  assert.equal(result.gitSha,fakeSha);
  assert.equal(result.schemaEvidence.highestMigrationId,result.schemaEvidence.migrationCount);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,FILES[0]),'utf8')).algorithm, "sha256(name + '\\n' + sql)");
  assert.ok(result.schemaEvidence.migrationCount>=35);
  assert.equal(result.protocolEvidence.realtime,'realtime/v1');
  assert.ok(result.sourceHashes[FILES[0]].length===64);
  assert.equal(result.sourceHashes[FILES[1]],sha256(fs.readFileSync(path.join(root,FILES[1]))));
  assert.equal(result.status,'SOURCE_ONLY_NOT_DEPLOYABLE');
  assert.equal(result.deployable,false);
  assert.deepEqual(result.artifacts,{});
  assert.deepEqual(result.deploymentIds,{});
  assert.deepEqual(result.gateEvidence,[]);
  assert.equal(verify(root,result,fakeSha),true);
});

test('source candidate is deterministic for same immutable commit',()=>{
  const first=candidate(root,fakeSha), second=candidate(root,fakeSha);
  assert.deepEqual(first,second);
  assert.match(first.candidateVersion,/^5\.0\.0-dev\.[0-9a-f]{12}$/);
  assert.notEqual(candidate(root,'c'.repeat(40)).candidateVersion,first.candidateVersion);
});

test('no synthetic release digests or guessed gates can pass verification',()=>{
  const sample=candidate(root,fakeSha);
  const changes=[
    {deployable:true},
    {status:'READY'},
    {artifacts:{core:'sha256:'+'a'.repeat(64)}},
    {gateEvidence:['P17_PASS']},
    {extra:'not-allowed'},
    {protocolEvidence:{...sample.protocolEvidence,realtime:'realtime/v2'}},
    {schemaEvidence:{...sample.schemaEvidence,highestMigrationId:99}},
    {sourceHashes:{...sample.sourceHashes,[FILES[0]]:'a'.repeat(64)}}
  ];
  for (const change of changes) assert.throws(()=>verify(root,{...sample,...change},fakeSha),/V5_CANDIDATE_REFUSED/);
  assert.throws(()=>verify(root,sample,'c'.repeat(40)),/V5_CANDIDATE_REFUSED/);
  assert.throws(()=>candidate(root,'not-a-sha'),/V5_CANDIDATE_REFUSED/);
});

test('writes and verifies a 0600 candidate in a scoped .artifacts directory',t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mega-v5-candidate-'));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  for (const file of FILES) {
    const dest=path.join(temp,file);
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.copyFileSync(path.join(root,file),dest);
  }
  const migrations=JSON.parse(fs.readFileSync(path.join(root,FILES[0]),'utf8'));
  for (const row of migrations.migrations) {
    const p=path.join('packages/migrations',row.file),dest=path.join(temp,p);
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.copyFileSync(path.join(root,p),dest);
  }
  const output='.artifacts/v5-source-candidate.json';
  const c=run(['create','--sha',fakeSha,'--output',output],temp);
  assert.equal(c.deployable,false);
  const p=path.join(temp,output);
  assert.equal(fs.statSync(p).mode & 0o777,0o600);
  assert.equal(run(['verify','--sha',fakeSha,'--file',output],temp).gitSha,fakeSha);
  assert.throws(()=>run(['create','--sha',fakeSha,'--output',output],temp),/EEXIST/);
  assert.throws(()=>run(['verify','--sha',fakeSha,'--file','../bad.json'],temp),/V5_CANDIDATE_REFUSED/);
  assert.throws(()=>run(['create','--sha',fakeSha,'--output','deploy/release.json'],temp),/V5_CANDIDATE_REFUSED/);
  const tampered=JSON.parse(fs.readFileSync(p,'utf8'));
  tampered.schemaEvidence.highestMigrationId+=1;
  fs.writeFileSync(p,JSON.stringify(tampered));
  assert.throws(()=>run(['verify','--sha',fakeSha,'--file',output],temp),/V5_CANDIDATE_REFUSED/);
});
