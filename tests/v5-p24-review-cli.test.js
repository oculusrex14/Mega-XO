'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {runCli,safeLocal}=require('../scripts/v5/p24/review-cli');
const SHA='a'.repeat(40);
const ledger=()=>({schema_version:1,current:{
 integration_branch:'V5-platform',
 passed_phase_gates:Array.from({length:9},(_,i)=>({
  phase:'P'+String(i).padStart(2,'0'),gate:'G'+String(i).padStart(2,'0'),
  evidence_refs:['docs/v5/evidence/phase-gate.json'],
 })),
}});
const input=()=>({format:'mega-v5-p24-review-input/v1',nowUtc:'2026-10-09T10:00:00Z',
 baseline:null,policy:null,intervals:[]});
function fakeReader(packet=input()){
 const calls=[];
 const read=(root,p,max)=>{
  calls.push({root,p,max});
  if(p==='.artifacts/p24-review.json')return packet;
  if(p==='docs/v5/progress.json')return ledger();
  throw Error('INVALID_FILE_REQUEST');
 };
 return {read,calls};
}
test('CLI template mode generates unknown metrics, NULL thresholds and zero mutation permissions',()=>{
 const r=runCli(['--templates',SHA]);
 assert.equal(r.capacityBaseline.metrics.length,10);
 assert.ok(r.capacityBaseline.metrics.every(x=>x.value===null));
 assert.ok(r.scalePolicy.entries.every(x=>x.threshold===null));
 assert.equal(r.productionMutationAuthorized,false);
 assert.equal(r.g24Accepted,false);
});
test('local review reads only fixed sanitized packet and repository owner ledger',()=>{
 const fake=fakeReader();
 const r=runCli(['--review',SHA],{root:'/repo',read:fake.read});
 assert.equal(r.status,'BLOCKED_G23_NOT_ACCEPTED');
 assert.deepEqual(fake.calls.map(x=>x.p),[
  '.artifacts/p24-review.json','docs/v5/progress.json',
 ]);
 assert.equal(fake.calls[0].max,262144);
 assert.equal(r.productionMutationAuthorized,false);
});
test('operator cannot choose an arbitrary URL, path, mode or non-SHA source',()=>{
 for(const args of [
  ['--review',SHA,'/etc/secrets'],['--fetch',SHA],
  ['--templates','../other'],['--review','HEAD'],
  ['--review',SHA,'https://provider.example'],[],
 ]){
  assert.throws(()=>runCli(args),/P24_CLI_REFUSED/);
 }
});
test('no arbitrary approval, telemetry or config keys can be injected',()=>{
 const rogue=input();rogue.approveScaling=true;
 const fake=fakeReader(rogue);
 assert.throws(()=>runCli(['--review',SHA],{root:'/repo',read:fake.read}),
  /P24_BASELINE_REFUSED|P24_CLI_REFUSED/);
});
test('safe reader rejects symlinks, directories and oversized evidence packets',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mega-p24-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'.artifacts'));
 const file=path.join(root,'.artifacts','p24-review.json');
 fs.writeFileSync(file,'{}');
 assert.deepEqual(safeLocal(root,'.artifacts/p24-review.json',2048),{});
 fs.unlinkSync(file);
 fs.symlinkSync(path.join(root,'other.json'),file);
 assert.throws(()=>safeLocal(root,'.artifacts/p24-review.json',2048),
  /P24_CLI_REFUSED:SYMLINK/);
 fs.unlinkSync(file);
 fs.writeFileSync(file,'X'.repeat(5000));
 assert.throws(()=>safeLocal(root,'.artifacts/p24-review.json',2048),
  /P24_CLI_REFUSED:UNSAFE_FILE/);
 assert.throws(()=>safeLocal(root,'.artifacts/../other.json',2048),
  /P24_CLI_REFUSED:PATH/);
});
