'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const G=require('../src/game.js'),R=require('../src/gameplay-rewind.js');
const play=(first,seq)=>{let s=G.create(first);for(const [b,c] of seq)s=G.apply(s,{b,c});return s;};
const clone=v=>JSON.parse(JSON.stringify(v));
function seededRandom(seed){let s=seed>>>0;return()=>{s=(Math.imul(s^s>>>15,2246822519)+0x6d2b79f5)>>>0;return (s>>>8)/2**24;};}
function randomGame(first,seed,limit=81){const r=seededRandom(seed);let s=G.create(first);const seq=[];while(!s.winner&&seq.length<limit){const ms=G.legal(s);const m=ms[Math.floor(r()*ms.length)];seq.push({b:m.b,c:m.c,player:s.turn});s=G.apply(s,m);}return {seq,state:s};}
function findGame(first,outcome,predicate,limit=200000){for(let seed=1;seed<limit;seed++){const g=randomGame(first,seed);if(g.state.winner===outcome&&predicate(g))return {...g,seed};}throw Error('fixture search failed');}
/* 20 committed plies: X then O every turn, the Bot completes Mini Boards 6-7-8 and wins the line. */
const BOT_LOSS=[[5,7],[7,0],[0,0],[0,1],[1,7],[7,1],[1,8],[8,0],[0,8],[8,1],[1,6],[6,0],[0,6],[6,1],[3,7],[7,2],[2,1],[6,2],[2,6],[8,2]];
/* The same opening with match.first==='O': the unmatched Bot opening ply stays at index 0. */
const FIRST_O=[[0,0],[0,5],[5,0],[0,7],[7,0],[0,8],[8,0],[0,4],[4,0],[0,6],[6,0],[1,6],[6,1],[1,8],[8,1],[1,7],[7,1],[3,8],[8,2],[2,0],[6,2],[2,8],[7,2]];
/* 16 plies where the Bot's last move closes the routed Mini Board, so the rewind restores the free route. */
const FREE_ROUTE=[[6,4],[4,7],[7,8],[8,7],[7,4],[4,6],[6,6],[6,5],[5,1],[1,2],[2,3],[3,7],[7,0],[0,7],[0,8],[8,6]];
/* 18 plies where the human's move claims a Mini Board that the rewind must un-claim. */
const WIN_MINI_BOARD=[[1,1],[1,6],[6,1],[1,5],[5,6],[6,3],[3,5],[5,7],[7,4],[4,3],[3,2],[2,3],[3,4],[4,0],[0,8],[8,3],[3,8],[8,0]];
const historyOf=(first,seq)=>{let h=R.createHistory(first),st=G.create(first);for(const [b,c] of seq){const rec=R.record(h,st,{b,c});h=rec.history;st=rec.state;}return {history:h,state:st};};
/* Any legal move after a rewind must still obey the engine's own routing: only the routed Mini Board
   when one is routed, and any Mini Board whose board still has an empty cell when none is routed. */
function assertRouting(state){
 const open=state.mini.map((m,i)=>!m&&state.board[i].some(c=>c===null));
 for(const m of G.legal(state))assert(open[m.b],'illegal destination '+m.b);
}
test('rewind removes exactly the human/Bot pair and rebuilds by canonical replay',()=>{
 const state=play('X',BOT_LOSS);
 assert.equal(state.winner,'O');
 const before=clone(state),result=R.rewind(state,{mode:'bot',first:'X',reason:'line'});
 assert.equal(result.ok,true,result.reason);
 assert.equal(result.plies,18);
 assert.equal(result.state.moves.length,18);
 assert.equal(result.state.turn,'X');
 assert.equal(result.state.winner,null);
 assert.deepEqual(result.pair,{human:{b:2,c:6},bot:{b:8,c:2},index:18});
 assert.deepEqual(result.removed.moves,[{b:2,c:6,player:'X'},{b:8,c:2,player:'O'}]);
 assert.deepEqual(result.state,R.rebuild('X',BOT_LOSS.slice(0,18).map(([b,c])=>({b,c}))).state);
 assert.equal(R.equal(result.state,play('X',BOT_LOSS.slice(0,18))),true);
 /* The terminal position never changed and the winning line is only in the removed branch. */
 assert.deepEqual(state,before);
 assert.equal(state.winner,'O');
 assert.equal(result.state.mini[8],null);
 assert.deepEqual(result.removed.state.winner,'O');
 assert.deepEqual(result.removed.state.line,state.line);
});
test('the removed Bot reply is not removed as a whole Mini Board',()=>{
 const state=play('X',BOT_LOSS);
 const result=R.rewind(state,{mode:'bot',first:'X',reason:'line'});
 /* Mini Board 8 held only the winning three-in-a-row; the pair removal takes one cell from it,
    while Mini Boards 6 and 7 stay claimed by the Bot. */
 assert.equal(result.state.board[8].filter(Boolean).length,2);
 assert.equal(result.state.mini[6],'O');
 assert.equal(result.state.mini[7],'O');
 assert.equal(result.state.mini[8],null);
 assert.equal(result.state.required,2);
 assert.equal(result.state.moves.filter(m=>m.player==='O').length,9);
});
test('legal routing and the free route are restored',()=>{
 const routed=play('X',FREE_ROUTE);
 assert.equal(routed.winner,null);
 assert.equal(routed.required,6);
 assert.equal(G.legal(routed).length,6);
 const restored=R.rewind(routed,{mode:'bot',first:'X'});
 assert.equal(restored.ok,true,restored.reason);
 assert.equal(restored.state.required,null);
 assert.equal(restored.state.turn,'X');
 /* Removing the Bot's closing move re-opens Mini Board 8 and drops the forced destination. */
 assert.equal(restored.state.mini[8],null);
 assert.equal(restored.state.board[8].filter(Boolean).length,1);
 assert.equal(G.legal(restored.state).length,61);
 assertRouting(restored.state);
 assert.equal(restored.state.required,null);
});
test('a Mini Board claimed by the removed human move is restored unclaimed',()=>{
 const state=play('X',WIN_MINI_BOARD);
 assert.equal(state.winner,null);
 assert.equal(state.mini[3],'X');
 assert.equal(state.required,0);
 const result=R.rewind(state,{mode:'bot',first:'X'});
 assert.equal(result.ok,true,result.reason);
 assert.equal(result.state.mini[3],null);
 assert.equal(result.state.board[3].filter(Boolean).length,3);
 assert.equal(result.state.required,3);
 assert.equal(result.state.turn,'X');
 assert.equal(G.legal(result.state).length,6);
 assertRouting(result.state);
});
test('a first-move Bot rematch keeps the unmatched opening ply and the X/O turn order',()=>{
 const state=play('O',FIRST_O);
 assert.equal(state.winner,'O');
 assert.equal(state.moves.length,23);
 assert.equal(state.moves[0].player,'O');
 assert.equal(state.moves[1].player,'X');
 const result=R.rewind(state,{mode:'bot',first:'O',reason:'line'});
 assert.equal(result.ok,true,result.reason);
 assert.equal(result.plies,21);
 assert.deepEqual(result.state.moves[0],{b:0,c:0,player:'O'});
 assert.deepEqual(result.removed.moves,[{b:2,c:8,player:'X'},{b:7,c:2,player:'O'}]);
 assert.equal(result.state.turn,'X');
 assert.equal(result.state.winner,null);
 assert.equal(R.undoEligible(state,{mode:'bot',first:'O',reason:'line',used:0,charges:2}),true);
});
test('the eight-ply threshold guards only the first press; the second charge survives shrink',()=>{
 const eight=play('X',BOT_LOSS.slice(0,8));
 assert.equal(eight.moves.length,8);
 assert.equal(R.undoEligible(eight,{mode:'bot',first:'X',used:0,charges:2}),true);
 const six=play('X',BOT_LOSS.slice(0,6));
 assert.equal(six.moves.length,6);
 assert.equal(R.undoEligible(six,{mode:'bot',first:'X',used:0,charges:2}),false);
 assert.equal(R.undoEligible(six,{mode:'bot',first:'X',used:1,charges:1}),true);
 assert.equal(R.rewind(six,{mode:'bot',first:'X',used:1,charges:1}).ok,true);
 /* Two presses are one two-charge package per Bot match, never more. */
 assert.equal(R.undoEligible(six,{mode:'bot',first:'X',used:2,charges:0}),false);
 assert.equal(R.rewind(six,{mode:'bot',first:'X',used:2,charges:0}).ok,false);
 const first=R.rewind(play('X',BOT_LOSS),{mode:'bot',first:'X',reason:'line',used:0,charges:2});
 assert.equal(first.ok,true);
 assert.equal(first.plies,18);
 const second=R.rewind(first.state,{mode:'bot',first:'X',used:1,charges:1});
 assert.equal(second.ok,true,second.reason);
 assert.equal(second.plies,16);
 assert.equal(second.state.turn,'X');
});
test('practice, online, ranked, queued, party, staked and in-flight Bot contexts refuse a rewind',()=>{
 const state=play('X',BOT_LOSS);
 for(const [k,v] of [['practice',true],['tutorial',true],['online',true],['ranked',true],['queued',true],['queue',true],['party',true],['tournament',true],['lan',true],['direct',true],['staked',true],['wager',true],['inFlight',true],['botPending',true]])
  assert.equal(R.undoEligible(state,{mode:'bot',first:'X',reason:'line',[k]:v}),false,k);
 for(const mode of ['local','casual','ranked','queue','tournament','practice'])assert.equal(R.undoEligible(state,{mode,first:'X',reason:'line'}),false,mode);
 /* An unstated mode is not permission, in eligibility or in the rewrite itself. */
 assert.equal(R.undoEligible(state,{first:'X',reason:'line'}),false);
 assert.equal(R.rewind(state,{first:'X',reason:'line'}).reason,'MODE_NOT_ELIGIBLE');
 assert.equal(R.undoEligible(state,{mode:'bot',first:'X',reason:'line',used:0,charges:0}),false);
 assert.equal(R.rewind(state,{mode:'bot',first:'X',reason:'line',charges:0}).reason,'NO_CHARGES');
 assert.equal(R.rewind(state,{mode:'bot',first:'X',reason:'line',inFlight:true}).reason,'BOT_DECISION_IN_FLIGHT');
});
test('an application match descriptor works directly; opts always wins',()=>{
 const state=play('X',BOT_LOSS);
 const match={id:'m1',state,mode:'bot',difficulty:'Medium',first:'X',practice:false,recorded:false,generation:0,revision:20,used:0,charges:2,botPending:false,reason:'line'};
 assert.equal(R.plies(match),20);
 assert.equal(R.plies(state),20);
 assert.equal(R.plies(null),0);
 assert.equal(R.undoEligible(match),true);
 assert.equal(R.undoEligible({...match,practice:true}),false);
 assert.equal(R.undoEligible({...match,botPending:true}),false);
 assert.equal(R.undoEligible(match,{practice:true}),false);
 assert.equal(R.rewind(match).plies,18);
 assert.equal(R.rewind(match).revision,21);
 assert.equal(R.rewind(match).generation,1);
 /* Without a history ledger there is no retained revision to fence against, so the caller's value
    is simply the base of the new revision. Mismatch is only detectable with a ledger. */
 assert.equal(R.rewind(match,{revision:19}).ok,true);
 assert.equal(R.rewind(match,{revision:19}).revision,20);
 const {history}=historyOf('X',BOT_LOSS);
 const withHistory=R.rewind({...match,history,generation:0,revision:20});
 assert.equal(withHistory.ok,true,withHistory.reason);
 assert.equal(withHistory.history.active,18);
 assert.equal(withHistory.history.nodes.length,21);
 assert.equal(withHistory.revision,21);
 assert.equal(withHistory.generation,1);
 assert.equal(R.rewind({...match,history,generation:0,revision:19}).reason,'STALE_REVISION');
 assert.equal(R.rewind({...match,history,generation:7,revision:20}).reason,'GENERATION_MISMATCH');
});
test('Bot loss, human win, draw and timeout are decided by the engine result, not the caller',()=>{
 const botLoss=play('X',BOT_LOSS);
 assert.equal(R.rewind(botLoss,{mode:'bot',first:'X',reason:'line'}).ok,true);
 for(const reason of ['timeout','resign','draw','unknown'])
  assert.equal(R.rewind(botLoss,{mode:'bot',first:'X',reason}).reason,'NO_UNDO_FOR_'+reason.toUpperCase());
 assert.equal(R.undoEligible(botLoss,{mode:'bot',first:'X',reason:'timeout',used:0,charges:2}),false);
 const humanWin=findGame('X','X',g=>g.seq.length>=8);
 assert.equal(humanWin.state.moves.at(-1).player,'X');
 assert.equal(R.rewind(humanWin.state,{mode:'bot',first:'X',reason:'line'}).reason,'PAIR_NOT_HUMAN_BOT');
 assert.equal(R.undoEligible(humanWin.state,{mode:'bot',first:'X',reason:'line'}),false);
 const draw=findGame('X','DRAW',g=>g.seq.length>=8&&g.seq.at(-1).player==='O');
 assert.equal(draw.state.moves.at(-2).player,'X');
 assert.equal(draw.state.moves.at(-1).player,'O');
 assert.equal(R.rewind(draw.state,{mode:'bot',first:'X',reason:'draw'}).reason,'NOT_BOT_TERMINAL');
 assert.equal(R.undoEligible(draw.state,{mode:'bot',first:'X',reason:'draw'}),false);
 /* A prefix that ends on the Bot's turn or with no removable pair is refused. */
 const onePly=play('X',[[4,4]]);
 assert.equal(R.rewind(onePly,{mode:'bot',first:'X'}).reason,'NOT_ENOUGH_PLIES');
 const botTurn=play('X',BOT_LOSS.slice(0,7));
 assert.equal(R.undoEligible(botTurn,{mode:'bot',first:'X'}),false);
});
test('a tampered ply list is refused by canonical replay instead of replayed anyway',()=>{
 const state=play('X',BOT_LOSS);
 const tampered={...state,moves:state.moves.map((m,i)=>i===3?{b:0,c:0,player:m.player}:m)};
 assert.equal(R.rewind(tampered,{mode:'bot',first:'X',reason:'line'}).reason,'ILLEGAL_REPLAY');
 const swapped={...state,moves:state.moves.map((m,i)=>i===1?{...m,player:'X'}:m)};
 assert.equal(R.rewind(swapped,{mode:'bot',first:'X',reason:'line'}).reason,'PLAYER_SEQUENCE');
 const drifted={...state,moves:state.moves.slice(0,-2)};
 assert.equal(R.rewind(drifted,{mode:'bot',first:'X',reason:'line'}).reason,'STATE_MISMATCH');
 const impossible={...state,moves:state.moves.map((m,i)=>i===5?{b:99,c:0,player:m.player}:m)};
 assert.equal(R.rewind(impossible,{mode:'bot',first:'X',reason:'line'}).reason,'INVALID_MOVE');
});
test('immutable history keeps every branch with a monotone stateVersion',()=>{
 const {history,state}=historyOf('X',BOT_LOSS);
 assert.equal(history.nodes.length,21);
 assert.equal(R.activeNode(history).stateVersion,21);
 assert.equal(history.revision,20);
 assert.deepEqual(history.nodes.map(n=>n.stateVersion),Array.from({length:21},(_,i)=>i+1));
 const first=R.rewind(state,{mode:'bot',first:'X',reason:'line',history,generation:history.generation,revision:history.revision});
 assert.equal(first.ok,true,first.reason);
 assert.equal(first.plies,18);
 assert.equal(first.history.active,18);
 assert.equal(R.activeNode(first.history).state.moves.length,18);
 assert.equal(first.history.nodes.length,21);
 assert.equal(first.history.nextStateVersion,22);
 assert.equal(first.history.generation,1);
 assert.equal(first.history.revision,21);
 assert.equal(first.removed.branch,'b1');
 assert.equal(first.removed.from,20);
 assert.equal(first.removed.to,19);
 assert.deepEqual(first.removed.stateVersions,[20,21]);
 assert.equal(first.removed.state.winner,'O');
 /* The superseded positions stay reachable: the abandoned branch is reported, not erased. */
 assert.deepEqual(R.path(first.history).map(n=>n.stateVersion),[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19]);
 const second=R.rewind(first.state,{mode:'bot',first:'X',used:1,charges:1,history:first.history,generation:first.history.generation,revision:first.history.revision});
 assert.equal(second.ok,true,second.reason);
 assert.equal(second.plies,16);
 assert.equal(second.history.active,16);
 assert.equal(second.history.nodes.length,21);
 assert.equal(R.activeNode(second.history).stateVersion,17);
 assert.deepEqual(second.history.nodes.map(n=>n.stateVersion),Array.from({length:21},(_,i)=>i+1));
 assert.equal(second.history.branches.length,2);
 assert.deepEqual(second.history.branches[1].stateVersions,[18,19]);
 assert.equal(second.history.branches[0].state.moves.length,20);
 /* Older nodes still hold their own full snapshots and the source objects were never mutated. */
 assert.equal(history.nodes.length,21);
 assert.equal(history.active,20);
 assert.equal(history.branches.length,0);
 assert.equal(history.nodes[20].state.winner,'O');
 assert.equal(second.history.nodes[20].state.winner,'O');
});
test('a stale Worker revision cannot be recorded over a rewound state',()=>{
 const {history,state}=historyOf('X',BOT_LOSS);
 const first=R.rewind(state,{mode:'bot',first:'X',reason:'line',history,generation:0,revision:20});
 const stale=R.record(first.history,first.state,{b:0,c:4},{revision:20});
 assert.equal(stale.ok,false);
 assert.equal(stale.reason,'STALE_REVISION');
 assert.equal(stale.expected,21);
 const ghost=R.record(first.history,R.rebuild('X',BOT_LOSS.map(([b,c])=>({b,c}))).state,{b:0,c:4},{revision:21});
 assert.equal(ghost.ok,false);
 assert.equal(ghost.reason,'STATE_MISMATCH');
 const fresh=R.record(first.history,first.state,G.legal(first.state)[0],{revision:21});
 assert.equal(fresh.ok,true,fresh.reason);
 assert.equal(fresh.state.moves.length,19);
 assert.equal(fresh.history.revision,22);
 /* A rewind also refuses a snapshot that no longer matches the active node or the fence. */
 assert.equal(R.rewind(first.state,{mode:'bot',first:'X',used:1,charges:1,history:first.history,generation:9}).reason,'GENERATION_MISMATCH');
 assert.equal(R.rewind(first.state,{mode:'bot',first:'X',used:1,charges:1,history:first.history,revision:20}).reason,'STALE_REVISION');
 assert.equal(R.rewind(first.state,{mode:'bot',first:'O',used:1,charges:1,history:first.history}).reason,'FIRST_MISMATCH');
});
test('a history whose prefix disagrees with the snapshot is refused',()=>{
 const {history,state}=historyOf('X',BOT_LOSS);
 const wrongDepth=historyOf('X',BOT_LOSS.slice(0,18));
 assert.equal(R.rewind(state,{mode:'bot',first:'X',reason:'line',history:wrongDepth.history}).reason,'INVALID_HISTORY');
 /* A path that still links but no longer equals the retained prefix fails deep equality. */
 const corrupt={...history,nodes:history.nodes.map(n=>n.stateVersion===5?{...n,state:{...n.state,turn:n.state.turn==='X'?'O':'X'}}:n)};
 assert.equal(R.rewind(state,{mode:'bot',first:'X',reason:'line',history:corrupt}).reason,'PREFIX_MISMATCH');
 /* A dangling parent breaks the active-node walk and is refused as an unusable ledger. */
 const dangling={...history,nodes:history.nodes.filter(n=>n.stateVersion!==19)};
 assert.equal(R.rewind(state,{mode:'bot',first:'X',reason:'line',history:dangling}).reason,'INVALID_HISTORY');
});
test('a sweep of random games: every accepted rewind is a canonical human-turn prefix',()=>{
 const reasons=new Set();
 let accepted=0,refused=0;
 for(let seed=1;seed<=400;seed++){
  const game=randomGame('X',seed);
  const state=game.state;
  const result=R.rewind(state,{mode:'bot',first:'X',reason:state.winner==='O'?'line':'draw'});
  if(!result.ok){refused++;reasons.add(result.reason);continue;}
  accepted++;
  /* Exactly two plies leave, the survivor is the human's turn with real legal moves, and it is
     deep-equal to a straight canonical replay of the retained prefix. */
  assert.equal(R.plies(result.state),state.moves.length-2,seed);
  assert.equal(result.state.moves.length,state.moves.length-2);
  assert.equal(result.state.turn,'X');
  assert.equal(result.state.winner,null);
  assert.equal(result.pair.bot.b,state.moves.at(-1).b);
  assert.equal(result.pair.bot.c,state.moves.at(-1).c);
  assert.equal(result.pair.human.b,state.moves.at(-2).b);
  assert.equal(result.pair.human.c,state.moves.at(-2).c);
  assert.equal(G.legal(result.state).length>0,true);
  assertRouting(result.state);
  const canonical=R.rebuild('X',state.moves.slice(0,-2).map(m=>({b:m.b,c:m.c})));
  assert.equal(canonical.ok,true);
  assert.equal(R.equal(result.state,canonical.state),true);
  /* A legal move in the rebuilt position must be accepted by the untouched engine. */
  assert.doesNotThrow(()=>G.apply(result.state,G.legal(result.state)[0]));
 }
 assert.equal(accepted>0,true);
 assert.equal(refused>0,true);
 for(const reason of reasons)assert.equal(['PAIR_NOT_HUMAN_BOT','NOT_BOT_TERMINAL'].includes(reason),true,reason);
});
test('exports stay pure and requirable without a browser or a clock',()=>{
 const source=require('node:fs').readFileSync(require.resolve('../src/gameplay-rewind.js'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
 for(const banned of [/\bwindow\b/,/\bdocument\b/,/\blocalStorage\b/,/\bfetch\s*\(/,/\bsetTimeout\b/,/\bsetInterval\b/,/\bDate\.now\b/,/\bnavigator\b/,/\bXMLHttpRequest\b/,/\bperformance\b/])
  assert.equal(banned.test(source),false,String(banned));
 for(const name of ['rewind','plies','undoEligible','reserve','commit','release','applyPresentation'])assert.equal(typeof R[name],'function',name);
 const state=play('X',BOT_LOSS);
 const before=clone(state);
 R.rewind(state,{mode:'bot',first:'X',reason:'line'});
 R.rewind(state,{mode:'bot',first:'X',reason:'timeout'});
 R.undoEligible(state,{mode:'bot',first:'X',reason:'line'});
 assert.deepEqual(state,before);
});
