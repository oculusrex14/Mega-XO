/* Approved pure matchmaking policy: search windows, latency/region/recency eligibility, quality,
   tournament cohort choice and seeding.
   Extracted unchanged from server/matchmaking.js so that the stateful ticket/result Maps and the
   storage calls stay in server/ while the rules keep exactly one definition.
   No storage, HTTP, timer or process-global state: accounts, tickets and `now` are injected. */
'use strict';
const D=require('../../src/domain.js');
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
/* `sec` and `normalizedRegion` are pure timing/context helpers shared with the stateful Matchmaker
   so that they are not defined twice; the public matchmaking surface stays unchanged. */
module.exports={CONFIG,expected,quality,casualSkill,skill,searchWindow,sec,normalizedRegion,compatibility,tournamentWindow,selectTournamentRoom,tournamentSeed};
