'use strict';
const crypto=require('node:crypto'),D=require('../src/domain.js');
const CONFIG=Object.freeze({
 ranked:Object.freeze({crossRegionAfter:35,recentAvoid:60,hardMax:200,eliteMax:250,acceptSeconds:15}),
 casual:Object.freeze({crossRegionAfter:12,recentAvoid:18,hardMax:350,acceptSeconds:15}),
 tournament:Object.freeze({hardMax:200})
});
const sec=(ticket,now)=>Math.max(0,(now-ticket.joinedAt)/1000);
function expected(a,b){return 1/(1+10**((b-a)/400));}
function quality(a,b){return 2/(1+10**(Math.abs(b-a)/400));}
function casualSkill(a){return Number.isFinite(a.casualRating)?a.casualRating:(a.games>=D.POLICY.placements?a.rating:1000);}
function skill(a,mode){return mode==='casual'?casualSkill(a):a.rating;}
function searchWindow(mode,wait,a){
 if(mode==='casual'){if(wait<6)return 100;if(wait<15)return 175;if(wait<30)return 250;return CONFIG.casual.hardMax;}
 const provisional=a.games<D.POLICY.placements;
 if(provisional){if(wait<10)return 100;if(wait<25)return 125;if(wait<45)return 150;return 200;}
 if(wait<10)return 50;if(wait<25)return 100;if(wait<45)return 150;if(wait<75)return 200;
 return a.rating>=2200?CONFIG.ranked.eliteMax:CONFIG.ranked.hardMax;
}
function normalizedRegion(value){return typeof value==='string'&&/^[A-Za-z0-9._-]{1,32}$/.test(value)?value:'global';}
function recentPair(a,b,mode){const rows=(a.history||[]).filter(h=>h.queue&&h.opponent===b.id&&(mode==='ranked'?h.rated:h.mode==='casual')).sort((x,y)=>y.at-x.at);return rows[0]||null;}
function compatibility(a,b,ta,tb,mode,now=Date.now()){
 if(!['ranked','casual'].includes(mode))return {ok:false,reason:'INVALID_MODE'};
 if(a.id===b.id||!a.verified||!b.verified||a.suspended||b.suspended||a.hold||b.hold||a.activeMatch||b.activeMatch)return {ok:false,reason:'INELIGIBLE'};
 if((a.blocked||[]).includes(b.id)||(b.blocked||[]).includes(a.id))return {ok:false,reason:'BLOCKED'};
 if(mode==='ranked'&&((a.friends||[]).includes(b.id)||(b.friends||[]).includes(a.id)))return {ok:false,reason:'FRIEND_QUEUE_BLOCK'};
 const wa=sec(ta,now),wb=sec(tb,now),ra=skill(a,mode),rb=skill(b,mode),gap=Math.abs(ra-rb),windowA=searchWindow(mode,wa,a),windowB=searchWindow(mode,wb,b);
 if(gap>windowA||gap>windowB)return {ok:false,reason:'SKILL_WINDOW',gap,windowA,windowB};
 if(mode==='ranked'){const pa=a.games<D.POLICY.placements,pb=b.games<D.POLICY.placements;if(pa!==pb&&(Math.min(wa,wb)<30||gap>100))return {ok:false,reason:'PLACEMENT_POOL'};}
 const sameRegion=ta.region==='global'||tb.region==='global'||ta.region===tb.region;
 if(!sameRegion&&Math.min(wa,wb)<CONFIG[mode].crossRegionAfter)return {ok:false,reason:'REGION_WAIT'};
 if((ta.latencyMs??0)>350||(tb.latencyMs??0)>350)return {ok:false,reason:'LATENCY_LIMIT'};
 const recent=recentPair(a,b,mode),avoid=CONFIG[mode].recentAvoid;if(recent&&Math.min(wa,wb)<avoid)return {ok:false,reason:'RECENT_OPPONENT'};
 const q=quality(ra,rb),regionPenalty=sameRegion?0:35,latencyPenalty=((ta.latencyMs||0)+(tb.latencyMs||0))/40,recentPenalty=recent?70:0;
 return {ok:true,gap,quality:q,score:gap+regionPenalty+latencyPenalty+recentPenalty,skills:[ra,rb],sameRegion,provisional:[a.games<D.POLICY.placements,b.games<D.POLICY.placements]};
}
function tournamentWindow(wait){return wait<25?100:wait<60?150:CONFIG.tournament.hardMax;}
function median(values){const x=values.slice().sort((a,b)=>a-b),m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;}
function lookupAccount(e,id){const a=e.accounts instanceof Map?e.accounts.get(id):Array.isArray(e.accounts)?e.accounts.find(([key])=>key===id)?.[1]:e.account(id);if(!a)throw Error('UNKNOWN_ACCOUNT');return a;}
function selectTournamentRoom(rooms,economy,actor,table,now=Date.now()){
 const a=lookupAccount(economy,actor),candidates=[];
 for(const room of rooms){
  if(room.table!==table||room.status!=='LOBBY'||room.players.length>=10||now>=room.expires)continue;
  const players=room.players.map(p=>lookupAccount(economy,p.id)).filter(Boolean);
  if(players.some(p=>(p.blocked||[]).includes(actor)||(a.blocked||[]).includes(p.id)))continue;
  if(players.some(p=>(p.friends||[]).includes(actor)||(a.friends||[]).includes(p.id)))continue;
  const ratings=players.map(p=>p.rating),centre=median(ratings),wait=(now-room.created)/1000,window=tournamentWindow(wait),next=ratings.concat(a.rating),spread=Math.max(...next)-Math.min(...next);
  if(Math.abs(a.rating-centre)>window||spread>CONFIG.tournament.hardMax)continue;
  candidates.push({room,score:Math.abs(a.rating-centre)+spread*.35-Math.min(wait,120)*.12,spread,window});
 }
 return candidates.sort((x,y)=>x.score-y.score||x.room.created-y.room.created)[0]?.room||null;
}
function tournamentSeed(ids,economy){const get=id=>lookupAccount(economy,id);return ids.slice().sort((a,b)=>{const A=get(a),B=get(b);return B.rating-A.rating||(B.games||0)-(A.games||0)||String(a).localeCompare(String(b));});}
class Matchmaker{
 constructor({store,now=()=>Date.now(),makeId=()=>crypto.randomUUID(),maxTickets=5000}={}){if(!store)throw Error('STORE_REQUIRED');this.store=store;this.now=now;this.makeId=makeId;this.maxTickets=maxTickets;this.tickets=new Map();this.results=new Map();}
 _context(context={}){const latency=Number(context.latencyMs);return {region:normalizedRegion(context.region),latencyMs:Number.isFinite(latency)?Math.max(0,Math.min(1000,latency)):null};}
 status(actor){let found=this.results.get(actor);if(found){try{const m=this.store.read().view(found.matchId);if(['OFFERED','PLAYING'].includes(m.status))return structuredClone(found);}catch{}this.results.delete(actor);found=null;}const t=this.tickets.get(actor);return t?{state:'searching',mode:t.mode,joinedAt:t.joinedAt,waitSeconds:Math.floor(sec(t,this.now())),window:searchWindow(t.mode,sec(t,this.now()),this.store.read().account(actor))}:{state:'idle'};}
 cancel(actor){if(this.results.has(actor))return {state:'matched',...structuredClone(this.results.get(actor))};const removed=this.tickets.delete(actor);return {state:removed?'cancelled':'idle'};}
 enqueue(actor,mode,key,context={}){if(!['ranked','casual'].includes(mode))throw Error('INVALID_MODE');const a=this.store.read().account(actor);if(!a.verified||a.suspended||a.hold||a.activeMatch)throw Error('INELIGIBLE');if(this.tickets.size>=this.maxTickets&&!this.tickets.has(actor))throw Error('QUEUE_FULL');const prior=this.results.get(actor);if(prior)return structuredClone(prior);if(!this.tickets.has(actor))this.tickets.set(actor,{actor,mode,joinedAt:this.now(),key:String(key||''),...this._context(context)});else if(this.tickets.get(actor).mode!==mode)throw Error('ALREADY_QUEUED');this.sweep(mode);return this.status(actor);}
 sweep(mode=null){const modes=mode?[mode]:['ranked','casual'];for(const m of modes){let progress=true;while(progress){progress=false;const auth=this.store.read(),tickets=[...this.tickets.values()].filter(t=>t.mode===m).sort((a,b)=>a.joinedAt-b.joinedAt||a.actor.localeCompare(b.actor));for(const ta of tickets){if(!this.tickets.has(ta.actor))continue;let A;try{A=auth.account(ta.actor);}catch{this.tickets.delete(ta.actor);continue;}let best=null;for(const tb of tickets){if(tb.actor===ta.actor||!this.tickets.has(tb.actor))continue;let B;try{B=auth.account(tb.actor);}catch{continue;}const c=compatibility(A,B,ta,tb,m,this.now());if(!c.ok)continue;if(m==='ranked'){const q=D.quote({mode:'ranked',from:auth.currentTier(A),to:auth.currentTier(B)});if(A.coins<q.fee||B.coins<q.fee)continue;}if(!best||c.score<best.c.score||(c.score===best.c.score&&tb.joinedAt<best.ticket.joinedAt))best={ticket:tb,c};}if(!best)continue;const tb=best.ticket,id='queue:'+this.makeId(),turnSeconds=m==='ranked'?30:60;try{const match=this.store.run({actor:'matchmaker',scope:'matchmaker'},'pair:'+id,{type:'queue',id,a:ta.actor,b:tb.actor,mode:m,turnSeconds});this.tickets.delete(ta.actor);this.tickets.delete(tb.actor);const result={state:'matched',mode:m,matchId:id,termsHash:match.termsHash,expires:match.expires,quality:best.c.quality,ratingGap:best.c.gap};this.results.set(ta.actor,result);this.results.set(tb.actor,result);progress=true;break;}catch(e){if(['RATED_PAIR_LIMIT','INELIGIBLE','ALREADY_IN_MATCH'].includes(e.message))continue;throw e;}}}}}
 tick(){this.sweep();return {queued:this.tickets.size,matched:this.results.size};}
 consume(actor){const x=this.results.get(actor);if(x)this.results.delete(actor);return x?structuredClone(x):null;}
}
module.exports={CONFIG,expected,quality,casualSkill,skill,searchWindow,compatibility,tournamentWindow,selectTournamentRoom,tournamentSeed,Matchmaker};
