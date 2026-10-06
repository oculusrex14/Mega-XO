'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AppleStoreNotifications}=require('../server/apple-store-notifications');
function fixture(environment='Production',appAppleId=1234567890){
 const inserted=[];
 const db={prepare(sql){
  if(sql.includes('SELECT 1 FROM v41_store_notifications'))return {get:()=>null};
  if(sql.includes('SELECT actor FROM v41_store_bindings'))return {get:()=>null};
  if(sql.includes('INSERT INTO v41_store_notifications'))return {run:(id,at)=>inserted.push({id,at})};
  if(sql.includes('INSERT OR IGNORE INTO v41_store_revocations'))return {run:()=>{}};
  throw Error('UNEXPECTED_SQL:'+sql);
 }};
 let calls=0;
 const storeKit={bundleId:'com.antimatter.mega',environment,appAppleId,
  verifyJws(){calls++;return calls===1?{notificationUUID:'n-1',notificationType:'DID_CHANGE_RENEWAL_STATUS',data:{bundleId:'com.antimatter.mega',environment,appAppleId,signedTransactionInfo:'tx-jws'}}:{bundleId:'com.antimatter.mega',environment,transactionId:'tx-1',productId:'sku',quantity:1,appAccountToken:'token'};},
  inspectTransaction(payload){return {transactionId:payload.transactionId,providerProductId:payload.productId,appAccountToken:payload.appAccountToken,revoked:false};}
 };
 const monetization={store:{read:()=>({receipts:new Map()})},refund:()=>({refunded:true})};
 return {handler:new AppleStoreNotifications(db,{storeKit,monetization,now:()=>42}),storeKit,inserted};
}
test('production Apple notifications require the configured numeric App Store app id',async()=>{
 const ok=fixture();assert.deepEqual(await ok.handler.handle({signedPayload:'notification-jws'}),{ok:true,duplicate:false});assert.equal(ok.inserted.length,1);
 const bad=fixture();bad.storeKit.verifyJws=(()=>{let calls=0;return ()=>++calls===1?{notificationUUID:'n-2',notificationType:'DID_CHANGE_RENEWAL_STATUS',data:{bundleId:'com.antimatter.mega',environment:'Production',appAppleId:999,signedTransactionInfo:'tx-jws'}}:{bundleId:'com.antimatter.mega',environment:'Production',transactionId:'tx-2',productId:'sku',quantity:1,appAccountToken:'token'};})();
 await assert.rejects(bad.handler.handle({signedPayload:'notification-jws'}),/INVALID_STORE_NOTIFICATION/);
});
test('sandbox notifications do not require an App Store app id',async()=>{
 const f=fixture('Sandbox',null);f.storeKit.verifyJws=(()=>{let calls=0;return ()=>++calls===1?{notificationUUID:'n-3',notificationType:'DID_CHANGE_RENEWAL_STATUS',data:{bundleId:'com.antimatter.mega',environment:'Sandbox',signedTransactionInfo:'tx-jws'}}:{bundleId:'com.antimatter.mega',environment:'Sandbox',transactionId:'tx-3',productId:'sku',quantity:1,appAccountToken:'token'};})();
 assert.deepEqual(await f.handler.handle({signedPayload:'notification-jws'}),{ok:true,duplicate:false});
});
