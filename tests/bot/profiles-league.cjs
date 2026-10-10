'use strict';
const fs=require('node:fs'),G=require('../../src/game.js'),S=require('../../src/bot/search.js'),R=require('./runner.cjs');
const pairs=Number(process.argv[2]||8);if(!Number.isInteger(pairs)||pairs<1||pairs>10000)throw Error('INVALID_PAIRS');
const engine=level=>({id:level,version:S.VERSION,budget:JSON.stringify(S.PROFILES[level]),choose:(s,rng)=>S.choose(s,{difficulty:level,seed:Math.floor(rng()*4294967296)}).move});
const leagues=[];for(let i=1;i<G.LEVELS.length;i++)leagues.push(R.league(engine(G.LEVELS[i]),engine(G.LEVELS[i-1]),{pairs,seed:613+i*100}));
const report={schemaVersion:1,runtime:process.version,pairs,scope:'Configured tier budgets, not equal-compute algorithm comparison. One Linux runtime is not cross-device calibration.',leagues,promotionApproved:false};
fs.mkdirSync('.artifacts/v51',{recursive:true});fs.writeFileSync('.artifacts/v51/profiles-league.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(leagues.map(l=>({a:l.engineA,b:l.engineB,...l.summary})),null,2));
