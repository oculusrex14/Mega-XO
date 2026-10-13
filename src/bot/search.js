/* Experimental bounded alpha-beta/UCT search. No authority outside local suggestions. */
(function(root,factory){const api=factory(typeof module==='object'?require('./board.js'):root.MegaBotBoard,typeof module==='object'?require('./contracts.js'):root.MegaBotContract);if(typeof module==='object')module.exports=api;else root.MegaBotSearch=api;})(globalThis,(B,C)=>{
'use strict';
const VERSION='search-v1-experimental';
const PROFILES=Object.freeze({Beginner:{ms:0,nodes:0,depth:0,tolerance:0,error:1},Easy:{ms:8,nodes:200,depth:1,tolerance:30,error:.2},Medium:{ms:55,nodes:18000,depth:4,tolerance:8,error:0},Hard:{ms:140,nodes:100000,depth:8,tolerance:0,error:0},Expert:{ms:320,nodes:350000,depth:12,tolerance:0,error:0}});
const STOP={};
function limits(options={}){const p=PROFILES[options.difficulty||'Expert'];if(!p)throw Error('UNSUPPORTED_DIFFICULTY');const finite=(v,f)=>Number.isFinite(v)?v:f;return {...p,ms:Math.max(0,Math.min(600000,finite(options.budgetMs,p.ms))),nodes:Math.max(1,Math.min(50000000,Math.floor(finite(options.nodeBudget,p.nodes)))),depth:Math.max(0,Math.min(20,Math.floor(finite(options.maxDepth,p.depth))))};}
function ordered(t,rng){
 const side=t.turn,other=3-side,ownMarks=side===1?t.x:t.o,otherMarks=side===1?t.o:t.x;
 const oppMacroThreats=B.threats(side===1?t.mo:t.mx,(side===1?t.mx:t.mo)|t.md),rows=[];
 for(const action of B.legal(t)){
  const b=Math.floor(action/9),c=action%9,previous=t.mini[b];
  const oppThreatsBefore=B.threats(otherMarks[b],ownMarks[b]),blockedOppMini=(oppThreatsBefore&(1<<c))!==0;
  const u=B.apply(t,action),wins=t.winner===side,unsafe=!t.winner&&B.immediateMega(t).length>0;
  let tactScore=0;
  if(wins)tactScore+=2000000;
  else if(unsafe)tactScore-=2000000;
  else{
   if((oppMacroThreats&(1<<b))&&blockedOppMini)tactScore+=50000;
   if(t.mini[b]===side&&!previous)tactScore+=300;
   else if(blockedOppMini)tactScore+=80;
   if(t.mini[b]===0){const threatsNow=B.threats(ownMarks[b],otherMarks[b]),count=B.POP[threatsNow];if(count>=2)tactScore+=120;else if(count===1)tactScore+=40;}
   if(t.mini[c]!==0)tactScore-=30;
   else{const oppDestThreats=B.threats(otherMarks[c],ownMarks[c]);if(oppDestThreats!==0)tactScore-=150;else tactScore+=25;}
  }
  const score=-B.evaluate(t)+tactScore;rows.push({action,score,wins,unsafe,tie:rng()});B.unapply(t,u);
 }
 return rows.sort((a,b)=>b.score-a.score||a.tie-b.tie);
}
function rootChoices(t,rng){const rows=ordered(t,rng),wins=rows.filter(x=>x.wins);if(wins.length)return wins;const safe=rows.filter(x=>!x.unsafe);return safe.length?safe:rows;}
function choose(state,options={}){const cfg=limits(options),seed=Number(options.seed)>>>0,rng=C.seeded(seed),clock=options.clock||(()=>performance.now()),start=clock(),end=start+cfg.ms,t=B.fromCanonical(state),all=B.legal(t);
 const info={...C.diagnostics({difficulty:options.difficulty||'Expert',seed,budgetMs:cfg.ms}),engineVersion:VERSION,nodes:0,completedDepth:0,elapsedMs:0,tableEntries:0,reason:'completed',rootScores:[]};
 info.thinkingBudget.nodeBudget=cfg.nodes;info.thinkingBudget.maxDepth=cfg.depth;
 const finish=(action)=>{info.elapsedMs=clock()-start;return {move:action===undefined?null:C.assertMove(state,B.move(action)),gameId:options.gameId,revision:options.revision??state.moves.length,diagnostics:info};};
 if(!all.length)return finish();if(options.signal?.aborted){info.reason='cancelled';return finish(all[0]);}
 if(options.difficulty==='Beginner')return finish(all[Math.floor(rng()*all.length)]);
 const roots=rootChoices(t,rng);let best=roots[0].action;if(roots[0].wins){info.reason='forced-mega-win';return finish(roots[Math.floor(rng()*roots.length)].action);}
 if(options.difficulty==='Easy'&&rng()<cfg.error)return finish(roots[Math.floor(rng()*roots.length)].action);
 // A fresh verified-key table per request prevents cross-game/model contamination.
 const table=new Map(),maxEntries=16384;
 const check=()=>{if(info.nodes>=cfg.nodes||clock()>=end||options.signal?.aborted)throw STOP;};
 function visit(depth,alpha,beta){info.nodes++;if((info.nodes&31)===0||info.nodes>=cfg.nodes)check();if(t.winner)return B.evaluate(t);
  if(depth===0){const win=B.immediateMega(t);if(win.length)return 1000000;return B.evaluate(t);}
  const k=B.key(t),cached=table.get(k);
  if(cached&&cached.depth>=depth){if(cached.flag==='exact')return cached.score;if(cached.flag==='lower')alpha=Math.max(alpha,cached.score);else beta=Math.min(beta,cached.score);if(alpha>=beta)return cached.score;}
  const alphaStart=alpha,betaStart=beta;
  const moves=ordered(t,rng);if(cached){const at=moves.findIndex(x=>x.action===cached.action);if(at>0)moves.unshift(...moves.splice(at,1));}
  let score=-Infinity,action=moves[0].action;
  for(const row of moves){const u=B.apply(t,row.action);let value;try{value=-visit(depth-1,-beta,-alpha);}finally{B.unapply(t,u);}if(value>score){score=value;action=row.action;}alpha=Math.max(alpha,value);if(alpha>=beta)break;}
  if(table.size>=maxEntries&&!table.has(k))table.delete(table.keys().next().value);
  table.set(k,{depth,score,action,flag:score<=alphaStart?'upper':score>=betaStart?'lower':'exact'});return score;
 }
 for(let depth=1;depth<=cfg.depth;depth++){const completed=[];try{for(const row of roots){check();const u=B.apply(t,row.action);let score;try{score=-visit(depth-1,-Infinity,Infinity);}finally{B.unapply(t,u);}completed.push({action:row.action,score});}
   const top=Math.max(...completed.map(x=>x.score));const equivalent=completed.filter(x=>x.score>=top-cfg.tolerance);best=equivalent[Math.floor(rng()*equivalent.length)].action;info.completedDepth=depth;info.rootScores=completed;roots.sort((a,b)=>completed.find(x=>x.action===b.action).score-completed.find(x=>x.action===a.action).score);if(top>=1000000)break;
  }catch(e){if(e!==STOP)throw e;info.reason=options.signal?.aborted?'cancelled':'budget';break;}}
 info.tableEntries=table.size;return finish(best);
}
// UCT baseline for training-data experiments, not a promoted replacement by label.
function mcts(state,options={}){const cfg=limits(options),rng=C.seeded(options.seed||0),clock=options.clock||(()=>performance.now()),start=clock(),end=start+cfg.ms,source=B.fromCanonical(state),roots=rootChoices(source,rng),policy=Array(81).fill(0);
 if(!roots.length)return {move:null,policy,diagnostics:{engineVersion:VERSION,visits:0}};
 if(roots[0].wins){const a=roots[Math.floor(rng()*roots.length)].action;policy[a]=1;return {move:C.assertMove(state,B.move(a)),policy,diagnostics:{engineVersion:VERSION,visits:1,reason:'forced-mega-win'}};}
 if(options.signal?.aborted){const a=roots[0].action;policy[a]=1;return {move:C.assertMove(state,B.move(a)),policy,diagnostics:{engineVersion:VERSION,visits:0,reason:'cancelled'}};}
 const node=(t,actions)=>({turn:t.turn,visits:0,value:0,children:[],pending:(actions||B.legal(t)).map(a=>({a,r:rng()})).sort((a,b)=>a.r-b.r).map(x=>x.a)}),root=node(source,roots.map(x=>x.action));let visits=0;
 const cap=Math.max(1,Math.min(50000,Number.isInteger(options.simulations)?options.simulations:800));
 for(let i=0;i<cap&&clock()<end&&!options.signal?.aborted;i++){const t=B.clone(source),path=[root];let n=root;
  while(!t.winner&&!n.pending.length&&n.children.length){let selected=null,best=-Infinity;for(const child of n.children){const score=child.visits?-child.value/child.visits+1.414*Math.sqrt(Math.log(n.visits+1)/child.visits):Infinity;if(score>best){best=score;selected=child;}}B.apply(t,selected.action);n=selected;path.push(n);}
  if(!t.winner&&n.pending.length){const a=n.pending.pop();B.apply(t,a);const child=node(t);child.action=a;n.children.push(child);n=child;path.push(n);}
  const leafPlayer=t.turn;let aborted=false;
  for(let ply=0;!t.winner;ply++){if((ply&7)===0&&(clock()>=end||options.signal?.aborted)){aborted=true;break;}const forced=B.immediateMega(t),moves=forced.length?forced:B.legal(t);B.apply(t,moves[Math.floor(rng()*moves.length)]);}
  if(aborted)break;
  let value=t.winner===3?0:t.winner===leafPlayer?1:-1;for(let j=path.length-1;j>=0;j--){path[j].visits++;path[j].value+=value;value=-value;}visits++;
 }
 for(const child of root.children)policy[child.action]=child.visits;
 let action=roots[0].action,best=-1;for(const child of root.children)if(child.visits>best){best=child.visits;action=child.action;}
 const total=policy.reduce((a,b)=>a+b,0);if(total)for(let i=0;i<81;i++)policy[i]/=total;else policy[action]=1;
 const reason=options.signal?.aborted?'cancelled':clock()>=end?'budget':'bounded-uct';
 return {move:C.assertMove(state,B.move(action)),policy,gameId:options.gameId,revision:options.revision??state.moves.length,diagnostics:{engineVersion:VERSION,visits,elapsedMs:clock()-start,reason}};
}
return {VERSION,PROFILES,choose,mcts,rootChoices};
});
