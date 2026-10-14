'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../src/gameplay-rewind.js');
/* Deterministic, injected clock: nothing here reads the wall clock. */
const DAY0=Date.parse('2026-10-14T00:00:00Z');
const DAY1=Date.parse('2026-10-15T00:00:00Z');
const clone=v=>JSON.parse(JSON.stringify(v));
const stocked=kinds=>kinds.reduce((inv,kind)=>R.bank(inv,kind).inventory,R.freshInventory());
/* A fresh inventory, one eligible presentation at a time, 2 minutes apart. */
function present(pacing,{kind,outcome,id,at,now}){return R.applyPresentation(pacing,at,{kind,outcome,id,now});}
test('bank capacity is one available entitlement per type with a separate reserved bucket',()=>{
 const inv=R.freshInventory();
 assert.equal(R.banked(inv,'undo'),false);
 for(const kind of R.KINDS)assert.equal(R.banked(R.bank(inv,kind).inventory,kind),true,kind);
 /* `available` never rises above the capacity; a second earned reward is held as an obligation
    rather than added to the bank, and a third is refused. */
 for(const kind of R.KINDS){
  const once=R.bank(inv,kind);
  const twice=R.bank(once.inventory,kind,{id:'race-'+kind});
  assert.equal(twice.ok,true,kind);
  assert.equal(twice.grant,'owed',kind);
  assert.equal(twice.credit,0,kind);
  assert.equal(twice.inventory.available[kind],1,kind);
  assert.equal(twice.inventory.owed[kind],1,kind);
  assert.equal(R.bank(twice.inventory,kind,{id:'race2-'+kind}).reason,'BANK_FULL',kind);
  assert.equal(R.bank(twice.inventory,kind,{id:'race-'+kind}).duplicate,true,kind);
 }
 const one=R.bank(inv,'undo').inventory;
 assert.deepEqual(one.available,{undo:1,hint:0,undoBlock:0,tacticalBlock:0});
 assert.deepEqual(one.reserved,{undo:null,hint:null,undoBlock:null,tacticalBlock:null});
 assert.equal(R.banked(one,'hint'),false);
 assert.throws(()=>R.bank(inv,'tokens'),/INVALID_KIND/);
 assert.throws(()=>R.reserve(inv,'undo',{id:''}),/INVALID_ATTEMPT/);
});
test('reserve, commit and release cannot double-consume and never expire silently',()=>{
 const stocked=R.bank(R.bank(R.freshInventory(),'undo').inventory,'hint').inventory;
 const reserved=R.reserve(stocked,'undo',{id:'attempt-1'});
 assert.equal(reserved.ok,true);
 assert.equal(reserved.token,'undo#1');
 assert.equal(reserved.inventory.available.undo,0);
 assert.deepEqual(reserved.inventory.reserved.undo,{token:'undo#1',id:'attempt-1'});
 /* A retried callback with the same attempt id is idempotent, never a second consume. */
 const retry=R.reserve(reserved.inventory,'undo',{id:'attempt-1'});
 assert.equal(retry.duplicate,true);
 assert.equal(retry.token,'undo#1');
 assert.equal(R.reserve(reserved.inventory,'undo',{id:'attempt-2'}).reason,'ALREADY_RESERVED');
 const committed=R.commit(reserved.inventory,'undo',{id:'attempt-1'});
 assert.equal(committed.ok,true);
 assert.equal(committed.inventory.consumed.undo,1);
 assert.equal(committed.inventory.available.undo,0);
 assert.equal(R.commit(committed.inventory,'undo',{id:'attempt-1'}).reason,'NO_RESERVATION');
 assert.equal(R.release(committed.inventory,'undo',{id:'attempt-1'}).reason,'NO_RESERVATION');
 /* A technical failure returns the reservation and its slot, exactly once. */
 const failed=R.reserve(stocked,'hint',{id:'attempt-3'});
 const released=R.release(failed.inventory,'hint',{id:'attempt-3'});
 assert.equal(released.ok,true);
 assert.equal(released.inventory.available.hint,1);
 assert.equal(released.inventory.consumed.hint,0);
 assert.equal(R.release(released.inventory,'hint',{id:'attempt-3'}).reason,'NO_RESERVATION');
 assert.equal(R.release(stocked,'undo',{token:'undo#9'}).reason,'NO_RESERVATION');
 const held=R.reserve(stocked,'undo',{id:'attempt-4'});
 assert.equal(R.commit(held.inventory,'undo',{id:'attempt-5'}).reason,'RESERVATION_MISMATCH');
 assert.equal(R.release(held.inventory,'undo',{token:'undo#9'}).reason,'RESERVATION_MISMATCH');
 /* Nothing in the inventory carries an expiry, and committing leaves no silent decay. */
 assert.equal(Object.keys(R.freshInventory()).some(k=>/expir|ttl|lifetime/i.test(k)),false);
});
test('an earned reward that cannot be banked stays owed instead of vanishing',()=>{
 const stocked=R.bank(R.freshInventory(),'undo').inventory;
 const earned=R.applyPresentation(R.freshPacing(DAY0),stocked,{id:'ad-2',kind:'undo',outcome:'earned',now:DAY0});
 assert.equal(earned.ok,true);
 assert.equal(earned.earned,true);
 assert.equal(earned.pacing.shown,1);
 assert.equal(earned.inventory.available.undo,1);
 assert.equal(earned.inventory.owed.undo,1);
 const spent=R.commit(R.reserve(earned.inventory,'undo',{id:'use-1'}).inventory,'undo',{id:'use-1'});
 assert.equal(spent.honoured,true);
 assert.equal(spent.inventory.owed.undo,0);
 assert.equal(spent.inventory.available.undo,1);
 assert.equal(spent.inventory.consumed.undo,1);
});
test('Bot Undo is one two-charge package with two presses, one per player decision',()=>{
 let powers=R.freshMatchPowers();
 assert.equal(R.pressBotUndo(powers).reason,'NO_CHARGES');
 const granted=R.grantBotUndoPackage(powers);
 assert.equal(granted.ok,true);
 assert.equal(granted.charges,2);
 assert.equal(granted.charges,R.POLICY.botUndoCharges);
 assert.equal(R.grantBotUndoPackage(granted.powers).reason,'PACKAGE_ALREADY_GRANTED');
 const first=R.pressBotUndo(granted.powers);
 const second=R.pressBotUndo(first.powers);
 assert.equal(first.charges,1);
 assert.equal(second.charges,0);
 assert.equal(second.powers.botUndo.presses,2);
 assert.equal(R.pressBotUndo(second.powers).reason,'NO_CHARGES');
 assert.equal(second.powers.botUndo.packages,1);
});
test('Casual Undo counts three initiations per player and one applied Undo match-wide',()=>{
 let powers=R.freshMatchPowers();
 const first=R.casualInitiate(powers,'X');
 assert.equal(first.ok,true);
 assert.equal(R.casualInitiate(first.powers,'X').reason,'REQUEST_PENDING');
 /* The reward copy promises an earned request token, not an unconditional rewind. */
 assert.equal(R.casualResolve(first.powers,{player:'X'}).reason,'REQUEST_TOKEN_REQUIRED');
 assert.equal(R.casualResolve(first.powers,{player:'X',blocked:true}).reason,'BLOCK_TOKEN_REQUIRED');
 const blocked=R.casualResolve(first.powers,{player:'X',blocked:true,token:'undoBlock'});
 assert.equal(blocked.ok,true);
 assert.equal(blocked.applied,false);
 assert.equal(blocked.powers.casualUndo.blocked.X,1);
 assert.equal(blocked.powers.casualUndo.applied,0);
 const second=R.casualInitiate(blocked.powers,'X');
 const applied=R.casualResolve(second.powers,{player:'X',token:'undo'});
 assert.equal(applied.ok,true);
 assert.equal(applied.applied,true);
 assert.equal(applied.powers.casualUndo.applied,1);
 assert.equal(applied.powers.casualUndo.appliedBy,'X');
 /* Only one successful Undo for the whole match, so player O is refused afterwards. */
 assert.equal(R.casualInitiate(applied.powers,'O').reason,'UNDO_ALREADY_APPLIED');
 assert.equal(applied.powers.casualUndo.initiations.X,2);
 assert.throws(()=>R.casualInitiate(powers,'Y'),/INVALID_PLAYER/);
});
test('the third initiation is reachable while an initiation cap remains',()=>{
 let powers=R.freshMatchPowers();
 for(let i=0;i<3;i++){
  const request=R.casualInitiate(powers,'X');
  assert.equal(request.ok,true,'initiation '+i);
  powers=R.casualResolve(request.powers,{player:'X',blocked:true,token:'undoBlock'}).powers;
 }
 assert.equal(powers.casualUndo.initiations.X,3);
 assert.equal(powers.casualUndo.blocked.X,3);
 assert.equal(R.casualInitiate(powers,'X').reason,'INITIATION_CAP');
});
test('hints deliver twice within three activations and a blocked hint is never revealed early',()=>{
 let powers=R.freshMatchPowers();
 for(let i=0;i<2;i++){
  const request=R.hintRequest(powers,'X');
  assert.equal(request.ok,true,'request '+i);
  /* While the counter window is open the recommendation must not be exposed. */
  const block=R.hintBlockAttempt(request.powers,'O');
  assert.equal(block.ok,true);
  assert.equal(R.hintReveal(block.powers,{square:{b:0,c:0}}).reason,'BLOCK_WINDOW_OPEN');
  const failed=R.hintBlockResolve(block.powers,{blocked:false});
  assert.equal(failed.revealable,true);
  const revealed=R.hintReveal(failed.powers,{square:{b:1,c:1}});
  assert.equal(revealed.ok,true,revealed.reason);
  assert.equal(revealed.square.b,1);
  powers=revealed.powers;
 }
 /* Two delivered, one activation left: the third activation cannot reveal and is refused. */
 assert.equal(powers.hint.X.activations,2);
 assert.equal(powers.hint.X.delivered,2);
 assert.equal(R.hintRequest(powers,'X').reason,'DELIVERY_CAP');
});
test('Tactical Block succeeds twice within three activations and stays separate from Undo Block',()=>{
 let powers=R.freshMatchPowers();
 for(let i=0;i<2;i++){
  const request=R.hintRequest(powers,'X');
  const block=R.hintBlockAttempt(request.powers,'O');
  assert.equal(block.ok,true,'block '+i);
  assert.equal(R.hintBlockAttempt(block.powers,'X').reason,'BLOCK_PENDING');
  const resolved=R.hintBlockResolve(block.powers,{blocked:true});
  assert.equal(resolved.ok,true);
  assert.equal(resolved.revealable,false);
  assert.equal(resolved.powers.pending.hint,null);
  assert.equal(R.hintReveal(resolved.powers).reason,'NO_HINT_PENDING');
  powers=resolved.powers;
 }
 assert.equal(powers.tacticalBlock.O.delivered,2);
 assert.equal(powers.tacticalBlock.O.activations,2);
 assert.equal(powers.hint.X.delivered,0);
 assert.equal(powers.hint.X.blocked,2);
 assert.equal(R.hintRequest(powers,'X').ok,true);
 assert.equal(R.hintBlockAttempt(R.hintRequest(powers,'X').powers,'O').reason,'BLOCK_CAP');
 assert.equal(R.hintBlockResolve(powers).reason,'NO_BLOCK_PENDING');
 /* Undo Block counters are a different item: a Tactical Block never increments them. */
 assert.deepEqual(powers.casualUndo.blocked,{X:0,O:0});
 assert.throws(()=>R.hintRequest(powers,'Y'),/INVALID_PLAYER/);
});
test('one aggregate ceiling of ten rewarded presentations per UTC day across all kinds',()=>{
 let pacing=R.freshPacing(DAY0),inventory=R.freshInventory(),at=DAY0;
 for(let i=0;i<10;i++){
  const kind=R.KINDS[i%R.KINDS.length];
  const window=R.offerAllowed(pacing,inventory,{kind,now:at});
  assert.equal(window.ok,true,'offer '+i);
  assert.equal(window.remaining,10-i);
  const shown=R.applyPresentation(pacing,inventory,{id:'ad-'+i,kind,outcome:'earned',now:at});
  assert.equal(shown.ok,true);
  assert.equal(shown.granted,kind);
  pacing=shown.pacing;
  inventory=R.bank(inventory,kind,{id:'bank-'+i}).inventory; /* free the bank so only the day cap can stop it */
  inventory={...inventory,available:{...inventory.available,[kind]:0}};
  at+=R.POLICY.rewardedGap;
 }
 assert.equal(pacing.shown,10);
 assert.deepEqual(pacing.byKind,{undo:3,hint:3,undoBlock:2,tacticalBlock:2});
 assert.equal(pacing.granted,10);
 assert.equal(R.pacingWindow(pacing,at).ok,false);
 assert.equal(R.pacingWindow(pacing,at).reason,'DAY_CAP');
 assert.equal(R.pacingWindow(pacing,at).remaining,0);
 assert.equal(R.offerAllowed(pacing,R.freshInventory(),{kind:'undo',now:at}).reason,'DAY_CAP');
});
test('the ceiling rolls over at UTC midnight and the two-minute gap still applies',()=>{
 let pacing=R.freshPacing(DAY0),at=DAY0;
 for(let i=0;i<10;i++){
  pacing=R.applyPresentation(pacing,R.freshInventory(),{id:'d'+i,kind:'undo',outcome:'earned',now:at}).pacing;
  at+=R.POLICY.rewardedGap;
 }
 assert.equal(R.pacingWindow(pacing,DAY0+12*3600000).reason,'DAY_CAP');
 const midnight=R.pacingWindow(pacing,DAY1+R.POLICY.rewardedGap);
 assert.equal(midnight.ok,true);
 assert.equal(midnight.pacing.shown,0);
 assert.equal(midnight.pacing.utcDay,'2026-10-15');
 assert.equal(midnight.remaining,10);
 assert.deepEqual(midnight.pacing.byKind,{undo:0,hint:0,undoBlock:0,tacticalBlock:0});
 assert.equal(midnight.pacing.granted,0);
 /* Ten presentations ending one minute before midnight: the daily counter resets at the boundary,
    but the two-minute gap is a real ad gap and spans it. */
 let late=R.freshPacing(DAY1-3600000);
 const lastShown=DAY1-60000;
 for(let i=0;i<10;i++){
  const now=lastShown-(9-i)*R.POLICY.rewardedGap;
  late=R.applyPresentation(late,R.freshInventory(),{id:'l'+i,kind:'hint',outcome:'earned',now}).pacing;
 }
 assert.equal(late.shown,10);
 assert.equal(late.nextEligibleAt,lastShown+R.POLICY.rewardedGap);
 const across=R.pacingWindow(late,DAY1+30000);
 assert.equal(across.reason,'SPACING');
 assert.equal(across.remaining,10);
 assert.equal(across.pacing.shown,0);
 assert.equal(across.nextEligibleAt,lastShown+R.POLICY.rewardedGap);
 assert.equal(R.pacingWindow(late,lastShown+R.POLICY.rewardedGap-1).reason,'SPACING');
 const after=R.pacingWindow(late,lastShown+R.POLICY.rewardedGap);
 assert.equal(after.ok,true);
 assert.equal(after.pacing.utcDay,'2026-10-15');
 assert.equal(after.remaining,10);
});
test('no-fill and failure consume nothing; a shown-then-skipped ad consumes exposure and grants no item',()=>{
 for(const outcome of ['no-fill','failed']){
  const result=R.applyPresentation(R.freshPacing(DAY0),R.freshInventory(),{kind:'undo',outcome,now:DAY0});
  assert.equal(result.consumed,false,outcome);
  assert.equal(result.granted,null,outcome);
  assert.equal(result.pacing.shown,0,outcome);
  assert.equal(result.pacing.nextEligibleAt,0,outcome);
  assert.equal(result.inventory.available.undo,0,outcome);
 }
 for(const outcome of ['skipped','dismissed']){
  const result=R.applyPresentation(R.freshPacing(DAY0),R.freshInventory(),{kind:'undo',outcome,id:'skip-'+outcome,now:DAY0});
  assert.equal(result.consumed,true,outcome);
  assert.equal(result.earned,false,outcome);
  assert.equal(result.granted,null,outcome);
  assert.equal(result.reason,'NO_REWARD');
  assert.equal(result.pacing.shown,1,outcome);
  assert.equal(result.pacing.granted,0,outcome);
  assert.equal(result.pacing.nextEligibleAt,DAY0+R.POLICY.rewardedGap,outcome);
  assert.equal(result.inventory.available.undo,0,outcome);
  /* A skipped presentation still uses one of the ten aggregate slots. */
  assert.equal(R.offerAllowed(result.pacing,R.freshInventory(),{kind:'undo',now:DAY0+R.POLICY.rewardedGap}).remaining,9);
 }
 const earned=R.applyPresentation(R.freshPacing(DAY0),R.freshInventory(),{id:'earn-1',kind:'undo',outcome:'earned',now:DAY0});
 assert.equal(earned.earned,true);
 assert.equal(earned.granted,'undo');
 assert.equal(earned.inventory.available.undo,1);
 assert.equal(earned.pacing.granted,1);
});
test('a retried provider callback cannot double-grant or consume a second slot',()=>{
 const first=R.applyPresentation(R.freshPacing(DAY0),R.freshInventory(),{id:'tx-1',kind:'hint',outcome:'earned',now:DAY0});
 const retry=R.applyPresentation(first.pacing,first.inventory,{id:'tx-1',kind:'hint',outcome:'earned',now:DAY0+1000});
 assert.equal(retry.duplicate,true);
 assert.equal(retry.consumed,false);
 assert.equal(retry.pacing.shown,1);
 assert.equal(retry.inventory.available.hint,1);
 assert.equal(retry.inventory.consumed.hint,0);
 /* A distinct attempt id is a distinct presentation. */
 const distinct=R.applyPresentation(first.pacing,{...first.inventory,available:{...first.inventory.available,hint:0}},{id:'tx-2',kind:'hint',outcome:'earned',now:DAY0+R.POLICY.rewardedGap});
 assert.equal(distinct.duplicate,false);
 assert.equal(distinct.pacing.shown,2);
 assert.throws(()=>R.applyPresentation(first.pacing,first.inventory,{kind:'hint',outcome:'earned',now:DAY0}),/INVALID_ATTEMPT/);
});
test('a full bank refuses the offer before any ad is shown',()=>{
 const stocked=R.bank(R.freshInventory(),'undo').inventory;
 const refused=R.offerAllowed(R.freshPacing(DAY0),stocked,{kind:'undo',now:DAY0});
 assert.equal(refused.ok,false);
 assert.equal(refused.reason,'BANK_FULL');
 assert.equal(refused.remaining,10);
 assert.equal(R.offerAllowed(R.freshPacing(DAY0),stocked,{kind:'hint',now:DAY0}).ok,true);
 assert.equal(R.offerAllowed(R.freshPacing(DAY0),R.freshInventory(),{kind:'undo',now:DAY0}).ok,true);
});
test('powers are refused in ranked, direct/staked, tournament, party, LAN and practice modes',()=>{
 for(const mode of ['ranked','queue','queued','direct','challenge','friend','friend-stake','staked','wager','prize','tournament','party','lan','practice','tutorial','impossible'])
  assert.equal(R.powersAllowed({mode},'undo'),false,mode);
 for(const flag of ['ranked','queued','queue','party','tournament','lan','direct','staked','wager','practice','tutorial'])
  assert.equal(R.powersAllowed({mode:'bot',[flag]:true},'undo'),false,flag);
 assert.equal(R.powersAllowed({mode:'bot'},'undo'),true);
 assert.equal(R.powersAllowed({mode:'casual',online:true},'undo'),true);
 assert.equal(R.powersAllowed({mode:'casual',online:true},'hint'),false);
 assert.equal(R.powersAllowed({mode:'bot'},'undoBlock'),false);
 assert.equal(R.powersAllowed({mode:'local'},'undo'),true);
 for(const mode of ['ranked','queue','direct','tournament','party','lan','practice'])
  assert.equal(R.rewardedAllowed({mode,consentReady:true,adReady:true},'undo'),false,mode);
 /* A rewarded placement needs a truthful opt-in context and never runs in Pass & Play. */
 assert.equal(R.rewardedAllowed({mode:'bot'},'undo'),false);
 assert.equal(R.rewardedAllowed({mode:'bot',consentReady:true},'undo'),false);
 assert.equal(R.rewardedAllowed({mode:'bot',adReady:true},'undo'),false);
 assert.equal(R.rewardedAllowed({mode:'bot',consentReady:true,adReady:true},'undo'),true);
 assert.equal(R.rewardedAllowed({mode:'local',consentReady:true,adReady:true},'undo'),false);
 assert.throws(()=>R.powersAllowed({mode:'bot'},'shield'),/INVALID_KIND/);
});
test('pacing state and inventory are pure: no argument is mutated and no timestamp expires',()=>{
 const pacing=R.freshPacing(DAY0);
 const stocked=R.bank(R.freshInventory(),'undo').inventory;
 const powers=R.freshMatchPowers();
 const before={pacing:clone(pacing),inventory:clone(stocked),powers:clone(powers)};
 R.applyPresentation(pacing,stocked,{id:'p1',kind:'undo',outcome:'earned',now:DAY0});
 R.pacingWindow(pacing,DAY0+R.POLICY.rewardedGap);
 R.offerAllowed(pacing,stocked,{kind:'hint',now:DAY0});
 R.bank(stocked,'hint');
 R.reserve(stocked,'undo',{id:'r1'});
 R.commit(R.reserve(stocked,'undo',{id:'r1'}).inventory,'undo',{id:'r1'});
 R.release(stocked,'undo',{id:'r1'});
 const request=R.hintRequest(powers,'X');
 R.hintBlockAttempt(request.powers,'O');
 R.hintReveal(request.powers,{square:{b:0,c:0}});
 R.casualInitiate(powers,'X');
 assert.deepEqual(pacing,before.pacing);
 assert.deepEqual(stocked,before.inventory);
 assert.deepEqual(powers,before.powers);
 assert.equal(R.POLICY.rewardedDayCap,10);
 assert.equal(R.POLICY.rewardedGap,2*R.MINUTE);
 assert.equal(R.POLICY.botUndoCharges,2);
 assert.equal(R.POLICY.bankCapacity,1);
});
