'use strict';
/* Bounded, authenticated, compressed record stream. Each file derives a unique AES-256-GCM key
 * from a random 128-bit salt. Counter nonces cannot repeat within that file. The authenticated
 * final record commits record count and plaintext hash. Readers validate the entire file before
 * returning any records. This is private storage, NOT a public anonymous-data format. */
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path');
const crypto = require('node:crypto'), zlib = require('node:zlib');
const {stable} = require('./capture.js');
const MAGIC = Buffer.from('MXOCAP1\n'), MAX = 1024 * 1024;
const err = code => { throw new Error(code); };
const keyValid = key => Buffer.isBuffer(key) && key.length === 32;
function headerValid(h) {
 if (!h || Object.keys(h).sort().join(',') !== 'format,keyId,kind,salt' || h.format !== 'private-records/v1' || !['gameplay','privacy-journal'].includes(h.kind) || !/^[A-Za-z0-9:_-]{1,120}$/.test(h.keyId) || !/^[a-f0-9]{32}$/.test(h.salt)) err('CAPTURE_ENCRYPTED_HEADER');
}
const fileKey = (key,h) => Buffer.from(crypto.hkdfSync('sha256', key, Buffer.from(h.salt,'hex'), Buffer.from('MegaXOXO private records v1'),32));
function nonce(index) { const b=Buffer.alloc(12); b.writeBigUInt64BE(BigInt(index),4); return b; }
const size = n => {const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
async function privateDirectory(dir) {
 await fsp.mkdir(dir,{recursive:true,mode:0o700});
 const s=await fsp.lstat(dir);
 if(!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077)) err('CAPTURE_PRIVATE_DIRECTORY_REQUIRED');
 return fsp.realpath(dir);
}
async function createWriter(destination,key,{keyId,kind='gameplay'}={}) {
 if(!keyValid(key))err('CAPTURE_KEY_REQUIRED');
 const h={format:'private-records/v1',keyId,kind,salt:crypto.randomBytes(16).toString('hex')};headerValid(h);
 const dir=await privateDirectory(path.dirname(destination)), target=path.join(dir,path.basename(destination));
 const temp=target+'.partial-'+crypto.randomBytes(12).toString('hex');
 const fh=await fsp.open(temp,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
 const raw=Buffer.from(stable(h)), aad=crypto.createHash('sha256').update(raw).digest(), derived=fileKey(key,h);
 const cipherHash=crypto.createHash('sha256'), plainHash=crypto.createHash('sha256');
 let index=0,records=0,bytes=0,closed=false;
 async function put(b){let offset=0;while(offset<b.length){const r=await fh.write(b,offset,b.length-offset);if(!r.bytesWritten)err('CAPTURE_STORAGE_WRITE');offset+=r.bytesWritten;}cipherHash.update(b);bytes+=b.length;}
 await put(Buffer.concat([MAGIC,size(raw.length),raw]));
 async function frame(record){
  if(closed || index>=Number.MAX_SAFE_INTEGER)err('CAPTURE_STREAM_CLOSED');
  const raw=Buffer.from(stable(record));if(raw.length>MAX)err('CAPTURE_RECORD_TOO_LARGE');
  const iv=nonce(index++),cipher=crypto.createCipheriv('aes-256-gcm',derived,iv,{authTagLength:16});cipher.setAAD(Buffer.concat([aad,iv]));
  const compressed=zlib.gzipSync(raw),body=Buffer.concat([cipher.update(compressed),cipher.final(),cipher.getAuthTag()]);
  await put(Buffer.concat([size(body.length),body]));return raw;
 }
 async function write(record){
  if(record?.type==='end')err('CAPTURE_RESERVED_RECORD');
  const raw=await frame(record);plainHash.update(raw).update('\n');records++;
 }
 async function abort(){if(!closed){closed=true;await fh.close().catch(()=>{});}await fsp.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});derived.fill(0);}
 async function finish(){
  const plainSha256=plainHash.digest('hex');
  let linked=false;
  try {
   await frame({type:'end',records,plainSha256});await fh.sync();await fh.close();closed=true;
   // link is an atomic no-replace publication; a repeated run can never overwrite an old export.
   await fsp.link(temp,target);linked=true;await fsp.unlink(temp);
   const d=await fsp.open(dir,'r');try{await d.sync();}finally{await d.close();}
   return {records,plainSha256,cipherSha256:cipherHash.digest('hex'),bytes};
  } catch(e){
   // A failure AFTER successful publication (e.g. unlink or directory fsync) must not
   // leave a private dataset with no DB manifest/retention receipt. Never remove an
   // existing target on EEXIST: only unlink a path THIS invocation just published.
   let cleanupError=null;
   if(linked)try{await fsp.unlink(target);}catch(cleanup){if(cleanup.code!=='ENOENT')cleanupError=cleanup;}
   await abort();
   if(cleanupError)throw new Error('CAPTURE_POSTPUBLISH_CLEANUP_FAILED',{cause:cleanupError});
   throw e;
  } finally{derived.fill(0);}
 }
 return {write,finish,abort};
}
async function openPrivate(filename) {
 const fh=await fsp.open(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 const stat=await fh.stat();if(!stat.isFile() || (stat.mode&0o077)){await fh.close();err('CAPTURE_PRIVATE_FILE_REQUIRED');}return fh;
}
async function *scan(fh,key,expected) {
 let offset=0,index=0,count=0;const cipherHash=crypto.createHash('sha256'),plainHash=crypto.createHash('sha256');
 async function read(n){const b=Buffer.alloc(n);let got=0;while(got<n){const r=await fh.read(b,got,n-got,offset+got);if(!r.bytesRead)err('CAPTURE_TRUNCATED');got+=r.bytesRead;}offset+=n;cipherHash.update(b);return b;}
 if(!(await read(MAGIC.length)).equals(MAGIC))err('CAPTURE_ENCRYPTED_MAGIC');
 const len=(await read(4)).readUInt32BE();if(len<2||len>1024)err('CAPTURE_ENCRYPTED_HEADER');
 const raw=await read(len);let h;try{h=JSON.parse(raw);}catch{err('CAPTURE_ENCRYPTED_HEADER');}headerValid(h);
 if(expected.keyId!==h.keyId || expected.kind!==h.kind)err('CAPTURE_ENCRYPTED_PURPOSE');
 const derived=fileKey(key,h),aad=crypto.createHash('sha256').update(raw).digest();
 try {while(true){
  const len=(await read(4)).readUInt32BE();if(len<17||len>MAX+2048)err('CAPTURE_ENCRYPTED_FRAME');
  const b=await read(len),iv=nonce(index++),decipher=crypto.createDecipheriv('aes-256-gcm',derived,iv,{authTagLength:16});
  decipher.setAAD(Buffer.concat([aad,iv]));decipher.setAuthTag(b.subarray(-16));
  let plain;try{const zipped=Buffer.concat([decipher.update(b.subarray(0,-16)),decipher.final()]);plain=zlib.gunzipSync(zipped,{maxOutputLength:MAX});}catch{err('CAPTURE_AUTHENTICATION_FAILED');}
  let r;try{r=JSON.parse(plain);}catch{err('CAPTURE_ENCRYPTED_JSON');}
  if(r?.type==='end'){
   if(Object.keys(r).sort().join(',')!=='plainSha256,records,type'||r.records!==count||r.plainSha256!==plainHash.digest('hex'))err('CAPTURE_FINAL_DIGEST');
   const extra=Buffer.alloc(1);if((await fh.read(extra,0,1,offset)).bytesRead)err('CAPTURE_TRAILING_DATA');
   const cipherSha256=cipherHash.digest('hex');if(expected.cipherSha256&&expected.cipherSha256!==cipherSha256)err('CAPTURE_CIPHER_HASH');
   if(expected.plainSha256&&expected.plainSha256!==r.plainSha256)err('CAPTURE_PLAIN_HASH');
   return;
  }
  plainHash.update(plain).update('\n');count++;yield r;
 }}finally{derived.fill(0);}
}
async function verifyFile(filename,key,expected) {
 if(!keyValid(key))err('CAPTURE_KEY_REQUIRED');const fh=await openPrivate(filename);
 try{for await(const _ of scan(fh,key,expected)){}return true;}finally{await fh.close();}
}
async function *readRecords(filename,key,expected) {
 if(!keyValid(key))err('CAPTURE_KEY_REQUIRED');const fh=await openPrivate(filename);
 try{
  const before=await fh.stat();for await(const _ of scan(fh,key,expected)){}
  const checked=await fh.stat();if(before.size!==checked.size||before.mtimeMs!==checked.mtimeMs)err('CAPTURE_FILE_CHANGED');
  yield*scan(fh,key,expected);
  const after=await fh.stat();if(checked.size!==after.size||checked.mtimeMs!==after.mtimeMs)err('CAPTURE_FILE_CHANGED');
 }finally{await fh.close();}
}
module.exports={createWriter,verifyFile,readRecords,privateDirectory,MAX};
