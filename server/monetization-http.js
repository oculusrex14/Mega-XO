/* Same-origin player API; only the signed SSV callback bypasses session/CSRF. */
'use strict';
const {readBody}=require('./community-http.js');
const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(value));};
function createMonetizationHandler({monetization,authenticate,guard,origin}){
 const rates=new Map();
 return async(req,res)=>{
  const path=new URL(req.url,origin).pathname;if(!path.startsWith('/api/monetization/')&&path!=='/api/v1/purchase')return false;
  try{
   if(path==='/api/monetization/admob-ssv'){if(req.method!=='GET')return send(res,405,{error:'METHOD_NOT_ALLOWED'}),true;await monetization.callback(req.url);return send(res,200,{ok:true}),true;}
   const identity=await authenticate(req);if(!identity?.id)return send(res,401,{error:'AUTH_REQUIRED'}),true;
   const actor=identity.id,minute=Math.floor(monetization.now()/60000),old=rates.get(actor),rate=old?.minute===minute?old:{minute,hits:0};rate.hits++;rates.set(actor,rate);if(rates.size>4096)rates.delete(rates.keys().next().value);if(rate.hits>60)return send(res,429,{error:'RATE_LIMITED'}),true;
   if(req.method==='GET'&&path==='/api/monetization/status')return send(res,200,monetization.status(actor)),true;
   if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'}),true;
   guard(req);if(!String(req.headers['content-type']||'').startsWith('application/json'))throw Error('ORIGIN_OR_CONTENT_TYPE');
   const b=await readBody(req,16384);if(!b||Array.isArray(b)||typeof b!=='object')throw Error('INVALID_COMMAND');const key=req.headers['idempotency-key'];let result;
   switch(path){
    case '/api/monetization/claim':result=monetization.claim(actor,key);break;
    case '/api/v1/purchase':
    case '/api/monetization/purchase':result=await monetization.purchase(actor,key,b.evidence,false);break;
    case '/api/monetization/restore':result=await monetization.purchase(actor,key,b.evidence,true);break;
    case '/api/monetization/reward-ticket':result=monetization.ticket(actor,key,b.kind);break;
    case '/api/monetization/interstitial-permit':result=monetization.automaticPermit(actor,key);break;
    default:return send(res,404,{error:'NOT_FOUND'}),true;
   }
   send(res,200,result);return true;
  }catch(e){const message=/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'REQUEST_FAILED';send(res,message==='AUTH_REQUIRED'||message==='LINK_ACCOUNT_REQUIRED'?401:409,{error:message});return true;}
 };
}
module.exports={createMonetizationHandler};
