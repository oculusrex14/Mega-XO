/* Cashfree PG v3 provider. Server-to-server order creation and verification; the browser
   only ever sees a payment session id. Webhook grants use our own recorded order row plus
   an independent GET /pg/orders/{order_id} check - a captured webhook alone never grants. */
'use strict';
const crypto=require('node:crypto');
const API_BASE='https://api.cashfree.com';
const ORDER_ID=/^cfmx[a-f0-9]{24}$/;
const newOrderId=()=>'cfmx'+crypto.randomBytes(12).toString('hex');
function createCashfreeProvider({appId,secretKey,apiVersion,env,fetchImpl=null}={}){
 if(!appId||!secretKey)throw Error('CASHFREE_CONFIG');
 if(!['PRODUCTION','TEST'].includes(env))throw Error('CASHFREE_CONFIG');
 const http=fetchImpl||(input=>fetch(input));
 const headers={'x-client-id':appId,'x-client-secret':secretKey,'x-api-version':apiVersion,'Content-Type':'application/json'};
 async function call(path,method,body){
  const response=await http(API_BASE+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();let parsed=null;try{parsed=text?JSON.parse(text):null;}catch{throw Error('CASHFREE_BAD_RESPONSE');}
  if(!response.ok)throw Error(response.status===401||response.status===403?'CASHFREE_AUTH':'CASHFREE_HTTP_'+response.status);
  if(!parsed||typeof parsed!=='object')throw Error('CASHFREE_BAD_RESPONSE');
  return parsed;
 }
 return {
  newOrderId,
  isOrderId:value=>typeof value==='string'&&ORDER_ID.test(value),
  async createOrder({orderId,productId,amount,actor,email,phone,returnUrl,notifyUrl}){
   const order=await call('/pg/orders','POST',{
    order_id:orderId,order_amount:Number(amount),order_currency:'INR',
    customer_details:{customer_id:String(actor).slice(0,40),customer_email:email,customer_phone:phone},
    order_meta:{return_url:returnUrl,notify_url:notifyUrl},
    order_note:'Mega XO '+productId,order_expiry_at:new Date(Date.now()+15*60000).toISOString()
   });
   if(typeof order.payment_session_id!=='string'||!order.payment_session_id)throw Error('CASHFREE_BAD_RESPONSE');
   return {orderId:order.order_id||orderId,paymentSessionId:order.payment_session_id};
  },
  async verifyOrder(orderId){
   const order=await call('/pg/orders/'+encodeURIComponent(orderId),'GET');
   const status=order.order_status,amount=Number(order.order_amount),currency=order.order_currency;
   if(!['ACTIVE','PAID','EXPIRED','TERMINATED','CANCELLED'].includes(status)||!Number.isFinite(amount))throw Error('CASHFREE_BAD_RESPONSE');
   if(currency!=='INR')throw Error('ORDER_CURRENCY_MISMATCH');
   /* The currency is RETURNED, not only checked: settleCashfree re-verifies it against the
      recorded order, so omitting the field here rejected every genuine payment at settle. */
   return {status,amount,currency};
  },
  verifyWebhook({timestamp,signature,rawBody,now=Date.now()}){
   const ts=String(timestamp||''),sig=String(signature||'');
   if(!/^\d{1,16}$/.test(ts)||!/^[A-Za-z0-9+/=]{1,512}$/.test(sig))return false;
   if(Math.abs(now-Number(ts))>300000)return false;
   const expected=crypto.createHmac('sha256',secretKey).update(ts+rawBody).digest('base64');
   const a=Buffer.from(expected),b=Buffer.from(sig);
   return a.length===b.length&&crypto.timingSafeEqual(a,b);
  }
 };
}
module.exports={createCashfreeProvider};
