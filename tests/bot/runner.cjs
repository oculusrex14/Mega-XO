'use strict';
// No services, wallets or browser globals. Every played move uses the rules oracle.
const G=require('../../src/game.js'),C=require('../../src/bot/contracts.js');
const {performance}=require('node:perf_hooks');
function legacy(level,{budget='nodes',nodeLimit=512}={}) {
 if(!G.LEVELS.includes(level)||!['nodes','wall'].includes(budget))throw Error('INVALID_PROFILE');
 return {id:'legacy-'+level,version:C.RULESET,budget:budget==='nodes'?'deterministic '+nodeLimit+'-node ceiling (128-node clock checks), also bounded by original tier cap':'original per-tier wall/node caps',
 choose:(state,rng)=>{let calls=0;return G.choose(state,level,rng,budget==='nodes'?{clock:()=>calls++*128>=nodeLimit?1e12:0}:{});}};
}
function play(a,b,{seed=1,first='X',opening=[],swap=false}={}) {
 let state=G.create(first);for(const move of opening)state=G.apply(state,move);
 const engines=swap?{X:b,O:a}:{X:a,O:b},rngs={X:C.seeded(seed),O:C.seeded(seed^0x9e3779b9)};
 const start=performance.now(),latency={X:[],O:[]};
 while(!state.winner){const who=state.turn,t=performance.now();const move=engines[who].choose(state,rngs[who]);latency[who].push(performance.now()-t);state=G.apply(state,C.assertMove(state,move));}
 const aSide=swap?'O':'X',point=state.winner==='DRAW'?.5:state.winner===aSide?1:0;
 return {seed,first,opening,swap,a:a.id,b:b.id,versions:[a.version,b.version],budgets:[a.budget,b.budget],point,winner:state.winner,moves:state.moves,latency,elapsedMs:performance.now()-start};
}
function quantile(values,q){const sorted=values.slice().sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor(sorted.length*q))]??null;}
function summarize(games) {
 if(!games.length)return {games:0};const points=games.reduce((n,g)=>n+g.point,0),pairs=[];
 for(let i=0;i+1<games.length;i+=2)pairs.push((games[i].point+games[i+1].point)/2);
 // Resample matched opening pairs, not individual games; preserve side correlation.
 const rng=C.seeded(731),boot=[];for(let i=0;i<2000&&pairs.length;i++){let p=0;for(let j=0;j<pairs.length;j++)p+=pairs[Math.floor(rng()*pairs.length)];boot.push(p/pairs.length);}
 return {games:games.length,wins:games.filter(g=>g.point===1).length,draws:games.filter(g=>g.point===.5).length,losses:games.filter(g=>g.point===0).length,pointScore:points/games.length,pairBootstrap95:boot.length?[quantile(boot,.025),quantile(boot,.975)]:null,uncertainty:pairs.length<30?'SMOKE ONLY: fewer than 30 independent pairs; interval is not promotion evidence':'Paired bootstrap; report opening-family coverage separately',p50MoveMs:quantile(games.flatMap(g=>[...g.latency.X,...g.latency.O]),.5),p95MoveMs:quantile(games.flatMap(g=>[...g.latency.X,...g.latency.O]),.95)};
}
function league(a,b,{pairs=1,seed=10,openings=[[]]}={}) {
 if(!Number.isInteger(pairs)||pairs<1||pairs>100000||!openings.length)throw Error('INVALID_LEAGUE');
 const games=[];for(let i=0;i<pairs;i++){const options={seed:seed+i,first:i%2?'O':'X',opening:openings[i%openings.length]};for(const swap of [false,true])games.push(play(a,b,{...options,swap}));}
 return {schemaVersion:1,engineA:a.id,engineB:b.id,seed,pairs,summary:summarize(games),games};
}
function scripted(script,fallback=legacy('Easy')) {
 return {id:'memorized-script-v1',version:C.RULESET,budget:fallback.budget,choose(state,rng){const m=script[state.moves.length];return G.legal(state).some(x=>C.sameMove(x,m))?m:fallback.choose(state,rng);}};
}
module.exports={legacy,play,league,summarize,scripted};
if(require.main===module){const [a='Easy',b='Beginner',pairs='8',budget='nodes']=process.argv.slice(2);process.stdout.write(JSON.stringify(league(legacy(a,{budget}),legacy(b,{budget}),{pairs:Number(pairs)}),null,2)+'\n');}
