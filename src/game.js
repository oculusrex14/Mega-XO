/* Pure rules and offline AI. Shared by the UI, tests and future authority. */
(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.MegaGame=api;})(globalThis,()=>{
'use strict';
const LINES=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const NAMES=['Top left','Top centre','Top right','Middle left','Centre','Middle right','Bottom left','Bottom centre','Bottom right'];
const LEVELS=['Beginner','Easy','Medium','Hard','Expert'];
function create(first='X'){if(!['X','O'].includes(first))throw Error('INVALID_PLAYER');return {board:Array.from({length:9},()=>Array(9).fill(null)),mini:Array(9).fill(null),turn:first,required:null,winner:null,line:null,moves:[]};}
function winner(a){for(const l of LINES)if(['X','O'].includes(a[l[0]])&&l.every(i=>a[i]===a[l[0]]))return {player:a[l[0]],line:l};return null;}
function legal(s){if(s.winner)return [];const out=[];for(let b=0;b<9;b++)if(!s.mini[b]&&(s.required===null||s.mini[s.required]||s.required===b))for(let c=0;c<9;c++)if(!s.board[b][c])out.push({b,c});return out;}
function apply(s,m){
 if(!m||!Number.isInteger(m.b)||!Number.isInteger(m.c)||m.b<0||m.b>8||m.c<0||m.c>8||!legal(s).some(x=>x.b===m.b&&x.c===m.c))throw Error('ILLEGAL_MOVE');
 return step(s,m);
}
function step(s,m){
 const n={...s,board:s.board.map(a=>a.slice()),mini:s.mini.slice(),moves:s.moves.concat({b:m.b,c:m.c,player:s.turn})};
 n.board[m.b][m.c]=s.turn;const local=winner(n.board[m.b]);
 if(local)n.mini[m.b]=local.player;else if(n.board[m.b].every(Boolean))n.mini[m.b]='DRAW';
 const big=winner(n.mini);if(big){n.winner=big.player;n.line=big.line;}else if(n.mini.every(Boolean))n.winner='DRAW';
 n.required=n.mini[m.c]?null:m.c;n.turn=s.turn==='X'?'O':'X';return n;
}
function potential(a,p){let v=0;for(const l of LINES){const other=l.some(i=>a[i]&&a[i]!==p);if(!other)v+=[0,3,22,300][l.filter(i=>a[i]===p).length];}return v;}
function evaluate(s,p){if(s.winner)return s.winner==='DRAW'?0:s.winner===p?1000000:-1000000;const o=p==='X'?'O':'X';let v=0;
 for(let i=0;i<9;i++){const w=i===4?1.25:[0,2,6,8].includes(i)?1.1:1;v+=(s.mini[i]===p?180:s.mini[i]===o?-180:!s.mini[i]?(potential(s.board[i],p)-potential(s.board[i],o))*2:0)*w;}
 for(const l of LINES){if(!l.some(i=>s.mini[i]&&s.mini[i]!==p))v+=[0,35,320,1000000][l.filter(i=>s.mini[i]===p).length];if(!l.some(i=>s.mini[i]&&s.mini[i]!==o))v-=[0,35,320,1000000][l.filter(i=>s.mini[i]===o).length];}
 return v+(s.required===null?(s.turn===p?20:-20):0);
}
function order(s,m,p){const n=step(s,m);let v=evaluate(n,p);if(n.winner)return v;if(n.mini[m.b]===p)v+=150;v+=m.c===4?4:0;return v;}
/* Iterative deepening, no arbitrary removal of legal moves. A time/node budget keeps input responsive. */
/* `clock` is the injected monotonic time source used for the search budget. Its default keeps the
   original browser/node reading, so existing callers and the shipped client behave identically. */
function choose(s,level='Medium',rng=Math.random,{clock=()=>typeof performance!=='undefined'?performance.now():Date.now()}={}){
 const ms=legal(s);if(!ms.length)return null;const p=s.turn,o=p==='X'?'O':'X';
 if(level==='Beginner')return ms[Math.floor(rng()*ms.length)];
 if(level==='Easy'){
  const win=ms.find(m=>winner(s.board[m.b].map((v,i)=>i===m.c?p:v)));
  if(win)return win;
  const block=ms.find(m=>winner(s.board[m.b].map((v,i)=>i===m.c?o:v)));
  if(block&&rng()<.8)return block;return ms[Math.floor(rng()*ms.length)];
 }
 const ranked=ms.map(m=>({m,v:order(s,m,p)})).sort((a,b)=>b.v-a.v);
 if(ranked[0].v>=1000000)return ranked[0].m;
 const cfg={Medium:{depth:2,nodes:4000,ms:55},Hard:{depth:4,nodes:22000,ms:140},Expert:{depth:6,nodes:85000,ms:320}}[level]||{depth:2,nodes:4000,ms:55};
 const now=clock,end=now()+cfg.ms;
 let nodes=0,best=ranked[0].m;const STOP={};
 function search(t,d,a,b){if(++nodes>cfg.nodes||((nodes&127)===0&&now()>end))throw STOP;if(!d||t.winner)return evaluate(t,p);
  const list=legal(t).map(m=>({m,v:order(t,m,t.turn)})).sort((x,y)=>y.v-x.v);let v=t.turn===p?-Infinity:Infinity;
  for(const {m} of list){const score=search(step(t,m),d-1,a,b);if(t.turn===p){v=Math.max(v,score);a=Math.max(a,v);}else{v=Math.min(v,score);b=Math.min(b,v);}if(a>=b)break;}return v;
 }
 for(let d=1;d<=cfg.depth;d++){let candidate=best,score=-Infinity;try{for(const {m} of ranked){const v=search(step(s,m),d-1,-Infinity,Infinity);if(v>score){score=v;candidate=m;}}best=candidate;}catch(e){if(e!==STOP)throw e;break;}}
 return best;
}
return {LINES,NAMES,LEVELS,create,winner,legal,apply,evaluate,choose};
});
