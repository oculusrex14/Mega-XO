/* V5.1 pure rewarded-power rules: full-turn rewind, immutable history, banked entitlements and
   rewarded-ad pacing. No DOM, no browser globals, no provider SDK, no network and no timers: every
   export is a pure transformation of its arguments, so the module is requirable in Node and
   replayable in tests. Rule refusals return {ok:false,reason}; malformed arguments (unknown player,
   kind or outcome) throw, matching src/game.js and src/domain.js.

   Owner decisions in force (docs/v5.1/release/OWNER-DECISIONS-AND-EXECUTION-20261014.md):
   - one successfully completed rewarded ad earns TWO Undo presses for that Bot match, at most one
     two-charge package per match; the first press needs eight plies, the second survives shrink;
   - one aggregate ceiling of ten rewarded presentations per UTC day across all reward types with
     the existing two-minute spacing; a no-fill/failed presentation consumes no slot, a shown and
     skipped ad consumes exposure and grants no item;
   - banked powers stay usable later, capacity one available entitlement per type, no silent
     expiry, and a technical failure returns its reservation;
   - no powers in ranked, direct/staked challenges, tournaments, parties or LAN;
   - reward copy promises the earned request/token for a counterable action, never an unconditional
     rewind, so this module counts requests and applied undos separately. */
(function(root,factory){const api=factory(typeof module==='object'?require('./game.js'):root.MegaGame);if(typeof module==='object')module.exports=api;else root.MegaRewind=api;})(globalThis,G=>{
'use strict';
const MINUTE=60000,DAY=86400000;
const KINDS=Object.freeze(['undo','hint','undoBlock','tacticalBlock']);
const OUTCOMES=Object.freeze(['no-fill','failed','skipped','dismissed','shown','earned']);
/* Only these outcomes put an ad on screen, so only these consume one aggregate daily slot and
   restart the two-minute gap. `no-fill` and `failed` never presented and consume nothing. */
const PRESENTED=Object.freeze(['skipped','dismissed','shown','earned']);
const POLICY=Object.freeze({
 version:'powers-1',
 rewardedDayCap:10,
 rewardedGap:2*MINUTE,
 bankCapacity:1,
 owedCapacity:1,
 seenLimit:200,
 botUndoFirstPly:8,
 botUndoCharges:2,
 botUndoPackagesPerMatch:1,
 casualInitiationsPerPlayer:3,
 casualAppliedPerMatch:1,
 hintActivations:3,
 hintDeliveries:2,
 blockActivations:3,
 blockSuccesses:2,
 maxPlies:81
});
/* Which power kinds may exist in which mode. `local` keeps the separate free/manual undo of the
   plan; it is never a rewarded-placement mode (see rewardedAllowed). */
const POWER_KINDS=Object.freeze({
 bot:Object.freeze(['undo','hint','tacticalBlock']),
 casual:Object.freeze(['undo','undoBlock']),
 local:Object.freeze(['undo'])
});
/* Modes that keep the ordinary competitive contract even when a flag looks permissive. */
const DENIED_MODES=Object.freeze(['ranked','queue','queued','direct','challenge','friend','friend-stake','staked','wager','prize','tournament','party','lan','practice','tutorial','impossible']);
const HUMAN='X',BOT='O';
const utcDay=now=>new Date(now).toISOString().slice(0,10);
/* Structural equality over the JSON-shaped engine snapshot. game.js snapshots contain only null,
   numbers, strings, arrays and plain objects, so this needs no provider or Node helper. */
function equal(a,b){
 if(a===b)return true;
 if(typeof a!=='object'||typeof b!=='object'||a===null||b===null)return Number.isNaN(a)&&Number.isNaN(b);
 if(Array.isArray(a)!==Array.isArray(b))return false;
 if(Array.isArray(a))return a.length===b.length&&a.every((v,i)=>equal(v,b[i]));
 const ka=Object.keys(a),kb=Object.keys(b);
 return ka.length===kb.length&&ka.every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]));
}
const isState=v=>!!v&&typeof v==='object'&&Array.isArray(v.moves)&&Array.isArray(v.board);
const descriptor=v=>!!v&&typeof v==='object'&&isState(v.state);
const stateOf=input=>descriptor(input)?input.state:input;
const fail=(reason,extra)=>extra?{ok:false,reason,...extra}:{ok:false,reason};
/* One normaliser for both accepted inputs: a bare engine snapshot plus opts, or an application
   match/context object whose own fields supply the defaults. opts always wins. */
function view(input,opts){
 const o=opts&&typeof opts==='object'?opts:{};
 const context=input&&typeof input==='object'&&!isState(input)?input:{};
 const read=key=>o[key]!==undefined?o[key]:context[key];
 const candidate=o.history||context.history||null;
 return {
  state:stateOf(input),
  first:['X','O'].includes(read('first'))?read('first'):HUMAN,
  mode:typeof read('mode')==='string'?read('mode'):null,
  practice:read('practice')===true,
  tutorial:read('tutorial')===true,online:read('online')===true,ranked:read('ranked')===true,
  queued:read('queued')===true||read('queue')===true,party:read('party')===true,
  tournament:read('tournament')===true,lan:read('lan')===true,direct:read('direct')===true,
  staked:read('staked')===true||read('wager')===true,
  reason:typeof read('reason')==='string'?read('reason'):null,
  botPending:read('botPending')===true||read('inFlight')===true,
  used:Number.isInteger(read('used'))?read('used'):0,
  charges:Number.isInteger(read('charges'))?read('charges'):POLICY.botUndoCharges,
  revision:read('revision'),generation:read('generation'),
  turnLimit:read('turnLimit'),turnRemaining:read('turnRemaining'),
  consentReady:read('consentReady'),adReady:read('adReady'),
  history:candidate&&candidate.version===1?candidate:null
 };
}
/* Play order comes from the pure engine's own ply log, so a first==='O' rematch keeps human X and
   Bot O exactly as match.first dictates. */
const playerAt=(first,index)=>index%2===0?first:first===HUMAN?BOT:HUMAN;
const plies=input=>{const s=stateOf(input);return isState(s)?s.moves.length:0;};
/* The removable full turn is always human X followed by bot O, so an unmatched Bot opening move at
   ply 0 and a human match-winning move can never be part of the removed pair. */
function trailingPair(state,first){
 const m=state.moves,n=m.length;
 if(n<2)return null;
 const a=m[n-2],b=m[n-1];
 if(playerAt(first,n-2)!==HUMAN||playerAt(first,n-1)!==BOT)return null;
 if(a.player&&a.player!==HUMAN||b.player&&b.player!==BOT)return null;
 if(!Number.isInteger(a.b)||!Number.isInteger(a.c)||!Number.isInteger(b.b)||!Number.isInteger(b.c))return null;
 return {human:{b:a.b,c:a.c},bot:{b:b.b,c:b.c},index:n-2};
}
/* Canonical replay. Never mutates an engine snapshot and never bends G.legal/G.apply: the only
   accepted reconstruction is G.create(first) plus one G.apply per retained {b,c} ply. */
function rebuild(first,moves,expected){
 if(!['X','O'].includes(first))throw Error('INVALID_PLAYER');
 if(!Array.isArray(moves))throw Error('INVALID_MOVES');
 let state=G.create(first);
 for(let i=0;i<moves.length;i++){
  const m=moves[i];
  if(!m||!Number.isInteger(m.b)||!Number.isInteger(m.c)||m.b<0||m.b>8||m.c<0||m.c>8)return fail('INVALID_MOVE',{ply:i});
  let next;
  try{next=G.apply(state,{b:m.b,c:m.c});}catch{return fail('ILLEGAL_REPLAY',{ply:i});}
  if(m.player&&next.moves[i].player!==m.player)return fail('PLAYER_SEQUENCE',{ply:i});
  if(expected&&expected[i]!==undefined&&!equal(next,expected[i]))return fail('PREFIX_MISMATCH',{ply:i});
  state=next;
 }
 return {ok:true,state};
}
/* --- immutable history ---------------------------------------------------------------------- */
/* Nodes are append-only. A rewind moves `active` back to an ancestor and keeps every superseded
   position, so the abandoned branch stays auditable instead of being erased. stateVersion is
   unique and monotone per created position and never reused; revision is the monotone fence the
   match stamps on every Bot request, and generation increases on every rewind. */
function createHistory(first=HUMAN,{at=0}={}){
 if(!['X','O'].includes(first))throw Error('INVALID_PLAYER');
 return {version:1,first,nodes:[{stateVersion:1,parent:null,branch:'b1',move:null,state:G.create(first),revision:0,generation:0,at}],active:0,nextStateVersion:2,nextBranch:2,revision:0,generation:0,branches:[]};
}
function activeNode(history){return history&&Array.isArray(history.nodes)?history.nodes[history.active]||null:null;}
function path(history){
 const index=new Map(history.nodes.map(n=>[n.stateVersion,n]));
 const out=[];let node=activeNode(history);
 while(node){out.unshift(node);node=node.parent===null?null:index.get(node.parent)||null;}
 return out;
}
/* Appends one committed ply. `revision` fences a stale Worker/Neural result: a reply computed at an
   older revision is refused instead of writing a ghost move over a rewind. */
function record(history,state,move,{at=0,revision}={}){
 if(!history||history.version!==1||!Array.isArray(history.nodes))return fail('INVALID_HISTORY');
 const active=activeNode(history);
 if(!active)return fail('INVALID_HISTORY');
 if(revision!==undefined&&revision!==history.revision)return fail('STALE_REVISION',{expected:history.revision});
 if(!equal(active.state,state))return fail('STATE_MISMATCH');
 if(!move||!Number.isInteger(move.b)||!Number.isInteger(move.c)||move.b<0||move.b>8||move.c<0||move.c>8)return fail('INVALID_MOVE');
 let next;
 try{next=G.apply(state,{b:move.b,c:move.c});}catch{return fail('ILLEGAL_MOVE');}
 const fork=history.nodes.some(n=>n.parent===active.stateVersion);
 const node={stateVersion:history.nextStateVersion,parent:active.stateVersion,branch:fork?'b'+history.nextBranch:active.branch,move:{b:move.b,c:move.c,player:next.moves[next.moves.length-1].player},state:next,revision:history.revision+1,generation:history.generation,at};
 return {ok:true,node,state:next,history:{...history,nodes:[...history.nodes,node],active:history.nodes.length,nextStateVersion:history.nextStateVersion+1,nextBranch:fork?history.nextBranch+1:history.nextBranch,revision:node.revision}};
}
/* Eligibility: eligible Bot match, no practice/tutorial/online/ranked/queued/party/direct/staked
   context, no concurrent in-flight Bot decision, one two-charge package per match, and eight
   committed plies before the FIRST press. The second charge only needs a remaining charge, so it
   survives the shrunken board. */
/* An unstated mode is not permission: only an explicit `bot` context may rewind. */
function blockers(c){
 if(c.mode!=='bot')return 'MODE_NOT_ELIGIBLE';
 if(c.practice||c.tutorial||c.online||c.ranked||c.queued||c.party||c.tournament||c.lan||c.direct||c.staked)return 'MODE_NOT_ELIGIBLE';
 if(c.botPending)return 'BOT_DECISION_IN_FLIGHT';
 if(!(c.charges>=1))return 'NO_CHARGES';
 if(c.used>=POLICY.botUndoPackagesPerMatch*POLICY.botUndoCharges)return 'CHARGE_CAP';
 return null;
}
function undoEligible(input,opts){
 const c=view(input,opts),s=c.state;
 if(!isState(s))return false;
 if(blockers(c))return false;
 if(s.moves.length<2)return false;
 if(c.used===0&&s.moves.length<POLICY.botUndoFirstPly)return false;
 if(s.winner){
  if(s.winner!==BOT)return false;
  if(c.reason!=='line')return false;
 }else if(s.turn!==HUMAN)return false;
 return trailingPair(s,c.first)!==null;
}
/* Full-turn rollback. Removes exactly the human X move and the Bot O reply, rebuilds by canonical
   replay, and reports a reason instead of guessing when anything disagrees. */
function rewind(input,opts){
 const c=view(input,opts),s=c.state;
 if(!isState(s))return fail('INVALID_STATE');
 const blocked=blockers(c);
 if(blocked)return fail(blocked);
 if(s.moves.length>POLICY.maxPlies)return fail('PLY_OVERFLOW');
 const history=c.history;
 if(history&&history.first!==c.first)return fail('FIRST_MISMATCH');
 const active=history?activeNode(history):null;
 if(history&&!active)return fail('INVALID_HISTORY');
 const chain=history?path(history):null;
 /* A dangling parent or a path of the wrong depth means the ledger can no longer vouch for the
    snapshot, so the rewind is refused rather than replayed from a partial history. */
 if(history&&chain.length!==s.moves.length+1)return fail(chain.length<s.moves.length+1?'INVALID_HISTORY':'HISTORY_LENGTH_MISMATCH');
 if(active&&!equal(active.state,s))return fail('STATE_MISMATCH');
 if(c.generation!==undefined&&active&&c.generation!==history.generation)return fail('GENERATION_MISMATCH',{expected:history.generation});
 if(c.revision!==undefined&&active&&c.revision!==history.revision)return fail('STALE_REVISION',{expected:history.revision});
 const pair=trailingPair(s,c.first);
 if(!pair)return fail(s.moves.length<2?'NOT_ENOUGH_PLIES':'PAIR_NOT_HUMAN_BOT');
 if(s.winner){
  if(s.winner!==BOT)return fail('NOT_BOT_TERMINAL');
  /* A timed or resigned forfeit is never forgiven and a draw is nobody's mistake to rewind. */
  if(c.reason!=='line')return fail('NO_UNDO_FOR_'+String(c.reason||'UNKNOWN').toUpperCase());
 }
 /* The caller's snapshot must be reproducible from its own retained ply list. */
 const full=rebuild(c.first,s.moves,null);
 if(!full.ok)return full;
 if(!equal(full.state,s))return fail('STATE_MISMATCH');
 let expected=null;
 if(history)expected=chain.slice(1,s.moves.length-1).map(n=>n.state);
 const kept=s.moves.slice(0,s.moves.length-2);
 const result=rebuild(c.first,kept,expected);
 if(!result.ok)return result;
 const next=result.state;
 if(next.moves.length!==kept.length)return fail('PLY_COUNT_MISMATCH');
 if(next.winner)return fail('PREFIX_STILL_TERMINAL');
 if(next.turn!==HUMAN)return fail('PREFIX_NOT_HUMAN_TURN');
 if(!G.legal(next).length)return fail('NO_LEGAL_REPLAY');
 let nextHistory=null,removed;
 if(history){
  const target=chain[chain.length-3],dropped=chain.slice(-2);
  const revision=history.revision+1,generation=history.generation+1;
  removed={branch:activeNode(history).branch,from:dropped[0].stateVersion,to:target.stateVersion,
   stateVersions:dropped.map(n=>n.stateVersion),
   moves:dropped.map(n=>({b:n.move.b,c:n.move.c,player:n.move.player})),
   state:dropped[dropped.length-1].state,winner:s.winner||null,reason:c.reason||null};
  nextHistory={...history,active:history.nodes.indexOf(target),revision,generation,branches:[...history.branches,removed]};
 }else{
  removed={branch:null,from:null,to:null,stateVersions:[],
   moves:[{b:pair.human.b,c:pair.human.c,player:HUMAN},{b:pair.bot.b,c:pair.bot.c,player:BOT}],
   state:s,winner:s.winner||null,reason:c.reason||null};
 }
 return {ok:true,state:next,plies:next.moves.length,pair,last:next.moves.length?{b:next.moves[next.moves.length-1].b,c:next.moves[next.moves.length-1].c}:null,
  removed,history:nextHistory,
  revision:nextHistory?nextHistory.revision:(Number.isFinite(c.revision)?c.revision:0)+1,
  generation:nextHistory?nextHistory.generation:(Number.isFinite(c.generation)?c.generation:0)+1,
  timer:{turnLimit:Number.isFinite(c.turnLimit)?c.turnLimit:null,turnRemaining:Number.isFinite(c.turnRemaining)?c.turnRemaining:null}};
}
/* --- banked entitlements -------------------------------------------------------------------- */
/* One available entitlement per type, a separate reserved bucket, and an `owed` obligation for a
   reward that arrived when the bank was full (a concurrent callback race) so a completed ad is
   never silently lost. A reservation leaves the reserved bucket only through commit or release;
   nothing here carries a timestamp, so nothing expires silently. `id` is the attempt/transaction
   identifier the provider callback and the retry share: replaying it is idempotent, which is what
   stops a retried callback from double-granting or consuming a second slot. */
function freshInventory(){
 return {version:1,counter:0,seen:[],
  available:{undo:0,hint:0,undoBlock:0,tacticalBlock:0},
  reserved:{undo:null,hint:null,undoBlock:null,tacticalBlock:null},
  owed:{undo:0,hint:0,undoBlock:0,tacticalBlock:0},
  consumed:{undo:0,hint:0,undoBlock:0,tacticalBlock:0}};
}
function requireKind(kind){if(!KINDS.includes(kind))throw Error('INVALID_KIND');return kind;}
const banked=(inventory,kind)=>{requireKind(kind);return inventory.available[kind]>=POLICY.bankCapacity;};
const isId=id=>typeof id==='string'&&id.length>0&&id.length<=160;
function bank(inventory,kind,{id=null}={}){
 requireKind(kind);
 if(id!==null&&!isId(id))throw Error('INVALID_ATTEMPT');
 if(id!==null&&inventory.seen.includes(id))return {ok:true,duplicate:true,grant:'duplicate',inventory};
 const seen=id===null?inventory.seen:[...inventory.seen,id].slice(-POLICY.seenLimit);
 if(inventory.available[kind]<POLICY.bankCapacity){
  return {ok:true,duplicate:false,grant:'available',credit:1,inventory:{...inventory,seen,available:{...inventory.available,[kind]:inventory.available[kind]+1}}};
 }
 /* Never drop a promised item: hold it as an obligation until a slot frees up. */
 if(inventory.owed[kind]<POLICY.owedCapacity){
  return {ok:true,duplicate:false,grant:'owed',credit:0,inventory:{...inventory,seen,owed:{...inventory.owed,[kind]:inventory.owed[kind]+1}}};
 }
 return fail('BANK_FULL',{duplicate:false,credit:0});
}
function reserve(inventory,kind,{id=null}={}){
 requireKind(kind);
 if(id!==null&&!isId(id))throw Error('INVALID_ATTEMPT');
 const held=inventory.reserved[kind];
 if(held)return held.id===id&&id!==null?{ok:true,duplicate:true,token:held.token,inventory}:fail('ALREADY_RESERVED',{token:held.token});
 if(inventory.available[kind]<1)return fail('NO_ENTITLEMENT');
 const token=kind+'#'+(inventory.counter+1);
 return {ok:true,duplicate:false,token,inventory:{...inventory,counter:inventory.counter+1,
  available:{...inventory.available,[kind]:inventory.available[kind]-1},
  reserved:{...inventory.reserved,[kind]:{token,id}}}};
}
function settle(inventory,kind,mode,opts={}){
 const {id=null,token=null}=opts;
 requireKind(kind);
 const held=inventory.reserved[kind];
 if(!held)return fail('NO_RESERVATION');
 if(id!==null&&held.id!==null&&held.id!==id)return fail('RESERVATION_MISMATCH');
 if(token!==null&&held.token!==token)return fail('RESERVATION_MISMATCH');
 const reserved={...inventory.reserved};reserved[kind]=null;
 const available={...inventory.available},consumed={...inventory.consumed},owed={...inventory.owed};
 let honoured=false;
 if(mode==='commit'){
  consumed[kind]=consumed[kind]+1;
  /* Committing frees the slot, which is the moment an owed reward becomes available. */
  if(owed[kind]>0){owed[kind]=owed[kind]-1;available[kind]=available[kind]+1;honoured=true;}
 }else if(mode==='release'){
  available[kind]=available[kind]+1;
 }else{
  throw Error('INVALID_SETTLEMENT');
 }
 return {ok:true,duplicate:false,token:held.token,honoured,inventory:{...inventory,available,reserved,consumed,owed}};
}
const commit=(inventory,kind,opts)=>settle(inventory,kind,'commit',opts);
const release=(inventory,kind,opts)=>settle(inventory,kind,'release',opts);
/* --- per-match power counters ---------------------------------------------------------------- */
function freshMatchPowers(){
 const side=()=>({activations:0,delivered:0,blocked:0});
 return {version:1,
  botUndo:{packages:0,charges:0,presses:0},
  casualUndo:{initiations:{X:0,O:0},requests:{X:null,O:null},applied:0,appliedBy:null,blocked:{X:0,O:0}},
  hint:{X:side(),O:side()},
  tacticalBlock:{X:side(),O:side()},
  pending:{hint:null,block:null}};
}
function requireSide(player){if(![HUMAN,BOT].includes(player))throw Error('INVALID_PLAYER');return player;}
/* One two-charge package per Bot match, redeemed once from a banked earned entitlement. */
function grantBotUndoPackage(powers){
 if(powers.botUndo.packages>=POLICY.botUndoPackagesPerMatch)return fail('PACKAGE_ALREADY_GRANTED');
 return {ok:true,charges:POLICY.botUndoCharges,powers:{...powers,botUndo:{...powers.botUndo,packages:powers.botUndo.packages+1,charges:POLICY.botUndoCharges}}};
}
function pressBotUndo(powers){
 if(powers.botUndo.charges<1)return fail('NO_CHARGES');
 return {ok:true,charges:powers.botUndo.charges-1,powers:{...powers,botUndo:{...powers.botUndo,charges:powers.botUndo.charges-1,presses:powers.botUndo.presses+1}}};
}
/* Three initiations per player, one successfully applied Undo for the whole Casual match. A
   counter is a separately earned Undo Block, so a blocked request is not an applied undo. */
function casualInitiate(powers,player){
 requireSide(player);
 if(powers.casualUndo.requests[player])return fail('REQUEST_PENDING');
 if(powers.casualUndo.initiations[player]>=POLICY.casualInitiationsPerPlayer)return fail('INITIATION_CAP');
 if(powers.casualUndo.applied>=POLICY.casualAppliedPerMatch)return fail('UNDO_ALREADY_APPLIED');
 const sequence=powers.casualUndo.initiations[player]+1;
 const request={id:player+':'+sequence,player,blocked:false};
 return {ok:true,request,powers:{...powers,casualUndo:{...powers.casualUndo,
  initiations:{...powers.casualUndo.initiations,[player]:sequence},
  requests:{...powers.casualUndo.requests,[player]:request}}}};
}
/* Resolving needs the matching earned token ('undo' for the request, 'undoBlock' for the counter),
   so a client cannot apply a rewind it has not earned and a block cannot stand in for a request. */
function casualResolve(powers,{player,blocked=false,token=null}={}){
 requireSide(player);
 const request=powers.casualUndo.requests[player];
 if(!request)return fail('NO_REQUEST');
 if(blocked){
  if(token!=='undoBlock')return fail('BLOCK_TOKEN_REQUIRED');
  return {ok:true,blocked:true,applied:false,request,powers:{...powers,casualUndo:{...powers.casualUndo,
   requests:{...powers.casualUndo.requests,[player]:null},
   blocked:{...powers.casualUndo.blocked,[player]:powers.casualUndo.blocked[player]+1}}}};
 }
 if(token!=='undo')return fail('REQUEST_TOKEN_REQUIRED');
 if(powers.casualUndo.applied>=POLICY.casualAppliedPerMatch)return fail('UNDO_ALREADY_APPLIED');
 return {ok:true,blocked:false,applied:true,request,powers:{...powers,casualUndo:{...powers.casualUndo,
  requests:{...powers.casualUndo.requests,[player]:null},
  applied:powers.casualUndo.applied+1,appliedBy:player}}};
}
/* Two delivered hints per player per game with up to three activations, and two successful blocks
   per player per game with up to three activations. The recommendation stays hidden while a
   Tactical Block window is unresolved, so a blocked hint is never revealed early; a request that
   could no longer be revealed or blocked is refused rather than stranding the pending slot. */
function hintRequest(powers,player){
 requireSide(player);
 if(powers.pending.hint)return fail('HINT_PENDING');
 if(powers.hint[player].activations>=POLICY.hintActivations)return fail('ACTIVATION_CAP');
 if(powers.hint[player].delivered>=POLICY.hintDeliveries)return fail('DELIVERY_CAP');
 const hint={id:player+':'+(powers.hint[player].activations+1),player,blocked:false};
 return {ok:true,hint,powers:{...powers,pending:{...powers.pending,hint},
  hint:{...powers.hint,[player]:{...powers.hint[player],activations:powers.hint[player].activations+1}}}};
}
function hintBlockAttempt(powers,player){
 requireSide(player);
 if(!powers.pending.hint)return fail('NO_HINT_PENDING');
 if(powers.pending.block)return fail('BLOCK_PENDING');
 if(powers.tacticalBlock[player].activations>=POLICY.blockActivations)return fail('ACTIVATION_CAP');
 if(powers.tacticalBlock[player].delivered>=POLICY.blockSuccesses)return fail('BLOCK_CAP');
 const block={id:'block:'+(powers.tacticalBlock[player].activations+1),blocker:player,hintId:powers.pending.hint.id};
 return {ok:true,block,powers:{...powers,pending:{...powers.pending,block},
  tacticalBlock:{...powers.tacticalBlock,[player]:{...powers.tacticalBlock[player],activations:powers.tacticalBlock[player].activations+1}}}};
}
/* A failed block leaves the hint pending and revealable; a successful one consumes it. */
function hintBlockResolve(powers,{blocked=true}={}){
 const block=powers.pending.block,hint=powers.pending.hint;
 if(!block||!hint)return fail('NO_BLOCK_PENDING');
 if(!blocked)return {ok:true,blocked:false,revealable:true,powers:{...powers,pending:{...powers.pending,block:null}}};
 if(powers.tacticalBlock[block.blocker].delivered>=POLICY.blockSuccesses)return fail('BLOCK_CAP');
 const blocker=powers.tacticalBlock[block.blocker];
 return {ok:true,blocked:true,revealable:false,powers:{...powers,pending:{hint:null,block:null},
  tacticalBlock:{...powers.tacticalBlock,[block.blocker]:{...blocker,delivered:blocker.delivered+1}},
  hint:{...powers.hint,[hint.player]:{...powers.hint[hint.player],blocked:powers.hint[hint.player].blocked+1}}}};
}
function hintReveal(powers,{square=null}={}){
 const hint=powers.pending.hint;
 if(!hint)return fail('NO_HINT_PENDING');
 if(powers.pending.block)return fail('BLOCK_WINDOW_OPEN');
 if(powers.hint[hint.player].delivered>=POLICY.hintDeliveries)return fail('DELIVERY_CAP');
 const owner=powers.hint[hint.player];
 return {ok:true,square,hint,powers:{...powers,pending:{...powers.pending,hint:null},
  hint:{...powers.hint,[hint.player]:{...owner,delivered:owner.delivered+1}}}};
}
/* --- modes ---------------------------------------------------------------------------------- */
/* No powers in ranked, direct/staked challenges, tournaments, parties or LAN; the mode decides
   which kinds may even exist. Never mutates the engine, so refusal changes nothing. */
function powersAllowed(input,opts,kind){
 const c=view(input,typeof opts==='string'?undefined:opts);
 const id=typeof opts==='string'?opts:kind;
 if(id!==undefined&&!KINDS.includes(id))throw Error('INVALID_KIND');
 if(!c.mode||DENIED_MODES.includes(c.mode))return false;
 if(c.practice||c.tutorial||c.ranked||c.queued||c.party||c.tournament||c.lan||c.direct||c.staked)return false;
 if(c.online&&c.mode!=='casual')return false;
 const kinds=POWER_KINDS[c.mode];
 if(!kinds)return false;
 return id===undefined?kinds.length>0:kinds.includes(id);
}
/* A rewarded placement additionally needs a truthful opt-in context and a mode that may offer a
   power at all; unknown consent or readiness is a refusal, never permission. */
function rewardedAllowed(input,opts,kind){
 const c=view(input,typeof opts==='string'?undefined:opts);
 const id=typeof opts==='string'?opts:kind;
 if(id!==undefined&&!KINDS.includes(id))throw Error('INVALID_KIND');
 if(!powersAllowed(input,opts,kind))return false;
 if(c.mode==='local')return false;
 if(c.consentReady!==true||c.adReady!==true)return false;
 return true;
}
/* --- rewarded pacing ------------------------------------------------------------------------ */
/* ONE aggregate ceiling of ten presentations per UTC day across every reward type, plus the
   existing two-minute spacing. `now` is injected so tests never depend on the clock. */
function freshPacing(now){
 return {version:1,utcDay:utcDay(now),shown:0,granted:0,byKind:{undo:0,hint:0,undoBlock:0,tacticalBlock:0},lastShownAt:0,nextEligibleAt:0,seen:[]};
}
function rollingDay(pacing,now){
 if(pacing.utcDay===utcDay(now))return {...pacing,byKind:{...pacing.byKind}};
 return {...pacing,utcDay:utcDay(now),shown:0,granted:0,byKind:{undo:0,hint:0,undoBlock:0,tacticalBlock:0}};
}
/* The daily counter rolls over at UTC midnight; the two-minute gap is a real ad gap, so it is not
   reset by the date change. */
function pacingWindow(pacing,now){
 const p=rollingDay(pacing,now);
 if(p.shown>=POLICY.rewardedDayCap)return {ok:false,reason:'DAY_CAP',remaining:0,nextEligibleAt:p.nextEligibleAt,pacing:p};
 if(now<p.nextEligibleAt)return {ok:false,reason:'SPACING',remaining:POLICY.rewardedDayCap-p.shown,nextEligibleAt:p.nextEligibleAt,pacing:p};
 return {ok:true,reason:null,remaining:POLICY.rewardedDayCap-p.shown,nextEligibleAt:p.nextEligibleAt,pacing:p};
}
/* Fail closed before an offer: a bank that cannot take the promised item means no ad is shown. */
function offerAllowed(pacing,inventory,{kind,now}={}){
 requireKind(kind);
 const gate=pacingWindow(pacing,now);
 if(!gate.ok)return {ok:false,reason:gate.reason,remaining:gate.remaining,nextEligibleAt:gate.nextEligibleAt};
 if(banked(inventory,kind))return {ok:false,reason:'BANK_FULL',remaining:gate.remaining,nextEligibleAt:gate.nextEligibleAt};
 return {ok:true,reason:null,remaining:gate.remaining,nextEligibleAt:gate.nextEligibleAt};
}
function notePresentation(pacing,inventory,{id,kind,outcome,now}={}){
 requireKind(kind);
 if(!OUTCOMES.includes(outcome))throw Error('INVALID_OUTCOME');
 if(PRESENTED.includes(outcome)&&!isId(id))throw Error('INVALID_ATTEMPT');
 const p=rollingDay(pacing,now);
 if(isId(id)&&p.seen.includes(id))return {ok:true,duplicate:true,consumed:false,earned:false,granted:null,reason:'DUPLICATE',pacing:p,inventory};
 const base=isId(id)?{...p,seen:[...p.seen,id].slice(-POLICY.seenLimit)}:p;
 if(!PRESENTED.includes(outcome))return {ok:true,duplicate:false,consumed:false,earned:false,granted:null,reason:'NOT_PRESENTED',pacing:base,inventory};
 const earned=outcome==='earned';
 return {ok:true,duplicate:false,consumed:true,earned,granted:earned?kind:null,reason:earned?null:'NO_REWARD',
  pacing:{...base,shown:base.shown+1,granted:base.granted+(earned?1:0),byKind:{...base.byKind,[kind]:base.byKind[kind]+1},lastShownAt:now,nextEligibleAt:now+POLICY.rewardedGap},inventory};
}
/* Exposure and inventory in one idempotent step: a presented ad always consumes its slot, an
   earned one is banked (or held as an obligation) when it cannot be banked yet. */
function applyPresentation(pacing,inventory,{id,kind,outcome,now}={}){
 const note=notePresentation(pacing,inventory,{id,kind,outcome,now});
 if(note.duplicate||!note.consumed||!note.earned)return note;
 const added=bank(note.inventory,kind,{id});
 if(!added.ok)return {...added,consumed:true,earned:true,granted:null,pacing:note.pacing};
 return {...added,consumed:true,earned:true,granted:kind,pacing:note.pacing};
}
return Object.freeze({POLICY,KINDS,OUTCOMES,PRESENTED,POWER_KINDS,DENIED_MODES,MINUTE,DAY,HUMAN,BOT,
 utcDay,equal,plies,playerAt,rebuild,trailingPair,undoEligible,rewind,
 createHistory,activeNode,path,record,
 freshInventory,banked,bank,reserve,commit,release,
 freshMatchPowers,grantBotUndoPackage,pressBotUndo,casualInitiate,casualResolve,
 hintRequest,hintBlockAttempt,hintBlockResolve,hintReveal,
 powersAllowed,rewardedAllowed,
 freshPacing,pacingWindow,offerAllowed,notePresentation,applyPresentation});
});
