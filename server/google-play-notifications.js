'use strict';
const crypto=require('node:crypto');
const safeId=x=>typeof x==='string'&&/^[A-Za-z0-9._:-]{1,200}$/.test(x);
class GooglePlayNotifications{
 constructor(db,{billing,auth,monetization,packageName,now=Date.now}={}){if(!db||!billing||!auth||!monetization||!packageName)throw Error('GOOGLE_RTDN_CONFIG');Object.assign(this,{db,billing,auth,monetization,packageName,now});}
 revoke(transactionId,productId,reason){
  this.db.prepare("INSERT OR IGNORE INTO v41_store_revocations(store,transaction_id,product_id,occurred_at,reason) VALUES('google',?,?,?,?)").run(transactionId,productId||null,this.now(),reason);
  try{return this.monetization.refund('google',transactionId);}catch(e){if(e.message!=='UNKNOWN_RECEIPT')throw e;return {refunded:false,pending:false};}
 }
 async handle(authorization,envelope){
  await this.auth.verify(authorization);
  const message=envelope?.message,id=message?.messageId||message?.message_id;if(!safeId(id)||typeof message?.data!=='string'||message.data.length>131072)throw Error('INVALID_STORE_NOTIFICATION');
  if(this.db.prepare("SELECT 1 FROM v41_store_notifications WHERE store='google' AND id=?").get(id))return {ok:true,duplicate:true};
  let body;try{const raw=Buffer.from(message.data,'base64');if(raw.length>65536)throw Error();body=JSON.parse(raw.toString('utf8'));}catch{throw Error('INVALID_STORE_NOTIFICATION');}
  if(body.packageName!==this.packageName)throw Error('INVALID_STORE_NOTIFICATION');
  const one=body.oneTimeProductNotification,voided=body.voidedPurchaseNotification;
  if(one){
   if(![1,2].includes(one.notificationType)||!safeId(one.sku)||typeof one.purchaseToken!=='string')throw Error('INVALID_STORE_NOTIFICATION');
   const current=await this.billing.currentByToken(one.purchaseToken),state=current.value?.purchaseStateContext?.purchaseState;
   if(one.notificationType===2||state==='CANCELLED')this.revoke(current.transactionId,one.sku,'google_rtdn_cancelled');
   else if(state!=='PURCHASED'&&state!=='PENDING')throw Error('INVALID_STORE_NOTIFICATION');
  }else if(voided){
   if(typeof voided.purchaseToken!=='string')throw Error('INVALID_STORE_NOTIFICATION');
   const transactionId=crypto.createHash('sha256').update(voided.purchaseToken).digest('hex');this.revoke(transactionId,null,'google_rtdn_voided');
  }else throw Error('INVALID_STORE_NOTIFICATION');
  this.db.prepare("INSERT INTO v41_store_notifications(store,id,received_at) VALUES('google',?,?)").run(id,this.now());
  return {ok:true,duplicate:false};
 }
}
module.exports={GooglePlayNotifications};
