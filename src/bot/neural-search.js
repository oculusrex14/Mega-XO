/* Bounded async PUCT research engine. Final move always revalidated by MegaGame. */
(function(root,factory){const api=factory(typeof module==='object'?require('../game.js'):root.MegaGame,typeof module==='object'?require('./contracts.js'):root.MegaBotContract,typeof module==='object'?require('./encoding.js'):root.MegaBotEncoding);if(typeof module==='object')module.exports=api;else root.MegaBotNeuralSearch=api;})(globalThis,(G,C,E)=>{
'use strict';
const VERSION='neural-puct-v1-experimental';
function critical(state){const player=state.turn,rows=G.legal(state).map(move=>{const next=G.apply(state,move);return {move,next,win:next.winner===player,unsafe:!next.winner&&G.legal(next).some(m=>G.apply(next,m).winner===next.turn)};});const wins=rows.filter(r=>r.win);if(wins.length)return wins;const safe=rows.filter(r=>!r.unsafe);return safe.length?safe:rows;}
async function choose(state,{infer,signal,seed=0,budgetMs=1500,simulations=256,maxNodes=2048,gameId,revision=state.moves.length,modelHash,policyOnly=false,clock=()=>performance.now()}={}){
 if(typeof infer!=='function'||!/^[a-f0-9]{64}$/.test(modelHash||''))throw Error('NEURAL_MODEL_NOT_PINNED');if(revision!==state.moves.length)throw Error('STALE_BOT_RESULT');
 const cap=Math.max(1,Math.min(2048,Math.floor(Number(simulations)||1))),nodeCap=Math.max(82,Math.min(8192,Math.floor(Number(maxNodes)||82))),duration=Math.max(0,Math.min(2000,Number(budgetMs)||0)),start=clock(),rng=C.seeded(seed),roots=critical(state);
 const check=()=>{if(signal?.aborted){const e=Error('NEURAL_CANCELLED');e.name='AbortError';throw e;}};check();
 const diagnostics={version:VERSION,modelHash,rngSeed:seed,simulations:0,nodes:1,budgetMs:duration,policyOnly,elapsedMs:0};
 if(!roots.length)return {move:null,gameId,revision,diagnostics};
 const result=move=>{diagnostics.elapsedMs=clock()-start;return {move:C.assertMove(state,move),gameId,revision,diagnostics};};
 if(roots[0].win)return result(roots[Math.floor(rng()*roots.length)].move);
 const node=(s,prior=1,move=null)=>({state:s,prior,move,visits:0,total:0,children:null,cachedValue:null,tie:rng()}),root=node(state);
 async function expand(n,choices){if(n.state.winner)return E.value(n.state.winner,n.state.turn);const evaluated=await infer(n.state,{signal});check();if(!Number.isFinite(evaluated.value)||Math.abs(evaluated.value)>1.0001)throw Error('INVALID_NEURAL_VALUE');const encoding=E.encode(n.state),policy=E.maskedPolicy(evaluated.logits,encoding.mask),rows=choices||critical(n.state);const total=rows.reduce((sum,r)=>sum+policy[r.move.b*9+r.move.c],0);
  n.cachedValue=policyOnly?Math.tanh(G.evaluate(n.state,n.state.turn)/600):evaluated.value;
  if(diagnostics.nodes+rows.length<=nodeCap){n.children=rows.map(row=>node(row.next,total?policy[row.move.b*9+row.move.c]/total:1/rows.length,row.move));diagnostics.nodes+=rows.length;}
  return n.cachedValue;
 }
 // A zero budget still returns a canonically safe legal move without invoking inference.
 if(clock()-start>=duration)return result(roots[Math.floor(rng()*roots.length)].move);
 await expand(root,roots);
 for(let i=0;i<cap&&clock()-start<duration;i++){check();let current=root;const path=[root];while(current.children?.length){let best=null,score=-Infinity;for(const child of current.children){const q=child.visits?-child.total/child.visits:0,u=1.5*child.prior*Math.sqrt(current.visits+1)/(child.visits+1),s=q+u+child.tie*1e-9;if(s>score){score=s;best=child;}}current=best;path.push(current);if(!current.children)break;}
  let value=current.state.winner?E.value(current.state.winner,current.state.turn):current.cachedValue??await expand(current);check();for(let p=path.length-1;p>=0;p--){path[p].visits++;path[p].total+=value;value=-value;}diagnostics.simulations++;
 }
 check();const choices=(root.children||[]).slice().sort((a,b)=>b.visits-a.visits||b.prior-a.prior||a.tie-b.tie);return result(choices[0]?.move||roots[0].move);
}
return {VERSION,critical,choose};
});
