/* V3.4 deterministic 90-day population model. Purchase pressure is not a revenue forecast. */
'use strict';
const D=require('../src/domain.js'),T=require('../src/tournament.js'),fs=require('node:fs'),path=require('node:path');
const LEGACY={startingCoins:100,quest:[5,15,15,10,15,15,20],bot:{Beginner:2,Easy:4,Medium:8,Hard:12,Expert:18},botCap:100,botWins:5,rankedBonusDailyCap:120,weekly:[50,150,250,350,450,550,700,850,1050,1300,1700],bonus:t=>Math.floor(12*t.multiplier),tables:{low:100,medium:500,high:2000,premium:500}};
const CURRENT={startingCoins:D.POLICY.startingCoins,quest:D.QUESTS.map(q=>q.reward),bot:D.BOT_PAY,botCap:D.POLICY.botDailyCap,botWins:D.POLICY.botWinsPerLevel,rankedBonusDailyCap:D.POLICY.rankedBonusDailyCap,weekly:D.TIERS.map(t=>t.weekly),bonus:t=>D.rankedWinBonus(t),tables:Object.fromEntries(Object.entries(T.TABLES).map(([k,v])=>[k,v.entry]))};
const ARCH=[
{name:'light',share:.40,tier:3,ranked:1,win:.47,quest:.35,bot:.5,tournaments:.10,direct:0,premium:0,buyer:false},
{name:'core',share:.35,tier:5,ranked:2.5,win:.50,quest:.60,bot:1,tournaments:.30,direct:.10,premium:0,buyer:false},
{name:'competitive',share:.20,tier:7,ranked:5,win:.53,quest:.75,bot:1.5,tournaments:.70,direct:.30,premium:.05,buyer:true},
{name:'high-stakes',share:.05,tier:9,ranked:7,win:.55,quest:.85,bot:2,tournaments:1.2,direct:1,premium:.25,buyer:true}
];
const SHARES=[.36,.20,.13,.11,.10,0,0,0,0,0],N=5000,DAYS=90;
function rng(seed=0x4d454741){return()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};}
function poisson(mean,r){const L=Math.exp(-mean);let k=0,p=1;do{k++;p*=r();}while(p>L);return k-1;}
function percentile(xs,p){const a=xs.slice().sort((x,y)=>x-y),i=Math.min(a.length-1,Math.max(0,Math.floor((a.length-1)*p)));return Math.round(a[i]*100)/100;}
function crownPack(need){for(const pack of D.CROWN_PACKS)if(pack.crowns>=need)return pack.crowns;const top=D.CROWN_PACKS[D.CROWN_PACKS.length-1].crowns;return Math.ceil(need/top)*top;}
function markPurchaseNeed(p,kind){p.neededPurchase=true;if(kind==='core')p.neededCorePurchase=true;else p.neededOptionalPurchase=true;}
function fundCrowns(p,amount,propensity,r,kind='optional'){
 if(p.crowns>=amount)return true;
 const need=amount-p.crowns,cost=need*D.POLICY.coinsPerCrown;
 if(p.coins>=cost){p.coins-=cost;p.crowns+=need;p.coinToCrown+=cost;return true;}
 markPurchaseNeed(p,kind);
 if(!p.a.buyer||r()>=propensity)return false;
 p.crowns+=crownPack(need);p.purchased=true;return p.crowns>=amount;
}
function fundCoins(p,amount,propensity,r,kind='optional'){
 if(p.coins>=amount)return true;
 const missing=amount-p.coins,use=Math.min(p.crowns,Math.ceil(missing/D.POLICY.coinsPerCrown));
 if(use){p.crowns-=use;const credit=use*D.POLICY.coinsPerCrown;p.coins+=credit;p.crownToCoin+=credit;}
 if(p.coins>=amount)return true;
 markPurchaseNeed(p,kind);
 if(!p.a.buyer||r()>=propensity)return false;
 const remaining=amount-p.coins,crowns=Math.ceil(remaining/D.POLICY.coinsPerCrown),bought=crownPack(crowns);
 p.crowns+=bought;p.purchased=true;
 const convert=Math.min(p.crowns,crowns);p.crowns-=convert;const credit=convert*D.POLICY.coinsPerCrown;p.coins+=credit;p.crownToCoin+=credit;
 return p.coins>=amount;
}
function directQuote(t,r){
 const roll=r(),delta=roll<.15?-1:roll<.60?0:roll<.90?1:2,target=D.TIERS[Math.max(0,Math.min(D.TIERS.length-1,t.index+delta))];
 const minimum=D.quote({mode:'direct',kind:'leaderboard',from:t.id,to:target.id}).minimum,stakeRoll=r(),factor=stakeRoll<.70?1:stakeRoll<.90?1.5:2,amount=2*Math.ceil(minimum*factor/2);
 return D.quote({mode:'direct',kind:'leaderboard',from:t.id,to:target.id,amount});
}
function weeklyPay(config,p){
 const w=p.week;if(w.games<D.POLICY.weeklyGames||w.queueGames<D.POLICY.weeklyQueueGames||w.opponents<D.POLICY.weeklyOpponents||w.activeDays<D.POLICY.weeklyActiveDays||w.dailyTiers.length<3)return 0;
 const indices=w.dailyTiers.map(id=>D.requireTier(id).index).sort((a,b)=>a-b),median=indices[Math.floor((indices.length-1)/2)],index=Math.min(p.a.tier,median);
 return Math.floor(config.weekly[index]*w.dailyTiers.length/7);
}
function simulate(config,seed){
 const r=rng(seed),players=[];for(let i=0;i<N;i++){let n=r(),a=ARCH[0],sum=0;for(const x of ARCH){sum+=x.share;if(n<sum){a=x;break;}}players.push({a,coins:config.startingCoins,crowns:0,neededPurchase:false,neededCorePurchase:false,neededOptionalPurchase:false,purchased:false,below25:false,below25Liquid:false,rankedBlocked:false,tournamentSkipped:false,minted:0,burned:0,tournamentEntries:0,directSpend:0,coinToCrown:0,crownToCoin:0,week:{games:0,queueGames:0,opponents:0,activeDays:0,dailyTiers:[]}});}
 for(let day=0;day<DAYS;day++){for(const p of players){const a=p.a,t=D.TIERS[a.tier],fee=t.fee,bonus=config.bonus(t);let rankedBonusPaid=0,ratedToday=false;
  for(let g=0,n=poisson(a.ranked,r);g<n;g++){if(!fundCoins(p,fee,.05,r,'core')){p.rankedBlocked=true;break;}p.coins-=fee;p.burned+=fee/2;p.week.games++;p.week.queueGames++;p.week.opponents++;ratedToday=true;if(r()<a.win){const pay=Math.min(bonus,Math.max(0,config.rankedBonusDailyCap-rankedBonusPaid));rankedBonusPaid+=pay;p.coins+=fee+pay;p.minted+=pay;}}
  for(const q of config.quest)if(r()<a.quest){p.coins+=q;p.minted+=q;}
  let botPaid=0,botValues=Object.values(config.bot);for(let b=0,n=Math.min(config.botWins,poisson(a.bot,r));b<n;b++){const value=botValues[Math.min(botValues.length-1,b+2)],pay=Math.min(value,Math.max(0,config.botCap-botPaid));botPaid+=pay;p.coins+=pay;p.minted+=pay;}
  if(r()<a.tournaments/7){const table=a.name==='light'?'low':a.name==='core'?'medium':(r()<.7?'medium':'high'),entry=config.tables[table];if(fundCoins(p,entry,.10,r,'optional')){p.coins-=entry;p.tournamentEntries+=entry;p.coins+=entry*10*SHARES[Math.floor(r()*10)];p.burned+=entry*.1;}else p.tournamentSkipped=true;}
  if(r()<a.direct/7){const q=directQuote(t,r),pot=q.fee;if(fundCrowns(p,pot,.20,r,'optional')){p.crowns-=pot;p.directSpend+=pot;p.week.games++;p.week.opponents++;ratedToday=true;if(r()<a.win)p.crowns+=q.payout;p.burned+=q.burn*D.POLICY.coinsPerCrown;}}
  if(r()<a.premium/30){const entry=config.tables.premium;if(fundCrowns(p,entry,.25,r,'optional')){p.crowns-=entry;p.tournamentEntries+=entry*D.POLICY.coinsPerCrown;p.crowns+=entry*10*SHARES[Math.floor(r()*10)];p.burned+=entry*D.POLICY.coinsPerCrown*.1;}}
  if(ratedToday){p.week.activeDays++;p.week.dailyTiers.push(t.id);}
  if(p.coins<25)p.below25=true;if(p.coins+p.crowns*D.POLICY.coinsPerCrown<25)p.below25Liquid=true;
 }if(day%7===6)for(const p of players){const pay=weeklyPay(config,p);if(pay){p.coins+=pay;p.minted+=pay;}p.week={games:0,queueGames:0,opponents:0,activeDays:0,dailyTiers:[]};}}
 const wealth=players.map(p=>p.coins+p.crowns*D.POLICY.coinsPerCrown),sum=k=>players.reduce((n,p)=>n+p[k],0);
 return {players:N,days:DAYS,coinsGeneratedPerPlayerDay:sum('minted')/N/DAYS,coinsBurnedEquivalentPerPlayerDay:sum('burned')/N/DAYS,tournamentEntrySpendPerPlayer:sum('tournamentEntries')/N,directChallengeCrownsSpentPerPlayer:sum('directSpend')/N,coinToCrownConversionPerPlayer:sum('coinToCrown')/N,crownToCoinConversionPerPlayer:sum('crownToCoin')/N,wallet:{p10:percentile(wealth,.1),median:percentile(wealth,.5),p90:percentile(wealth,.9)},everBelow25Coins:players.filter(p=>p.below25).length/N,everBelow25LiquidWealth:players.filter(p=>p.below25Liquid).length/N,everBlockedFromRanked:players.filter(p=>p.rankedBlocked).length/N,everSkippedChosenTournament:players.filter(p=>p.tournamentSkipped).length/N,everNeededPurchase:players.filter(p=>p.neededPurchase).length/N,everNeededCorePurchase:players.filter(p=>p.neededCorePurchase).length/N,everNeededOptionalPurchase:players.filter(p=>p.neededOptionalPurchase).length/N,simulatedPurchaserShare:players.filter(p=>p.purchased).length/N};
}
const legacy=simulate(LEGACY,0x334),current=simulate(CURRENT,0x340),report={model:'pressure model, not revenue forecast',segments:ARCH,legacy,current,changes:{mintReduction:1-current.coinsGeneratedPerPlayerDay/legacy.coinsGeneratedPerPlayerDay,medianWealthReduction:1-current.wallet.median/legacy.wallet.median}};
fs.mkdirSync(path.join(__dirname,'../.artifacts'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../.artifacts/v34-economy-sim.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
if(!(current.coinsGeneratedPerPlayerDay<legacy.coinsGeneratedPerPlayerDay*.75))throw Error('MINT_REDUCTION_TOO_SMALL');
if(current.wallet.median>2500)throw Error('WALLET_INFLATION_HIGH');
if(current.everNeededCorePurchase>.18)throw Error('CORE_PURCHASE_NEED_TOO_HIGH');
if(current.simulatedPurchaserShare>.16)throw Error('PURCHASER_SHARE_TOO_HIGH');
if(current.everBelow25LiquidWealth>.10)throw Error('TOO_MANY_LIQUID_WALLET_STARVED');
if(current.everBlockedFromRanked>.15)throw Error('RANKED_ACCESS_TOO_TIGHT');
if(current.everSkippedChosenTournament>.50)throw Error('TOURNAMENT_ACCESS_TOO_TIGHT');
if(current.coinsBurnedEquivalentPerPlayerDay/current.coinsGeneratedPerPlayerDay<.45)throw Error('CURRENCY_SINK_TOO_WEAK');
