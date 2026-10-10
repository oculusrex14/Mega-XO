/* Compact search adapter v1. Live state still belongs to MegaGame. */
(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.MegaBotBoard=api;})(globalThis,()=>{
'use strict';
const VERSION='bitboard-v1',FULL=511,LINES=[7,56,448,73,146,292,273,84];
const POP=new Uint8Array(512),WIN=new Uint8Array(512),THREAT=new Uint16Array(512*512);
for(let i=1;i<512;i++)POP[i]=POP[i>>1]+(i&1);
for(let i=0;i<512;i++)WIN[i]=Number(LINES.some(line=>(i&line)===line));
// Tiny local table is generated once per worker, not downloaded or trained.
for(let own=0;own<512;own++)for(let other=0;other<512;other++)if(!(own&other)){let result=0;for(const line of LINES)if(!(line&other)&&POP[line&own]===2)result|=line&~own;THREAT[own*512+other]=result;}
const code=v=>v==='X'?1:v==='O'?2:v==='DRAW'?3:0;
function fromCanonical(s){
 if(!s||!Array.isArray(s.moves)||!Array.isArray(s.board)||s.board.length!==9||!Array.isArray(s.mini)||s.mini.length!==9||!['X','O'].includes(s.turn)||!(s.required===null||Number.isInteger(s.required)&&s.required>=0&&s.required<9))throw Error('INVALID_CANONICAL_STATE');
 const t={x:new Uint16Array(9),o:new Uint16Array(9),mini:new Uint8Array(9),mx:0,mo:0,md:0,turn:code(s.turn),required:s.required===null?-1:s.required,winner:code(s.winner),ply:s.moves.length};
 for(let b=0;b<9;b++){if(!Array.isArray(s.board[b])||s.board[b].length!==9)throw Error('INVALID_CANONICAL_BOARD');for(let c=0;c<9;c++){const v=s.board[b][c];if(v==='X')t.x[b]|=1<<c;else if(v==='O')t.o[b]|=1<<c;else if(v!==null)throw Error('INVALID_CANONICAL_CELL');}if(![null,'X','O','DRAW'].includes(s.mini[b]))throw Error('INVALID_MINI_STATE');t.mini[b]=code(s.mini[b]);if(t.mini[b]===1)t.mx|=1<<b;else if(t.mini[b]===2)t.mo|=1<<b;else if(t.mini[b]===3)t.md|=1<<b;}
 if(t.required>=0&&t.mini[t.required])t.required=-1;
 return t;
}
function clone(t){return {...t,x:t.x.slice(),o:t.o.slice(),mini:t.mini.slice()};}
function legal(t){if(t.winner)return [];const out=[];for(let b=0;b<9;b++)if(!t.mini[b]&&(t.required<0||t.mini[t.required]||t.required===b)){let empty=FULL&~(t.x[b]|t.o[b]);while(empty){const bit=empty&-empty;out.push(b*9+31-Math.clz32(bit));empty^=bit;}}return out;}
function apply(t,action){const b=Math.floor(action/9),c=action%9,bit=1<<c;
 if(!Number.isInteger(action)||action<0||action>80||t.winner||t.mini[b]||((t.required>=0&&!t.mini[t.required])&&t.required!==b)||((t.x[b]|t.o[b])&bit))throw Error('ILLEGAL_SEARCH_MOVE');
 const undo={b,x:t.x[b],o:t.o[b],mini:t.mini[b],mx:t.mx,mo:t.mo,md:t.md,required:t.required,turn:t.turn,winner:t.winner,ply:t.ply};
 const marks=t.turn===1?t.x:t.o;marks[b]|=bit;
 if(WIN[marks[b]]){t.mini[b]=t.turn;if(t.turn===1)t.mx|=1<<b;else t.mo|=1<<b;}
 else if((t.x[b]|t.o[b])===FULL){t.mini[b]=3;t.md|=1<<b;}
 if(WIN[t.mx])t.winner=1;else if(WIN[t.mo])t.winner=2;else if((t.mx|t.mo|t.md)===FULL)t.winner=3;
 t.required=t.mini[c]?-1:c;t.turn=3-t.turn;t.ply++;return undo;
}
function unapply(t,u){if(!u||t.ply!==u.ply+1)throw Error('SEARCH_UNDO_ORDER');t.x[u.b]=u.x;t.o[u.b]=u.o;t.mini[u.b]=u.mini;for(const k of ['mx','mo','md','required','turn','winner','ply'])t[k]=u[k];}
// Full state verification, not an unchecked short hash. Draws/routing/turn are included.
function key(t){return VERSION+':'+[...t.x,...t.o,...t.mini,t.required,t.turn,t.winner].join(',');}
function threats(own,other){return THREAT[own*512+other];}
function immediateMega(t){if(t.winner)return [];const own=t.turn===1?t.x:t.o,other=t.turn===1?t.o:t.x,macro=threats(t.turn===1?t.mx:t.mo,(t.turn===1?t.mo:t.mx)|t.md),out=[];
 for(let b=0;b<9;b++)if(!t.mini[b]&&(macro&(1<<b))&&(t.required<0||t.required===b)){let wins=threats(own[b],other[b]);while(wins){const bit=wins&-wins;out.push(b*9+31-Math.clz32(bit));wins^=bit;}}return out;
}
function potential(own,other){let score=0;for(const line of LINES)if(!(line&other))score+=[0,3,22,300][POP[line&own]];return score;}
function evaluate(t){if(t.winner)return t.winner===3?0:t.winner===t.turn?1000000:-1000000;let score=0;
 for(let b=0;b<9;b++){const weight=b===4?1.25:([0,2,6,8].includes(b)?1.1:1);score+=(t.mini[b]===1?180:t.mini[b]===2?-180:t.mini[b]===0?(potential(t.x[b],t.o[b])-potential(t.o[b],t.x[b]))*2:0)*weight;}
 for(const line of LINES){if(!(line&(t.mo|t.md)))score+=[0,35,320,1000000][POP[line&t.mx]];if(!(line&(t.mx|t.md)))score-=[0,35,320,1000000][POP[line&t.mo]];}
 return (t.turn===1?1:-1)*Math.round(score*100)/100+(t.required<0?20:0);
}
function move(action){return {b:Math.floor(action/9),c:action%9};}
function action(m){return m.b*9+m.c;}
return {VERSION,FULL,LINES,POP,WIN,fromCanonical,clone,legal,apply,unapply,key,threats,immediateMega,evaluate,move,action};
});
