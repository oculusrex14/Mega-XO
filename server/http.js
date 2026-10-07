/* HTTP integration surface, not an authentication implementation.
 * Supply authenticate(req) backed by your identity provider and a DurableStore.
 * The handler NEVER accepts actor IDs, balances, rating changes or outcomes from body JSON.
 * Network matchmaking and native billing are separate adapters, optional/fail-closed.
 */
'use strict';
const D=require('../src/domain.js');
const C=require('../packages/contracts');
const json=(res,status,value)=>C.guards.writeJson(res,status,value);
const body=req=>C.guards.readRawJsonBody(req,32768);
function publicPlayer(a,tier,showWealth=false){return {id:a.id,name:a.name||a.id,region:a.region,tier,rating:a.rating,games:a.games,...(showWealth?{wealth:D.wealth(a)}:{})};}
function publicMatch(m,actor){const out=structuredClone(m);if(out.status==='OFFERED'&&out.terms?.source==='queue'){out.players=[actor];out.opponentHidden=true;out.terms={source:'queue',mode:out.terms.mode,kind:out.terms.kind,rated:out.terms.rated,turnSeconds:out.terms.turnSeconds};delete out.symbols;}return out;}
function createHandler({store,authenticate,origin,matchmaker=null}={}){
 if(!store||typeof authenticate!=='function'||!origin)throw Error('AUTHENTICATED_ADAPTER_REQUIRED');
 return async(req,res)=>{
  try{
   if(req.method!=='GET'&&req.method!=='POST')return json(res,405,{error:'METHOD_NOT_ALLOWED'});
   if(req.method==='POST'&&(C.guards.hasConflictingOrigin(req,origin)||!C.guards.isJsonContentType(req)))return json(res,403,{error:'ORIGIN_OR_CONTENT_TYPE'});
   const identity=await authenticate(req);if(!identity?.id)return json(res,401,{error:'AUTH_REQUIRED'});
   const principal=C.guards.sessionPrincipal(identity),url=new URL(req.url,origin),a=store.read(),self=a.account(identity.id),path=url.pathname.replace(/^\/api\/v1/,'');
   if(self.suspended)return json(res,403,{error:'ACCOUNT_HELD'});
   if(req.method==='GET'){
    if(path==='/profile')return json(res,200,{id:self.id,friendCode:self.friendCode||self.id,name:self.name||self.id,rating:self.rating,games:self.games,tier:a.currentTier(self),wallet:{coins:self.coins,crowns:self.crowns,reservedCoins:self.reservedCoins,reservedCrowns:self.reservedCrowns,owned:self.owned,ledger:a.journal.filter(e=>e.actor===self.id).slice(-40)},records:self.history,daily:self.daily[D.day(a.now())]||{},friends:self.friends.map(id=>publicPlayer(a.account(id),a.currentTier(a.account(id)))),friendRequests:self.friendRequests,wealthPublic:self.wealthPublic,season:a.seasonStatus(self),tournament:D.tournamentStats(self.tournamentRecord)});
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
   const b=await body(req),key=C.guards.truthyOperationKey(req);let cmd;
   switch(path){
    case '/purchase':cmd=C.commands.purchase(b);break;
    case '/convert':cmd=C.commands.convert(b);break;
    case '/quest':cmd=C.commands.quest(b);break;
    case '/friend':cmd=C.commands.friend(b);break;
    case '/accept-friend':cmd=C.commands.acceptFriend(b);break;
    case '/preferences':cmd=C.commands.preferences(b);break;
    case '/cosmetic':cmd=C.commands.cosmetic(b);break;
    case '/offer':cmd=C.commands.offer(b,b.opponent);break;
    case '/accept':cmd=C.commands.accept(b);break;
    case '/decline':cmd=C.commands.decline(b);break;
    case '/cancel':cmd=C.commands.cancel(b);break;
    case '/move':cmd=C.commands.move(b);break;
    case '/resign':cmd=C.commands.resign(b);break;
    case '/cancel-queue':if(!matchmaker?.cancel)return json(res,503,{error:'ONLINE_UNAVAILABLE'});return json(res,200,await matchmaker.cancel(self.id,key));
    case '/queue':if(!matchmaker)return json(res,503,{error:'ONLINE_UNAVAILABLE'});return json(res,200,await matchmaker.enqueue(self.id,b.mode,key,{region:identity.matchRegion,latencyMs:identity.latencyMs}));
    default:return json(res,404,{error:'NOT_FOUND'});
   }
   return json(res,200,store.run(principal,key,cmd));
  }catch(e){return json(res,C.guards.standaloneStatus(e.message),{error:C.guards.standalonePublicCode(e.message)});}
 };
}
module.exports={createHandler};
