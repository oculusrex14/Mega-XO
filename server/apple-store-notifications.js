'use strict';
const safeId=x=>typeof x==='string'&&/^[A-Za-z0-9._:-]{1,200}$/.test(x);
class AppleStoreNotifications{
 constructor(db,{storeKit,monetization,now=Date.now}={}){if(!db||!storeKit||!monetization)throw Error('APPLE_NOTIFICATION_CONFIG');Object.assign(this,{db,storeKit,monetization,now});}
 revoke(tx,reason){
  this.db.prepare("INSERT OR IGNORE INTO v41_store_revocations(store,transaction_id,product_id,occurred_at,reason) VALUES('apple',?,?,?,?)").run(tx.transactionId,tx.providerProductId||null,this.now(),reason);
  try{return this.monetization.refund('apple',tx.transactionId);}catch(e){if(e.message!=='UNKNOWN_RECEIPT')throw e;return {refunded:false};}
 }
 async handle(body){
  if(!body||typeof body.signedPayload!=='string')throw Error('INVALID_STORE_NOTIFICATION');
  let payload;try{payload=this.storeKit.verifyJws(body.signedPayload);}catch{throw Error('INVALID_STORE_NOTIFICATION');}
  const id=payload.notificationUUID;if(!safeId(id)||payload.data?.bundleId!==this.storeKit.bundleId||payload.data?.environment!==this.storeKit.environment)throw Error('INVALID_STORE_NOTIFICATION');
  if(this.db.prepare("SELECT 1 FROM v41_store_notifications WHERE store='apple' AND id=?").get(id))return {ok:true,duplicate:true};
  const signed=payload.data?.signedTransactionInfo;if(typeof signed!=='string')throw Error('INVALID_STORE_NOTIFICATION');
  let tx;try{tx=this.storeKit.inspectTransaction(this.storeKit.verifyJws(signed));}catch{throw Error('INVALID_STORE_NOTIFICATION');}
  const binding=typeof tx.appAccountToken==='string'?this.db.prepare('SELECT actor FROM v41_store_bindings WHERE apple_token=?').get(tx.appAccountToken):null;
  const receipt=this.monetization.store.read().receipts.get('apple:'+tx.transactionId);
  if(binding&&receipt&&receipt.actor!==binding.actor)throw Error('INVALID_STORE_NOTIFICATION');
  const revoke=tx.revoked||['REFUND','REVOKE'].includes(payload.notificationType);if(revoke)this.revoke(tx,'apple_'+String(payload.notificationType||'revoked').toLowerCase());
  this.db.prepare("INSERT INTO v41_store_notifications(store,id,received_at) VALUES('apple',?,?)").run(id,this.now());
  return {ok:true,duplicate:false};
 }
}
module.exports={AppleStoreNotifications};
