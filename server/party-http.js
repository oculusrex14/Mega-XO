'use strict';
const T=require('../src/tournament.js');
function createPartyHandler({store,authenticate,origin,allowedHosts=null}){
 const limits=new Map();
 return async function(req,res){
  const path=new URL(req.url,'http://local').pathname;if(!path.startsWith('/api/party/'))return false;
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  try{
   if(allowedHosts&&!allowedHosts.has(req.headers.host))throw Error('BAD_HOST');
   if(req.headers.origin&&req.headers.origin!==(origin||'http://'+req.headers.host))throw Error('BAD_ORIGIN');
   const address=req.socket.remoteAddress||'',now=Date.now(),limit=limits.get(address)||{time:now,count:0};if(now-limit.time>60000){limit.time=now;limit.count=0;}if(++limit.count>2400)throw Error('RATE_LIMIT');limits.set(address,limit);if(limits.size>1000)limits.delete(limits.keys().next().value);
   if(req.method==='GET'&&path==='/api/party/capabilities'){send(200,{lan:store.lanOnly,online:!store.lanOnly,publicEnabled:!store.lanOnly&&store.paidEntryEnabled,tables:Object.keys(T.TABLES).map(T.prize)});return true;}
   let body={};if(req.method==='POST'){if(!String(req.headers['content-type']).startsWith('application/json'))throw Error('BAD_CONTENT_TYPE');let text='';for await(const part of req){text+=part;if(Buffer.byteLength(text)>16384)throw Error('BODY_TOO_LARGE');}body=JSON.parse(text||'{}');}
   if(req.method==='POST'&&path==='/api/party/session'){if(!store.lanOnly)throw Error('AUTH_REQUIRED');send(200,store.guest(body.name));return true;}
   const identity=store.lanOnly?store.authenticate((req.headers.authorization||'').replace(/^Bearer /,'')):await authenticate?.(req);
   const principal=store.lanOnly?identity:identity?.id?{actor:identity.id,name:identity.name||identity.id}:null;
   if(!principal)throw Error('AUTH_REQUIRED');
   if(!store.lanOnly&&store.account(store.economy(),principal.actor).suspended)throw Error('ACCOUNT_HELD');
   if(req.method==='GET'&&path==='/api/party/me'){send(200,{actor:principal.actor,name:principal.name});return true;}
   if(req.method==='GET'&&path.startsWith('/api/party/rooms/')){const id=decodeURIComponent(path.slice('/api/party/rooms/'.length));const view=store.view(id,principal.actor);send(200,new URL(req.url,'http://local').searchParams.get('revision')===String(view.revision)?{unchanged:true,serverNow:view.serverNow}:view);}
   else if(req.method==='POST'&&path==='/api/party/command'){if(body.type==='cancel'&&principal.scope==='operator')throw Error('PLAYER_ENDPOINT');send(200,store.run({...principal,scope:'player'},req.headers['idempotency-key'],body));}
   else send(404,{error:'NOT_FOUND'});
  }catch(e){const known=['INVALID_','ROOM_','NOT_','AUTH_','HOST_','FREE_','PAID_','INSUFFICIENT_','PLAYERS_','MATCH_','STALE_','TIME_','CANNOT_','EVENT_','INELIGIBLE','ALREADY_','COMPLETE_','RULES_','AUTOMATIC_','USE_','ACCOUNT_','BODY_','BAD_','RATE_','SESSION_','SKILL_','IDEMPOTENCY_'];const publicError=known.some(p=>e.message.startsWith(p))?e.message:'REQUEST_REJECTED';send(e.message==='AUTH_REQUIRED'?401:400,{error:publicError});}
  return true;
 };
}
module.exports={createPartyHandler};
