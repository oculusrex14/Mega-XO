/* V5.2 rewarded-powers client adapter: the DOM-free, provider-free bridge that exposes the frozen
   `window.MegaPowers` (`powers/v1`) contract (docs/v5.2/release/EXECUTION-BOARD-AND-CONTRACTS-20261014.md)
   over the pure rules in `src/gameplay-rewind.js`. No DOM, no timer, no network, no SDK: every
   provider call goes through the injected native reward lane, and every rule decision is a pure
   transformation of the arguments.

   Trust lanes stay separate. `window.MegaNativeReward` is the origin-pinned native lane: a reward
   exists only when its `present()` resolves the native `EARNED` outcome. `window.MegaAds` keeps
   serving the account-bound cosmetic lane and is never consulted here. A browser or offline build
   has no native lane, so `request()` resolves `earned:false` and the game stays fully playable.

   Shipped live scope: `undo` (Bot Undo) and `hint` (Tactical Power in a Bot match). `undoBlock` and
   `tacticalBlock` exist in the pure rules module and in `inventory()`, but the client refuses to earn
   or apply them: a counter answers another player's power use, so it is only meaningful in the
   two-player Casual protocol, which is not built. They are disclosed as unavailable, not faked.

   `eligibility` is side-effect free. `request` grants only from a native-confirmed EARNED and never
   from a shown/closed callback. `apply` is fenced on the live match revision, so a late Bot reply can
   never land on a rewound board and a hint can never describe a board that already moved. */
(function(root,factory){
 const api=factory(typeof module==='object'?require('./gameplay-rewind.js'):root.MegaRewind,
  typeof module==='object'?require('./game.js'):root.MegaGame);
 if(typeof module==='object')module.exports=api;else root.MegaPowersAdapter=api;
})(globalThis,(R,G)=>{
'use strict';
const VERSION='powers/v1',INVENTORY_VERSION='powers/inventory/v1',STATE_VERSION=1;
/* Bot Undo and Tactical Power are wired into the live client; the two counter kinds are refused,
   not stubbed. */
const SHIPPED=Object.freeze(['undo','hint']);
const isId=value=>typeof value==='string'&&value.length>0&&value.length<=160;
const count=(value,fallback=0)=>{
 if(!Number.isSafeInteger(value)||value<0)return fallback;
 return Math.min(value,9999);
};
/* --- persisted adapter state ------------------------------------------------------------------ */
function mergeInventory(raw){
 const base=R.freshInventory();
 if(!raw||typeof raw!=='object'||raw.version!==base.version)return base;
 const out={version:base.version,counter:count(raw.counter),seen:Array.isArray(raw.seen)?raw.seen.filter(isId).slice(-R.POLICY.seenLimit):[]};
 for(const bucket of ['available','reserved','owed','consumed']){
  out[bucket]={};
  for(const kind of R.KINDS){
   const held=raw[bucket]?.[kind];
   if(bucket==='reserved')out[bucket][kind]=held&&typeof held==='object'&&isId(held.token)?{token:held.token,id:isId(held.id)?held.id:null}:null;
   else out[bucket][kind]=count(held);
  }
 }
 return out;
}
function mergePacing(raw,now){
 const base=R.freshPacing(now);
 if(!raw||typeof raw!=='object'||raw.version!==base.version)return base;
 const byKind={};
 for(const kind of R.KINDS)byKind[kind]=count(raw.byKind?.[kind]);
 return {version:base.version,utcDay:typeof raw.utcDay==='string'?raw.utcDay:base.utcDay,
  shown:count(raw.shown),granted:count(raw.granted),byKind,
  lastShownAt:count(raw.lastShownAt),nextEligibleAt:count(raw.nextEligibleAt),
  seen:Array.isArray(raw.seen)?raw.seen.filter(isId).slice(-R.POLICY.seenLimit):[]};
}
function freshState(now=0){return {version:STATE_VERSION,inventory:R.freshInventory(),pacing:R.freshPacing(now),attempt:null,lastAttempt:null};}
function migrateState(raw,now=0){
 if(!raw||typeof raw!=='object'||raw.version!==STATE_VERSION)return freshState(now);
 const inventory=mergeInventory(raw.inventory);
 const attempt=raw.attempt&&isId(raw.attempt.id)?{id:raw.attempt.id,kind:raw.attempt.kind||null,at:count(raw.attempt.at)}:null;
 /* An interrupted request leaves its reservation behind. There is no earned evidence for it after a
    restart, so the promise is returned to the bank instead of expiring silently. */
 if(attempt&&R.KINDS.includes(attempt.kind)&&inventory.reserved[attempt.kind]?.id===attempt.id){
  const released=R.release(inventory,attempt.kind,{id:attempt.id});
  if(released.ok)Object.assign(inventory,released.inventory);
 }
 return {version:STATE_VERSION,inventory,pacing:mergePacing(raw.pacing,now),attempt:null,
  lastAttempt:raw.lastAttempt&&isId(raw.lastAttempt.id)?raw.lastAttempt:null};
}
/* Per-match counters live on the match, so an older snapshot is migrated leaf by leaf against the
   canonical shape instead of being trusted or discarded. */
function mergeCounters(raw,base){
 if(typeof base==='number')return count(raw,base);
 if(base===null)return raw===null||raw===undefined?null:raw;
 if(!base||typeof base!=='object'||Array.isArray(base))return base;
 const out={};
 for(const [key,value] of Object.entries(base))out[key]=mergeCounters(raw&&typeof raw==='object'?raw[key]:undefined,value);
 return out;
}
function matchPowers(raw){
 const base=R.freshMatchPowers();
 if(!raw||typeof raw!=='object'||raw.version!==base.version)return base;
 return mergeCounters(raw,base);
}
/* Read-only summary of a live match, and the summary the caller may pass instead. A bare engine
   snapshot has neither an id nor a revision, so the live match supplies the fence. */
function summaryOf(input,live){
 const candidate=input&&typeof input==='object'?input:null;
 if(candidate&&(candidate.state||Array.isArray(candidate.moves)))return candidate;
 return live&&typeof live==='function'?live():null;
}
const usedOf=summary=>Number.isInteger(summary.used)?summary.used:Number.isInteger(summary.perMatchUsed)?summary.perMatchUsed:0;
const chargesOf=summary=>Number.isInteger(summary.charges)?summary.charges:0;
const powersOf=summary=>matchPowers(summary&&summary.powers);
/* --- native reward lane ----------------------------------------------------------------------- */
/* The host exposes the typed, origin-pinned reward bridge. Anything else — a browser page setting
   `watched=true`, a page-level flag, an SDK show call — is never proof of an earned reward. */
function nativeBridge(host){
 // Primary lane: window.MegaAds, the origin-pinned bridge the native hosts actually publish
 // (MegaAdsBridge.kt / MegaAdsBridge.swift). The reward ticket is issued by Core and passed
 // through; showRewarded() settles only on the SDK earned-reward callback, so this is not a
 // client-watched grant. `present` keeps the generic outcome shape the caller already expects.
 const ads=host&&host.MegaAds;
 if(ads&&typeof ads.showRewarded==='function'){
  return {
   present:payload=>{
    const issue=payload&&typeof payload.issueTicket==='function'?payload.issueTicket:null;
    if(!issue)return Promise.resolve({outcome:'failed'});
    return Promise.resolve()
     .then(()=>issue({kind:payload.kind,platform:ads.platform,attemptId:payload.attemptId}))
     .then(ticket=>{
      if(!ticket)return {outcome:'no-fill'};
      return Promise.resolve(ads.showRewarded(ticket));
     })
     .then(value=>({outcome:value&&value.earned===true?'earned':(value&&value.shown===true?'shown':'failed')}),
           ()=>({outcome:'failed'}));
   },
   ready:typeof ads.isReady==='function'?()=>ads.isReady('rewarded')===true:null,
   consent:typeof ads.privacyState==='function'?()=>{try{return ads.privacyState()?.canRequestAds===true;}catch{return false;}}:null
  };
 }
 // Fallback lane: a host that publishes the typed reward bridge directly. Anything else — a page
 // setting `watched=true`, a page-level flag, an SDK show call — is never proof of an earned reward.
 const api=host&&host.MegaNativeReward;
 if(!api||typeof api.present!=='function')return null;
 return {
  present:payload=>Promise.resolve().then(()=>api.present(payload)).then(value=>({outcome:value&&value.outcome})),
  ready:typeof api.isReady==='function'?()=>api.isReady('rewarded')===true:null,
  consent:typeof api.privacyState==='function'?()=>{try{return api.privacyState()?.canRequestAds===true;}catch{return false;}}:null
 };
}
function newAttemptId(host,now){
 const random=host?.crypto?.randomUUID?.();
 if(typeof random==='string'&&random)return random;
 return 'powers-'+now+'-'+Math.random().toString(36).slice(2,10);
}
/* --- the frozen contract ---------------------------------------------------------------------- */
function createPowers(options={}){
 const enabled=typeof options.enabled==='function'?options.enabled:()=>false;
 const clock=typeof options.clock==='function'?options.clock:()=>Date.now();
 const host=options.host||globalThis;
 const storage=options.storage||null;
 const live=typeof options.live==='function'?options.live:null;
 const commit=typeof options.commit==='function'?options.commit:null;
 const bridge=options.bridge||null;
 /* The owner's ceiling is ONE aggregate ten-per-UTC-day across Credits, boost and Undo together, so
    the powers lane must count presentations the cosmetic lane already booked. `otherShown` is a host
    probe into that shared ledger; absent, it reports zero and behaviour is exactly the powers lane's
    own count. */
 const otherShown=typeof options.otherShown==='function'?options.otherShown:()=>0;
 /* The caller supplies the Expert recommender, so the suggestion is a real engine answer for the
    board being hinted. The module still validates it against G.legal before showing anything. */
 const recommender=typeof options.recommender==='function'?options.recommender:({state})=>G&&typeof G.choose==='function'?G.choose(state,'Expert'):null;
 const matchRevisions=new Map();
 let state=migrateState(storage&&typeof storage.read==='function'?storage.read():null,clock());
 let inFlight=false;
 const persist=()=>{if(storage&&typeof storage.write==='function')storage.write(state);};
 /* A press needs an earned charge; an offer may earn the two-charge package, so it is judged as if
    one charge were already available. Both use the pure module's own predicate, never a copy. */
 const pressFailure=(summary,opts)=>{
  if(R.undoEligible(summary,opts))return null;
  const rewound=R.rewind(summary,opts);
  if(!rewound.ok)return rewound.reason;
  return R.plies(summary)<R.POLICY.botUndoFirstPly?'FIRST_USE_NEEDS_'+R.POLICY.botUndoFirstPly+'_PLIES':'NOT_ELIGIBLE';
 };
 function eligibilityOf(summary){
  if(!summary)return {eligible:false,reason:'NO_MATCH',ply:0,charges:0,perMatchUsed:0};
  const opts={used:usedOf(summary),charges:chargesOf(summary)};
  const powers=powersOf(summary);
  const ply=R.plies(summary);
  const press=pressFailure(summary,opts);
  const offerable=powers.botUndo.packages<R.POLICY.botUndoPackagesPerMatch&&pressFailure(summary,{used:opts.used,charges:1})===null;
  if(press===null)return {eligible:true,reason:'',ply,charges:opts.charges,perMatchUsed:opts.used};
  if(opts.charges<1&&offerable)return {eligible:true,reason:'',ply,charges:0,perMatchUsed:opts.used};
  return {eligible:false,reason:opts.charges<1&&offerable===false&&powers.botUndo.packages>=R.POLICY.botUndoPackagesPerMatch?'PACKAGE_ALREADY_GRANTED':press,ply,charges:opts.charges,perMatchUsed:opts.used};
 }
 function redeem(summary){
  /* Redeem one banked earned entitlement as this match's single two-charge package, honouring an
     obligation the bank held when it was full. A refused commit leaves the entitlement banked. */
  const powers=powersOf(summary);
  if(powers.botUndo.packages>=R.POLICY.botUndoPackagesPerMatch)return {ok:false,reason:'PACKAGE_ALREADY_GRANTED',powers};
  const granted=R.grantBotUndoPackage(powers);
  if(!granted.ok)return {ok:false,reason:granted.reason,powers};
  if(commit&&commit({type:'grant',matchId:summary.id||null,expectedRevision:summary.revision,powers:granted.powers})===false)
   return {ok:false,reason:'LIVE_MATCH_CHANGED',powers};
  if(R.banked(state.inventory,'undo')){
   const held=R.reserve(state.inventory,'undo',{id:state.lastAttempt?.id||null});
   if(held.ok){const settled=R.commit(held.inventory,'undo',{id:state.lastAttempt?.id||null});if(settled.ok)state.inventory=settled.inventory;}
  }
  return {ok:true,reason:null,powers:granted.powers};
 }
 function applyUndo(summary){
  const fence=live?live():null;
  const expected=fence?fence.revision:(Number.isInteger(summary.expectedRevision)?summary.expectedRevision:(matchRevisions.has(summary.id)?matchRevisions.get(summary.id):(summary.history?summary.history.revision:(summary.state?.moves?.length))));
  if(expected!==undefined&&Number.isInteger(summary.revision)&&summary.revision!==expected)
   return {applied:false,reason:'STALE_REVISION',revision:expected};
  if(fence&&(fence.id!==summary.id||(fence.revision||0)!==(summary.revision||0)))
   return {applied:false,reason:'STALE_REVISION',revision:fence.revision||0};
  let powers=powersOf(summary);
  let current=summary;
  if(powers.botUndo.charges<1){
   if(powers.botUndo.packages>=R.POLICY.botUndoPackagesPerMatch)
    return {applied:false,reason:'NO_CHARGES',revision:summary.revision||0};
   const redeemed=redeem(summary);
   if(!redeemed.ok)return {applied:false,reason:redeemed.reason,revision:summary.revision||0};
   powers=redeemed.powers;
   current={...summary,powers,charges:powers.botUndo.charges};
  }
  if(pressFailure(current,{used:current.used,charges:powers.botUndo.charges})!==null)
   return {applied:false,reason:pressFailure(current,{used:usedOf(current),charges:powers.botUndo.charges}),revision:summary.revision||0};
  const rewound=R.rewind(current,{used:usedOf(current),charges:powers.botUndo.charges});
  if(!rewound.ok)return {applied:false,reason:rewound.reason,revision:summary.revision||0};
  const pressed=R.pressBotUndo(powers);
  if(!pressed.ok)return {applied:false,reason:pressed.reason,revision:summary.revision||0};
  if(!commit)return {applied:false,reason:'NO_LIVE_MATCH',revision:summary.revision||0};
  const installed=commit({type:'rewind',matchId:summary.id||null,expectedRevision:summary.revision,
   state:rewound.state,powers:pressed.powers,history:rewound.history||null,revision:rewound.revision,generation:rewound.generation,last:rewound.last});
  if(installed===false)return {applied:false,reason:'LIVE_MATCH_CHANGED',revision:summary.revision||0};
  matchRevisions.set(summary.id, rewound.revision);
  return {applied:true,reason:null,revision:rewound.revision};
 }
/* --- Tactical Power (hint) --------------------------------------------------------------------- */
/* The recommendation comes from the caller's Expert engine through `recommender`, never invented
   here, and it is filtered through G.legal so an engine that returns a non-legal square is refused
   instead of shown. Caps, the pending window and every refusal reason are the pure module's own. */
const hintSideOf=powers=>powers.hint[R.HUMAN];
function hintEligibilityOf(summary,inventory){
 const state_=summary&&summary.state;
 const powers=powersOf(summary);
 const side=hintSideOf(powers);
 const shape={activations:side.activations,deliveries:side.delivered,
  remaining:Math.max(0,Math.min(R.POLICY.hintDeliveries-side.delivered,R.POLICY.hintActivations-side.activations)),
  charges:inventory?inventory.available.hint:0};
 /* Ranked, staked/direct, tournament, party, LAN, tutorial and practice are refused by the mode gate
    itself, and an unstated mode is not permission. */
 const reason=
  !summary?'NO_MATCH':
  !state_||!Array.isArray(state_.moves)?'INVALID_STATE':
  !R.powersAllowed(summary,'hint')?'MODE_NOT_ELIGIBLE':
  side.activations>=R.POLICY.hintActivations?'ACTIVATION_CAP':
  side.delivered>=R.POLICY.hintDeliveries?'DELIVERY_CAP':
  powers.pending.block?'BLOCK_WINDOW_OPEN':
  powers.pending.hint?'HINT_PENDING':
  state_.winner?'MATCH_FINISHED':
  summary.botPending?'BOT_DECISION_IN_FLIGHT':
  state_.turn!==R.HUMAN?'NOT_HUMAN_TURN':
  null;
 return reason?{eligible:false,reason,...shape}:{eligible:true,reason:'',...shape};
}
function applyHint(summary){
 const fence=live?live():null;
 const expected=fence?fence.revision:(Number.isInteger(summary.expectedRevision)?summary.expectedRevision:(matchRevisions.has(summary.id)?matchRevisions.get(summary.id):(summary.history?summary.history.revision:summary.state?.moves?.length)));
 if(fence&&(fence.id!==summary.id||(fence.revision||0)!==(summary.revision||0)))
  return {applied:false,reason:'STALE_REVISION',revision:fence.revision||0};
 if(expected!==undefined&&Number.isInteger(summary.revision)&&summary.revision!==expected)
  return {applied:false,reason:'STALE_REVISION',revision:expected};
 const revision=summary.revision||0;
 const verdict=hintEligibilityOf(summary,state.inventory);
 if(!verdict.eligible)return {applied:false,reason:verdict.reason,revision};
 /* A hint is an earned item, never a free tip: the banked entitlement is reserved first so an
    unbanked press refuses with the pure module's own NO_ENTITLEMENT and nothing is spent. */
 const attemptId=newAttemptId(host,clock());
 const held=R.reserve(state.inventory,'hint',{id:attemptId});
 if(!held.ok)return {applied:false,reason:held.reason,revision};
 const release=()=>{const back=R.release(held.inventory,'hint',{id:attemptId});if(back.ok){state.inventory=back.inventory;persist();}};
 if(!commit){release();return {applied:false,reason:'NO_LIVE_MATCH',revision};}
 /* The counters are spent purely before the match moves: an exhausted or already-pending slot
    refuses with the module's own reason instead of stranding the reservation. */
 const requested=R.hintRequest(powersOf(summary),R.HUMAN);
 if(!requested.ok){release();return {applied:false,reason:requested.reason,revision};}
 const square=recommender({state:summary.state,difficulty:summary.difficulty||null,first:summary.first||R.HUMAN});
 const legal=G.legal(summary.state);
 /* A recommendation the engine cannot make, or one that is not a legal square, is refused rather
    than shown: the player keeps every legal choice because this only ever highlights one square. */
 if(!square||!Number.isInteger(square.b)||!Number.isInteger(square.c)||!legal.some(move=>move.b===square.b&&move.c===square.c))
  {release();return {applied:false,reason:legal.length?'ENGINE_ILLEGAL_RECOMMENDATION':'NO_LEGAL_MOVE',revision};}
 const revealed=R.hintReveal(requested.powers,{square:{b:square.b,c:square.c}});
 if(!revealed.ok){release();return {applied:false,reason:revealed.reason,revision};}
 const installed=commit({type:'hint',matchId:summary.id||null,expectedRevision:summary.revision,
  powers:revealed.powers,square:{b:square.b,c:square.c},player:R.HUMAN,revision});
 if(installed===false){release();return {applied:false,reason:'LIVE_MATCH_CHANGED',revision};}
 const settled=R.commit(held.inventory,'hint',{id:attemptId});
 if(settled.ok)state.inventory=settled.inventory;
 persist();
 return {applied:true,reason:null,revision,square:{b:square.b,c:square.c},player:R.HUMAN};
}
return Object.freeze({
  version:VERSION,
  inventory(){
   const bucket=kind=>({available:state.inventory.available[kind],reserved:state.inventory.reserved[kind]?state.inventory.reserved[kind].token:null});
   return {version:INVENTORY_VERSION,undo:bucket('undo'),hint:bucket('hint'),undoBlock:bucket('undoBlock'),tacticalBlock:bucket('tacticalBlock')};
  },
  eligibility(matchSummary){
   const summary=summaryOf(matchSummary,live);
   if(!enabled())return {undo:{eligible:false,reason:'FEATURE_DISABLED',ply:summary?R.plies(summary):0,charges:summary?chargesOf(summary):0,perMatchUsed:summary?usedOf(summary):0},
    hint:{eligible:false,reason:'FEATURE_DISABLED',activations:0,deliveries:0,remaining:0,charges:0}};
   return {undo:eligibilityOf(summary),hint:hintEligibilityOf(summary,state.inventory)};
  },
  request(kind,context){
   return Promise.resolve().then(()=>{
    const now=clock();
    if(!R.KINDS.includes(kind))throw Error('INVALID_KIND');
    if(!enabled())return {earned:false,reason:'FEATURE_DISABLED',entitlement:null};
    const summary=summaryOf(context&&context.match||context,live);
    if(!summary)return {earned:false,reason:'NO_MATCH',entitlement:null};
    if(!SHIPPED.includes(kind))return {earned:false,reason:'POWER_NOT_SHIPPED',entitlement:null};
    if(inFlight)return {earned:false,reason:'REQUEST_IN_FLIGHT',entitlement:null};
    const activeBridge=bridge||nativeBridge(host);
    if(!activeBridge)return {earned:false,reason:'NATIVE_BRIDGE_UNAVAILABLE',entitlement:null};
    const consentReady=activeBridge.consent?activeBridge.consent()===true:false;
    const adReady=activeBridge.ready?activeBridge.ready()===true:false;
    if(!R.rewardedAllowed(summary,{consentReady,adReady},kind))
     return {earned:false,reason:!consentReady?'CONSENT_UNAVAILABLE':'AD_UNAVAILABLE',entitlement:null};
    const windowedNow=R.pacingWindow(state.pacing,now).pacing;
    const others=Math.max(0,Number.isSafeInteger(otherShown())?otherShown():0);
    const aggregate={...windowedNow,shown:Math.min(R.POLICY.rewardedDayCap,windowedNow.shown+others)};
    const gate=R.offerAllowed(aggregate,state.inventory,{kind,now});
    if(!gate.ok)return {earned:false,reason:gate.reason,entitlement:null};
    const offer=kind==='hint'?hintEligibilityOf(summary,state.inventory):eligibilityOf(summary);
    if(!offer.eligible||offer.charges>0)return {earned:false,reason:offer.charges>0?'CHARGE_AVAILABLE':offer.reason,entitlement:null};
    const id=newAttemptId(host,now);
    state={...state,attempt:{id,kind,at:now}};
    persist();
    inFlight=true;
    return Promise.resolve()
     .then(()=>activeBridge.present({kind,match:summary,attemptId:id,issueTicket:typeof options.issueTicket==='function'?options.issueTicket:null,context:{matchId:summary.id||null,revision:summary.revision??null,ply:R.plies(summary)}}))
     .then(value=>({outcome:value&&R.OUTCOMES.includes(value.outcome)?value.outcome:'failed'}),
           ()=>({outcome:'failed'}))
     .then(result=>{
      /* Exposure is recorded from the outcome the native lane reports: a shown-then-skipped ad
         consumes its aggregate slot and grants nothing, a no-fill or failed start consumes nothing. */
      const presented=R.applyPresentation(state.pacing,state.inventory,{id,kind,outcome:result.outcome,now:clock()});
      state={...state,pacing:presented.pacing,inventory:presented.inventory,attempt:null,
       lastAttempt:{id,kind,outcome:result.outcome,at:clock()}};
      persist();
      if(!presented.earned||presented.granted!==kind)
       return {earned:false,reason:result.outcome==='no-fill'||result.outcome==='failed'?'AD_NOT_PRESENTED':'AD_NOT_EARNED',entitlement:null};
      return {earned:true,reason:null,entitlement:kind};
     })
     .then(result=>{inFlight=false;return result;},
           error=>{inFlight=false;throw error;});
   });
  },
  /* Crown purchase: debit the injected spend lane first, then bank the charge. The pre-check
     guarantees the bank has room, so the grant is always an 'available' credit - the caller's
     Crowns can never be taken without a charge landing. */
  async purchase(kind){
   return Promise.resolve().then(()=>{
    if(!enabled())throw Error('FEATURE_DISABLED');
    if(!SHIPPED.includes(kind))throw Error('INVALID_KIND');
    if(R.banked(state.inventory,kind))throw Error('BANK_FULL');
    const spend=options.spend;
    if(typeof spend!=='function')throw Error('PURCHASE_UNAVAILABLE');
    const id='purchase-'+clock()+'-'+Math.random().toString(36).slice(2,10);
    return Promise.resolve().then(()=>spend(kind,id)).then(()=>{
     const added=R.bank(state.inventory,kind,{id});
     if(!added.ok)throw Error(added.reason||'BANK_FAILED');
     state={...state,inventory:added.inventory};
     persist();
     return {ok:true,kind};
    });
   });
  },
  apply(kind,context){
   const summary=summaryOf(context,live);
   const revision=summary&&Number.isInteger(summary.revision)?summary.revision:0;
   if(!enabled())return {applied:false,reason:'FEATURE_DISABLED',revision};
   if(!summary)return {applied:false,reason:'NO_MATCH',revision};
   if(!R.KINDS.includes(kind))throw Error('INVALID_KIND');
   if(!SHIPPED.includes(kind))return {applied:false,reason:'POWER_NOT_SHIPPED',revision};
   return kind==='hint'?applyHint(summary):applyUndo(summary);
  },
  pacing(){
   const windowed=R.pacingWindow(state.pacing,clock());
   const others=Math.max(0,Number.isSafeInteger(otherShown())?otherShown():0);
   const total=Math.min(R.POLICY.rewardedDayCap,windowed.pacing.shown+others);
   return {rewardedShownToday:total,rewardedDayCap:R.POLICY.rewardedDayCap,nextEligibleAt:windowed.nextEligibleAt};
  }
 });
}
/* Install the frozen global. A host that keeps the switch off never gets the object at all. */
function install(options={}){
 const target=options.root||globalThis;
 const api=options.api||createPowers(options);
 target.MegaPowers=api;
 return api;
}
return Object.freeze({VERSION,INVENTORY_VERSION,STATE_VERSION,SHIPPED,freshState,migrateState,mergeInventory,mergePacing,matchPowers,nativeBridge,createPowers,install});
});
