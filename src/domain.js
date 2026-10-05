/* Shared product mathematics. Server records, never client balances, drive online play. */
(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.MegaDomain=api;})(globalThis,()=>{
'use strict';
const TIERS=[
 ['wood','Wood',0,2,1,'Seed',20],['stone','Stone',700,4,1.05,'Foundation',25],['iron','Iron',900,6,1.1,'Resolve',30],
 ['bronze','Bronze',1100,8,1.15,'Contender',40],['silver','Silver',1300,10,1.2,'Precision',50],['gold','Gold',1500,12,1.3,'Brilliance',65],
 ['diamond','Diamond',1700,16,1.4,'Clarity',85],['emerald','Emerald',1900,20,1.5,'Distinction',110],
 ['champion','Champion',2200,24,1.65,'Laureate',150],['master','Master',2400,30,1.8,'Virtuoso',220],['grandmaster','Grandmaster',2600,40,2,'The Twenty',300]
].map(([id,name,min,fee,multiplier,motto,weekly],index)=>Object.freeze({id,name,min,fee,multiplier,motto,weekly,index,cap:index===8?1000:index===9?200:index===10?20:null}));
const QUESTS=[
 {id:'finish',title:'A good start',desc:'Finish one full match.',metric:'finished',target:1,reward:2},
 {id:'three',title:'One more round',desc:'Finish three matches.',metric:'finished',target:3,reward:4},
 {id:'time',title:'Take your time',desc:'Complete 10 active minutes in full games.',metric:'seconds',target:600,reward:5},
 {id:'boards',title:'Small victories',desc:'Claim six Mini Boards.',metric:'boards',target:6,reward:3},
 {id:'casual',title:'Meet your match',desc:'Finish a free casual online match.',metric:'casual',target:1,reward:5,online:true},
 {id:'friend',title:'Friendly rivalry',desc:'Finish a free game with a friend.',metric:'friend',target:1,reward:5,online:true},
 {id:'ranked',title:'Step up',desc:'Finish a ranked match.',metric:'ranked',target:1,reward:6,online:true}
];
const BOT_PAY=Object.freeze({Beginner:1,Easy:1,Medium:2,Hard:4,Expert:6});
const POLICY=Object.freeze({version:'economy-2',startingCoins:150,coinsPerCrown:10,eloK:24,rankedBonusRatio:.6,botDailyCap:20,botWinsPerLevel:3,rankedBonusDailyCap:50,minRewardSeconds:30,minRewardMoves:12,elitePopulation:5000,placements:10,friendPotCap:20,directPairDaily:1,directPairWeekly:3,queuePairDaily:3,offerDaily:20,offerMinutes:10,weeklyGames:5,weeklyQueueGames:3,weeklyOpponents:3,weeklyActiveDays:3,seasonPlacementGames:5,seasonPlacementQueueGames:3,seasonPlacementOpponents:3,eliteActivityDays:14,eliteActivityGames:5,eliteActivityQueueGames:3,eliteActivityOpponents:3,eliteLastGameDays:7,leaderboardInactiveDays:28,seasonHistoryLimit:8});
/* Suggested catalogue quantities. Localized prices always come from the native store. */
const CROWN_PACKS=Object.freeze([{id:'crowns_100',crowns:100,suggestedUSD:0.99},{id:'crowns_525',crowns:525,suggestedUSD:4.99},{id:'crowns_1100',crowns:1100,suggestedUSD:9.99}].map(Object.freeze));
const DAY=86400000;
const tier=id=>TIERS.find(t=>t.id===id)||TIERS[0];
function requireTier(id){const t=TIERS.find(t=>t.id===id);if(!t)throw Error('INVALID_TIER');return t;}
function integer(n,label='AMOUNT'){if(!Number.isSafeInteger(n)||n<0)throw Error('INVALID_'+label);return n;}
function add(a,b){const n=a+b;integer(n);return n;}
const day=(now=Date.now())=>new Date(now).toISOString().slice(0,10);
function week(now=Date.now()){const d=new Date(now);d.setUTCHours(0,0,0,0);d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10);}
function weekStart(id){const n=Date.parse(id+'T00:00:00Z');if(!Number.isFinite(n)||week(n)!==id)throw Error('INVALID_WEEK');return n;}
function season(now=Date.now()){const d=new Date(now);if(!Number.isFinite(d.getTime()))throw Error('INVALID_SEASON_DATE');const year=d.getUTCFullYear(),quarter=Math.floor(d.getUTCMonth()/3)+1,start=Date.UTC(year,(quarter-1)*3,1),end=quarter===4?Date.UTC(year+1,0,1):Date.UTC(year,quarter*3,1);return {id:year+'-Q'+quarter,year,quarter,start,end};}
function seasonQualified(p,now=Date.now()){const s=p?.season;return !!s&&s.id===season(now).id&&p.games>=POLICY.placements&&s.games>=POLICY.seasonPlacementGames&&s.queueGames>=POLICY.seasonPlacementQueueGames&&new Set(s.opponents||[]).size>=POLICY.seasonPlacementOpponents;}
function skillLeaderboardEligible(p,now=Date.now()){const last=p?.season?.lastRatedAt??p?.lastRatedAt;return !!p?.verified&&!p.suspended&&!p.hold&&seasonQualified(p,now)&&Number.isFinite(last)&&now-last<=POLICY.leaderboardInactiveDays*DAY;}
function basicTier(rating){return TIERS.slice(0,8).filter(t=>rating>=t.min).pop()||TIERS[0];}
function rankedWinBonus(value){const t=typeof value==='string'?requireTier(value):value;if(!t||!Number.isSafeInteger(t.fee))throw Error('INVALID_TIER');return Math.max(1,Math.floor(t.fee*POLICY.rankedBonusRatio));}
function eligible(p,now){return skillLeaderboardEligible(p,now)&&p.games>=50&&p.uniqueOpponents>=10&&p.recent14Games>=POLICY.eliteActivityGames&&p.recent14QueueGames>=POLICY.eliteActivityQueueGames&&p.recent14Opponents>=POLICY.eliteActivityOpponents&&Number.isFinite(p.lastRatedAt)&&now-p.lastRatedAt<=POLICY.eliteLastGameDays*DAY&&now-p.createdAt>=14*DAY;}
/* Publish elite seats weekly; caps are exclusive and may remain unfilled. */
function assignTiers(players,now=Date.now()){
 const ranked=players.filter(p=>skillLeaderboardEligible(p,now)).sort((a,b)=>b.rating-a.rating||(a.reachedAt||0)-(b.reachedAt||0)||a.id.localeCompare(b.id));
 const out=new Map(ranked.map((p,i)=>[p.id,{tier:basicTier(p.rating).id,position:i+1,percentile:ranked.length>1?100*(ranked.length-i-1)/(ranked.length-1):null}]));
 if(ranked.length>=POLICY.elitePopulation){const used=new Set();for(const t of [...TIERS.slice(8)].reverse()){let count=0;for(const p of ranked)if(!used.has(p.id)&&eligible(p,now)&&p.rating>=t.min&&count<t.cap){out.get(p.id).tier=t.id;used.add(p.id);count++;}}}
 return out;
}
/* Chess-style expected score, game-by-game update; payment never enters this function.
   Store hundredths to avoid repeatedly rounding tiny favourite wins to a whole point. */
function elo(a,b,result,k=POLICY.eloK){
 if(![0,.5,1].includes(result)||![a,b,k].every(Number.isFinite)||a<0||b<0||k<=0||k>40)throw Error('INVALID_RATING');
 const expected=1/(1+10**((b-a)/400));
 const A=Math.round(a*100),B=Math.round(b*100);if(!Number.isSafeInteger(A)||!Number.isSafeInteger(B))throw Error('INVALID_RATING');
 const units=Math.max(-A,Math.min(B,Math.round(k*(result-expected)*100)));
 return {a:(A+units)/100,b:(B-units)/100,delta:units/100,expectedA:expected,k};
}
/* Ranked queue uses Coins. ALL direct ranked challenges use Crowns.
   A friend pot ceiling of 20 Crowns is exactly the approved 200-Coin ceiling. */
function quote({mode='ranked',kind='leaderboard',rated=true,from='wood',to='wood',stake,amount}={}){
 if(['casual','friend-free'].includes(mode)||mode==='direct'&&!rated)return {version:POLICY.version,mode:'unranked',rated:false,currency:null,minimum:0,ceiling:0,fee:0,contributions:[0,0],pool:0,burn:0,payout:0,bonus:0,netWin:0};
 const A=requireTier(from),B=requireTier(to);
 if(mode==='ranked'||mode==='queue'){
  const fee=Math.min(A.fee,B.fee);return {version:POLICY.version,mode:'queue',rated:true,currency:'coins',minimum:fee,ceiling:fee,fee,contributions:[fee,fee],pool:2*fee,burn:fee,payout:fee,bonus:rankedWinBonus(A),netWin:0};
 }
 if(!['direct','challenge','friend-stake'].includes(mode))throw Error('INVALID_MODE');
 if(mode==='friend-stake')kind='friend';if(!['friend','leaderboard'].includes(kind))throw Error('INVALID_KIND');
 const gap=Math.max(0,B.index-A.index);
 // Exactly 2*ceil(targetFee*(1+gap/2+gap^2/8)/2); no floating currency arithmetic.
 const minimum=kind==='friend'?2:2*Math.ceil(B.fee*(8+4*gap+gap*gap)/16);
 const offered=amount??stake??minimum;integer(offered);
 if(offered%2||offered<minimum)throw Error('POT_BELOW_MINIMUM_OR_NOT_EVEN');
 if(kind==='friend'&&offered>POLICY.friendPotCap)throw Error('FRIEND_POT_MAX_20_CROWNS');
 return {version:POLICY.version,mode:'direct',kind,rated:true,currency:'crowns',minimum,ceiling:kind==='friend'?POLICY.friendPotCap:null,gap,fee:offered,contributions:[offered,0],pool:offered,burn:offered/2,payout:offered/2,bonus:0,netWin:-offered/2};
}
function conversion(from,amount){
 integer(amount);if(amount===0)throw Error('AMOUNT_REQUIRED');
 if(from==='coins'){if(amount%POLICY.coinsPerCrown)throw Error('COINS_MULTIPLE_OF_10');return {from,to:'crowns',debit:amount,credit:amount/POLICY.coinsPerCrown};}
 if(from==='crowns'){const credit=amount*POLICY.coinsPerCrown;integer(credit);return {from,to:'coins',debit:amount,credit};}
 throw Error('INVALID_CURRENCY');
}
function wealth(w){for(const k of ['coins','crowns','reservedCoins','reservedCrowns'])integer(w[k]??0);return add(add(w.coins??0,w.reservedCoins??0),add(w.crowns??0,w.reservedCrowns??0)*POLICY.coinsPerCrown);}
function migrate(data){
 if(!data||data.version!==3.2)throw Error('INVALID_SAVE');
 const w=data.wallet;integer(w.coins);integer(w.crowns);w.ledger=w.ledger||[];w.operations=w.operations||{};w.reservedCoins=w.reservedCoins||0;w.reservedCrowns=w.reservedCrowns||0;
 for(const row of w.ledger)if(!row.currency)row.currency='coins';
 data.settings=data.settings||{};for(const [key,value] of Object.entries({notifications:false,notifyMatches:false,notifySocial:false,notifyRewards:false}))if(typeof data.settings[key]!=='boolean')data.settings[key]=value;
 data.economyVersion=POLICY.version;data.weekly=data.weekly||{};return data;
}
/* Atomic local conversion. The online server has its own independent wallet and journal. */
function convert(data,from,amount,id,now=Date.now()){
 migrate(data);if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(id))throw Error('INVALID_OPERATION');
 const q=conversion(from,amount),fingerprint=JSON.stringify(q),previous=Object.hasOwn(data.wallet.operations,id)?data.wallet.operations[id]:null;
 if(previous){if(previous.fingerprint!==fingerprint)throw Error('IDEMPOTENCY_CONFLICT');return {...previous.result,duplicate:true};}
 const w=data.wallet;if(w[from]<q.debit)throw Error('INSUFFICIENT_'+from.toUpperCase());
 const next=add(w[q.to],q.credit);w[from]-=q.debit;w[q.to]=next;
 const result={...q,id};w.operations[id]={fingerprint,result};
 w.ledger.push({id:id+':out',operation:id,currency:from,amount:-q.debit,reason:'Convert to '+q.to,at:now},{id:id+':in',operation:id,currency:q.to,amount:q.credit,reason:'Converted from '+from,at:now});return result;
}
function aggregate(records,mode='bot',difficulty='all'){
 const rows=records.filter(r=>r.mode===mode&&(difficulty==='all'||r.difficulty===difficulty)&&r.result&&r.eligibleStats!==false);
 const wins=rows.filter(r=>r.result==='win').length,losses=rows.filter(r=>r.result==='loss').length,draws=rows.filter(r=>r.result==='draw').length;
 const timed=rows.filter(r=>Number.isFinite(r.activeSeconds));const total=timed.reduce((a,r)=>a+Math.max(0,r.activeSeconds),0);
 return {games:rows.length,wins,losses,draws,winRate:rows.length?wins/rows.length:null,averageSeconds:timed.length?total/timed.length:null,hours:total/3600,timedGames:timed.length};
}
function fresh(now=Date.now()){return {version:3.2,economyVersion:POLICY.version,settings:{theme:'vector',sound:true,music:false,haptics:true,motion:false,legal:true,preview:true,timer:0,confirm:false,notifications:false,notifyMatches:false,notifySocial:false,notifyRewards:false},records:[],processed:[],wallet:{coins:POLICY.startingCoins,crowns:0,reservedCoins:0,reservedCrowns:0,operations:{},ledger:[{id:'welcome',currency:'coins',amount:POLICY.startingCoins,reason:'Welcome coins',at:now}],owned:[]},daily:{},weekly:{},legacy:null,profile:{name:'You',region:'India',wealthPublic:false}};}
function getDaily(data,now=Date.now()){
 const key=day(now);if(!data.daily[key])data.daily[key]={finished:0,seconds:0,boards:0,casual:0,friend:0,ranked:0,botPaid:0,botWins:{},claimed:[]};return data.daily[key];
}
function credit(data,id,amount,reason,now=Date.now()){
 if(data.wallet.ledger.some(e=>e.id===id))return 0;integer(amount);const next=add(data.wallet.coins,amount);
 data.wallet.coins=next;data.wallet.ledger.push({id,currency:'coins',amount,reason,at:now});return amount;
}
/* Only offline results enter here. No public browser method can submit a verified online result. */
function complete(data,record,now=Date.now()){
 if(data.processed.includes(record.id))return 0;
 if(!record.id||!['bot','local','ranked','casual','friend'].includes(record.mode)||!['win','loss','draw'].includes(record.result))throw Error('INVALID_RESULT');
 if(['ranked','casual','friend'].includes(record.mode))throw Error('SERVER_RESULT_REQUIRED');
 if(!Number.isFinite(record.activeSeconds)||record.activeSeconds<0||record.activeSeconds>86400||!Number.isInteger(record.moves)||record.moves<0||record.moves>81)throw Error('INVALID_MATCH_METRICS');
 data.processed.push(record.id);if(record.mode==='local'||record.practice)return 0;data.records.push({...record});const d=getDaily(data,now);
 if(!['line','draw'].includes(record.reason)||record.activeSeconds<POLICY.minRewardSeconds||record.moves<POLICY.minRewardMoves)return 0;
 d.finished++;d.seconds+=Math.min(900,Math.max(0,record.activeSeconds));d.boards+=Math.min(9,Math.max(0,record.claimed||0));
 let earned=0;if(record.mode==='bot'&&record.result==='win'){
  const count=d.botWins[record.difficulty]||0,amount=BOT_PAY[record.difficulty];
  if(amount&&count<POLICY.botWinsPerLevel){earned=Math.min(amount,Math.max(0,POLICY.botDailyCap-d.botPaid));d.botWins[record.difficulty]=count+1;d.botPaid+=earned;credit(data,'bot:'+record.id,earned,record.difficulty+' bot win',now);}
 }return earned;
}
function claim(data,id,now=Date.now()){
 const q=QUESTS.find(q=>q.id===id),d=getDaily(data,now);if(!q||q.online||d.claimed.includes(id)||(d[q.metric]||0)<q.target)return 0;
 const earned=credit(data,'quest:'+day(now)+':'+id,q.reward,q.title,now);d.claimed.push(id);return earned;
}
function spend(data,id,cost){integer(cost);if(!cost)throw Error('INVALID_COST');if(data.wallet.owned.includes(id))return false;if(data.wallet.coins<cost)throw Error('INSUFFICIENT_COINS');data.wallet.coins-=cost;data.wallet.owned.push(id);data.wallet.ledger.push({id:'cosmetic:'+id,currency:'coins',amount:-cost,reason:id,at:Date.now()});return true;}
function tournamentStats(record={}){const num=k=>Number.isSafeInteger(record?.[k])&&record[k]>=0?record[k]:0,entered=num('entered'),wins=num('wins'),runnerUp=num('runnerUp'),top3=num('top3'),top5=num('top5'),finishSum=num('finishSum'),premiumWins=num('premiumWins'),best=Number.isSafeInteger(record?.bestFinish)&&record.bestFinish>=1&&record.bestFinish<=10?record.bestFinish:null;return {entered,wins,runnerUp,top3,top5,bestFinish:best,averageFinish:entered?finishSum/entered:null,premiumWins,winRate:entered?wins/entered:null};}
/* One unified wealth table, not lifetime gross purchase volume. Held balances count once. */
function leaderboard(rows,{scope='global',region='',league='all',metric='rating',limit=20,now=Date.now()}={}){
 if(!['rating','wealth'].includes(metric))throw Error('INVALID_METRIC');
 const value=p=>metric==='rating'?p.rating:wealth(p.wallet||p);
 return rows.filter(p=>p.verified&&!p.suspended&&(metric==='wealth'||skillLeaderboardEligible(p,now))&&(scope!=='local'||p.region===region)&&(league==='all'||p.tier===league)&&(metric==='rating'||(p.wealthPublic&&!p.hold))).sort((a,b)=>value(b)-value(a)||a.id.localeCompare(b.id)).slice(0,Math.min(20,Math.max(0,limit)));
}
/* Snapshot-based weekly reward. A late rank spike cannot buy the full higher weekly payment.
   dailyTiers are trusted post-placement daily snapshots, at most one for each of the seven days. */
function weeklyReward({dailyTiers=[],endTier='wood',games=0,queueGames=0,uniqueOpponents=0,activeDays=0}={}){
 if(dailyTiers.length>7)throw Error('INVALID_SNAPSHOTS');dailyTiers.forEach(requireTier);const end=requireTier(endTier);
 if(games<POLICY.weeklyGames||queueGames<POLICY.weeklyQueueGames||uniqueOpponents<POLICY.weeklyOpponents||activeDays<POLICY.weeklyActiveDays||dailyTiers.length<3)return {amount:0,tier:null,eligible:false};
 const indices=dailyTiers.map(x=>requireTier(x).index).sort((a,b)=>a-b),median=indices[Math.floor((indices.length-1)/2)],t=TIERS[Math.min(end.index,median)];
 return {amount:Math.floor(t.weekly*dailyTiers.length/7),tier:t.id,eligible:true,days:dailyTiers.length};
}
return {TIERS,QUESTS,BOT_PAY,POLICY,CROWN_PACKS,DAY,tier,requireTier,integer,add,day,week,weekStart,season,seasonQualified,skillLeaderboardEligible,eligible,basicTier,rankedWinBonus,assignTiers,elo,quote,conversion,wealth,migrate,convert,aggregate,fresh,getDaily,complete,claim,spend,tournamentStats,leaderboard,weeklyReward};
});
