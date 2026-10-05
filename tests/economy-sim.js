/* V3.4 deterministic 90-day population model. Purchase pressure is not a revenue forecast. */
'use strict';
const D=require('../src/domain.js'),T=require('../src/tournament.js'),fs=require('node:fs'),path=require('node:path');
const LEGACY={startingCoins:100,quest:[5,15,15,10,15,15,20],bot:{Beginner:2,Easy:4,Medium:8,Hard:12,Expert:18},botCap:100,botWins:5,weekly:[50,150,250,350,450,550,700,850,1050,1300,1700],bonus:t=>Math.floor(12*t.multiplier),tables:{low:100,medium:500,high:2000,premium:500}};
const CURRENT={startingCoins:D.POLICY.startingCoins,quest:D.QUESTS.map(q=>q.reward),bot:D.BOT_PAY,botCap:D.POLICY.botDailyCap,botWins:D.POLICY.botWinsPerLevel,weekly:D.TIERS.map(t=>t.weekly),bonus:t=>D.rankedWinBonus(t),tables:Object.fromEntries(Object.entries(T.TABLES).map(([k,v])=>[k,v.entry]))};
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
function simulate(config,seed){
 const r=rng(seed),players=[];for(let i=0;i<N;i++){let n=r(),a=ARCH[0],sum=0;for(const x of ARCH){sum+=x.share;if(n<sum){a=x;break;}}players.push({a,coins:config.startingCoins,crowns:0,purchased:false,below25:false,rankedBlocked:false,tournamentSkipped:false,minted:0,burned:0,tournamentEntries:0,directSpend:0,converted:0});}
 for(let day=0;day<DAYS;day++){for(const p of players){const a=p.a,t=D.TIERS[a.tier],fee=t.fee,bonus=config.bonus(t);
  for(let g=0,n=poisson(a.ranked,r);g<n;g++){if(p.coins<fee){p.rankedBlocked=true;break;}p.coins-=fee;p.burned+=fee/2;if(r()<a.win){p.coins+=fee+bonus;p.minted+=bonus;}}
  for(const q of config.quest)if(r()<a.quest){p.coins+=q;p.minted+=q;}
  let botPaid=0,botValues=Object.values(config.bot);for(let b=0,n=Math.min(config.botWins,poisson(a.bot,r));b<n;b++){const value=botValues[Math.min(botValues.length-1,b+2)],pay=Math.min(value,Math.max(0,config.botCap-botPaid));botPaid+=pay;p.coins+=pay;p.minted+=pay;}
  if(r()<a.tournaments/7){const table=a.name==='light'?'low':a.name==='core'?'medium':(r()<.7?'medium':'high'),entry=config.tables[table];if(p.coins>=entry){p.coins-=entry;p.tournamentEntries+=entry;p.coins+=entry*10*SHARES[Math.floor(r()*10)];p.burned+=entry*.1;}else p.tournamentSkipped=true;}
  if(r()<a.direct/7){const pot=Math.max(2,2*Math.ceil(t.fee/2));if(p.crowns<pot){const need=pot-p.crowns,cost=need*D.POLICY.coinsPerCrown;if(p.coins>=cost){p.coins-=cost;p.crowns+=need;p.converted+=cost;}else if(a.buyer&&r()<.55){p.crowns+=100;p.purchased=true;}}if(p.crowns>=pot){p.crowns-=pot;p.directSpend+=pot;if(r()<a.win)p.crowns+=pot/2;p.burned+=pot*D.POLICY.coinsPerCrown/2;}}
  if(r()<a.premium/30){const entry=config.tables.premium;if(p.crowns<entry){const need=entry-p.crowns,cost=need*D.POLICY.coinsPerCrown;if(p.coins>=cost){p.coins-=cost;p.crowns+=need;p.converted+=cost;}else if(a.buyer&&r()<.5){p.crowns+=Math.ceil(need/525)*525;p.purchased=true;}}if(p.crowns>=entry){p.crowns-=entry;p.tournamentEntries+=entry*D.POLICY.coinsPerCrown;p.crowns+=entry*10*SHARES[Math.floor(r()*10)];p.burned+=entry*D.POLICY.coinsPerCrown*.1;}}
  if(p.coins<25)p.below25=true;
 }if(day%7===6)for(const p of players){if(r()<(p.a.name==='light'?.5:.8)){const pay=config.weekly[p.a.tier];p.coins+=pay;p.minted+=pay;}}}
 const wealth=players.map(p=>p.coins+p.crowns*D.POLICY.coinsPerCrown),sum=k=>players.reduce((n,p)=>n+p[k],0);
 return {players:N,days:DAYS,coinsGeneratedPerPlayerDay:sum('minted')/N/DAYS,coinsBurnedEquivalentPerPlayerDay:sum('burned')/N/DAYS,tournamentEntrySpendPerPlayer:sum('tournamentEntries')/N,directChallengeCrownsSpentPerPlayer:sum('directSpend')/N,coinToCrownConversionPerPlayer:sum('converted')/N,wallet:{p10:percentile(wealth,.1),median:percentile(wealth,.5),p90:percentile(wealth,.9)},everBelow25Coins:players.filter(p=>p.below25).length/N,everBlockedFromRanked:players.filter(p=>p.rankedBlocked).length/N,everSkippedChosenTournament:players.filter(p=>p.tournamentSkipped).length/N,modeledPurchasePressure:players.filter(p=>p.purchased).length/N};
}
const legacy=simulate(LEGACY,0x334),current=simulate(CURRENT,0x340),report={model:'pressure model, not revenue forecast',segments:ARCH,legacy,current,changes:{mintReduction:1-current.coinsGeneratedPerPlayerDay/legacy.coinsGeneratedPerPlayerDay,medianWealthReduction:1-current.wallet.median/legacy.wallet.median}};
fs.mkdirSync(path.join(__dirname,'../.artifacts'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../.artifacts/v34-economy-sim.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
if(!(current.coinsGeneratedPerPlayerDay<legacy.coinsGeneratedPerPlayerDay*.75))throw Error('MINT_REDUCTION_TOO_SMALL');
if(current.wallet.median>2500)throw Error('WALLET_INFLATION_HIGH');
if(current.modeledPurchasePressure>.16)throw Error('PURCHASE_PRESSURE_TOO_HIGH');
if(current.everBelow25Coins>.10)throw Error('TOO_MANY_COIN_STARVED');
if(current.everBlockedFromRanked>.15)throw Error('RANKED_ACCESS_TOO_TIGHT');
if(current.everSkippedChosenTournament>.50)throw Error('TOURNAMENT_ACCESS_TOO_TIGHT');
if(current.coinsBurnedEquivalentPerPlayerDay/current.coinsGeneratedPerPlayerDay<.45)throw Error('CURRENCY_SINK_TOO_WEAK');
