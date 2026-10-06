'use strict';
const crypto=require('node:crypto');
const TOKEN_URL='https://oauth2.googleapis.com/token';
const API='https://androidpublisher.googleapis.com/androidpublisher/v3/applications/';
const SCOPE='https://www.googleapis.com/auth/androidpublisher';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const b64=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
const cleanToken=value=>typeof value==='string'&&value.length>=8&&value.length<=4096&&!/[\s\u0000-\u001f]/.test(value);
const cleanProduct=value=>typeof value==='string'&&/^[A-Za-z0-9._-]{1,160}$/.test(value);

class GooglePlayBilling{
 constructor(db,{packageName,serviceAccount,products={},fetcher=globalThis.fetch,now=Date.now}={}){
  this.db=db;this.packageName=packageName;this.account=serviceAccount;this.products=Object.freeze({...products});this.fetch=fetcher;this.now=now;this.token=null;
  if(!db||!packageName||!serviceAccount?.client_email||!serviceAccount?.private_key)throw Error('GOOGLE_PLAY_CONFIG');
  if(!/^[A-Za-z][A-Za-z0-9_.]{2,199}$/.test(packageName))throw Error('GOOGLE_PLAY_CONFIG');
  if(!Object.keys(this.products).length||Object.values(this.products).some(v=>!['crowns_100','crowns_525','crowns_1100','remove_ads'].includes(v)))throw Error('GOOGLE_PLAY_CONFIG');
 }
 async json(url,options={}){
  const res=await this.fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(7000)}),text=await res.text();
  if(text.length>262144)throw Error('STORE_UNAVAILABLE');
  let value={};if(text)try{value=JSON.parse(text);}catch{throw Error('STORE_UNAVAILABLE');}
  if(!res.ok){const e=Error(res.status===400||res.status===404?'INVALID_RECEIPT':'STORE_UNAVAILABLE');e.status=res.status;throw e;}return value;
 }
 assertion(){
  const now=Math.floor(this.now()/1000),header=b64({alg:'RS256',typ:'JWT'}),payload=b64({iss:this.account.client_email,scope:SCOPE,aud:TOKEN_URL,iat:now,exp:now+300}),input=header+'.'+payload;
  return input+'.'+crypto.sign('RSA-SHA256',Buffer.from(input),this.account.private_key).toString('base64url');
 }
 async accessToken(){
  if(this.token&&this.token.expires>this.now()+30000)return this.token.value;
  const body=new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:this.assertion()});
  const value=await this.json(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
  if(typeof value.access_token!=='string'||!value.access_token||!Number.isFinite(Number(value.expires_in)))throw Error('STORE_UNAVAILABLE');
  this.token={value:value.access_token,expires:this.now()+Math.max(60,Math.min(3600,Number(value.expires_in)))*1000};return this.token.value;
 }
 async call(path,{method='GET',body}={}){
  const access=await this.accessToken(),headers={Authorization:'Bearer '+access};if(body!==undefined)headers['Content-Type']='application/json';
  return this.json(API+encodeURIComponent(this.packageName)+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 }
 async lookup(purchaseToken){
  if(!cleanToken(purchaseToken))throw Error('INVALID_RECEIPT');
  return this.call('/purchases/productsv2/tokens/'+encodeURIComponent(purchaseToken));
 }
 normalize(value,purchaseToken,actor,binding){
  if(value?.purchaseStateContext?.purchaseState!=='PURCHASED'||value.obfuscatedExternalAccountId!==binding.googleAccountId)throw Error('INVALID_RECEIPT');
  if(!Array.isArray(value.productLineItem)||value.productLineItem.length!==1)throw Error('INVALID_RECEIPT');
  const line=value.productLineItem[0],storeProduct=line?.productId,offer=line?.productOfferDetails||{},internal=this.products[storeProduct];
  if(!cleanProduct(storeProduct)||!internal||Number(offer.quantity??1)!==1)throw Error('INVALID_RECEIPT');
  const transactionId=sha(purchaseToken),revoked=this.db.prepare('SELECT 1 FROM v41_store_revocations WHERE store=? AND transaction_id=?').get('google',transactionId);
  if(revoked)throw Error('RECEIPT_REFUNDED');
  return {valid:true,accountId:actor,store:'google',transactionId,productId:internal,refunded:false,providerProductId:storeProduct,finalizeKind:internal==='remove_ads'?'acknowledge':'consume'};
 }
 async verify(evidence,actor,binding){
  if(!evidence||evidence.store!=='google'||!binding?.googleAccountId||!cleanToken(evidence.purchaseToken))throw Error('INVALID_RECEIPT');
  const value=await this.lookup(evidence.purchaseToken),receipt=this.normalize(value,evidence.purchaseToken,actor,binding),now=this.now();
  this.db.prepare(`INSERT INTO v41_store_finalize(store,transaction_id,product_id,purchase_token,kind,state,attempts,next_at,created,updated)
   VALUES('google',?,?,?,?, 'pending',0,?,?,?)
   ON CONFLICT(store,transaction_id) DO UPDATE SET product_id=excluded.product_id,purchase_token=CASE WHEN v41_store_finalize.state='done' THEN v41_store_finalize.purchase_token ELSE excluded.purchase_token END,kind=excluded.kind,updated=excluded.updated`).run(receipt.transactionId,receipt.providerProductId,evidence.purchaseToken,receipt.finalizeKind,now,now,now);
  return receipt;
 }
 async finalizeRow(row){
  if(!row||row.store!=='google'||!cleanProduct(row.product_id)||!cleanToken(row.purchase_token))throw Error('INVALID_FINALIZATION');
  const suffix='/purchases/products/'+encodeURIComponent(row.product_id)+'/tokens/'+encodeURIComponent(row.purchase_token)+':'+(row.kind==='consume'?'consume':'acknowledge');
  await this.call(suffix,{method:'POST',body:{}});
  this.db.prepare("UPDATE v41_store_finalize SET state='done',purchase_token='',updated=? WHERE store='google' AND transaction_id=?").run(this.now(),row.transaction_id);
  return true;
 }
 async finalize(transactionId){
  const row=this.db.prepare("SELECT * FROM v41_store_finalize WHERE store='google' AND transaction_id=?").get(transactionId);if(!row||row.state==='done')return true;
  try{return await this.finalizeRow(row);}catch(e){const attempts=row.attempts+1,next=this.now()+Math.min(3600000,15000*2**Math.min(8,attempts));this.db.prepare("UPDATE v41_store_finalize SET attempts=?,next_at=?,updated=? WHERE store='google' AND transaction_id=?").run(attempts,next,this.now(),transactionId);return false;}
 }
 async processDue(hasReceipt){
  const rows=this.db.prepare("SELECT * FROM v41_store_finalize WHERE store='google' AND state='pending' AND next_at<=? ORDER BY created LIMIT 10").all(this.now()),out={processed:0,completed:0};
  for(const row of rows){out.processed++;if(!hasReceipt('google',row.transaction_id)){if(this.now()-row.created>3600000)this.db.prepare("DELETE FROM v41_store_finalize WHERE store='google' AND transaction_id=?").run(row.transaction_id);continue;}if(await this.finalize(row.transaction_id))out.completed++;}
  return out;
 }
 async currentByToken(purchaseToken){const value=await this.lookup(purchaseToken);return {value,transactionId:sha(purchaseToken)};}
}
module.exports={GooglePlayBilling};
