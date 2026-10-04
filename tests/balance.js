/* Exact binomial expectation, not a retention, revenue or player-behaviour forecast. */
'use strict';
const D=require('../src/domain.js'),fs=require('node:fs'),path=require('node:path');
function choose(n,k){let p=1;for(let i=1;i<=k;i++)p=p*(n-i+1)/i;return p;}
function expected(t,games=10,win=.5){let bonus=0;for(let k=0;k<=games;k++)bonus+=choose(games,k)*win**k*(1-win)**(games-k)*Math.min(k*Math.floor(12*t.multiplier),120);return Math.round((7*(-games*(1-win)*t.fee+bonus)+t.weekly)*100)/100;}
const report={assumptions:{days:7,gamesPerDay:10,winProbability:.5,drawProbability:0,weeklyQualification:'All criteria met, seven snapshots',otherRewards:0,fees:'Both opponents in same league'},netWeeklyCoins:D.TIERS.map(t=>({league:t.name,ticket:t.fee,weekly:t.weekly,winBonus:Math.floor(12*t.multiplier),expectedNet:expected(t),netAt30PercentWins:expected(t,10,.3)})),examples:{goldToGrandmaster:D.quote({mode:'direct',from:'gold',to:'grandmaster'}),woodToGrandmaster:D.quote({mode:'direct',from:'wood',to:'grandmaster'}),upset:D.elo(1500,2700,1)}};
if(report.netWeeklyCoins.some(r=>r.expectedNet<0))throw Error('BASELINE_NOT_SUSTAINABLE');
fs.mkdirSync(path.join(__dirname,'../.artifacts'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../.artifacts/economy-balance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
