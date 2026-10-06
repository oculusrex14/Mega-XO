'use strict';
const crypto=require('node:crypto');
const safe=x=>typeof x==='string'&&/^[A-Za-z0-9._:-]{1,200}$/.test(x);
const jsonPart=(value,max=65536)=>{const b=Buffer.from(value,'base64url');if(!b.length||b.length>max)throw Error('INVALID_RECEIPT');try{return JSON.parse(b.toString('utf8'));}catch{throw Error('INVALID_RECEIPT');}};
const certTime=(cert,at)=>{const from=Date.parse(cert.validFrom),to=Date.parse(cert.validTo);return Number.isFinite(from)&&Number.isFinite(to)&&at>=from&&at<=to;};

class AppleStoreKit{
 constructor(db,{bundleId,environment='Production',products={},trustedRoots=[],now=Date.now}={}){
  this.db=db;this.bundleId=bundleId;this.environment=environment;this.products=Object.freeze({...products});this.now=now;
  if(!db||!safe(bundleId)||!['Production','Sandbox'].includes(environment)||!Object.keys(products).length)throw Error('APPLE_STORE_CONFIG');
  this.roots=trustedRoots.map(pem=>new crypto.X509Certificate(pem));if(!this.roots.length)throw Error('APPLE_STORE_CONFIG');
  if(Object.values(products).some(v=>!['crowns_100','crowns_525','crowns_1100','remove_ads'].includes(v)))throw Error('APPLE_STORE_CONFIG');
 }
 chain(header,at){
  if(header?.alg!=='ES256'||!Array.isArray(header.x5c)||!header.x5c.length||header.x5c.length>5||header.jku||header.jwk||header.x5u||header.crit)throw Error('INVALID_RECEIPT');
  let certs;try{certs=header.x5c.map(x=>{if(typeof x!=='string'||x.length>8192)throw Error();return new crypto.X509Certificate(Buffer.from(x,'base64'));});}catch{throw Error('INVALID_RECEIPT');}
  for(const cert of certs)if(!certTime(cert,at))throw Error('INVALID_RECEIPT');
  for(let i=0;i<certs.length-1;i++){if(!certs[i].verify(certs[i+1].publicKey)||certs[i].checkIssued&&!certs[i].checkIssued(certs[i+1]))throw Error('INVALID_RECEIPT');}
  const last=certs.at(-1),trusted=this.roots.some(root=>last.fingerprint256===root.fingerprint256||(certTime(root,at)&&last.verify(root.publicKey)&&(!last.checkIssued||last.checkIssued(root))));
  if(!trusted)throw Error('INVALID_RECEIPT');return certs[0].publicKey;
 }
 verifyJws(jws){
  if(typeof jws!=='string'||jws.length>65536)throw Error('INVALID_RECEIPT');const parts=jws.split('.');if(parts.length!==3)throw Error('INVALID_RECEIPT');
  const header=jsonPart(parts[0],16384),payload=jsonPart(parts[1]),at=Number(payload.signedDate);if(!Number.isSafeInteger(at)||at<0||at>this.now()+5*60000)throw Error('INVALID_RECEIPT');
  const key=this.chain(header,at),signature=Buffer.from(parts[2],'base64url');if(signature.length!==64||!crypto.verify('sha256',Buffer.from(parts[0]+'.'+parts[1]),{key,dsaEncoding:'ieee-p1363'},signature))throw Error('INVALID_RECEIPT');
  return payload;
 }
 inspectTransaction(payload){
  if(payload.bundleId!==this.bundleId||payload.environment!==this.environment||!safe(String(payload.transactionId||''))||!safe(payload.productId)||Number(payload.quantity??1)!==1)throw Error('INVALID_RECEIPT');
  const internal=this.products[payload.productId];if(!internal)throw Error('INVALID_RECEIPT');return {transactionId:String(payload.transactionId),productId:internal,providerProductId:payload.productId,appAccountToken:payload.appAccountToken,revoked:payload.revocationDate!=null,payload};
 }
 validateTransaction(payload,actor,binding,{allowRevoked=false}={}){
  const tx=this.inspectTransaction(payload);if(!binding?.appleAppAccountToken||tx.appAccountToken!==binding.appleAppAccountToken)throw Error('INVALID_RECEIPT');
  const revoked=tx.revoked||this.db.prepare("SELECT 1 FROM v41_store_revocations WHERE store='apple' AND transaction_id=?").get(tx.transactionId);if(revoked&&!allowRevoked)throw Error('RECEIPT_REFUNDED');
  return {valid:!revoked,accountId:actor,store:'apple',transactionId:tx.transactionId,productId:tx.productId,refunded:!!revoked,providerProductId:tx.providerProductId,payload};
 }
 async verify(evidence,actor,binding){
  if(evidence?.store!=='apple'||typeof evidence.signedTransactionInfo!=='string'||!binding?.appleAppAccountToken)throw Error('INVALID_RECEIPT');
  return this.validateTransaction(this.verifyJws(evidence.signedTransactionInfo),actor,binding);
 }
 async finalize(){return true;}
}
module.exports={AppleStoreKit};
