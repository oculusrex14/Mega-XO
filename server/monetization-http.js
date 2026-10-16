/* Same-origin player API; only the signed SSV callback bypasses session/CSRF. */
'use strict';
const C=require('../packages/contracts');
const send=(res,status,value)=>C.guards.writeJson(res,status,value,{noReferrer:true});
function createMonetizationHandler({monetization,authenticate,guard,origin,storeNotifications={},cashfreeProvider=null,polarProvider=null}){
 const rates=new Map();
  const readRawText=async(req,limit)=>{let text='';for await(const chunk of req){text+=chunk;if(text.length>limit)throw Error('BODY_TOO_LARGE');}return text;};
 return async(req,res)=>{
  const path=new URL(req.url,origin).pathname;if(!path.startsWith('/api/monetization/')&&path!=='/api/v1/purchase')return false;
  try{
   if(path==='/api/monetization/admob-ssv'){
    if(req.method!=='GET')return send(res,405,{error:'METHOD_NOT_ALLOWED'}),true;
    /* AdMob's reachability probe for the configured callback URL is a GET with no parameters.
       A parameter-less request must NOT be treated as a verification attempt: the SSV contract
       requires a missing or unverifiable signature to fail closed (409), which is the assertion
       tests/monetization-http.test.js makes. Only GET-with-no-query answers the probe, and it
       never touches tickets. */
    if(req.method==='GET'&&!new URL(req.url,origin).search)return send(res,200,{ok:'probe'}),true;
    await monetization.callback(req.url);return send(res,200,{ok:true}),true;
   }
   if(path==='/api/monetization/google-play-rtdn'||path==='/api/monetization/apple-notifications'){
    if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'}),true;C.guards.requireJson(req,'INVALID_STORE_NOTIFICATION');const b=await C.guards.readStoreNotification(req);
    const handler=path.endsWith('google-play-rtdn')?storeNotifications.google:storeNotifications.apple;if(!handler)throw Error('STORE_UNAVAILABLE');const result=path.endsWith('google-play-rtdn')?await handler.handle(req.headers.authorization,b):await handler.handle(b);return send(res,200,result),true;
   }
   if(path==='/api/monetization/polar/webhook'){
    /* Provider-to-server: the Standard Webhooks signature covers the exact raw body. Only
       mega_pass subscription lifecycle events mutate the entitlement row. */
    if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'}),true;
    if(!polarProvider)throw Error('STORE_UNAVAILABLE');
    const raw=await readRawText(req,262144);
    const result=await monetization.polarPassWebhook({id:req.headers['webhook-id'],timestamp:req.headers['webhook-timestamp'],signature:req.headers['webhook-signature'],raw});
    return send(res,200,result),true;
   }
   if(path==='/api/monetization/cashfree/webhook'){
    /* Provider-to-server: the signature covers the exact raw body, then every grant is backed
       by an independent order verification. Never mount behind the session gate. */
    if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'}),true;
    if(!cashfreeProvider)throw Error('STORE_UNAVAILABLE');
    const raw=await readRawText(req,131072);
    if(!cashfreeProvider.verifyWebhook({timestamp:req.headers['x-webhook-timestamp'],signature:req.headers['x-webhook-signature'],rawBody:raw}))throw Error('INVALID_WEBHOOK_SIGNATURE');
    let event=null;try{event=JSON.parse(raw);}catch{throw Error('INVALID_WEBHOOK_EVENT');}
    const type=typeof event?.type==='string'?event.type:'';
    if(type==='payment.captured'||type==='order.paid'){
     const orderId=type==='payment.captured'?event?.data?.payment?.order_id:event?.data?.order?.order_id;
     if(typeof orderId!=='string'||!cashfreeProvider.isOrderId(orderId))throw Error('INVALID_WEBHOOK_EVENT');
     const verified=await cashfreeProvider.verifyOrder(orderId);
     await monetization.settleCashfree(orderId,verified);
    }else if(type==='refund.processed'){
     const orderId=event?.data?.refund?.order_id;
     if(typeof orderId!=='string'||!cashfreeProvider.isOrderId(orderId))throw Error('INVALID_WEBHOOK_EVENT');
     await monetization.refund('cashfree',orderId);
    }else throw Error('INVALID_WEBHOOK_EVENT');
    return send(res,200,{ok:true}),true;
   }
   const identity=await authenticate(req);if(!identity?.id)return send(res,401,{error:'AUTH_REQUIRED'}),true;
   const actor=identity.id,minute=Math.floor(monetization.now()/60000),old=rates.get(actor),rate=old?.minute===minute?old:{minute,hits:0};rate.hits++;rates.set(actor,rate);if(rates.size>4096)rates.delete(rates.keys().next().value);if(rate.hits>60)return send(res,429,{error:'RATE_LIMITED'}),true;
   if(req.method==='GET'&&path==='/api/monetization/status')return send(res,200,monetization.status(actor)),true;
   if(req.method==='GET'&&path==='/api/monetization/cashfree/status'){
    if(!cashfreeProvider)throw Error('STORE_UNAVAILABLE');
    const orderId=new URL(req.url,origin).searchParams.get('order_id')||'';
    if(!cashfreeProvider.isOrderId(orderId))throw Error('ORDER_NOT_FOUND');
    const row=monetization.cashfreeStatus(orderId);
    if(!row||row.actor!==actor)throw Error('ORDER_NOT_FOUND');
    let result;if(row.status==='PAID')result={orderId,settled:true,productId:row.product};
    else{const verified=await cashfreeProvider.verifyOrder(orderId);result=await monetization.settleCashfree(orderId,verified);}
    return send(res,200,{...result,paid:result.settled===true}),true;
   }
   if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'}),true;
   guard(req);if(!C.guards.isJsonContentType(req))throw Error('ORIGIN_OR_CONTENT_TYPE');
   const b=await C.guards.readCommandBody(req);const key=req.headers['idempotency-key'];let result;
   switch(path){
    case '/api/monetization/claim':result=monetization.claim(actor,key);break;
    case '/api/v1/purchase':
    case '/api/monetization/purchase':result=await monetization.purchase(actor,key,b.evidence,false);break;
    case '/api/monetization/restore':result=await monetization.purchase(actor,key,b.evidence,true);break;
    case '/api/monetization/reward-ticket':result=monetization.ticket(actor,key,b.kind,b.platform);break;
    case '/api/monetization/interstitial-permit':result=monetization.automaticPermit(actor,key,b.platform);break;
    case '/api/monetization/cashfree/order':{
     if(!cashfreeProvider)throw Error('STORE_UNAVAILABLE');
     const productId=typeof b.product==='string'?b.product:'',email=typeof b.email==='string'?b.email.trim().slice(0,254):'',phone=typeof b.phone==='string'?b.phone.trim().slice(0,20):'';
     if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)||!/^[0-9]{8,15}$/.test(phone))throw Error('INVALID_CUSTOMER_DETAILS');
     const amount=(monetization.cashfreeCatalog||{})[productId];if(typeof amount!=='string')throw Error('INVALID_PRODUCT');
     const existing=monetization.existingCashfree(actor,key);
     if(existing){result={...existing};break;}
     const created=await cashfreeProvider.createOrder({orderId:cashfreeProvider.newOrderId(),productId,amount,actor,email,phone,returnUrl:origin+'/store?cf_order={order_id}',notifyUrl:origin+'/api/monetization/cashfree/webhook'});
     result={...await monetization.recordCashfreeOrder(actor,key,created.orderId,productId,amount),paymentSessionId:created.paymentSessionId};
     break;}
    default:return send(res,404,{error:'NOT_FOUND'}),true;
   }
   send(res,200,result);return true;
  }catch(e){const message=C.guards.publicCode(e.message);send(res,C.guards.monetizationStatus(message),{error:message});return true;}
 };
}
module.exports={createMonetizationHandler};
