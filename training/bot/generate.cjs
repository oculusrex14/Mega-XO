'use strict';
// Canonical complete-game bootstrap data. Large outputs belong outside Git.
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const G=require('../../src/game.js'),C=require('../../src/bot/contracts.js'),E=require('../../src/bot/encoding.js'),S=require('../../src/bot/search.js');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function family(moves){return Array.from({length:8},(_,s)=>moves.map(m=>{const t=E.mapMove(m,s);return t.b*9+t.c;}).join(',')).sort()[0];}
function splitFor(f){const n=parseInt(digest('split-v1:'+f).slice(0,8),16)%100;return n<80?'train':n<90?'validation':'holdout';}
function game({seed,simulations=32,openingPlies=4}={}){const rng=C.seeded(seed);let state=G.create(seed%2?'O':'X');for(let i=0;i<openingPlies;i++){const moves=G.legal(state);state=G.apply(state,moves[Math.floor(rng()*moves.length)]);}
 const opening=state.moves.map(({b,c})=>({b,c})),openingFamily=family(opening),split=splitFor(openingFamily),gameId='bootstrap-'+seed+'-'+openingFamily,rows=[];
 while(!state.winner){const analysis=S.mcts(state,{seed:Math.floor(rng()*4294967296),simulations,budgetMs:2000,clock:()=>0});const encoding=E.encode(state);rows.push({schemaVersion:1,gameId,openingFamily,split,seed,revision:state.moves.length,first:state.moves[0].player,moves:state.moves,player:state.turn,encodingVersion:E.VERSION,planes:[...encoding.planes],legalMask:[...encoding.mask],visitTarget:analysis.policy,searchVisits:analysis.diagnostics.visits,modelVersion:'no-neural-bootstrap-'+S.VERSION});
  // Mixed opponents provide states beyond a single deterministic teacher.
  const chooser=(seed+state.moves.length)%5;const move=chooser===0?G.choose(state,'Beginner',rng):chooser===1?G.choose(state,'Easy',rng):analysis.move;rows.at(-1).behavior=chooser<2?'mixed-'+(chooser===0?'Beginner':'Easy'):'uct';rows.at(-1).playedMove=move;state=G.apply(state,move);
 }
 for(const row of rows){row.terminalOutcome=state.winner;row.valueTarget=E.value(state.winner,row.player);row.completeGameMoves=state.moves.length;}
 return {gameId,openingFamily,split,rows,winner:state.winner,moves:state.moves};
}
function generate({output,games=16,seed=1000,simulations=32}={}){if(!output||!Number.isInteger(games)||games<1||games>100000||!Number.isInteger(simulations)||simulations<1||simulations>50000)throw Error('INVALID_GENERATION_OPTIONS');
 fs.mkdirSync(path.dirname(output),{recursive:true});const fd=fs.openSync(output,'wx'),hash=crypto.createHash('sha256'),counts={train:0,validation:0,holdout:0},ids=[];let records=0;
 try{for(let i=0;i<games;i++){const result=game({seed:seed+i,simulations});counts[result.split]++;ids.push({gameId:result.gameId,openingFamily:result.openingFamily,split:result.split});for(const row of result.rows){const text=JSON.stringify(row)+'\n';fs.writeSync(fd,text);hash.update(text);records++;}}}finally{fs.closeSync(fd);}
 const manifest={schemaVersion:1,encodingVersion:E.VERSION,rulesSha256:digest(fs.readFileSync('src/game.js')),searchSha256:digest(fs.readFileSync('src/bot/search.js')),records,games,seed,simulations,counts,gameIndex:ids,sha256:hash.digest('hex'),trainingStatus:'BOOTSTRAP_ONLY',perspective:'value target is terminal outcome for side to move; draw=0',targetPolicy:'UCT visits at every retained position; mixed behavior creates off-policy coverage',splitPolicy:'whole games grouped by D4-normalized four-ply opening; no family crosses splits'};
 fs.writeFileSync(output+'.manifest.json',JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});return manifest;
}
module.exports={family,splitFor,game,generate};
if(require.main===module){const [output='.artifacts/v51/bootstrap.jsonl',games='16',seed='1000',simulations='32']=process.argv.slice(2);console.log(JSON.stringify(generate({output,games:Number(games),seed:Number(seed),simulations:Number(simulations)}),null,2));}
