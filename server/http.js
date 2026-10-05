/* HTTP integration surface, not an authentication implementation.
 * Supply authenticate(req) backed by your identity provider and a DurableStore.
 * The handler NEVER accepts actor IDs, balances, rating changes or outcomes from body JSON.
 * Network matchmaking and native billing are separate adapters, optional/fail-closed.
 */
'use strict';
const D=require('../src/domain.js');
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>32768)throw Error('BODY_TOO_LARGE');}try{return JSON.parse(text||'{}');}catch{throw Error('INVALID_JSON');}}
function publicPlayer(a,tier,showWealth=false){return {id:a.id,name:a.name||a.id,region:a.region,tier,rating:a.rating,games:a.games,...(showWealth?{wealth:D.wealth(a)}:{})};}
function publicMatch(m,actor){const out=structuredClone(m);if(out.status==='OFFERED'&&out.terms?.source==='queue'){out.players=[actor];out.opponentHidden=true;out.terms={source:'queue',mode:out.terms.mode,kind:out.terms.kind,rated:out.terms.rated,turnSeconds:out.terms.turnSeconds};delete out.symbols;}return out;}
function createHandler({store,authenticate,origin,matchmaker=null}={}){
 if(!store||typeof authenticate!=='function'||!origin)throw Error('AUTHENTICATED_ADAPTER_REQUIRED');
 return async(req,res)=>{
  try{
   if(req.method!=='GET'&&req.method!=='POST')return json(res,405,{error:'METHOD_NOT_ALLOWED'});
   if(req.method==='POST'&&((req.headers.origin&&req.headers.origin!==origin)||!String(req.headers['content-type']).startsWith('application/json')))return json(res,403,{error:'ORIGIN_OR_CONTENT_TYPE'});
   const identity=await authenticate(req);if(!identity?.id)return json(res,401,{error:'AUTH_REQUIRED'});
   const principal={actor:identity.id,scope:'player'},url=new URL(req.url,origin),a=store.read(),self=a.account(identity.id),path=url.pathname.replace(/^\/api\/v1/,'');
   if(self.suspended)return json(res,403,{error:'ACCOUNT_HELD'});
   if(req.method==='GET'){
    if(path==='/profile')return json(res,200,{id:self.id,friendCode:self.friendCode||self.id,name:self.name||self.id,rating:self.rating,games:self.games,tier:a.currentTier(self),wallet:{coins:self.coins,crowns:self.crowns,reservedCoins:self.reservedCoins,reservedCrowns:self.reservedCrowns,owned:self.owned,ledger:a.journal.filter(e=>e.actor===self.id).slice(-40)},records:self.history,daily:self.daily[D.day(a.now())]||{},friends:self.friends.map(id=>publicPlayer(a.account(id),a.currentTier(a.account(id)))),friendRequests:self.friendRequests,wealthPublic:self.wealthPublic,season:a.seasonStatus(self)});
    if(path==='/leaderboard'){
     const metric=url.searchParams.get('metric')||'rating',scope=url.searchParams.get('scope')||'global';if(!['rating','wealth'].includes(metric)||!['global','local'].includes(scope))throw Error('INVALID_FILTER');
     const rows=a.leaderboard({metric,scope,league:url.searchParams.get('league')||'all',region:url.searchParams.get('region')||''});return json(res,200,rows.map(p=>publicPlayer(p,p.tier,metric==='wealth')));
    }
    if(path==='/invitations')return json(res,200,[...a.matches.values()].filter(m=>m.players.includes(self.id)&&!m.accepted.includes(self.id)&&m.status==='OFFERED'&&m.expires>a.now()).map(m=>publicMatch(a.view(m.id),self.id)));
    if(path==='/queue'){if(!matchmaker?.status)return json(res,503,{error:'ONLINE_UNAVAILABLE'});matchmaker.sweep?.();return json(res,200,matchmaker.status(self.id));}
    if(path.startsWith('/match/')){let m=a.view(path.slice(7));if(!m.players.includes(self.id))return json(res,403,{error:'NOT_PARTICIPANT'});
     if(m.status==='PLAYING'&&m.deadline!==null&&a.now()>=m.deadline){try{store.run({actor:'clock',scope:'matchmaker'},'timeout:'+m.id+':'+m.revision,{type:'timeout',id:m.id});}catch{}m=store.read().view(m.id);}
     if(m.status==='OFFERED'&&a.now()>=m.expires){try{store.run({actor:'clock',scope:'matchmaker'},'expire:'+m.id,{type:'expire',id:m.id});}catch{}m=store.read().view(m.id);}
     return json(res,200,{...publicMatch(m,self.id),serverNow:a.now()});}

    if(path==='/weekly')return json(res,200,[...a.weeklyPaid.values()].filter(p=>p.account===self.id));
    return json(res,404,{error:'NOT_FOUND'});
   }
   const b=await body(req),key=req.headers['idempotency-key'];if(!key)throw Error('IDEMPOTENCY_KEY_REQUIRED');let cmd;
   switch(path){
    case '/purchase':cmd={type:'purchase',evidence:b.evidence};break;
    case '/convert':cmd={type:'convert',from:b.from,amount:b.amount};break;
    case '/quest':cmd={type:'quest',quest:b.quest};break;
    case '/friend':cmd={type:'friend',target:b.target};break;
    case '/accept-friend':cmd={type:'acceptFriend',from:b.from};break;
    case '/preferences':cmd={type:'preferences',changes:{wealthPublic:b.changes?.wealthPublic,region:b.changes?.region}};break;
    case '/cosmetic':cmd={type:'cosmetic',name:b.name};break;
    case '/offer':cmd={type:'offer',id:b.id,opponent:b.opponent,terms:{mode:'direct',kind:b.terms?.kind,rated:b.terms?.rated===true,amount:b.terms?.amount,turnSeconds:b.terms?.rated===true?30:60}};break;
    case '/accept':cmd={type:'accept',id:b.id,termsHash:b.termsHash};break;
    case '/decline':cmd={type:'decline',id:b.id};break;
    case '/cancel':cmd={type:'cancel',id:b.id};break;
    case '/move':cmd={type:'move',id:b.id,revision:b.revision,move:b.move};break;
    case '/resign':cmd={type:'resign',id:b.id};break;
    case '/cancel-queue':if(!matchmaker?.cancel)return json(res,503,{error:'ONLINE_UNAVAILABLE'});return json(res,200,await matchmaker.cancel(self.id,key));
    case '/queue':if(!matchmaker)return json(res,503,{error:'ONLINE_UNAVAILABLE'});return json(res,200,await matchmaker.enqueue(self.id,b.mode,key,{region:identity.matchRegion,latencyMs:identity.latencyMs}));
    default:return json(res,404,{error:'NOT_FOUND'});
   }
   return json(res,200,store.run(principal,key,cmd));
  }catch(e){return json(res,e.message==='AUTH_REQUIRED'?401:409,{error:/^[A-Z0-9_]+$/.test(e.message)?e.message:'REQUEST_FAILED'});}
 };
}
module.exports={createHandler};
