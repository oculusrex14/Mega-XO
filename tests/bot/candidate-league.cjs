'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const G=require('../../src/game.js'),C=require('../../src/bot/contracts.js'),S=require('../../src/bot/search.js'),R=require('./runner.cjs');
const {performance}=require('node:perf_hooks');
const [pairsArg='12',budgetArg='20',output='.artifacts/v51/candidate-league.json']=process.argv.slice(2),pairs=Number(pairsArg),budgetMs=Number(budgetArg);
if(!Number.isInteger(pairs)||pairs<1||!Number.isFinite(budgetMs)||budgetMs<1||budgetMs>320)throw Error('INVALID_BENCHMARK_ARGS');
const legacy={id:'legacy-Expert',version:'f8913fd',budget:budgetMs+'ms scaled original clock; original node cap remains',choose(state,rng){const start=performance.now();return G.choose(state,'Expert',rng,{clock:()=>(performance.now()-start)*(320/budgetMs)});}};
const candidate={id:S.VERSION,version:crypto.createHash('sha256').update(fs.readFileSync('src/bot/search.js')).digest('hex'),budget:budgetMs+'ms; 350000-node ceiling',choose:(state,rng)=>S.choose(state,{difficulty:'Expert',seed:Math.floor(rng()*4294967296),budgetMs}).move};
const rng=C.seeded(280),openings=[[]];for(let i=0;i<8;i++){let s=G.create();for(let j=0;j<2+i%3;j++){const moves=G.legal(s);s=G.apply(s,moves[Math.floor(rng()*moves.length)]);}openings.push(s.moves.map(({b,c})=>({b,c})));}
const report=R.league(candidate,legacy,{pairs,seed:2026,openings});
report.runtime=process.version;report.budgetMs=budgetMs;report.methodology='Same wall search budget; original root ordering before its clock and 128-node checks can overshoot. Latencies include overhead. Paired seeds/sides and seeded opening families. Not device or 320ms promotion evidence when lower budget or sample is small.';report.promotionApproved=false;
fs.mkdirSync(require('node:path').dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.summary,null,2));
