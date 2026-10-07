'use strict';
const T=require('../src/tournament.js');
const C=require('../packages/contracts');
function createPartyHandler({store,authenticate,origin,allowedHosts=null}){
 const limits=new Map();
 return async function(req,res){
  const path=new URL(req.url,'http://local').pathname;if(!path.startsWith('/api/party/'))return false;
  const send=(code,data)=>C.guards.writeJson(res,code,data);
  try{
   C.guards.requirePartyHost(req,allowedHosts);
   C.guards.requirePartyOrigin(req,origin);
   const address=req.socket.remoteAddress||'',now=Date.now(),limit=limits.get(address)||{time:now,count:0};if(now-limit.time>60000){limit.time=now;limit.count=0;}if(++limit.count>2400)throw Error('RATE_LIMIT');limits.set(address,limit);if(limits.size>1000)limits.delete(limits.keys().next().value);
   if(req.method==='GET'&&path==='/api/party/capabilities'){send(200,{lan:store.lanOnly,online:!store.lanOnly,publicEnabled:!store.lanOnly,tables:Object.keys(T.TABLES).map(T.prize)});return true;}
   let body={};if(req.method==='POST'){C.guards.requirePartyJson(req);body=await C.guards.readPartyBody(req,16384);}
   if(req.method==='POST'&&path==='/api/party/session'){if(!store.lanOnly)throw Error('AUTH_REQUIRED');send(200,store.guest(body.name));return true;}
   const identity=store.lanOnly?store.authenticate((req.headers.authorization||'').replace(/^Bearer /,'')):await authenticate?.(req);
   const principal=C.guards.partyPrincipal(identity);
   if(!principal)throw Error('AUTH_REQUIRED');
   if(!store.lanOnly&&store.account(store.economy(),principal.actor).suspended)throw Error('ACCOUNT_HELD');
   if(req.method==='GET'&&path==='/api/party/me'){send(200,{actor:principal.actor,name:principal.name});return true;}
   if(req.method==='GET'&&path.startsWith('/api/party/rooms/')){const id=decodeURIComponent(path.slice('/api/party/rooms/'.length));const view=store.view(id,principal.actor);send(200,new URL(req.url,'http://local').searchParams.get('revision')===String(view.revision)?{unchanged:true,serverNow:view.serverNow}:view);}
   else if(req.method==='POST'&&path==='/api/party/command'){if(body.type==='cancel'&&principal.scope==='operator')throw Error('PLAYER_ENDPOINT');send(200,store.run({...principal,scope:'player'},C.guards.rawOperationKey(req),body));}
   else send(404,{error:'NOT_FOUND'});
  }catch(e){send(C.guards.partyStatus(e.message),{error:C.guards.partyPublicCode(e.message)});}
  return true;
 };
}
module.exports={createPartyHandler};
