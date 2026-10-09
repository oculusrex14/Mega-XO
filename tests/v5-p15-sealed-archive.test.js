'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {Readable,Writable}=require('node:stream');
const {sealStream,openArchive,authenticateArchive,decryptToWritable,digestFile,publicRecipient}=require('../scripts/v5/p15/sealed-archive.js');

const keys=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
const PUB=keys.publicKey.export({format:'pem',type:'spki'});
const PRI=keys.privateKey.export({format:'pem',type:'pkcs8'});
const ctx={createdAtUtc:'2026-10-09T00:00:00.000Z',
 sourceFingerprint:'a'.repeat(64),schemaManifestSha256:'b'.repeat(64),sourceSha:'c'.repeat(40)};
const tmp=t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-p15-sealed-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return path.join(dir,'backup.partial');
};
async function decode(file,privateKey=PRI){
 const chunks=[];
 const sink=new Writable({write(chunk,_enc,callback){chunks.push(Buffer.from(chunk));callback();}});
 await decryptToWritable(file,privateKey,sink);
 return Buffer.concat(chunks);
}
test('P15 pg_dump-compatible arbitrary bytes stream directly into authenticated encrypted archive',async t=>{
 const file=tmp(t),secret=Buffer.concat([
  Buffer.from('PGDMP secret actor=svc_alice Crown=100 \n','utf8'),
  crypto.randomBytes(100000)]);
 const sealed=await sealStream(Readable.from([secret]),PUB,file,ctx);
 assert.ok(sealed.bytes>secret.length,'encryption envelope and tag are present');
 assert.equal(sealed.sha256,await digestFile(file));
 assert.equal((fs.statSync(file).mode&0o077),0,'ciphertext mode 0600');
 const raw=fs.readFileSync(file);
 assert.equal(raw.includes(Buffer.from('svc_alice')),false,'no personal data is visible in ciphertext');
 assert.deepEqual((await decode(file)),secret);
 const authenticated=await authenticateArchive(file,PRI);
 assert.equal(authenticated.header.sourceSha,ctx.sourceSha);
 assert.equal(authenticated.header.sourceFingerprint,ctx.sourceFingerprint);
});
test('wrong recovery key, tampered ciphertext, AAD and truncated authentication tag all refuse',async t=>{
 const file=tmp(t);
 await sealStream(Readable.from([Buffer.from('TEST PRIVATE RECORD')]),PUB,file,ctx);
 const alien=crypto.generateKeyPairSync('rsa',{modulusLength:3072}).privateKey.export({format:'pem',type:'pkcs8'});
 await assert.rejects(()=>authenticateArchive(file,alien),/P15_SEAL_REFUSED/);
 const original=fs.readFileSync(file);
 for(const position of [original.length-20,original.length-1,16]){
  const damaged=Buffer.from(original);
  damaged[position]^=0x01;
  fs.writeFileSync(file,damaged);
  await assert.rejects(()=>authenticateArchive(file,PRI),/P15_SEAL_REFUSED/);
 }
 fs.writeFileSync(file,original.subarray(0,original.length-4));
 await assert.rejects(()=>authenticateArchive(file,PRI),/P15_SEAL_REFUSED/);
});
test('rejects short or weak recovery key and never outputs plaintext on stream error',async t=>{
 const short=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'pem',type:'spki'});
 assert.throws(()=>publicRecipient(short),/P15_SEAL_REFUSED/);
 const file=tmp(t),error=new Readable({read(){this.destroy(Error('fixture failure'))}});
 await assert.rejects(()=>sealStream(error,PUB,file,ctx),/P15_SEAL_REFUSED/);
 assert.equal(fs.existsSync(file),false,'partial ciphertext is destroyed');
});
