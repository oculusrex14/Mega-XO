/* Versioned product rules. Prices/thresholds are launch hypotheses, not live data. */
(function(root,factory){const a=factory();if(typeof module==='object')module.exports=a;else root.MegaDomain=a;})(globalThis,()=>{
'use strict';
const TIERS=[
 ['wood','Wood',0,2,1,'Seed'],['stone','Stone',700,4,1.05,'Foundation'],['iron','Iron',900,6,1.1,'Resolve'],
 ['bronze','Bronze',1100,8,1.15,'Contender'],['silver','Silver',1300,10,1.2,'Precision'],['gold','Gold',1500,12,1.3,'Brilliance'],
 ['diamond','Diamond',1700,16,1.4,'Clarity'],['emerald','Emerald',1900,20,1.5,'Distinction'],
 ['champion','Champion',2200,24,1.65,'Laureate'],['master','Master',2400,30,1.8,'Virtuoso'],['grandmaster','Grandmaster',2600,40,2,'The Twenty']
].map(([id,name,min,fee,multiplier,motto],index)=>({id,name,min,fee,multiplier,motto,index,cap:index===8?1000:index===9?200:index===10?20:null}));
const QUESTS=[
 {id:'finish',title:'A good start',desc:'Finish one full match.',metric:'finished',target:1,reward:5},
 {id:'three',title:'One more round',desc:'Finish three matches.',metric:'finished',target:3,reward:15},
 {id:'time',title:'Take your time',desc:'Play for 10 active minutes.',metric:'seconds',target:600,reward:15},
 {id:'boards',title:'Small victories',desc:'Claim six Mini Boards.',metric:'boards',target:6,reward:10},
 {id:'casual',title:'Meet your match',desc:'Finish a free casual online match.',metric:'casual',target:1,reward:15,online:true},
 {id:'friend',title:'Friendly rivalry',desc:'Finish a free game with a friend.',metric:'friend',target:1,reward:15,online:true},
 {id:'ranked',title:'Step up',desc:'Finish a ranked match.',metric:'ranked',target:1,reward:20,online:true}
];
const BOT_PAY={Beginner:2,Easy:4,Medium:8,Hard:12,Expert:18};
const POLICY=Object.freeze({version:'3.2',botDailyCap:100,botWinsPerLevel:5,rankedBonusDailyCap:120,minRewardSeconds:30,minRewardMoves:12,elitePopulation:5000,placements:10,paidStakes:false,online:false,purchases:false});
const tier=id=>TIERS.find(t=>t.id===id)||TIERS[0];
const day=(now=Date.now())=>new Date(now).toISOString().slice(0,10);
const cleanNumber=n=>Number.isFinite(n)&&n>=0?n:0;
function basicTier(rating){return TIERS.slice(0,8).filter(t=>rating>=t.min).pop()||TIERS[0];}
function eligible(p,now){return p.verified&&!p.suspended&&p.games>=50&&p.uniqueOpponents>=10&&p.recentGames>=5&&now-p.createdAt>=14*86400000;}
/* Elite tiers are exclusive seats, not inclusive top-200/top-1000 bands. */
function assignTiers(players,now=Date.now()){
 const ranked=players.filter(p=>p.verified&&!p.suspended&&p.games>=10).sort((a,b)=>b.rating-a.rating||(a.reachedAt||0)-(b.reachedAt||0)||a.id.localeCompare(b.id));
 const out=new Map(ranked.map((p,i)=>[p.id,{tier:basicTier(p.rating).id,position:i+1,percentile:ranked.length>1?100*(ranked.length-i-1)/(ranked.length-1):null}]));
 if(ranked.length>=POLICY.elitePopulation){const used=new Set();for(const t of [...TIERS.slice(8)].reverse()){let count=0;for(const p of ranked)if(!used.has(p.id)&&eligible(p,now)&&p.rating>=t.min&&count<t.cap){out.get(p.id).tier=t.id;used.add(p.id);count++;}}}
 return out;
}
/* A single symmetric K preserves the pair's rating total. No coin/rank multiplier enters Elo. */
function elo(a,b,result,k=24){if(![0,.5,1].includes(result)||![a,b,k].every(Number.isFinite)||k<=0)throw Error('INVALID_RATING');const expected=1/(1+10**((b-a)/400));const delta=Math.round(k*(result-expected));return {a:a+delta,b:b-delta,delta};}
function quote({mode='ranked',from='wood',to='wood',stake=0}={}){
 if(mode==='casual'||mode==='friend-free')return {fee:0,pool:0,burn:0,payout:0,bonus:0,netWin:0};
 let fee;if(mode==='friend-stake'){if(!Number.isSafeInteger(stake)||stake<2||stake>200||stake%2)throw Error('STAKE_MUST_BE_EVEN_2_TO_200');fee=stake;}
 else if(mode==='challenge'){fee=Math.min(200,2*Math.ceil(tier(to).fee*(1+Math.max(0,tier(to).index-tier(from).index)*.25)/2));}
 else if(mode==='ranked')fee=Math.min(tier(from).fee,tier(to).fee);
 else throw Error('INVALID_MODE');
 const bonus=mode==='ranked'?Math.floor(12*tier(from).multiplier):0;
 return {fee,pool:fee*2,burn:fee,payout:fee,bonus,netWin:bonus};
}
function aggregate(records,mode='bot',difficulty='all'){
 const rows=records.filter(r=>r.mode===mode&&(difficulty==='all'||r.difficulty===difficulty)&&r.result&&r.eligibleStats!==false);
 const wins=rows.filter(r=>r.result==='win').length,losses=rows.filter(r=>r.result==='loss').length,draws=rows.filter(r=>r.result==='draw').length;
 const timed=rows.filter(r=>Number.isFinite(r.activeSeconds));const seconds=timed.reduce((a,r)=>a+cleanNumber(r.activeSeconds),0);
 return {games:rows.length,wins,losses,draws,winRate:rows.length?wins/rows.length:null,averageSeconds:timed.length?seconds/timed.length:null,hours:seconds/3600,timedGames:timed.length};
}
function fresh(){return {version:3.2,settings:{theme:'vector',sound:true,music:false,haptics:true,motion:false,legal:true,preview:true,timer:0,confirm:false},records:[],processed:[],wallet:{coins:100,crowns:0,ledger:[{id:'welcome',amount:100,reason:'Welcome coins',at:Date.now()}],owned:[]},daily:{},legacy:null,profile:{name:'You',region:'India',wealthPublic:false}};}
function getDaily(data,now=Date.now()){
 const key=day(now);if(!data.daily[key])data.daily[key]={finished:0,seconds:0,boards:0,casual:0,friend:0,ranked:0,botPaid:0,botWins:{},claimed:[]};return data.daily[key];
}
function credit(data,id,amount,reason,now=Date.now()){
 if(data.wallet.ledger.some(e=>e.id===id))return 0;
 if(!Number.isSafeInteger(amount)||amount<0)throw Error('INVALID_AMOUNT');
 data.wallet.coins+=amount;data.wallet.ledger.push({id,amount,reason,at:now});return amount;
}
/* Local rewards are explicitly provisional. They must NEVER become server-spendable on client assertion. */
function complete(data,record,now=Date.now()){
 if(data.processed.includes(record.id))return 0;
 if(!record.id||!['bot','local','ranked','casual','friend'].includes(record.mode)||!['win','loss','draw'].includes(record.result))throw Error('INVALID_RESULT');
 if(['ranked','casual','friend'].includes(record.mode))throw Error('SERVER_RESULT_REQUIRED');
 if(!Number.isFinite(record.activeSeconds)||record.activeSeconds<0||record.activeSeconds>86400||!Number.isInteger(record.moves)||record.moves<0||record.moves>81)throw Error('INVALID_MATCH_METRICS');
 data.processed.push(record.id);if(record.mode==='local'||record.practice)return 0;
 data.records.push({...record});const d=getDaily(data,now);
 if(record.reason!=='line'&&record.reason!=='draw')return 0;
 if(record.activeSeconds<POLICY.minRewardSeconds||record.moves<POLICY.minRewardMoves)return 0;
 d.finished++;d.seconds+=Math.min(900,cleanNumber(record.activeSeconds));d.boards+=Math.min(9,cleanNumber(record.claimed));
 let earned=0;if(record.mode==='bot'&&record.result==='win'){
  const count=d.botWins[record.difficulty]||0;const amount=BOT_PAY[record.difficulty];
  if(amount&&count<POLICY.botWinsPerLevel){earned=Math.min(amount,Math.max(0,POLICY.botDailyCap-d.botPaid));d.botWins[record.difficulty]=count+1;d.botPaid+=earned;credit(data,'bot:'+record.id,earned,record.difficulty+' bot win',now);}
 }
 return earned;
}
function claim(data,id,now=Date.now()){
 const q=QUESTS.find(q=>q.id===id),d=getDaily(data,now);if(!q||q.online||d.claimed.includes(id)||(d[q.metric]||0)<q.target)return 0;
 d.claimed.push(id);return credit(data,'quest:'+day(now)+':'+id,q.reward,q.title,now);
}
function spend(data,id,cost){if(!Number.isSafeInteger(cost)||cost<=0)throw Error('INVALID_COST');if(data.wallet.owned.includes(id))return false;if(data.wallet.coins<cost)throw Error('INSUFFICIENT_COINS');data.wallet.coins-=cost;data.wallet.owned.push(id);data.wallet.ledger.push({id:'cosmetic:'+id,amount:-cost,reason:id,at:Date.now()});return true;}
function leaderboard(rows,{scope='global',region='',league='all',metric='rating',limit=20}={}){
 const valid=['rating','coins','crowns'];if(!valid.includes(metric))throw Error('INVALID_METRIC');
 return rows.filter(p=>(scope!=='local'||p.region===region)&&(league==='all'||p.tier===league)&&(metric==='rating'||p.wealthPublic)).sort((a,b)=>b[metric]-a[metric]||a.id.localeCompare(b.id)).slice(0,Math.min(20,Math.max(0,limit)));
}
return {TIERS,QUESTS,BOT_PAY,POLICY,tier,day,eligible,basicTier,assignTiers,elo,quote,aggregate,fresh,getDaily,complete,claim,spend,leaderboard};
});
