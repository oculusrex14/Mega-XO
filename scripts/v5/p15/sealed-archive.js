'use strict';

/**
 * P15 streaming envelope for a PostgreSQL custom-format logical backup.
 *
 * Authenticated AES-256-GCM stream, 96-bit random nonce, new 256-bit DEK
 * for EACH archive; RSA-3072+ OAEP-SHA256 wraps the DEK for an OFF-HOST
 * recovery private key. Only the public key belongs on a backup runner.
 *
 * Wire layout: 8-byte magic | uint32BE header length | canonical JSON
 * header (also the GCM AAD) | ciphertext | 16-byte GCM tag.
 *
 * pg_dump stdout -> cipher -> sealed archive. No plaintext dump file.
 * On restore, authenticate a FULL pass to /dev/null BEFORE feeding a
 * second decryption pass to pg_restore in a quarantined new database.
 * The temporary private key is never written by this module.
 */
const fs=require('node:fs');
const crypto=require('node:crypto');
const {Readable,Writable}=require('node:stream');
const {pipeline}=require('node:stream/promises');

const MAGIC=Buffer.from('MEGAXO15','ascii');
const HEADER_LIMIT=8192,TAG_BYTES=16;
const SHA64=/^[0-9a-f]{64}$/,SHA40=/^[0-9a-f]{40}$/;
function refuse(why){throw Error('P15_SEAL_REFUSED: '+why);}
function validContext(c){
 if(!c||typeof c!=='object'||Array.isArray(c)||
   Object.keys(c).sort().join(',')!==['createdAtUtc','schemaManifestSha256','sourceFingerprint','sourceSha'].sort().join(',')||
   !SHA64.test(c.sourceFingerprint)||!SHA64.test(c.schemaManifestSha256)||
   !SHA40.test(c.sourceSha)||typeof c.createdAtUtc!=='string'||
   !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(c.createdAtUtc)||
   !Number.isFinite(Date.parse(c.createdAtUtc)))refuse('invalid source/version/manifest context');
}
function publicRecipient(key){
 let pub;
 try{pub=crypto.createPublicKey(key);}catch{refuse('invalid public recovery key');}
 if(pub.asymmetricKeyType!=='rsa'||pub.asymmetricKeyDetails?.modulusLength<3072) {
  refuse('recovery recipient must be RSA-3072 or stronger');
 }
 return {pub,fingerprint:crypto.createHash('sha256').update(pub.export({type:'spki',format:'der'})).digest('hex')};
}
function canonicalHeader(publicKey,context,key,nonce){
 const {pub,fingerprint}=publicRecipient(publicKey);
 const wrapped=crypto.publicEncrypt({key:pub,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,
   oaepHash:'sha256'},key);
 const data={
  format:'mega-v5-p15-sealed-archive/v1',
  algorithm:'AES-256-GCM',
  keyWrap:'RSA-OAEP-SHA256',
  recipientSpkiSha256:fingerprint,
  wrappedKey:wrapped.toString('base64'),
  nonce:nonce.toString('base64'),
  createdAtUtc:context.createdAtUtc,
  sourceFingerprint:context.sourceFingerprint,
  schemaManifestSha256:context.schemaManifestSha256,
  sourceSha:context.sourceSha
 };
 return Buffer.from(JSON.stringify(data),'utf8');
}
function openArchive(file){
 let fd;
 try{
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const st=fs.fstatSync(fd);
  if(!st.isFile()||st.size<12+TAG_BYTES+1)refuse('sealed archive empty or not a regular file');
  const prefix=Buffer.alloc(12);
  if(fs.readSync(fd,prefix,0,12,0)!==12||!prefix.subarray(0,8).equals(MAGIC))refuse('sealed magic mismatch');
  const len=prefix.readUInt32BE(8);
  if(len<40||len>HEADER_LIMIT||st.size<=12+len+TAG_BYTES)refuse('sealed header length invalid');
  const raw=Buffer.alloc(len);
  if(fs.readSync(fd,raw,0,len,12)!==len)refuse('sealed header incomplete');
  let header;try{header=JSON.parse(raw.toString('utf8'));}catch{refuse('sealed header not JSON');}
  if(!header||typeof header!=='object'||Array.isArray(header)||
     Object.keys(header).sort().join(',')!==[
       'format','algorithm','keyWrap','recipientSpkiSha256','wrappedKey','nonce',
       'createdAtUtc','sourceFingerprint','schemaManifestSha256','sourceSha'
     ].sort().join(',')||
     header.format!=='mega-v5-p15-sealed-archive/v1'||
     header.algorithm!=='AES-256-GCM'||header.keyWrap!=='RSA-OAEP-SHA256'||
     !SHA64.test(header.recipientSpkiSha256)||!SHA64.test(header.sourceFingerprint)||
     !SHA64.test(header.schemaManifestSha256)||!SHA40.test(header.sourceSha)||
     typeof header.wrappedKey!=='string'||!/^[A-Za-z0-9+/]+=*$/.test(header.wrappedKey)||
     typeof header.nonce!=='string'||!/^[A-Za-z0-9+/]+=*$/.test(header.nonce)) {
    refuse('sealed envelope metadata invalid');
  }
  const nonce=Buffer.from(header.nonce,'base64');
  if(nonce.length!==12||Buffer.from(header.wrappedKey,'base64').length<384)refuse('sealed key/nonce size invalid');
  const tag=Buffer.alloc(TAG_BYTES);
  if(fs.readSync(fd,tag,0,TAG_BYTES,st.size-TAG_BYTES)!==TAG_BYTES)refuse('sealed auth tag incomplete');
  return {fd,header,raw,nonce,tag,start:12+len,end:st.size-TAG_BYTES-1,size:st.size};
 }catch(e){
  if(fd!==undefined)fs.closeSync(fd);
  if(e.message&&e.message.startsWith('P15_SEAL_REFUSED:'))throw e;
  refuse('cannot open sealed archive');
 }
}
async function digestFile(file){
 const hash=crypto.createHash('sha256');
 for await(const data of fs.createReadStream(file))hash.update(data);
 return hash.digest('hex');
}
async function sealStream(input,publicPem,outputFile,context){
 validContext(context);
 if(!input||typeof input.pipe!=='function')refuse('streamed plaintext input required');
 if(typeof outputFile!=='string'||!outputFile.endsWith('.partial'))refuse('unique .partial output required');
 const key=crypto.randomBytes(32),nonce=crypto.randomBytes(12);
 const header=canonicalHeader(publicPem,context,key,nonce);
 if(header.length>HEADER_LIMIT)refuse('sealed header too large');
 const prefix=Buffer.alloc(12);
 MAGIC.copy(prefix);prefix.writeUInt32BE(header.length,8);
 const cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);
 key.fill(0);
 cipher.setAAD(header);
 let out;
 try{
  out=fs.createWriteStream(outputFile,{flags:'wx',mode:0o600});
  out.write(prefix);
  out.write(header);
  await pipeline(input,cipher,out,{end:false});
  const tag=cipher.getAuthTag();
  await new Promise((resolve,reject)=>out.end(tag,e=>e?reject(e):resolve()));
  const stat=fs.statSync(outputFile);
  if((stat.mode&0o077)!==0||stat.size<=prefix.length+header.length+TAG_BYTES) {
   refuse('sealed archive missing, accessible or empty');
  }
  return {bytes:stat.size,sha256:await digestFile(outputFile),
   recipientSpkiSha256:JSON.parse(header.toString('utf8')).recipientSpkiSha256,
   archiveFormat:'mega-v5-p15-sealed-archive/v1'};
 }catch(e){
  if(out)out.destroy();
  try{fs.unlinkSync(outputFile);}catch{}
  if(e.message&&e.message.startsWith('P15_SEAL_REFUSED:'))throw e;
  refuse('stream encryption failed (partial archive destroyed)');
 }
}
function unwrapKey(privatePem,opened){
 let privateKey;
 try{privateKey=crypto.createPrivateKey(privatePem);}catch{refuse('invalid private recovery identity');}
 const {fingerprint}=publicRecipient(crypto.createPublicKey(privateKey));
 if(fingerprint!==opened.header.recipientSpkiSha256)refuse('recipient key mismatch');
 let key;
 try{
  key=crypto.privateDecrypt({key:privateKey,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,
   oaepHash:'sha256'},Buffer.from(opened.header.wrappedKey,'base64'));
 }catch{refuse('wrapped backup key cannot be opened');}
 if(key.length!==32)refuse('unwrapped key length invalid');
 return key;
}
async function decryptToWritable(file,privatePem,sink){
 if(!sink||typeof sink.write!=='function')refuse('streaming restore sink required');
 const opened=openArchive(file);
 try{
  const key=unwrapKey(privatePem,opened);
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,opened.nonce);
  key.fill(0);
  decipher.setAAD(opened.raw);
  decipher.setAuthTag(opened.tag);
  const encrypted=fs.createReadStream(null,{fd:opened.fd,autoClose:false,
   start:opened.start,end:opened.end});
  await pipeline(encrypted,decipher,sink,{end:false});
  return {header:opened.header,encryptedBytes:opened.size};
 }catch(e){
  if(e.message&&e.message.startsWith('P15_SEAL_REFUSED:'))throw e;
  refuse('sealed archive authentication failed; restore must abort');
 }finally{fs.closeSync(opened.fd);}
}
async function authenticateArchive(file,privatePem){
 const sink=new Writable({write(_chunk,_enc,callback){callback();}});
 return decryptToWritable(file,privatePem,sink);
}
module.exports={MAGIC,HEADER_LIMIT,validContext,publicRecipient,openArchive,
 sealStream,digestFile,decryptToWritable,authenticateArchive};
