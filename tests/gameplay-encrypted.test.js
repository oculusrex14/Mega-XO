'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs').promises,os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const S=require('../packages/learning/encrypted.js');
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capture-crypto-'));await fs.chmod(dir,0o700);t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {dir,key:crypto.randomBytes(32),opts:{keyId:'test-only',kind:'gameplay'}};}
async function collect(file,key,o){const a=[];for await(const r of S.readRecords(file,key,o))a.push(r);return a;}
test('private authenticated streaming archive roundtrip, deterministic plaintext, randomized encryption',async t=>{
 const {dir,key,opts}=await fixture(t);const receipts=[];
 for(let i=0;i<2;i++){const file=path.join(dir,'file'+i);const w=await S.createWriter(file,key,opts);for(let n=0;n<200;n++)await w.write({type:'game',index:n,moves:[{b:4,c:1}]});const r=await w.finish();receipts.push(r);assert.equal((await fs.stat(file)).mode&0o777,0o600);assert.equal((await collect(file,key,{...opts,...r})).length,200);}
 assert.equal(receipts[0].plainSha256,receipts[1].plainSha256);assert.notEqual(receipts[0].cipherSha256,receipts[1].cipherSha256);
});
test('tampering, truncation, wrong key, wrong purpose, wrong hash never expose a record',async t=>{
 const {dir,key,opts}=await fixture(t),file=path.join(dir,'good');const w=await S.createWriter(file,key,opts);await w.write({type:'game',secret:'synthetic'});const r=await w.finish();const b=await fs.readFile(file);
 for(const [name,bytes,k,o] of [['truncated',b.subarray(0,-4),key,opts],['tampered',Buffer.concat([b.subarray(0,-1),Buffer.from([b.at(-1)^1])]),key,opts],['wrong-key',b,crypto.randomBytes(32),opts],['purpose',b,key,{...opts,kind:'privacy-journal'}],['checksum',b,key,{...opts,cipherSha256:'0'.repeat(64)}],['appended',Buffer.concat([b,Buffer.from('x')]),key,opts]]){
  const f=path.join(dir,name);await fs.writeFile(f,bytes,{mode:0o600});let yielded=0;await assert.rejects(async()=>{for await(const _ of S.readRecords(f,k,o))yielded++;},/CAPTURE_/);assert.equal(yielded,0,name);
 }
 assert.ok(!b.includes(Buffer.from('synthetic')));assert.ok(await S.verifyFile(file,key,{...opts,...r}));
});
test('failed/aborted output cannot overwrite a completed export; symlinks and public files denied',async t=>{
 const {dir,key,opts}=await fixture(t),file=path.join(dir,'export');const w=await S.createWriter(file,key,opts);await w.write({type:'a'});await w.finish();
 const second=await S.createWriter(file,key,opts);await second.write({type:'b'});await assert.rejects(second.finish(),e=>e.code==='EEXIST');assert.equal((await collect(file,key,opts))[0].type,'a');
 const incomplete=await S.createWriter(path.join(dir,'aborted'),key,opts);await incomplete.abort();assert.ok(!(await fs.readdir(dir)).some(f=>f.includes('partial')));
 await fs.symlink(file,path.join(dir,'link'));await assert.rejects(collect(path.join(dir,'link'),key,opts));await fs.chmod(file,0o644);await assert.rejects(collect(file,key,opts),/CAPTURE_PRIVATE_FILE/);
});
test('oversized records, absent encryption keys and forged end records rejected',async t=>{
 const {dir,key,opts}=await fixture(t),file=path.join(dir,'x');await assert.rejects(S.createWriter(file,null,opts),/CAPTURE_KEY/);const w=await S.createWriter(file,key,opts);
 await assert.rejects(w.write({data:'x'.repeat(S.MAX)}),/CAPTURE_RECORD_TOO_LARGE/);await assert.rejects(w.write({type:'end'}),/CAPTURE_RESERVED/);await w.abort();
});
