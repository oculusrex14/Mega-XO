/* Mega XOXO: shared local UI and authenticated economy adapter. */
(()=>{
'use strict';
/* V5.1 guided-practice hooks */
const T=window.MegaTutorial;
/* V5.1 worker bot hooks */
const BR=window.MegaBotRuntime,BC=window.MegaBotContract,A=BR?new BR.Client():null;
const LA=window.MegaLocalAI,LS=window.MegaLocalSession,BP=window.MegaBotPack;
/* V5.2 rewarded powers: the pure rules module plus its frozen `window.MegaPowers` adapter. Both
   stay inert while the kill switch is off. */
const RW=window.MegaRewind,PW=window.MegaPowersAdapter;
const POWERS_KEY='mega_v52_powers',POWERS_FLAG='mega_v52_powers_enabled';
/* The rewarded powers are a shipped feature, so they default ON. Both switches are explicit off
   switches and either one is enough: `localStorage['mega_v52_powers_enabled']==='off'` disables them,
   and so does a host that publishes `window.MEGA_POWERS_ENABLED === false`. Anything else (including
   no preference) keeps them available, and a player without ad inventory simply sees a truthful
   'unavailable' state. */
const POWERS_ON=(()=>{
 /* The emergency switch is authoritative: a stored 'off' disables the lane even if a host flag
    says otherwise. Without a stored preference an explicit host flag decides, and the shipped
    default is available. */
 try{if(localStorage.getItem(POWERS_FLAG)==='off')return false;}catch{}
 if(window.MEGA_POWERS_ENABLED===true)return true;
 if(window.MEGA_POWERS_ENABLED===false)return false;
 return true;
})();
/* Persisted powers state lives in the adapter's own storage lane (`readPowersState`/
   `writePowersState`), which migrates it leaf by leaf; the app never reads it directly. */
function readPowersState(){try{return JSON.parse(localStorage.getItem(POWERS_KEY)||'null');}catch{return null;}}
function writePowersState(value){try{localStorage.setItem(POWERS_KEY,JSON.stringify(value));}catch{}}
let localSession=LS?LS.createSession({baseURL:location?.href}):null;
const G=window.MegaGame,D=window.MegaDomain,I=window.MegaIcons,$=s=>document.querySelector(s);
const KEY='mega_v32_state',SNAPSHOT_VERSION=2,escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const parse=(key)=>{try{return JSON.parse(localStorage.getItem(key)||'null');}catch{return null;}};
let data=parse(KEY);if(!data||data.version!==3.2){data=D.fresh();const old=parse('mega_v3_settings');if(old){Object.assign(data.settings,old);data.settings.haptics=old.haptic!==false;}data.legacy=parse('mega_v3_stats');}
data.playSeconds=data.playSeconds||{};D.migrate(data);data.profile=data.profile||{};
const legacyThemeMap={dark:'midnight',paper:'paperclub',neon:'afterhours',light:'vector'};
if(legacyThemeMap[data.settings.theme])data.settings.theme=legacyThemeMap[data.settings.theme];
if(!data.profile.friendCode){const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';data.profile.friendCode='MEGA-'+Array.from({length:4},()=>chars[Math.floor(Math.random()*chars.length)]).join('');}
if(!['vector','midnight','paperclub','afterhours'].includes(data.settings.theme))data.settings.theme='vector';
let page='play',mode='bot',difficulty='Medium',first='X',onlineType='ranked',statsMode='bot',statsDifficulty='all',rankLeague='all',rankScope='global',rankMetric='rating';
let online={ready:false,profile:null,rows:[],invitations:[],products:[]},target=null,pendingExchange=null,refreshSerial=0,onlinePoll=null,onlinePollBusy=false,onlinePending=false,waitingId=null,queueSubmission=null,queueCancelling=false,connectionState='online';
const NET=window.MegaNetwork,opId=()=>globalThis.crypto?.randomUUID?.()||String(Date.now())+'-'+Math.random().toString(36).slice(2);
let match=null,botTimer=null,toastTimer=null,ctx=null,ambient=null,sheetKind='',sheetReturnFocus=null,lastTick=performance.now(),lastInput=performance.now(),lastSave=0,powers=null;
/* Rewarded-power controls: the host row injected into the match control zone, its last painted
   signature, and the square the shipped Tactical Power is currently recommending. */
let powersControls=null,powersPainted='',hintSquare=null;
const themeNames={vector:'Vector Light',midnight:'Midnight Club',paperclub:'Paper Club',afterhours:'After Hours'};
const lightBadges=[['#ead9c5','#715234'],['#e3e8ed','#58646b'],['#dae3f0','#465c7d'],['#f4dfc6','#7c4b20'],['#e3edf4','#4a6276'],['#f5e7b2','#805b0c'],['#d7f0fa','#176d8a'],['#d7efdf','#23673f'],['#eed7f0','#784576'],['#e7defa','#644991'],['#faf0c7','#805b0c']];
const darkBadges=[['#42372d','#e4c49c'],['#343f48','#d0dce5'],['#283b53','#b8d1f7'],['#4a3526','#f0bf91'],['#314455','#d6eafa'],['#4c4123','#f2d88d'],['#173e52','#9ce2f8'],['#233e31','#a5e4bf'],['#442e49','#e7b8ee'],['#362b51','#d9c2fc'],['#514224','#fff0aa']];
const icon=n=>I.icon(n),badge=(t,large=false)=>{const c=(['midnight','afterhours'].includes(data.settings.theme)?darkBadges:lightBadges)[t.index];return '<span class="badge-wrap" style="--badge-bg:'+c[0]+';--badge-ink:'+c[1]+'">'+I.badge(t,large)+'</span>';};
function refreshIcons(){requestAnimationFrame(()=>I.refresh?.());}
function walletData(){return online.ready&&online.profile?online.profile.wallet:data.wallet;}
function renderWalletSummary(){const w=walletData(),coins=w.coins.toLocaleString(),crowns=w.crowns.toLocaleString();$('#walletAmount').textContent=coins;$('#walletCrownAmount').textContent=crowns;$('#walletButton').setAttribute('aria-label','Open wallet. Coins '+coins+'. Crowns '+crowns+'.');}
function myTier(){return online.profile?.tier||'wood';}
function initPowers(){
 if(!PW||powers)return powers;
 powers=PW.createPowers({
  enabled:()=>POWERS_ON,
  /* The aggregate ceiling is shared with the cosmetic rewarded lane, which books its presentations
     in the ad-cadence store. Report today's count from there so Credits and Undo cannot together
     exceed the owner's ten-per-UTC-day ceiling. */
  otherShown:()=>{
   const M=window.MegaMonetization;if(!M)return 0;
   try{const raw=JSON.parse(localStorage.getItem('mega_v35_ad_cadence')||'null');
    return raw?M.rewardedExposure(raw).shownToday:0;}catch{return 0;}
  },
  storage:{read:readPowersState,write:writePowersState},
  /* Tactical Power recommends with the canonical Expert search — the same rules engine the match
     already plays with — and never invents a square. The adapter re-validates the answer against
     G.legal, so a bad recommendation is refused rather than highlighted. */
  recommender:info=>G.choose(info.state,'Expert'),
  live:()=>match?{
   id:match.id,
   state:match.state,
   mode:match.mode,
   difficulty:match.difficulty,
   first:match.first,
   practice:match.practice,
   online:!!match.online,
   reason:match.pendingTerminal?match.pendingTerminal.reason:match.terminalReason||null,
   revision:match.powersHistory?match.powersHistory.revision:match.state.moves.length,
   generation:match.powersHistory?match.powersHistory.generation:0,
   history:match.powersHistory||null,
   powers:match.powers||null,
   charges:match.powers?match.powers.botUndo.charges:0,
   used:match.powers?match.powers.botUndo.presses:0,
   botPending:!!botTimer
  }:null,
  commit:cmd=>{
   if(!match)return false;
   if(match.id!==cmd.matchId)return false;
   if(cmd.type==='grant'){
    match.powers=cmd.powers;
    save();
    return true;
   }
   if(cmd.type==='hint'){
    match.powers=cmd.powers;
    hintSquare={...cmd.square};
    save();
    renderPowerControls();
    paint();
    return true;
   }
   if(cmd.type!=='rewind')return false;
   if(match.powersHistory&&match.powersHistory.revision!==cmd.expectedRevision)return false;
   match.state=cmd.state;
   match.powers=cmd.powers;
   match.powersHistory=cmd.history;
   match.last=cmd.last;
   match.pendingTerminal=null;
   match.recorded=false;
   save();render();paint();
   return true;
  },
  // Core issues the opaque reward ticket; the native lane re-validates it against the build's
  // configured unit before the SDK runs. Without an account API the ticket is unavailable and the
  // reward path fails closed, which is correct for browser/offline play.
  issueTicket:info=>{
   const API=window.MegaAccount;
   if(!API||typeof API.request!=='function')return Promise.resolve(null);
   return API.request('/api/monetization/reward-ticket',{kind:info.kind,platform:info.platform})
    .then(r=>r&&r.ticket?r.ticket:null)
    .catch(()=>null);
  }
 });
 if(POWERS_ON){
  PW.install({root:window,api:powers});
 }
 return powers;
}
function attachPowers(m, saved){
 initPowers();
 const on=POWERS_ON;
 if(!on||!PW||!RW)return;
 m.powers=PW.matchPowers(saved?.powers);
 if(saved?.powersHistory)m.powersHistory={...saved.powersHistory};
 else{
  m.powersHistory=RW.createHistory(m.first);
  for(const ply of m.state.moves){
   const rec=RW.record(m.powersHistory,m.powersHistory.nodes[m.powersHistory.active].state,ply,{revision:m.powersHistory.revision});
   if(rec.ok)m.powersHistory=rec.history;
  }
 }
 m.terminalUndoEligible=(target,reason,result)=>{
  if(!powers||!POWERS_ON)return false;
  if(target.mode!=='bot'||target.practice||target.online||result!=='loss'||reason!=='line')return false;
  const elig=powers.eligibility(target).undo;
  return elig.eligible;
 };
}
/* One match summary for every power decision. The adapter's own eligibility, request and apply all
   read this shape, so the control zone, the stats sheet and the terminal offer cannot disagree
   about what is eligible. Consent and ad readiness are deliberately absent: `request` reads those
   from the native lane itself, and an app that asserted them could only lie about them. */
function powerContext(reason,botPending=!!botTimer){
 const m=match;if(!m)return null;
 return {id:m.id,state:m.state,mode:m.mode,first:m.first,reason,
  practice:m.practice,online:!!m.online,
  revision:m.powersHistory?m.powersHistory.revision:m.state.moves.length,
  generation:m.powersHistory?m.powersHistory.generation:0,
  history:m.powersHistory||null,powers:m.powers||null,
  charges:m.powers?m.powers.botUndo.charges:0,used:m.powers?m.powers.botUndo.presses:0,
  botPending};
}
/* Why a counter is not a control: Undo Block and Tactical Block answer ANOTHER PLAYER's power use,
   so they only mean anything in the two-player Casual protocol with authoritative resolution. That
   protocol is not built, and the owner's rule that a Bot never secretly gains counter powers means
   no honest Bot-mode counter exists — so they are disclosed, disabled, and never faked. */
const COUNTER_COPY='Counter controls are unavailable until authoritative resolution is supported.';
function counterDisclosure(){return '<div class="note"><b>Undo Block &middot; Tactical Block</b><p class="caption">These answer another player\'s power use, so they need a two-player Casual match with authoritative resolution. '+COUNTER_COPY+' The Bot never secretly gains counter powers, so no Bot-mode counter is offered.</p><div class="split"><span>Undo Block</span><span class="pill">Unavailable</span></div><div class="split"><span>Tactical Block</span><span class="pill">Unavailable</span></div></div><p class="caption">A suggestion is never revealed to a counter while a counter window is open, and a counter never reveals a suggestion that was already shown.</p>';}
/* The rewarded path is disclosed before it starts: the ad earns the item, and a shown-then-skipped
   ad uses one of the ten daily rewarded views without earning anything. */
function powerReasonText(reason){
 return ({NO_MATCH:'No match is in progress.',FEATURE_DISABLED:'Rewarded powers are turned off.',
  NATIVE_BRIDGE_UNAVAILABLE:'This build has no rewarded-ad lane, so no ad can be shown.',
  CONSENT_UNAVAILABLE:'Ad consent is not available here, so no ad can be shown.',
  AD_UNAVAILABLE:'No rewarded ad is available right now. Try again later.',
  DAY_CAP:'Your ten rewarded views for today (UTC) are used up. They reset at 00:00 UTC.',
  SPACING:'The next rewarded ad unlocks about two minutes after the last one.',
  BANK_FULL:'You already hold the maximum of one earned item of that type.',
  CHARGE_AVAILABLE:'You still have a banked charge. Use it before earning another.',
  REQUEST_IN_FLIGHT:'An ad request is already in progress.',
  NO_ENTITLEMENT:'No earned item of that type is banked yet.',
  ACTIVATION_CAP:'This match already used its three activations for that power.',
  DELIVERY_CAP:'This match already delivered the maximum number of that power.',
  HINT_PENDING:'A suggestion is already waiting to resolve.',
  BLOCK_WINDOW_OPEN:'A counter window is open, so the suggestion stays hidden.',
  MODE_NOT_ELIGIBLE:'Powers are not available in this match.',
  NOT_HUMAN_TURN:'Wait for your turn.',
  MATCH_FINISHED:'This match is over.',
  BOT_DECISION_IN_FLIGHT:'The Bot is still thinking. Wait for its reply.',
  STALE_REVISION:'The match moved on. Try again.',
  LIVE_MATCH_CHANGED:'The match changed before that could apply. Nothing was spent.',
  ENGINE_ILLEGAL_RECOMMENDATION:'The engine could not name a legal square. Nothing was spent.',
  NO_LEGAL_MOVE:'There is no legal square to recommend.',
  AD_NOT_PRESENTED:'The ad never opened, so nothing was earned and no daily view was used.',
  AD_NOT_EARNED:'The ad did not earn a reward, so nothing was banked.',
  POWER_NOT_SHIPPED:'That power is not available yet.'})[reason]||'That did not complete. Nothing was spent.';
}
/* Host row for the rewarded controls. It is injected into the existing Bot match control zone beside
   Rules/Restart/Stats, so a banked charge is one tap away instead of buried in the stats sheet, and
   it reuses that zone's own button styles rather than adding a second visual convention. */
function powerControlsHost(){
 const zone=$('.match-controls');
 if(!zone)return null;
 if(!powersControls){
  powersControls=document.createElement('span');
  powersControls.className='powers-slot';
  /* The control zone is a grid, so the injected row spans every column and lays its own buttons out
     in one flex row. No stylesheet change: the zone's own `.match-controls .button` styling applies. */
  powersControls.style.cssText='grid-column:1 / -1;display:flex;gap:7px;padding-top:5px';
  zone.appendChild(powersControls);
 }
 if(!powersControls.isConnected){zone.appendChild(powersControls);}
 return powersControls;
}
function renderPowerControls(){
 const on=POWERS_ON;
 /* A Bot match without practice or an online opponent is the only place a rewarded control may
    exist. Ranked, casual, staked, tournament, party and LAN matches are never Bot matches, and the
    pure module refuses every one of them anyway. With the switch off nothing is created at all. */
 const live=on&&powers&&match&&match.mode==='bot'&&!match.practice&&!match.online;
 if(!live){
  if(powersControls){if(powersPainted!==''){powersControls.innerHTML='';powersPainted='';}powersControls.hidden=true;}
  return;
 }
 const host=powerControlsHost();if(!host)return;
 const ctx=powerContext(null,!!botTimer);
 const elig=powers.eligibility(ctx);
 const charges=ctx.charges,banked=powers.inventory().hint.available>=1;
 const signature=[elig.undo.eligible,charges,elig.hint.eligible,banked,ctx.botPending].join('|');
 if(signature===powersPainted&&!host.hidden)return;
 powersPainted=signature;host.hidden=false;
 const undo=elig.undo.eligible?'<button class="button quiet" data-action="botundo" aria-label="'+(charges?'Undo your last turn with '+charges+' earned charge'+(charges===1?'':'s')+' left':'Watch one optional ad to earn two Undo presses')+'">'+(charges?'Undo last turn ('+charges+' left)':'Undo with a rewarded ad')+'</button>':'';
 const hint=elig.hint.eligible?'<button class="button quiet" data-action="bothint" aria-label="'+(banked?'Tactical Power: show the recommended legal square':'Watch one optional ad to earn one Tactical Power')+'">'+(banked?'Tactical Power':'Tactical Power (rewarded)')+'</button>':'';
 /* The counter disclosure is always reachable in a Bot match so the two kinds are explained rather
    than silently missing. */
 host.innerHTML=undo+hint+'<button class="button quiet" data-action="powercounters">Counters</button>';
}
const offlineSnapshot=()=>{
 const snapshot={id:match.id,version:SNAPSHOT_VERSION,first:match.first,mode:match.mode,difficulty:match.difficulty,practice:match.practice,tutorial:T?.snapshot(match)||null,bot:match.bot||null,moves:match.state.moves,active:match.active,turnLimit:match.turnLimit,turnRemaining:match.turnRemaining};
 if(match.resultClass==='unverified-local-ai'||match.difficulty==='Impossible'||match.engine==='neural')snapshot.localAi=LA?LA.snapshot(match):null;
 if(match.powers)snapshot.powers=match.powers;
 if(match.powersHistory)snapshot.powersHistory={...match.powersHistory};
 if(match.pendingTerminal){
  /* A pending Bot loss survives an app restart with its original plies, result, quota use and
     reward attempt, so the choice can be resolved honestly and no ad is ever assumed completed. */
  const record=match.pendingTerminal.record||null;
  snapshot.pendingTerminal={reason:match.pendingTerminal.reason,record:record?{...record,moves:match.state.moves.length,activeSeconds:Math.round(match.active)}:null};
 }
 return snapshot;
};
function save(){try{
 const live=match&&!match.online&&!match.recorded&&!$('#gameScreen').hidden;
 if(live&&(!match.state.winner||match.pendingTerminal))data.offlineMatch=offlineSnapshot();
 else if(match?.recorded||(match?.state.winner&&!match?.pendingTerminal))delete data.offlineMatch;
 localStorage.setItem(KEY,JSON.stringify(data));window.dispatchEvent(new Event('mega:local-save'));
 }catch{notify('Storage is unavailable. Progress lasts for this session only.');}}
function openNeuralRecovery(err){if(!match)return;const code=err?.code||err?.message||'INFERENCE_FAILED';open('Impossible Bot Recovery','<div class="ai-pack-recovery"><p><strong>Background thinking could not complete.</strong> ('+escape(code)+')</p><p class="caption">All completed human moves are preserved. Choose recovery:</p></div>'+fullButton('Retry move','retrybot')+fullButton('Continue with Expert bot (Unverified, no rewards)','fallbackexpert','',true)+fullButton('Resign match','resign','',true),'recovery');}
function notify(text){const t=$('#toast');t.textContent=text;t.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('visible'),2800);}
function applyTheme(){document.documentElement.dataset.theme=data.settings.theme;document.body.dataset.theme=data.settings.theme;document.documentElement.dataset.motion=data.settings.motion?'reduced':'full';document.querySelector('meta[name="theme-color"]').content=getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();window.MegaNativeTheme?.apply?.({ theme: data.settings.theme, dark: ['midnight','afterhours'].includes(data.settings.theme), surface: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() });updateBrandMark();}
function updateBrandMark(){
 const host=$('#brandIcon');if(!host)return;
 const source='assets/p21/logos/mega-xoxo-'+data.settings.theme+'-mark.webp';
 let image=host.querySelector('img.brand-theme-mark');
 if(!image){image=document.createElement('img');image.className='brand-theme-mark';image.alt='';image.width=34;image.height=34;image.decoding='async';host.replaceChildren(image);}
 if(image.getAttribute('src')!==source)image.setAttribute('src',source);
}

function tone(freq=500){if(!data.settings.sound)return;try{const C=window.AudioContext||window.webkitAudioContext;if(!C)return;ctx=ctx||new C();ctx.resume().catch(()=>{});const o=ctx.createOscillator(),a=ctx.createGain();o.type='sine';o.frequency.value=freq;a.gain.setValueAtTime(.035,ctx.currentTime);a.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+.12);o.connect(a);a.connect(ctx.destination);o.start();o.stop(ctx.currentTime+.14);}catch{}}
function syncAudio(){try{if(ambient){ambient.osc.stop();ambient=null;}if(!data.settings.music||document.hidden)return;const C=window.AudioContext||window.webkitAudioContext;if(!C)return;ctx=ctx||new C();ctx.resume().catch(()=>{});const osc=ctx.createOscillator(),gain=ctx.createGain();osc.frequency.value=130.81;gain.gain.value=.004;osc.connect(gain);gain.connect(ctx.destination);osc.start();ambient={osc,gain};}catch{}}
function haptic(){if(data.settings.haptics&&navigator.vibrate)navigator.vibrate(10);}
const seconds=s=>{if(s===null||s===undefined)return '--';const n=Math.round(s);return Math.floor(n/60)+':'+String(n%60).padStart(2,'0');};
const button=(text,action,value='',quiet=false)=>'<button class="button '+(quiet?'quiet':'')+'" data-action="'+action+'" data-value="'+escape(value)+'">'+text+'</button>';
const fullButton=(text,action,value='',quiet=false)=>'<button class="button full '+(quiet?'quiet':'')+'" data-action="'+action+'" data-value="'+escape(value)+'">'+text+'</button>';
const opts=(items,selected)=>items.map(([value,label])=>'<option value="'+value+'" '+(value===selected?'selected':'')+'>'+label+'</option>').join('');
const field=(title,id,options)=>'<label class="field">'+title+'<select id="'+id+'">'+options+'</select></label>';
const empty=(symbol,title,text)=>'<div class="empty">'+icon(symbol)+'<h3>'+title+'</h3><p>'+text+'</p></div>';
function seasonProgress(s){if(!s)return '';return Math.min(s.games||0,s.requirements?.games||5)+' / '+(s.requirements?.games||5)+' games · '+Math.min(s.queueGames||0,s.requirements?.queueGames||3)+' / '+(s.requirements?.queueGames||3)+' matchmade · '+Math.min(s.uniqueOpponents||0,s.requirements?.uniqueOpponents||3)+' / '+(s.requirements?.uniqueOpponents||3)+' opponents';}
function seasonName(s){return s?.id?s.id.replace('-', ' '):'Current season';}
function render(){
 renderWalletSummary();
 $('#navigation').innerHTML=[['play','Play','board'],['friends','Friends','users'],['rank','Rank','trophy'],['stats','Stats','chart'],['quests','Quests','quest']].map(([id,name,symbol])=>'<button class="nav-button '+(id===page?'active':'')+'" data-action="nav" data-value="'+id+'" '+(id===page?'aria-current="page"':'')+'>'+icon(symbol)+'<span>'+name+'</span></button>').join('');
 $('#page').innerHTML=({play:home,friends:friends,rank:ranks,stats:statsView,quests:quests,rewards:rewards})[page]();refreshIcons();
}
function home(){
 const chip=(label,action,value,active)=>'<button class="setup-chip '+(active?'active':'')+'" data-action="'+action+'" data-value="'+value+'" aria-pressed="'+active+'">'+label+'</button>';
 const modes=[['bot','bot','Vs Bot','Five skill levels, fully offline'],['local','users','Pass & Play','Two players on one device'],['online','swords','Play Online','Ranked or casual matchmaking'],['private','link','Private Match','Create or join a friend room'],['tournament','trophy','Tournaments','Ten players. One table. Bigger prizes.']];
 const rankTier=D.tier(myTier()),rankFee=rankTier.fee;
 let setup='';
 if(['bot','local'].includes(mode)){
  setup='<div class="setup old-setup">'+(mode==='bot'?'<div class="setup-block"><div class="setup-title"><b>Bot difficulty</b><span>Strategy depth</span></div><div class="setup-chips">'+G.LEVELS.map(x=>chip(x.toUpperCase(),'difficulty',x,difficulty===x)).join('')+'</div></div>':'')+'<div class="setup-block"><div class="setup-title"><b>First move</b><span>Who starts</span></div><div class="setup-chips two">'+chip('X STARTS','first','X',first==='X')+chip('O STARTS','first','O',first==='O')+'</div></div><div class="setup-block"><div class="setup-title"><b>Turn timer</b><span>Optional</span></div><div class="setup-chips three">'+[['0','OFF'],['30','30 SEC'],['60','60 SEC']].map(([v,l])=>chip(l,'settimer',v,String(data.settings.timer||0)===v)).join('')+'</div></div>';
 }
 else if(mode==='online')setup='<div class="setup old-setup"><div class="setup-block"><div class="setup-title"><b>Match type</b><span>Choose your queue</span></div><div class="setup-chips two">'+chip('RANKED','onlinetype','ranked',onlineType==='ranked')+chip('CASUAL','onlinetype','casual',onlineType==='casual')+'</div></div><p class="setup-note">'+(onlineType==='ranked'?'Entry cost: '+rankFee+' Coins at your current '+rankTier.name+' league. Skill rating applies.':'Free to play. No rating changes.')+'</p></div>';
 const placed=online.profile?.games>=D.POLICY.placements,s=online.profile?.season,seasonReady=!!s?.qualified,rankTitle=!placed?'Your ranked journey starts here':!seasonReady?'Season requalification':D.tier(myTier()).name,rankSub=!placed?'Unranked &middot; '+Math.min(10,online.profile?.games||0)+' / 10 placement games':!seasonReady?seasonProgress(s):online.profile.rating+' Elo · '+seasonName(s);
 return '<div class="hero home-hero"><h1><span class="home-title-main">The Ultimate <span class="home-game-name">Tic-tac-toe.</span></span><br><em>Think bigger.</em></h1><p>Win the small boards to win the big one. Every move also decides where your opponent plays next.</p></div>'+
 '<button class="card rank-summary" data-action="nav" data-value="rank">'+badge(D.tier(myTier()))+'<span class="grow"><b>'+rankTitle+'</b><small>'+rankSub+'</small></span>'+icon('arrow')+'</button>'+
 '<div class="section-heading"><h3>Choose mode</h3><span class="eyebrow">YOUR MOVE</span></div><div class="mode-list">'+modes.map(([id,sym,title,desc])=>'<button class="mode '+(id===mode?'active':'')+'" data-action="mode" data-value="'+id+'" aria-pressed="'+(id===mode)+'"><span class="mode-symbol">'+icon(sym)+'</span><span class="mode-copy"><strong>'+title+'</strong><small>'+desc+'</small></span>'+icon('arrow')+'</button>').join('')+'</div>'+setup+
 fullButton(icon('play')+(mode==='tournament'?'Browse Tournaments':mode==='private'?'Open Private Lobby':mode==='online'?'Find Match':'Start Match'),'start')+
 '<button class="learn" data-action="tutorial">'+icon('tutorial')+'<span><strong>New to Mega XOXO?</strong><small>Learn the rules in under a minute</small></span>'+icon('arrow')+'</button>'+
 '<div class="home-quests"><span><b>Daily quests</b><small>Earn coins through play.</small></span>'+button('View quests','nav','quests',true)+'</div>';
}
function rewards(){return window.MegaMonetizationUI?.pageMarkup?.()||'<div class="mono-page"><div class="mono-page-head"><p class="mono-kicker">STYLE &amp; REWARDS</p><h2>Rewards &amp; Themes</h2><p class="caption">Loading your rewards...</p></div></div>';}
function friends(){if(window.MegaCommunity?.friendsMarkup)return window.MegaCommunity.friendsMarkup();return '<div class="panel-head friends-head"><div class="eyebrow">Social</div><h2>Friends</h2><p>Challenge people you know, or add someone you just played.</p></div>'+
 '<div class="friend-search"><div class="friend-search-wrap">'+icon('search')+'<input id="friendName" aria-label="Search username" placeholder="Search username" maxlength="30" autocomplete="off"></div><button class="friend-add" data-action="findfriend">'+icon('userPlus')+'<span>Add</span></button></div>'+
 '<div class="friend-code-card"><div><span>YOUR FRIEND CODE</span><div class="friend-code">'+escape(online.profile?.friendCode||'Sign in')+'</div></div><button class="copy-friend" data-action="copyfriend" aria-label="Copy friend code">'+icon('copy')+'</button></div>'+
 '<div class="section-title friends-section-title"><span>Friends</span><small>'+(online.profile?.friends||[]).filter(p=>p.online).length+' ONLINE</small></div>'+
 ((online.profile?.friends||[]).length?(online.profile.friends.map(p=>'<div class="standing"><span></span>'+badge(D.tier(p.tier))+'<div><b>'+escape(p.name)+'</b><small>'+D.tier(p.tier).name+'</small></div>'+button('Challenge','friendchallenge',p.id,true)+'</div>').join('')):'<div class="friend-empty"><div class="friend-empty-icon">'+icon('usersRound')+'</div><b>Your squad is empty</b><p>Add a friend by username or share your code.</p></div>')+
 ((online.profile?.friendRequests||[]).length?'<div class="section-heading"><h3>Friend requests</h3></div>'+online.profile.friendRequests.map(id=>'<div class="ledger"><span>'+escape(id)+'</span>'+button('Accept','acceptfriend',id,true)+'</div>').join(''):'')+
 (online.invitations.length?'<div class="section-heading"><h3>Challenges</h3></div>'+online.invitations.map(m=>'<div class="ledger"><span>'+escape(m.challengerName||m.players[0])+'<small>'+(m.quote.rated?'Ranked':'Unranked')+' &middot; '+m.quote.pool+' '+(m.quote.currency||'entry')+'</small></span>'+button('Review','reviewinvite',m.id,true)+'</div>').join(''):'');}
function statsView(){const tabs='<div class="tabs">'+[['bot','Bot'],['ranked','Ranked'],['casual','Casual'],['friend','Friends'],['tournament','Tournaments']].map(([id,name])=>'<button class="tab '+(statsMode===id?'active':'')+'" data-action="statmode" data-value="'+id+'">'+name+'</button>').join('')+'</div>';
 const difficultyOptions=[['all','All difficulties'],...G.LEVELS.map(x=>[x,x])];
 if(!difficultyOptions.some(([value])=>value===statsDifficulty))statsDifficulty='all';
 if(statsMode==='tournament'){const t=online.profile?.tournament||online.profile?.stats?.tournament||D.tournamentStats();return '<h2>Your game, in numbers</h2><p class="caption">Competitive public tournament results.</p>'+tabs+'<div class="section-heading"><h3>Tournament record</h3><span class="eyebrow">'+t.entered+' events</span></div><div class="stats-grid">'+[['Wins',t.wins],['Runner-up',t.runnerUp],['Top 3',t.top3],['Top 5',t.top5],['Best finish',t.bestFinish===null?'--':'#'+t.bestFinish],['Average finish',t.averageFinish===null?'--':t.averageFinish.toFixed(1)],['Win rate',t.winRate===null?'--':(100*t.winRate).toFixed(1)+'%'],['Premium wins',t.premiumWins]].map(([label,value])=>'<div class="stat"><span>'+label+'</span><strong>'+value+'</strong></div>').join('')+'</div><p class="caption">Only completed public tournaments count. Private/friendly events and refunded tournaments do not.</p>';}
 const records=statsMode==='bot'?data.records:(online.profile?.records||[]),a=D.aggregate(records,statsMode,statsDifficulty);
 return '<h2>Your game, in numbers</h2><p class="caption">Different opponents. Separate records.</p>'+tabs+(statsMode==='bot'?field('Bot difficulty','statsDifficulty',opts(difficultyOptions,statsDifficulty)):'')+
 '<div class="section-heading"><h3>'+({bot:'Against the bot',ranked:'Ranked matches',casual:'Casual matches',friend:'Friend matches'}[statsMode])+'</h3><span class="eyebrow">'+a.games+' games</span></div><div class="stats-grid">'+[['Win rate',a.winRate===null?'--':(a.winRate*100).toFixed(1)+'%'],['Wins',a.wins],['Average game',seconds(a.averageSeconds)],['Hours played',((data.playSeconds[statsMode+':'+statsDifficulty]??a.hours*3600)/3600).toFixed(2)],['Losses',a.losses],['Draws',a.draws]].map(([label,value])=>'<div class="stat"><span>'+label+'</span><strong>'+value+'</strong></div>').join('')+'</div><p class="caption">Win rate = wins / all completed games, including draws. Average game time uses completed matches. Total hours also includes unfinished sessions.</p>'+
 '<div class="section-heading"><h3>Recent games</h3></div>'+records.filter(r=>r.mode===statsMode).slice(-6).reverse().map(r=>'<div class="ledger"><span>'+escape(r.difficulty||r.mode)+'<small>'+new Date(r.at).toLocaleDateString()+' &middot; '+seconds(r.activeSeconds)+'</small></span><b>'+r.result+'</b></div>').join('')+(a.games?'':empty('chart','Your first game goes here','Finish a match to start your record.'));
}
function rankDescription(t){return t.cap?'Up to '+t.cap.toLocaleString()+' exclusive worldwide seats &middot; '+t.min+'+ Elo':t.name==='Emerald'?'1900+ Elo &middot; the highest open league':t.min+' &ndash; '+(D.TIERS[t.index+1].min-1)+' Elo';}
function rankSeasonCard(s){if(rankMetric!=='rating'||!s)return '';const req=s.requirements||{},gamesReq=req.games||5,queueReq=req.queueGames||3,opponentReq=req.uniqueOpponents||3,games=Math.min(s.games||0,gamesReq),queueGames=Math.min(s.queueGames||0,queueReq),opponents=Math.min(s.uniqueOpponents||0,opponentReq),score=s.qualified?(online.profile?.rating||0)+' Elo':games+' / '+gamesReq;return '<section class="card rank-season-card"><div class="rank-season-head"><div class="rank-season-title"><span class="eyebrow">'+seasonName(s)+'</span><strong>'+(s.qualified?'Ranked season qualified':'Requalification in progress')+'</strong></div><strong class="rank-season-score">'+score+'</strong></div>'+(s.qualified?'<p class="rank-season-copy">Your Elo carried into this season. Keep playing to remain eligible for scarce elite seats.</p>':'<div class="rank-season-progress"><span><b>'+games+' / '+gamesReq+'</b> games</span><span><b>'+queueGames+' / '+queueReq+'</b> matchmade</span><span><b>'+opponents+' / '+opponentReq+'</b> opponents</span></div><p class="rank-season-copy">Your underlying Elo is preserved while you requalify.</p>')+'</section>';}
function ranks(){
 const t=D.tier(rankLeague==='all'?myTier():rankLeague),rows=online.rows,s=online.profile?.season,seasonCard=rankSeasonCard(s);
 return '<h2>Find your league</h2><p class="caption">Skill and wealth. Two separate leaderboards.</p>'+seasonCard+'<div class="tabs">'+[['rating','Skill'],['wealth','Wealth']].map(([id,label])=>'<button class="tab '+(id===rankMetric?'active':'')+'" data-action="metric" data-value="'+id+'">'+label+'</button>').join('')+'</div>'+
 '<div class="two-fields">'+field('Leaderboard','rankScope',opts([['global','Global'],['local',data.profile.region+' (country)']],rankScope))+field('League','rankLeague',opts([['all','All leagues'],...D.TIERS.map(t=>[t.id,t.name])],rankLeague))+'</div>'+
 '<div class="league-strip" aria-label="Browse leagues">'+D.TIERS.map(x=>'<button class="league '+(x.id===rankLeague?'active':'')+'" data-action="league" data-value="'+x.id+'">'+badge(x)+'<b>'+x.name+'</b></button>').join('')+'</div>'+
 '<div class="league-hero">'+badge(t,true)+'<h3>'+t.name+'</h3><p>'+rankDescription(t)+'</p><div class="league-meta"><span class="pill">'+t.weekly+' weekly Coins</span><span class="pill">'+t.fee+' Coin queue entry</span><span class="pill">'+t.multiplier.toFixed(2)+'&times; win bonus</span></div></div>'+
 '<div class="section-heading"><h3>Top 20 &middot; '+(rankMetric==='rating'?'Skill':'Wealth')+'</h3></div>'+
 (rankMetric==='wealth'?'<p class="caption">Coins + 10 &times; Crowns, including reserved balances. Purchases count here, never toward skill.</p>':'')+
 (rows.length?rows.map((p,i)=>'<div class="standing"><span class="position">'+(i+1)+'</span>'+badge(D.tier(p.tier))+'<div><b>'+escape(p.name)+'</b><small>'+(rankMetric==='rating'?p.rating+' Elo':Number(p.wealth).toLocaleString()+' Coin value')+'</small></div><button data-action="challenge" data-value="'+escape(p.id)+'" aria-label="Challenge '+escape(p.name)+'">'+icon('swords')+'</button></div>').join(''):empty('trophy',online.ready?'No ranked players yet':'Rankings unavailable',online.ready?'The first results will appear here.':'Connect to load the rankings.'))+
 fullButton('How ranks work','rankhelp','',true)+fullButton('Challenge and reward rules','feehelp','',true);
}
async function refreshOnline(){
 const serial=++refreshSerial;if(!NET)return;const options={scope:rankScope,region:data.profile.region,league:rankLeague,metric:rankMetric},forPage=page;
 try{const profile=await NET.profile(),invitations=await NET.invitations(),rows=forPage==='rank'?await NET.leaderboard(options):[];if(serial!==refreshSerial)return;online.ready=true;online.profile=profile;online.invitations=invitations;if(forPage==='rank')online.rows=rows;if(['rank','friends','stats','quests'].includes(page))render();else renderWalletSummary();}
 catch{if(serial===refreshSerial){online.ready=false;online.profile=null;online.rows=[];online.invitations=[];if(['rank','friends'].includes(page))render();}}
}

function quests(){const d=D.getDaily(data),remaining=Math.max(0,D.POLICY.botDailyCap-d.botPaid);return '<h2>A reason for one more</h2><p class="caption">Small goals. More ways to play.</p><div class="status-line">'+icon('clock')+'Daily reset &middot; 00:00 UTC</div>'+D.QUESTS.map(q=>{const source=online.ready?(online.profile?.daily||{}):d,count=Math.min(q.target,source[q.metric]||0),done=(source.claimed||[]).includes(q.id),ready=count>=q.target&&(!q.online||online.ready);return '<div class="quest"><div><strong>'+q.title+'</strong><p>'+q.desc+'</p><div class="progress"><span style="width:'+Math.min(100,count/q.target*100)+'%"></span></div><p>'+(q.metric==='seconds'?seconds(count)+' / 10:00':count+' / '+q.target)+'</p></div><div class="quest-side"><span class="reward">'+icon('coin')+' '+q.reward+'</span><button class="button quiet" data-action="claim" data-value="'+q.id+'" '+(!ready||done?'disabled':'')+'>'+(done?'Claimed':'Claim')+'</button></div></div>';}).join('')+
 '<div class="section-heading"><h3>Weekly rank reward</h3></div><div class="card"><b>'+(online.profile?.games<10?'Complete your ranked placements':online.profile?.season&&!online.profile.season.qualified?'Complete season requalification':D.tier(myTier()).weekly+' Coins at '+D.tier(myTier()).name)+'</b><p class="caption">Play 5 ranked games, including 3 matchmade games, against 3 opponents over 3 days. Rewards arrive automatically after the week ends.</p>'+button('Reward details','weeklyhelp','',true)+'</div>'+
 '<div class="section-heading"><h3>Bot rewards</h3><span class="pill">'+remaining+' / '+D.POLICY.botDailyCap+' left today</span></div>'+G.LEVELS.map(l=>'<div class="split"><span>'+l+'</span><span class="amount">'+D.BOT_PAY[l]+' Coins / win</span></div>').join('')+'<p class="caption">Up to '+D.POLICY.botWinsPerLevel+' rewarded wins per difficulty each day.</p>'+fullButton('Open wallet','wallet','',true);}
function sheetOpen(){return !$('#sheet').hidden;}

function sheetIsolation(active){for(const selector of ['.topbar','#contentScroll','#gameScreen','#navigation']){const el=$(selector);if(el)el.inert=active;}}
function open(title,html,kind='info'){
 A?.cancel();
 clearTimeout(botTimer);botTimer=null;const sheet=$('#sheet'),wasHidden=sheet.hidden;if(wasHidden)sheetReturnFocus=document.activeElement;sheetKind=kind;$('#sheetTitle').textContent=title;$('#sheetBody').innerHTML=html;sheet.dataset.kind=kind;$('#sheetBackdrop').hidden=false;sheet.hidden=false;sheet.scrollTop=0;sheetIsolation(true);lastTick=performance.now();refreshIcons();window.dispatchEvent(new Event('mega:sheet'));requestAnimationFrame(()=>$('#sheetClose')?.focus());
}
function close(){const sheet=$('#sheet');if(sheet.hidden)return;sheet.hidden=true;sheet.removeAttribute('data-kind');$('#sheetBackdrop').hidden=true;sheetIsolation(false);sheetKind='';lastTick=performance.now();lastInput=lastTick;const returnTo=sheetReturnFocus;sheetReturnFocus=null;if(returnTo?.isConnected&&!returnTo.inert)requestAnimationFrame(()=>returnTo.focus());scheduleBot();}

function settings(){const s=data.settings;
 const toggle=(key,label,desc,disabled=false,child=false)=>'<div class="setting-row '+(child?'notification-child':'')+'"><label for="setting-'+key+'">'+label+'<small>'+desc+'</small></label><input class="switch" id="setting-'+key+'" data-setting="'+key+'" type="checkbox" '+(s[key]?'checked':'')+' '+(disabled?'disabled':'')+'></div>';
 const themes='<div class="theme-grid">'+Object.entries(themeNames).map(([id,name])=>'<button class="theme-card '+(s.theme===id?'active':'')+'" data-action="theme" data-value="'+id+'" aria-pressed="'+(s.theme===id)+'"><span class="theme-preview '+id+'"><span class="sample-x">X</span><span class="sample-o">O</span></span><b>'+name+'</b><small>'+({vector:'Clear, bright and familiar.',midnight:'Slate, soft light, lime accents.',paperclub:'Printed paper and warm ink.',afterhours:'Arcade glow. No strobe effects.'}[id])+'</small></button>').join('')+'</div>';
 open('Settings','<div class="setting-group"><h4>GAMEPLAY</h4>'+toggle('legal','Legal board highlight','Shows the board you can play in')+toggle('preview','Destination preview','Shows where a move sends the next player')+'<div class="setting-row"><label for="setting-timer">Move timer<small>Applies to the next match</small></label><select id="setting-timer" data-setting="timer">'+opts([['0','Off'],['30','30 seconds'],['60','60 seconds']],String(s.timer))+'</select></div>'+toggle('confirm','Confirm each move','Tap a cell twice before placing')+'</div><div class="setting-group"><h4>FEEDBACK</h4>'+toggle('sound','Sound effects','Move and win cues')+toggle('music','Ambient sound','Soft background tone')+toggle('haptics','Haptics','On supported devices')+'</div><div class="setting-group notification-settings"><h4>NOTIFICATIONS</h4>'+toggle('notifications','Device alerts','Off by default. Pending activity still appears under the bell.')+'<div class="notification-options" aria-label="Notification groups">'+toggle('notifyMatches','Challenges','Direct challenge invitations and acceptance activity',!s.notifications,true)+toggle('notifySocial','Social','Friend requests',!s.notifications,true)+toggle('notifyRewards','Daily quests','Evening reminder before the 00:00 UTC reset',!s.notifications,true)+'</div></div><div class="setting-group"><h4>APPEARANCE</h4>'+themes+toggle('motion','Reduce motion','Fewer visual effects')+'</div><div class="setting-group"><h4>LEARN</h4><div class="setting-row"><label>How to play<small>Learn by playing, or read the rules</small></label>'+button('Open tutorial','tutorial','',true)+'</div></div><div class="setting-group"><h4>PROFILE</h4><div class="setting-row"><label for="profileRegion">Leaderboard country</label><select id="profileRegion">'+opts(['India','Australia','United States','United Kingdom'].map(x=>[x,x]),data.profile.region)+'</select></div><div class="setting-row"><label for="wealthPublic">Show my wealth<small>Join the separate wealth leaderboard</small></label><input class="switch" type="checkbox" id="wealthPublic" '+(data.profile.wealthPublic?'checked':'')+'></div></div><div class="setting-group"><h4>PURCHASES</h4>'+fullButton('Get Crowns','wallet','',true)+fullButton('Remove Ads / Restore Purchases','billing','',true)+'</div><div class="setting-group"><h4>ABOUT</h4><div class="setting-row"><label>Mega XOXO<small>Developed by Antimatter Innovations · contact@antimatterinnovations.com</small></label></div>'+fullButton('Copy support diagnostics','copydiagnostics','',true)+'<div class="legal-links"><a class="button quiet legal-link" href="/privacy" target="_blank" rel="noopener">Privacy Policy</a><a class="button quiet legal-link" href="/privacy-choices" target="_blank" rel="noopener">Privacy choices</a><a class="button quiet legal-link" href="/terms" target="_blank" rel="noopener">Terms</a><a class="button quiet legal-link" href="/support" target="_blank" rel="noopener">Support</a></div></div>','settings');
}

function wallet(){const w=walletData();open('Your wallet','<p class="caption">'+(online.ready?'Account wallet':'Saved on this device')+'</p><div class="balance-grid"><div class="balance">'+icon('coin')+'<strong>'+w.coins.toLocaleString()+'</strong><span>Coins</span></div><div class="balance">'+icon('crown')+'<strong>'+w.crowns.toLocaleString()+'</strong><span>Crowns</span></div></div><p class="caption">Total wealth: '+D.wealth(w).toLocaleString()+' Coin value</p>'+
 '<div class="section-heading"><h3>Exchange</h3></div><p class="caption">10 Coins = 1 Crown. Either direction, no conversion fee.</p><div class="two-fields">'+field('From','exchangeFrom',opts([['coins','Coins'],['crowns','Crowns']],'coins'))+'<label class="field">Amount<input id="exchangeAmount" type="number" min="10" step="10" value="10"></label></div><p id="exchangeQuote" class="caption"></p>'+fullButton('Review exchange','exchange','',true)+
 '<div class="section-heading"><h3>Get Crowns</h3></div><p class="caption">Earn them by exchanging Coins, or buy a pack.</p>'+D.CROWN_PACKS.map(pack=>{const product=online.products.find(p=>p.id===pack.id);return '<div class="ledger"><span>'+pack.crowns+' Crowns</span>'+button(product?.price||'View store','buy',pack.id,true)+'</div>';}).join('')+
 '<div class="section-heading"><h3>Activity</h3></div>'+(w.ledger||[]).slice(-12).reverse().map(e=>'<div class="ledger"><span>'+escape(e.reason)+'<small>'+new Date(e.at).toLocaleDateString()+'</small></span><b class="'+(e.amount>=0?'gain':'loss')+'">'+(e.amount>=0?'+':'')+e.amount+' '+escape(e.currency||'coins')+'</b></div>').join('')+fullButton('Currency and match rules','feehelp','',true),'wallet');updateExchange();}
function updateExchange(){if(!$('#exchangeQuote'))return;try{const from=$('#exchangeFrom').value,n=Number($('#exchangeAmount').value),q=D.conversion(from,n);$('#exchangeQuote').textContent='Receive '+q.credit+' '+q.to+'.';}catch{$('#exchangeQuote').textContent='Enter a positive whole amount. Coins must be in multiples of 10.';}}
function reviewExchange(){try{const q=D.conversion($('#exchangeFrom').value,Number($('#exchangeAmount').value));if(walletData()[q.from]<q.debit)return notify('Not enough '+q.from+'.');pendingExchange={...q,id:opId()};open('Confirm exchange','<p>'+q.debit+' '+q.from+' becomes '+q.credit+' '+q.to+'.</p><p class="caption">Your total wealth stays the same.</p>'+fullButton('Confirm','exchangeconfirm')+fullButton('Cancel','wallet','',true),'exchange');}catch{notify('Check the amount. Coins exchange in multiples of 10.');}}
async function confirmExchange(){const q=pendingExchange;if(!q)return;pendingExchange=null;try{if(online.ready){await NET.convert(q.from,q.debit,q.id);online.profile=await NET.profile();}else D.convert(data,q.from,q.debit,q.id);save();render();wallet();notify('Exchange complete.');}catch(e){pendingExchange=q;notify(e.message==='INSUFFICIENT_COINS'?'Not enough Coins.':'Exchange could not be completed.');}}
function rankHelp(){open('How ranks work','<p>Ranked matches change Elo. An upset earns more than a win against an equal opponent, but no match swaps your positions.</p><p class="caption">Maximum change: 24 points per game. Payment, pot size and wealth do not enter the calculation.</p><h3>Quarterly seasons</h3><p>Every Jan-Mar, Apr-Jun, Jul-Sep and Oct-Dec season starts with 5 requalification games. At least 3 must be matchmade Ranked games against at least 3 different opponents.</p><p class="caption">Your Elo is never wiped. After requalification you return immediately to the league your current Elo supports; there is no artificial climb from Wood.</p>'+D.TIERS.map(t=>'<div class="ledger"><span>'+t.name+'<small>'+rankDescription(t)+'</small></span>'+badge(t)+'</div>').join('')+'<p class="caption">Grandmaster: up to 20 players. Master: the next 200. Champion: the next 1,000. Elite seats are allocated weekly and require recent ranked activity: 5 rated games in 14 days, including 3 matchmade games against 3 opponents, plus at least one rated game in the last 7 days. Direct ranked challenges count toward activity but are never mandatory.</p><p class="caption">After 28 days without a rated match, a player leaves the public skill leaderboard until they return. Their Elo is retained.</p>');}
function weeklyHelp(){open('Weekly rank rewards','<p>Finish 5 ranked games, including 3 matchmade games, against 3 opponents on at least 3 days.</p>'+D.TIERS.map(t=>'<div class="split"><span>'+t.name+'</span><b>'+t.weekly+' Coins</b></div>').join('')+'<p class="caption">Your weekly reward uses the lower of your final daily snapshot and your median daily rank. Partial first weeks are pro-rated. Qualified rewards arrive automatically after Monday 00:00 UTC and do not expire.</p>');}
function feeHelp(){open('Coins, Crowns and matches','<h3>Exchange</h3><p>10 Coins = 1 Crown, in either direction. No exchange fee. Neither currency can be cashed out.</p><h3>Matched ranked games</h3><p>Both players pay the same Coin ticket, based on the lower league. Half the combined pot is burned; half goes to the winner. A draw refunds both entries.</p><h3>Direct challenges</h3><p>Unranked is free. For a ranked challenge, only the challenger pays a Crown pot. Half is burned and half goes to the winner. The invited player pays nothing.</p><p>Friends: up to 20 Crowns (200 Coins). Leaderboard challenges: a minimum based on the opponent\'s league and the upward league gap. You may offer more.</p><p class="caption">Bought and earned Crowns are treated the same where ranked Crown challenges are available. Crowns have no cash value or cash-out. No charge for an invitation, rejection or expiry; once an accepted match starts, entry is normally final unless the match is voided/refunded or mandatory consumer rights apply. Direct challenges use normal Elo and have no separate win bonus.</p>'+fullButton('Weekly rewards','weeklyhelp','',true));}
function challenge(id,kind='leaderboard'){
 target=(kind==='friend'?online.profile?.friends:online.rows)?.find(p=>p.id===id);if(!target)return notify('Player unavailable.');target={...target,kind};
 const placed=(online.profile?.games||0)>=D.POLICY.placements&&(target.games===undefined||target.games>=D.POLICY.placements),defaultRated=kind==='leaderboard'&&placed;
 const matchOptions='<option value="false" '+(!defaultRated?'selected':'')+'>Unranked - free</option><option value="true" '+(defaultRated?'selected':'')+' '+(!placed?'disabled':'')+'>Ranked - Crowns</option>';
 open('Challenge '+escape(target.name),'<div class="challenge-opponent">'+badge(D.tier(target.tier||'wood'))+'<div><b>'+escape(target.name)+'</b><small>'+(target.rating!==undefined?target.rating+' Elo · ':'')+D.tier(target.tier||'wood').name+'</small></div></div><div class="two-fields">'+field('Match','challengeRated',matchOptions)+'<label class="field">Crown pot<input id="challengeAmount" type="number" min="2" step="2" value="2"></label></div>'+(!placed?'<p class="caption">Ranked direct challenges unlock after both players complete placement games.</p>':'')+'<div id="challengeQuote"></div>'+fullButton('Send challenge','sendchallenge'),'challenge');updateQuote(true);
}
function updateQuote(reset=false){if(!target||!$('#challengeQuote'))return;try{
 const rated=$('#challengeRated').value==='true',base=D.quote({mode:'direct',kind:target.kind,rated,from:myTier(),to:target.tier});
 if(reset)$('#challengeAmount').value=base.minimum||2;$('#challengeAmount').min=base.minimum||2;if(base.ceiling)$('#challengeAmount').max=base.ceiling;else $('#challengeAmount').removeAttribute('max');$('#challengeAmount').disabled=!rated;
 const q=D.quote({mode:'direct',kind:target.kind,rated,from:myTier(),to:target.tier,amount:Number($('#challengeAmount').value)});
 target.quote=q;$('#challengeQuote').innerHTML=rated?'<div class="community-terms challenge-terms"><h3>Ranked challenge terms</h3>'+[['You fund',q.pool+' Crowns'],['Opponent pays','0 Crowns'],['Winner receives',q.payout+' Crowns'],['Retired from pot',q.burn+' Crowns'],['Turn timer','30 seconds']].map(([k,v])=>'<div class="split"><span>'+k+'</span><b>'+v+'</b></div>').join('')+'<p>Standard Elo applies. Crown amount never changes rating gain or loss.</p><p class="caption">'+(q.ceiling===null?'Minimum '+q.minimum+' Crowns; no leaderboard ceiling.':'Friend challenges are capped at '+q.ceiling+' Crowns.')+' No funds move until the invitation is accepted.</p></div>':'<div class="community-terms challenge-terms"><h3>Unranked challenge</h3><div class="split"><span>Entry</span><b>Free</b></div><div class="split"><span>Rank change</span><b>None</b></div><div class="split"><span>Turn timer</span><b>60 seconds</b></div><p>Use this for a no-stakes game.</p></div>';
 }catch{target.quote=null;$('#challengeQuote').innerHTML='<p class="caption">Use an even Crown amount at or above the minimum'+(target.kind==='friend'?', up to 20.':'.')+'</p>';}}
async function sendChallenge(){if(!target?.quote)return;try{const invitation=await NET.offer(target.id,{kind:target.kind,rated:target.quote.rated,amount:target.quote.pool},opId());window.MegaCommunity?.refresh?.(false);watchInvitation(invitation.id,'challenge',invitation);}catch(e){notify(friendlyError(e));}}
function reviewInvite(id){const m=online.invitations.find(m=>m.id===id);if(!m)return;const idx=m.players.indexOf(online.profile.id),entry=m.quote.contributions[idx],queue=m.terms?.source==='queue';
 if(queue){open('Match invitation','<p>'+(m.quote.rated?'A ranked opponent is ready.':'A casual opponent is ready.')+'</p><div class="community-terms">'+[['You pay',entry+' '+(m.quote.currency||'')],['Winner receives',m.quote.payout+' '+(m.quote.currency||'')],['Retired',m.quote.burn+' '+(m.quote.currency||'')],['Turn timer',m.terms.turnSeconds+' seconds']].map(([k,v])=>'<div class="split"><span>'+k+'</span><b>'+v+'</b></div>').join('')+'</div>'+fullButton('Accept match','acceptinvite',id)+fullButton('Decline','declineinvite',id,true),'invite');return;}
 const ranked=m.quote.rated,challenger=escape(m.challengerName||m.players[0]),mins=Math.max(1,Math.ceil((m.expires-Date.now())/60000)),ratings=m.terms?.ratings||[];
 open(ranked?'Ranked challenge':'Challenge invitation','<div class="challenge-invite"><div class="challenge-opponent">'+badge(D.tier(m.terms?.from||'wood'))+'<div><b>'+challenger+'</b><small>'+(ratings[0]!==undefined?ratings[0]+' Elo · ':'')+D.tier(m.terms?.from||'wood').name+'</small></div></div><p>'+challenger+' challenged you. You choose whether to accept; nothing is charged for declining or letting it expire.</p><div class="community-terms">'+(ranked?[['Your entry','0 Crowns'],['Challenger pot',m.quote.pool+' Crowns'],['Winner receives',m.quote.payout+' Crowns'],['Retired from pot',m.quote.burn+' Crowns'],['Turn timer','30 seconds']]:[['Your entry','Free'],['Rank change','None'],['Turn timer',(m.terms.turnSeconds||60)+' seconds']]).map(([k,v])=>'<div class="split"><span>'+k+'</span><b>'+v+'</b></div>').join('')+(ranked?'<p>Standard Elo applies at the ratings captured when the challenge was sent. Stake size does not affect Elo.</p>':'')+'<p class="caption">Expires in about '+mins+' minute'+(mins===1?'':'s')+'.</p></div></div>'+fullButton(ranked?'Accept ranked challenge':'Accept challenge','acceptinvite',id)+fullButton('Decline','declineinvite',id,true),'invite');}
function friendlyError(e){const base=({COMPLETE_PLACEMENTS:'Finish your ranked placements first.',FRIENDSHIP_REQUIRED:'Add this player as a friend first.',ALREADY_IN_MATCH:'Finish your current match first.',ALREADY_QUEUED:'Leave matchmaking before sending a challenge.',RATED_PAIR_LIMIT:'You have reached the rated rematch limit with this player.',PENDING_INVITATION:'You already have an open invitation with this player.',INVITE_RATE_LIMIT:'You have sent too many invitations today. Try again later.',INSUFFICIENT_CROWNS:'Not enough Crowns.',INSUFFICIENT_COINS:'Not enough Coins.',AUTH_REQUIRED:'Your session expired. Sign in again for online play.',LINK_ACCOUNT_REQUIRED:'Sign in to play online.',MAINTENANCE:'Online services are temporarily in maintenance.',OFFLINE:'You are offline. Offline matches still work.',REQUEST_TIMEOUT:'The connection timed out. Your action can be retried safely.',SERVICE_UNAVAILABLE:'Online services are temporarily unavailable.',STORE_UNAVAILABLE:'The store is unavailable.',OFFER_EXPIRED:'This challenge expired. Ask for a new one.',TERMS_CHANGED:'The challenge terms changed. Ask for a new invitation.',REQUOTE_REQUIRED:'A player rating or league changed before acceptance. Send a fresh challenge.'})[e?.message]||'Online play is unavailable right now.';return e?.supportId?base+' Support code '+e.supportId+'.':base;}
function renderConnectivity(detail={state:'online'}){connectionState=detail.state||'online';const box=$('#networkStatus');if(!box)return;if(connectionState==='online'){box.hidden=true;box.removeAttribute('data-state');return;}const copy={offline:['You are offline','Bot and Pass & Play still work. Online matches and progress will reconnect when your connection returns.','Try again'],maintenance:['Servers are in maintenance','New online activity is paused. Your client will reconnect when service is available again.','Try again'],auth:['Session expired','Sign in again to continue online play. Offline modes are still available.','Sign in'],timeout:['Connection timed out','We could not confirm the latest online state. Retrying is safe; server writes use idempotency protection.','Try again'],degraded:['Connection interrupted','Online services are temporarily unavailable. Offline modes still work.','Try again'],reconnecting:['Reconnecting','Checking your latest online state…','Retry now']}[connectionState]||['Connection interrupted','Online features will reconnect automatically.','Try again'];box.dataset.state=connectionState;$('#networkStatusTitle').textContent=copy[0];$('#networkStatusText').textContent=copy[1]+(detail.supportId?' Support code '+detail.supportId+'.':'');$('#networkStatusAction').textContent=copy[2];box.hidden=false;if(['offline','maintenance','auth'].includes(connectionState))online.ready=false;if(connectionState==='auth'){clearInterval(onlinePoll);onlinePoll=null;onlinePollBusy=false;}}
async function retryNetwork(){if(connectionState==='auth'){window.MegaCommunity?.login?.();return;}try{if(match?.online){const state=await NET.match(match.id);if(match?.id===state.id)receiveOnline(state);}await refreshOnline();}catch(e){notify(friendlyError(e));}}
function supportDiagnostics(){const current=window.MegaAccount?.connectivity?.()||{};return {product:'Mega XOXO',clientVersion:'4.1.0',generatedAt:new Date().toISOString(),connectivity:{state:current.state||connectionState,code:current.code||'',supportId:current.supportId||''},context:{page,mode,onlineType,onlineMatch:!!match?.online,waiting:!!waitingId,sheet:sheetKind||'',theme:data.settings.theme,reducedMotion:!!data.settings.motion||globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches===true},viewport:{width:innerWidth,height:innerHeight}};}
async function copySupportDiagnostics(){const text=JSON.stringify(supportDiagnostics(),null,2);try{if(!navigator.clipboard?.writeText)throw Error('NO_CLIPBOARD');await navigator.clipboard.writeText(text);notify('Support diagnostics copied.');}catch{open('Support diagnostics','<p class="caption">This report contains app state only. It excludes email, player ID, cookies, passwords, OTPs, receipts and request contents.</p><textarea id="supportDiagnosticsText" class="support-diagnostics" readonly aria-label="Support diagnostics">'+escape(text)+'</textarea>');requestAnimationFrame(()=>$('#supportDiagnosticsText')?.select());}}
document.addEventListener('mega:connectivity',e=>renderConnectivity(e.detail||{}));
window.addEventListener('online',()=>setTimeout(()=>retryNetwork().catch(()=>{}),300));
async function onlineInfo(){try{if(mode==='private'){if(window.MegaParties?.open)return window.MegaParties.open();return notify('Private rooms are unavailable right now.');}if(!online.ready)await refreshOnline();if(!online.ready)return notify('Online play is unavailable right now.');if(onlineType==='ranked'){const q=D.quote({from:myTier(),to:myTier()});open('Find a ranked match','<p>Entry: up to '+q.fee+' Coins. The exact ticket is shown when a match is found.</p><p class="caption">Nothing is charged while searching.</p>'+fullButton('Find Match','queue'));}else await startQueue();}catch(e){notify(friendlyError(e));}}
async function startQueue(){
 if(queueSubmission||queueCancelling)return;
 try{clearInterval(onlinePoll);waitingId='queue';open('Finding a match','<p>Searching for an opponent. No entry is charged yet.</p>'+fullButton('Cancel search','cancelqueue'),'queue');queueSubmission=NET.queue(onlineType,opId());await queueSubmission;queueSubmission=null;if(queueCancelling)return;
 const check=async()=>{if(onlinePollBusy)return;onlinePollBusy=true;try{const queueState=NET.queueStatus?await NET.queueStatus():null;const invitations=await NET.invitations();if(waitingId!=='queue')return;if(queueState&&['expired','declined','cancelled','disconnected'].includes(queueState.state)){clearInterval(onlinePoll);waitingId=null;open('Match not accepted','<p>No entry was charged. Search again when you are ready.</p>'+fullButton('Find Match','queue')+fullButton('Back','close','',true));return;}const m=invitations.find(x=>x.terms?.source==='queue'||x.quote.mode==='queue');if(m){online.invitations=invitations;clearInterval(onlinePoll);waitingId=null;reviewInvite(m.id);}}catch{}finally{onlinePollBusy=false;}};
 onlinePoll=setInterval(check,1000);check();}catch(e){waitingId=null;close();notify(friendlyError(e));}finally{queueSubmission=null;}
}

function tutorial(){
 if(match&&!match.state.winner){rules();return;}
 open('How to play','<p>Learn by playing. Claim three Mini Boards in a line to win the Mega Board.</p>'+fullButton('Start guided practice','practice')+fullButton('Read the rules','rules','',true)+'<p class="caption">No coins or personal stats. Skip guidance at any time.</p>','tutorial');
}
function rules(){
 const grid=(hot=[],marks={})=>'<div class="tutorial-map old-map">'+Array.from({length:9},(_,i)=>'<span class="'+(hot.includes(i)?'hot':'')+'">'+(marks[i]||'')+'</span>').join('')+'</div>';
 open('How to play','<div class="tutorial-cards"><div class="tutorial-card"><span class="step-number">01</span><div><b>Win a Mini Board</b><p>Inside any Mini Board, X and O play normal tic-tac-toe. Make 3 in a row to claim that whole board.</p>'+grid([2],{0:'X',1:'X',2:'X',3:'O',5:'O'})+'</div></div><div class="tutorial-card"><span class="step-number">02</span><div><b>Your cell sends the opponent</b><p>The cell position you choose becomes the opponent\'s next Mini Board. Play top-right and they must play in the top-right board.</p><div class="tutorial-flow">'+grid([2],{2:'X'})+icon('arrow')+grid([2],{2:'GO'})+'</div></div></div><div class="tutorial-card"><span class="step-number">03</span><div><b>Closed board? Free Move.</b><p>If your move points to a Mini Board that is already won or drawn, the next player can choose any open Mini Board.</p></div></div><div class="tutorial-card"><span class="step-number">04</span><div><b>Win the Mega Board</b><p>Claim 3 Mini Boards in a row, column or diagonal to win the match.</p>'+grid([0,1,2],{0:'X',1:'X',2:'X',4:'O',6:'O'})+'</div></div></div>'+fullButton(match&&!match.state.winner?'Back to your match':'Start guided practice',match&&!match.state.winner?'close':'practice')+'<p class="caption">Practice has no coins or personal stats.</p>','tutorial');try{localStorage.setItem('mega_v32_tutorial_seen','1');}catch{}}


function watchInvitation(id,kind='challenge',snapshot=null){
 waitingId=id;clearInterval(onlinePoll);let body='<p>Waiting for the other player. No funds are taken until acceptance.</p>';
 if(kind!=='queue'&&snapshot){const ranked=snapshot.quote?.rated,mins=Math.max(1,Math.ceil((snapshot.expires-Date.now())/60000));body='<div class="challenge-wait"><div class="challenge-opponent">'+badge(D.tier(snapshot.terms?.to||target?.tier||'wood'))+'<div><b>'+escape(target?.name||snapshot.playerNames?.[snapshot.players?.[1]]||'Opponent')+'</b><small>'+(snapshot.terms?.ratings?.[1]!==undefined?snapshot.terms.ratings[1]+' Elo · ':'')+(ranked?'Ranked challenge':'Unranked challenge')+'</small></div></div><div class="community-terms">'+(ranked?[['Your pot',snapshot.quote.pool+' Crowns'],['Opponent pays','0 Crowns'],['Winner receives',snapshot.quote.payout+' Crowns'],['Turn timer','30 seconds']]:[['Entry','Free'],['Rank change','None'],['Turn timer',(snapshot.terms?.turnSeconds||60)+' seconds']]).map(([k,v])=>'<div class="split"><span>'+k+'</span><b>'+v+'</b></div>').join('')+'<p class="caption">Waiting for acceptance · about '+mins+' minute'+(mins===1?'':'s')+' remaining.</p></div></div>';}
 open(kind==='queue'?'Waiting for your opponent':'Challenge sent',body+fullButton(kind==='queue'?'Cancel match':'Cancel invitation',kind==='queue'?'cancelqueue':'cancelinvite'),'waiting');
 const check=async()=>{if(onlinePollBusy)return;onlinePollBusy=true;try{const m=await NET.match(id);if(waitingId!==id)return;if(m.status==='PLAYING'){if(kind!=='queue')window.MegaCommunity?.challengeAccepted?.(id,m.playerNames?.[m.players?.find(p=>p!==online.profile?.id)]||'Opponent');beginOnline(m);}else if(['DECLINED','CANCELLED','EXPIRED','VOID'].includes(m.status)){clearInterval(onlinePoll);waitingId=null;close();window.MegaCommunity?.refresh?.(false);notify('Invitation '+m.status.toLowerCase()+'. No charge.');}}catch{}finally{onlinePollBusy=false;}};
 onlinePoll=setInterval(check,1000);check();
}
function beginOnline(m){
 T?.stop();A?.cancel();
 clearInterval(onlinePoll);waitingId=null;close();clearTimeout(botTimer);onlinePending=false;
 match={id:m.id,state:m.state,online:true,symbols:m.symbols,mode:m.quote.rated?'ranked':m.terms.source==='queue'?'casual':'friend',difficulty:'',first:'X',practice:false,active:0,turnLimit:m.terms.turnSeconds,turnRemaining:0,deadline:m.deadline,clockOffset:(m.serverNow||Date.now())-Date.now(),last:null,recorded:false,pending:null};
 $('#gameScreen').hidden=false;$('#matchMode').textContent=m.terms.source==='queue'?(m.quote.rated?'Ranked':'Casual'):(m.quote.rated?'Ranked challenge':'Friendly match');$('#matchLevel').textContent='ONLINE';$('#playerXName').textContent=m.symbols.X===online.profile.id?'You':m.playerNames?.[m.symbols.X]||'Opponent';$('#playerOName').textContent=m.symbols.O===online.profile.id?'You':m.playerNames?.[m.symbols.O]||'Opponent';
 lastTick=lastInput=performance.now();receiveOnline(m);onlinePoll=setInterval(async()=>{if(onlinePollBusy)return;onlinePollBusy=true;try{const state=await NET.match(m.id);if(match?.id===m.id&&match.online)receiveOnline(state);}catch{}finally{onlinePollBusy=false;}},700);
}
function receiveOnline(m){
 if(!match?.online||match.id!==m.id||m.state.moves.length<match.state.moves.length||match.recorded)return;const count=match.state.moves.length;match.state=m.state;match.deadline=m.deadline;if(m.serverNow)match.clockOffset=m.serverNow-Date.now();match.turnRemaining=match.deadline===null?0:Math.max(0,(match.deadline-(Date.now()+match.clockOffset))/1000);match.last=m.state.moves.at(-1)||null;paint();clearPreview();
 if(m.state.moves.length>count&&match.last&&!m.state.winner)animateRoute(match.last.b,match.last.c,m.state.required);
 if(m.status==='VOID'&&!match.recorded){match.recorded=true;clearInterval(onlinePoll);open('Match cancelled','<p>Your entry was refunded.</p>'+fullButton('Back to home','home'),'result');refreshOnline();}
 else if(m.status==='FINISHED'&&!match.recorded){match.recorded=true;clearInterval(onlinePoll);const r=m.receipt,won=r.winner===online.profile.id;const idx=m.players.indexOf(online.profile.id),delta=r.rating?(idx?-r.rating.delta:r.rating.delta):0;open(r.winner===null?'Draw':won?'You win':'Match finished','<p>'+ (r.refunded?'Entries refunded.':won?'Winner payout: '+r.payout+' '+(r.currency||'')+'.':'Match settled.')+'</p>'+(r.rating?'<p>Elo: '+(delta>=0?'+':'')+delta+'</p>':'')+fullButton('Back to home','home'),'result');refreshOnline();}
}
async function onlineMove(move){
 if(!match?.online||onlinePending||sheetOpen()||match.state.winner||match.symbols[match.state.turn]!==online.profile?.id)return;
 onlinePending=true;paint();const id=match.id,key=opId();
 try{await NET.move(id,match.state.moves.length,move,key);if(match?.id===id)receiveOnline(await NET.match(id));}catch(e){notify(friendlyError(e));}finally{onlinePending=false;paint();}
}
async function onlineResign(){if(!match?.online)return;try{await NET.resign(match.id,opId());close();receiveOnline(await NET.match(match.id));}catch(e){notify(friendlyError(e));}}
// Build the fixed board once. Theme changes and marks never replace its grid containers.
const miniNodes=[],cellNodes=[];
// Destination preview currently shown by hover or press-and-hold, or null. `paint()` re-asserts it
// because it rebuilds every Mini Board's class list on each poller tick.
let previewCell=null;
// Press-and-hold destination preview for touch/pen. Mouse keeps hover preview.
let holdTimer=null,holdFired=false,suppressHoldClick=false;
function releaseTouchHold(){clearTimeout(holdTimer);holdTimer=null;if(holdFired){suppressHoldClick=true;clearPreview();}holdFired=false;}
function buildBoard(){for(let b=0;b<9;b++){const el=document.createElement('div');el.className='mini';el.dataset.board=b;const cells=[];for(let c=0;c<9;c++){const cell=document.createElement('button');cell.type='button';cell.className='cell';cell.dataset.b=b;cell.dataset.c=c;cell.addEventListener('click',e=>{if(suppressHoldClick){suppressHoldClick=false;e.preventDefault();return;}humanMove(b,c);},{passive:false});cell.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse')preview(b,c);});cell.addEventListener('pointerleave',e=>{if(e.pointerType==='mouse')clearPreview();else releaseTouchHold();});cell.addEventListener('pointerdown',e=>{holdFired=false;suppressHoldClick=false;if(e.pointerType==='mouse')return;clearTimeout(holdTimer);holdTimer=setTimeout(()=>{holdFired=true;preview(b,c);},200);});cell.addEventListener('pointerup',releaseTouchHold);cell.addEventListener('pointercancel',releaseTouchHold);el.append(cell);cells.push(cell);}const claim=document.createElement('div');claim.className='claim';claim.hidden=true;el.append(claim);$('#board').append(el);miniNodes.push({el,claim});cellNodes.push(cells);}}
function mark(p){return '<span class="mark-layer '+p.toLowerCase()+'"><svg viewBox="0 0 40 40" stroke="currentColor" aria-hidden="true">'+(p==='X'?'<path d="M10 10 30 30M30 10 10 30"/>':'<circle cx="20" cy="20" r="11"/>')+'</svg></span>';}
function startGame(practice=false,rematch=false,explicitPin=null){
 T?.stop();A?.cancel();localSession?.cancel();
 clearTimeout(botTimer);botTimer=null;
 const isNeural=!practice&&mode==='bot'&&difficulty==='Impossible';
 let pin=explicitPin;
 if(isNeural&&!pin){
  const manifest=localSession?.getLatestManifest();
  if(manifest)try{pin=localSession.store.pin(manifest);}catch{}
 }
 if(isNeural&&(!pin||!localSession?.runtime?.loaded)){
  notify('Please set up and download the optional Impossible pack first.');
  window.MegaAiPack?.show();
  return;
 }
 const starter=practice?'X':rematch&&match?(match.first==='X'?'O':'X'):first;
 const seed=Math.floor(Math.random()*0xffffffff);
 match={id:globalThis.crypto?.randomUUID?.()||String(Date.now())+Math.random(),state:G.create(starter),mode:practice?'bot':mode,difficulty:practice?'Beginner':difficulty,first:starter,practice,active:0,turnRemaining:Number(data.settings.timer)||0,turnLimit:Number(data.settings.timer)||0,last:null,recorded:false,pending:null};
 if(isNeural&&pin&&LA){match.version=LA.VERSION;match.resultClass=LA.RESULT_CLASS;match.engine='neural';match.pin={...pin};match.seed=seed;match.status='ready';}
 if(BR&&!isNeural)match.bot=BR.startInfo(null,practice);if(practice)T?.start(match);
 attachPowers(match,{reason:null,record:null,attempt:null});
 $('#gameScreen').hidden=false;$('#matchMode').textContent=practice?'Tutorial practice':match.mode==='local'?'Pass & Play':'Vs Bot';$('#matchLevel').textContent=match.mode==='local'?'Two players, one device':match.difficulty==='Impossible'?'Impossible \u00b7 '+(match.pin?.packVersion||'Neural'):match.difficulty+' difficulty';$('#playerXName').textContent=match.mode==='local'?'Player X':'You';$('#playerOName').textContent=match.mode==='local'?'Player O':match.difficulty==='Impossible'?'Impossible Bot':'Bot';
 lastTick=lastInput=performance.now();paint();syncAudio();save();scheduleBot();
}
function paint(){if(!match)return;const s=match.state,canHuman=!s.winner&&(match.online?match.symbols[s.turn]===online.profile?.id&&!onlinePending:match.mode==='local'||s.turn==='X');const choices=new Set(G.legal(s).map(m=>m.b*9+m.c));
 for(let b=0;b<9;b++){const {el,claim}=miniNodes[b],allowed=!s.mini[b]&&!s.winner&&(s.required===null||s.required===b);
  el.className='mini'+(allowed&&data.settings.legal?(s.required===null?' available':' active'):'')+(!allowed&&!s.mini[b]?' inactive':'')+(s.line?.includes(b)?' win':'');
  el.setAttribute('aria-label',G.NAMES[b]+' Mini Board'+(s.mini[b]?', '+(s.mini[b]==='DRAW'?'drawn':'won by '+s.mini[b]):allowed?', playable':''));
  for(let c=0;c<9;c++){const n=cellNodes[b][c],v=s.board[b][c];if(n.dataset.mark!==(v||'')){n.innerHTML=v?mark(v):'';n.dataset.mark=v||'';}n.disabled=!canHuman||!choices.has(b*9+c);n.classList.toggle('last',!!match.last&&match.last.b===b&&match.last.c===c);n.classList.toggle('cell-hint',!!hintSquare&&hintSquare.b===b&&hintSquare.c===c);n.setAttribute('aria-label',G.NAMES[b]+' board, '+G.NAMES[c]+' cell, '+(v||'empty')+(hintSquare&&hintSquare.b===b&&hintSquare.c===c?', recommended by Tactical Power':''));}
  claim.hidden=!s.mini[b];if(s.mini[b]&&claim.dataset.owner!==s.mini[b]){claim.className='claim '+s.mini[b].toLowerCase();claim.innerHTML=s.mini[b]==='DRAW'?'<span>DRAW</span>':mark(s.mini[b]);claim.dataset.owner=s.mini[b];}
 }
 // `el.className=...` above rebuilds each Mini Board's class list, which would silently drop an
 // active destination preview (the poller repaints about every 900 ms, and a press-and-hold lasts
 // longer than that). Re-assert the preview mark so a hold keeps its destination highlighted.
 if(previewCell){const {b,next}=previewCell;cellNodes[b][next].classList.add('cell-hover',s.turn==='X'?'hover-x':'hover-o');if(data.settings.preview&&!s.mini[next])miniNodes[next].el.classList.add('preview');}
 /* Tactical Power is a recommendation, not a forced move: the square is highlighted and named, and
    every legal square stays enabled until the player actually plays. */
 if(hintSquare&&!s.winner)$('#previewText').textContent='Tactical Power recommends '+G.NAMES[hintSquare.b].toLowerCase()+' board, '+G.NAMES[hintSquare.c].toLowerCase()+' cell. Any legal cell still plays.';
 $('#miniX').textContent=s.mini.filter(x=>x==='X').length;$('#miniO').textContent=s.mini.filter(x=>x==='O').length;$('#playerX').classList.toggle('active',!s.winner&&s.turn==='X');$('#playerO').classList.toggle('active',!s.winner&&s.turn==='O');
 const who=match.online?(match.symbols[s.turn]===online.profile?.id?'YOUR TURN':'OPPONENT TURN'):match.mode==='local'?(s.turn==='X'?'PLAYER X':'PLAYER O'):(s.turn==='X'?'YOUR TURN':'BOT TURN');
 $('#turnText').textContent=s.winner?(s.winner==='DRAW'?'MATCH DRAWN':s.winner+' WINS'):s.required===null?'FREE ROUTE':who+' \u00b7 '+G.NAMES[s.required].toUpperCase();
 $('#destinationText').textContent=s.winner?'Review the board or start a rematch.':s.required===null?'CHOOSE ANY OPEN MINI BOARD':'PLAY ONLY IN THIS MINI BOARD';
 $('#clock').textContent=match.turnLimit?Math.ceil(match.turnRemaining)+'s':'\u221e';$('#clock').classList.toggle('urgent',match.turnLimit>0&&match.turnRemaining<=5);
 renderPowerControls();
 T?.render(match);
}
function clearPreview(){previewCell=null;miniNodes.forEach(x=>x.el.classList.remove('preview'));cellNodes.flat().forEach(n=>n.classList.remove('cell-hover','hover-x','hover-o'));if(match)$('#previewText').textContent=match.pending?'Tap the same cell again to confirm.':"Your cell determines the opponent's next board.";}
function preview(b,c){if(!match||cellNodes[b][c].disabled)return;clearPreview();previewCell={b,next:c};cellNodes[b][c].classList.add('cell-hover',match.state.turn==='X'?'hover-x':'hover-o');if(!data.settings.preview)return;if(match.state.mini[c])$('#previewText').textContent='This gives your opponent free choice of any open board.';else{miniNodes[c].el.classList.add('preview');$('#previewText').textContent='This sends your opponent to the '+G.NAMES[c].toLowerCase()+' board.';}}
function animateRoute(b,c,next){const routeOverlay=$('#routeOverlay');routeOverlay.innerHTML='';if(next===null)return;requestAnimationFrame(()=>{const wrap=$('#boardWrap').getBoundingClientRect(),cell=cellNodes[b]?.[c],target=miniNodes[next]?.el;if(!cell||!target)return;const a=cell.getBoundingClientRect(),t=target.getBoundingClientRect();const x1=a.left+a.width/2-wrap.left,y1=a.top+a.height/2-wrap.top,x2=t.left+t.width/2-wrap.left,y2=t.top+t.height/2-wrap.top;routeOverlay.setAttribute('viewBox','0 0 '+wrap.width+' '+wrap.height);routeOverlay.innerHTML='<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'"/><circle cx="'+x2+'" cy="'+y2+'" r="5"/>';target.classList.add('route-target');setTimeout(()=>{routeOverlay.innerHTML='';target.classList.remove('route-target');},700);});}

function humanMove(b,c){if(match?.online){onlineMove({b,c});return;}if(!match||match.state.winner||sheetOpen()||(match.mode==='bot'&&match.state.turn==='O'))return;if(T&&!T.allows(match,{b,c})){T.hint();return;}lastInput=performance.now();if(data.settings.confirm&&(!match.pending||match.pending.b!==b||match.pending.c!==c)){match.pending={b,c};preview(b,c);$('#previewText').textContent='Tap the same cell again to confirm.';return;}move({b,c},'human');}
function recordPowersHistory(before,m){if(!match.powersHistory)return;const recorded=RW.record(match.powersHistory,before,m,{revision:match.powersHistory.revision});if(recorded.ok){match.powersHistory=recorded.history;match.stateVersion=recorded.node.stateVersion;}}
function move(m,source){if(!match||match.state.winner)return;if(match.mode==='bot'&&((match.state.turn==='O')!==(source==='bot')))return;
 if(T&&!T.permits(match,m,source))return;const before=match.state;
 try{match.state=G.apply(match.state,m);}catch{notify('Choose an empty cell in the highlighted board.');return;}
 if(match.resultClass==='unverified-local-ai')match.status=match.state.winner?'finished':'ready';
 T?.after(match,before,m);recordPowersHistory(before,m);match.last=m;match.pending=null;match.turnRemaining=match.turnLimit;hintSquare=null;tone(source==='bot'?370:540);haptic();paint();clearPreview();animateRoute(m.b,m.c,match.state.required);if(match.state.winner)finish(match.state.winner==='DRAW'?'draw':'line');else{save();scheduleBot();}
}
function scheduleBot(){clearTimeout(botTimer);botTimer=null;A?.cancel();localSession?.cancel();if(!match||match.state.winner||match.mode!=='bot'||match.state.turn!=='O'||sheetOpen()||document.hidden||T?.blocked(match))return;
 const current=match,revision=match.state.moves.length,generation=match.powersHistory?match.powersHistory.generation:0;
 const valid=()=>match===current&&match.state.moves.length===revision&&(match.powersHistory?match.powersHistory.generation:0)===generation&&!match.state.winner&&!sheetOpen()&&!document.hidden&&!T?.blocked(match);
 botTimer=setTimeout(async()=>{botTimer=null;if(!valid())return;const seed=((current.seed||current.bot?.seed||0)^Math.imul(revision+1,0x9e3779b9))>>>0;let m=null;
  if(current.engine==='neural'&&LA){
   try{
    if(!localSession?.runtime)throw Error('NEURAL_RUNTIME_UNAVAILABLE');
    const manifest=localSession.getLatestManifest();
    if(!manifest||manifest.sha256!==current.pin?.modelHash)throw Error('LOCAL_AI_MODEL_CHANGED');
    const result=await localSession.runtime.choose({state:current.state,gameId:current.id,revision,seed,modelHash:current.pin.modelHash,budgetMs:2600});
    if(!valid())return;
    BC.accept({state:current.state,gameId:current.id,revision},result);
    if(result.diagnostics?.modelHash!==current.pin.modelHash)throw Error('LOCAL_AI_MODEL_CHANGED');
    current.botDiagnostics=result.diagnostics;m=result.move;
   }catch(e){
    if(e?.name==='AbortError'||!valid())return;
    current.status='failed';current.botDiagnostics={error:e.code||e.message,modelHash:current.pin?.modelHash};
    openNeuralRecovery(e);return;
   }
  }else{
   try{
    if(!A)throw Error('BOT_WORKER_UNAVAILABLE');
    const result=await A.choose({state:current.state,gameId:current.id,revision,difficulty:current.difficulty,engine:current.bot?.engine||'legacy',seed});
    if(!valid()||result?.gameId!==current.id||result?.revision!==revision)return;
    current.botDiagnostics=result.diagnostics;m=result.move;
   }catch(e){
    if(e?.name==='AbortError'||!valid())return;
    const started=performance.now();m=G.choose(current.state,current.difficulty,BC?BC.seeded(seed):Math.random);current.botDiagnostics={engineVersion:'canonical-main-thread-recovery',rngSeed:seed,recoveryCode:e?.code||'BOT_WORKER_UNAVAILABLE',elapsedMs:performance.now()-started};if(!current.warnedBotFallback){notify('Background thinking is unavailable. Using the standard bot.');current.warnedBotFallback=true;}
   }
  }
  if(valid()&&m)move(m,'bot');
 },850+Math.random()*220);
}
function terminalRecord(reason){const s=match.state,result=s.winner==='DRAW'?'draw':s.winner==='X'?'win':'loss';return {id:match.id,at:Date.now(),mode:match.mode,difficulty:match.difficulty,practice:match.practice,result,reason,moves:s.moves.length,activeSeconds:Math.round(match.active),claimed:s.mini.filter(x=>x==='X').length};}
function finish(reason){
 if(!match||match.recorded||match.pendingTerminal)return;
 match.terminalReason=reason;
 const prepared=prepareTerminalResult(reason);
 if(prepared.pending){offerTerminalUndo();return;}
 finalizeTerminalResult(reason);
}
/* Split terminal handling. `prepareTerminalResult` decides whether this result must wait for the
   player: an eligible Bot 'O' loss on the last completed Bot move in a match where an earned
   two-charge package can still be earned or spent. While it waits, nothing is settled — no
   `D.complete`, no record, no Coins, no quest progress, no daily-cap increment and no interstitial
   eligibility — and the discarded result is never awarded if the player rewinds instead. */
function prepareTerminalResult(reason){
 const s=match.state,result=s.winner==='DRAW'?'draw':s.winner==='X'?'win':'loss';
 const record=terminalRecord(reason);
 if(match.resultClass==='unverified-local-ai'||match.difficulty==='Impossible'){record.resultClass='unverified-local-ai';if(LA)LA.record(data,match);}
 const eligible=!!match.terminalUndoEligible&&match.terminalUndoEligible(match,reason,result);
 if(!eligible)return {pending:false,record};
 T?.stop();A?.cancel();localSession?.cancel();clearTimeout(botTimer);botTimer=null;
 match.pendingTerminal={reason,record};
 save();
 if(!window.MegaPowers){finalizeTerminalResult();return {pending:false,record};}
 return {pending:true,record};
}
function offerTerminalUndo(){open('One more try?','<p class="caption">The Bot closed the match with its last move.</p>'+fullButton('Accept loss','acceptloss')+fullButton('Undo with a rewarded ad','undooffer','',true),'terminal');}
/* Exactly one settlement per real result. `match.recorded` is set before `D.complete`, so a repeated
   call — a second click, a resumed snapshot, a late timer tick — cannot double-pay. */
function finalizeTerminalResult(reasonOverride){
 if(!match||match.recorded)return;
 const pending=match.pendingTerminal,reason=reasonOverride||(pending?pending.reason:match.terminalReason||'line');
 const record=(pending&&pending.record)?pending.record:terminalRecord(reason);
 match.pendingTerminal=null;match.terminalReason=null;match.recorded=true;
 T?.stop();A?.cancel();localSession?.cancel();clearTimeout(botTimer);botTimer=null;
 const s=match.state,result=record.result;
 const award=D.complete(data,record);save();render();paint();
 open(result==='draw'?'A well-fought draw':match.mode==='local'?'Player '+s.winner+' wins':result==='win'?'Nicely played.':'One more try?',
 '<p class="caption">'+(reason==='line'?'Three Mini Boards in a row.':reason==='draw'?'All Mini Boards resolved without a big winning line.':reason==='timeout'?'The turn timer ran out.':'The match ended by resignation.')+'</p><div class="stats-grid"><div class="stat"><span>Moves</span><strong>'+s.moves.length+'</strong></div><div class="stat"><span>Active time</span><strong>'+seconds(match.active)+'</strong></div></div><div class="note">'+(match.practice?'Tutorial practice is not counted in your personal stats.':match.mode==='local'?'Pass & Play does not affect personal stats or rewards.':match.resultClass==='unverified-local-ai'||match.difficulty==='Impossible'?'Impossible local match recorded. No Coin, Crown or Elo rewards.':award?'You earned '+award+' Coins on this device.':'No coin reward for this result.')+'</div>'+(match.assisted?'<div class="note">Assisted match. The rewind is not part of your personal history and earns nothing.</div>':'')+fullButton('Rematch','rematch')+fullButton('Back to home','home','',true),'result');
}
setInterval(()=>{const now=performance.now(),delta=Math.min(1,Math.max(0,(now-lastTick)/1000));lastTick=now;if(!match||match.state.winner||$('#gameScreen').hidden||sheetOpen()||document.hidden||T?.blocked(match))return;if(now-lastInput<60000){match.active+=delta;if(!match.online&&match.mode!=='local'&&!match.practice){const isUnverified=match.resultClass==='unverified-local-ai'||match.difficulty==='Impossible';if(isUnverified){data.localAiPlaySeconds=(data.localAiPlaySeconds||0)+delta;}else{const k=match.mode+':all',d=match.mode+':'+match.difficulty;data.playSeconds[k]=(data.playSeconds[k]||0)+delta;data.playSeconds[d]=(data.playSeconds[d]||0)+delta;}if(now-lastSave>5000){save();lastSave=now;}}}if(match.online){if(match.turnLimit)$('#clock').textContent=Math.max(0,Math.ceil((match.deadline-(Date.now()+match.clockOffset))/1000))+'s';return;}if(match.turnLimit){match.turnRemaining=Math.max(0,match.turnRemaining-delta);$('#clock').textContent=Math.ceil(match.turnRemaining)+'s';if(match.turnRemaining<=0){finish('timeout');return;}}paint();}
,100);
document.addEventListener('visibilitychange',()=>{lastTick=performance.now();if(document.hidden){A?.cancel();localSession?.cancel();clearTimeout(botTimer);botTimer=null;}else{lastInput=lastTick;scheduleBot();}syncAudio();});
document.addEventListener('pointerdown',()=>{lastInput=performance.now();},true);
function currentMatchStats(){if(!match)return;const s=match.state;let extra='';if(match.resultClass==='unverified-local-ai'||match.difficulty==='Impossible'){extra='<div class="note">Impossible match &middot; Model: '+escape(match.pin?.packVersion||'none')+' &middot; Hash: '+escape(match.pin?.modelHash?.slice(0,12)||'none')+(match.fallbackFrom?'<br><small>Fallback from: '+escape(match.fallbackFrom.slice(0,12))+'</small>':'')+'</div>';}
 /* The sheet keeps its own Undo entry point for a banked charge, judged by the same summary the
    control zone uses. */
 const banked=powers&&match.mode==='bot'&&match.powers?.botUndo?.charges>=1&&powers.eligibility(powerContext(null,false)).undo.eligible;
 if(banked)extra+=fullButton('Undo last turn ('+match.powers.botUndo.charges+' left)','undoingame');
 open('Current match','<div class="stats-grid"><div class="stat"><span>Moves</span><strong>'+s.moves.length+'</strong></div><div class="stat"><span>Active time</span><strong>'+seconds(match.active)+'</strong></div><div class="stat"><span>X Mini Boards</span><strong>'+s.mini.filter(x=>x==='X').length+'</strong></div><div class="stat"><span>O Mini Boards</span><strong>'+s.mini.filter(x=>x==='O').length+'</strong></div></div>'+extra+fullButton('Resign match','resign','',true),'matchstats');}
function leave(){if(match?.pendingTerminal)finalizeTerminalResult();T?.stop();A?.cancel();localSession?.cancel();clearInterval(onlinePoll);onlinePoll=null;waitingId=null;delete data.offlineMatch;match=null;save();clearTimeout(botTimer);botTimer=null;hintSquare=null;$('#gameScreen').hidden=true;close();page='play';render();}
/* The reward copy promises the earned item, never an unconditional result, and it is shown BEFORE
   the ad starts so the player can decline. `askReward` resolves true only on an explicit start. */
function undoRewardCopy(){return '<p>Watch one optional ad to rewind your last move and the Bot\'s reply.</p><p class="caption">A completed ad earns two Undo presses for this Bot match. Skipping the ad earns nothing and still uses one of your ten rewarded views today. Nothing is charged and no ad plays automatically.</p>';}
function hintRewardCopy(){return '<p>Watch one optional ad to earn one Tactical Power for this Bot match.</p><p class="caption">A completed ad earns one Tactical Power: the Expert engine highlights a recommended legal square and you may still play any legal square. It is advice, not a guaranteed win. Skipping the ad earns nothing and still uses one of your ten rewarded views today.</p>';}
/* The sheet's own buttons answer the promise; a dismissed sheet is a refusal, never a grant. */
let rewardAnswer=()=>{};
function askReward(copy){
 return new Promise(resolve=>{
  let settled=false;
  const done=value=>{if(settled)return;settled=true;resolve(value);};
  open('Optional rewarded ad',copy+fullButton('Watch ad and earn','rewardyes')+fullButton('Not now','rewardno','',true),'reward');
  rewardAnswer=done;
 });
}
const actions={
 nav:v=>{page=v;render();$('#contentScroll').scrollTop=0;if(['rank','friends'].includes(v))refreshOnline();},retrynetwork:()=>retryNetwork(),copydiagnostics:copySupportDiagnostics,mode:v=>{mode=v;render();},difficulty:v=>{if(v==='Impossible'&&!localSession?.isAvailable?.()&&window.MegaAiPack?.getState?.()?.status!=='ready'){window.MegaAiPack?.show();notify('Please set up and download the optional Impossible pack first.');return;}difficulty=v;render();},first:v=>{first=v;render();},settimer:v=>{data.settings.timer=Number(v);save();render();},onlinetype:v=>{onlineType=v;render();},start:()=>mode==='tournament'?(window.MegaParties?.tables?window.MegaParties.tables():notify('Tournaments are unavailable right now.')):['bot','local'].includes(mode)?startGame():onlineInfo(),
 acceptloss:()=>{close();finalizeTerminalResult();},
 undooffer:async()=>{
  if(!powers||!match)return;
  close();
  const ctx=powerContext(match.pendingTerminal?match.pendingTerminal.reason:'line',false);
  // The ticket fetch and the ad are awaited across an interactive window: the player can restart,
  // leave or resign in the meantime, which replaces or clears `match`. Every resume must therefore
  // re-check that we are still looking at the SAME pending-finalization match before touching state,
  // or the earned entitlement would be spent and a bogus loss recorded on a live match.
  const stillTerminal=()=>match&&match.id===ctx.id&&match.pendingTerminal;
  if(!match.powers||match.powers.botUndo.charges<1){
   const req=await powers.request('undo',ctx);
   if(!stillTerminal())return;
   if(!req.earned){
    notify('No reward was earned. The loss stands.');
    offerTerminalUndo();
    return;
   }
  }
  if(!stillTerminal())return;
  const applied=powers.apply('undo',ctx);
  if(!applied.applied){
   if(!stillTerminal())return;
   notify('Could not rewind move.');
   offerTerminalUndo();
   return;
  }
  match.assisted=true;
  notify('Turn rewound! Choose your move.');
 },
 undoingame:()=>{
  if(!powers||!match||match.state.winner)return;
  close();
  const ctx=powerContext(null,false);
  const applied=powers.apply('undo',ctx);
  if(!applied.applied)notify('Could not rewind move.');
  else {
   match.assisted=true;
   notify('Turn rewound!');
   renderPowerControls();
  }
 },
 /* The visible Bot control zone. Both buttons act only when the pure module says the kind is
    eligible and the player can actually pay for it; a shown/skipped ad grants nothing and the
    player is told the truth instead. */
 botundo:async()=>{
  if(!powers||!match||match.state.winner)return;
  const ctx=powerContext(null,!!botTimer);
  const elig=powers.eligibility(ctx);
  if(!elig.undo.eligible)return notify(powerReasonText(R.powersAllowed(ctx,'undo')?elig.undo.reason:'MODE_NOT_ELIGIBLE'));
  if(ctx.charges<1){
   /* No charge is banked, so the offered path is the ad. The promise is stated before it starts. */
   if(!await askReward(undoRewardCopy()))return;
   const earned=await powers.request('undo',ctx);
   if(!earned.earned)return notify(powerReasonText(earned.reason));
   /* A restart, leave or resign during the ad replaces the match. The earned item stays banked
      rather than being spent on a board the player is no longer looking at. */
   if(!match||match.id!==ctx.id)return notify('Two Undo presses earned and banked.');
  }
  const applied=powers.apply('undo',powerContext(null,!!botTimer));
  if(!applied.applied)return notify(powerReasonText(applied.reason));
  match.assisted=true;hintSquare=null;
  notify('Turn rewound! Choose your move.');
  renderPowerControls();paint();
 },
 bothint:async()=>{
  if(!powers||!match||match.state.winner)return;
  const ctx=powerContext(null,!!botTimer);
  const elig=powers.eligibility(ctx).hint;
  if(!elig.eligible)return notify(powerReasonText(elig.reason));
  if(powers.inventory().hint.available<1){
   if(!await askReward(hintRewardCopy()))return;
   const earned=await powers.request('hint',ctx);
   if(!earned.earned)return notify(powerReasonText(earned.reason));
   if(!match||match.id!==ctx.id)return notify('Tactical Power earned and banked.');
  }
  const applied=powers.apply('hint',powerContext(null,!!botTimer));
  if(!applied.applied)return notify(powerReasonText(applied.reason));
  notify('Recommended square highlighted. You can still play anywhere legal.');
  renderPowerControls();paint();
 },
 /* Deliberately a disclosure, not a control: see counterDisclosure(). */
 powercounters:()=>open('Counter powers',counterDisclosure()+'<p class="caption">Your Tactical Power suggestion is not revealed to a counter while a counter window is open, and a counter never reveals a suggestion that was already shown.</p>'+fullButton('Close','close','',true),'info'),
 rewardyes:()=>{close();rewardAnswer(true);},rewardno:()=>{close();rewardAnswer(false);},
 acceptfriend:async id=>{try{await NET.acceptFriend(id,opId());await refreshOnline();render();}catch(e){notify(friendlyError(e));}},
 cancelqueue:async()=>{if(queueCancelling)return;queueCancelling=true;clearInterval(onlinePoll);waitingId=null;try{if(queueSubmission)await queueSubmission.catch(()=>{});const r=await NET.cancelQueue(opId());if(r.state==='playing'){beginOnline(await NET.match(r.matchId));return;}}catch{notify('Cancellation could not be confirmed. Reconnect to check the match.');}finally{queueCancelling=false;}close();},
 cancelinvite:async()=>{const id=waitingId;if(!id)return;try{await NET.cancel(id,opId());clearInterval(onlinePoll);waitingId=null;close();}catch(e){notify(friendlyError(e));}},
 close:()=>{if(sheetKind==='reward'){const answer=rewardAnswer;rewardAnswer=()=>{};const settle=()=>answer(false);close();return settle();}if(sheetKind==='terminal'){finalizeTerminalResult();close();return;}if(sheetKind==='queue')return actions.cancelqueue();if(sheetKind==='waiting'&&waitingId)return $('#sheet [data-action="cancelqueue"]')?actions.cancelqueue():actions.cancelinvite();close();},theme:v=>{if(!themeNames[v])return;data.settings.theme=v;applyTheme();save();if(sheetKind==='settings'){const top=$('#sheet').scrollTop;settings();$('#sheet').scrollTop=top;}render();paint();},
 statmode:v=>{statsMode=v;statsDifficulty='all';render();},metric:v=>{rankMetric=v;online.rows=[];render();refreshOnline();},league:v=>{rankLeague=v;online.rows=[];render();refreshOnline();},challenge,friendchallenge:v=>challenge(v,'friend'),sendchallenge:sendChallenge,reviewinvite:reviewInvite,
 acceptinvite:async v=>{const m=online.invitations.find(x=>x.id===v);if(!m)return;try{const accepted=await NET.accept(v,m.termsHash,opId());window.MegaCommunity?.refresh?.(false);if(accepted.status==='PLAYING')beginOnline(accepted);else watchInvitation(accepted.id,accepted.terms?.source==='queue'?'queue':'challenge',accepted);}catch(e){if(['REQUOTE_REQUIRED','OFFER_EXPIRED','TERMS_CHANGED'].includes(e?.message)){close();refreshOnline();window.MegaCommunity?.refresh?.(false);}notify(friendlyError(e));}},
 declineinvite:async v=>{try{await NET.decline(v,opId());close();await refreshOnline();window.MegaCommunity?.refresh?.(false);}catch(e){notify(friendlyError(e));}},
 openfriends:()=>{close();page='friends';render();refreshOnline();},exchange:reviewExchange,exchangeconfirm:confirmExchange,
 claim:async v=>{try{let n;if(online.ready){n=await NET.quest(v,opId());await refreshOnline();}else n=D.claim(data,v);save();render();notify(n?'Claimed '+n+' Coins.':'Quest is not ready.');}catch(e){notify(friendlyError(e));}},
 cosmetic:async v=>{const cost={'Copper edge':30,'Orbit frame':60,'Crown frame':120}[v];try{if(online.ready){await NET.cosmetic(v,opId());online.profile=await NET.profile();}else D.spend(data,v,cost);save();render();wallet();notify('Cosmetic added.');}catch(e){notify(e.message==='INSUFFICIENT_COINS'?'Earn a few more Coins first.':'Could not complete the purchase.');}},
 buy:async v=>{try{if(!online.ready)return notify('Sign in before purchasing Crowns.');if(!window.MegaBilling?.purchase)return notify('The store is unavailable.');const evidence=await window.MegaBilling.purchase(v);await NET.purchase(evidence,opId());await refreshOnline();wallet();}catch{notify('Purchase not completed.');}},
 billing:()=>{if(window.MegaBilling?.restore)window.MegaBilling.restore().catch(()=>notify('The store is unavailable.'));else notify('The store is unavailable.');},
 findfriend:async()=>{const name=$('#friendName').value.trim();if(!name)return notify('Enter a username first.');try{const person=await NET.friend(name);if(!person)return notify('Player not found.');online.profile=await NET.profile();render();notify('Friend request sent.');}catch(e){notify(friendlyError(e));}},
 copyfriend:()=>{const code=online.profile?.friendCode;if(!code)return notify('Sign in to share your friend code.');if(navigator.clipboard?.writeText)navigator.clipboard.writeText(code).then(()=>notify('Friend code copied.')).catch(()=>notify(code));else notify(code);},
 practice:()=>{close();mode='bot';difficulty='Beginner';startGame(true);},
 leave:()=>{if(!match||match.state.winner)return leave();if(match.online){actions.resign();return;}open('Leave this game?','<p>Your current offline match will be discarded. No coins or completed-game stats are awarded.</p>'+fullButton('Leave game','home')+fullButton('Keep playing','close','',true));},
 home:leave,restart:()=>{if(match?.online){actions.resign();return;}open('Start a new game?','<p>This discards the current match, without rewards.</p>'+fullButton('Start again','restartyes')+fullButton('Keep playing','close','',true));},restartyes:()=>{if(match?.pendingTerminal)finalizeTerminalResult();close();startGame(match?.practice||false);},
 rematch:()=>{if(match?.pendingTerminal)finalizeTerminalResult();if(match?.online){leave();page='friends';render();return;}close();startGame(match?.practice||false,true);},resign:()=>{if(!match||match.state.winner)return;open('Resign?','<p>'+(match.online?'Resigning ends this match as a loss. Ranked rating and the agreed pot will settle.':'A bot game resignation counts as a loss, but gives no coins.')+'</p>'+fullButton('Resign match','resignyes')+fullButton('Keep playing','close','',true));},
 resignyes:()=>{if(match?.online){onlineResign();return;}close();match.state={...match.state,winner:match.mode==='bot'?'O':match.state.turn==='X'?'O':'X'};finish('resign');},queue:startQueue,settings,wallet,tutorial,rules,aipack:()=>window.MegaAiPack?.show(),matchstats:currentMatchStats,rankhelp:rankHelp,feehelp:feeHelp,weeklyhelp:weeklyHelp,onlineinfo:onlineInfo,retrybot:()=>{close();if(match){match.status='ready';scheduleBot();}},fallbackexpert:()=>{if(match&&LA){match=LA.expertFallback(match,{confirmed:true});$('#matchLevel').textContent='Expert (Fallback \u00b7 Unverified)';close();notify('Switched to Expert bot. Result remains unverified with no rewards.');scheduleBot();}}};
document.addEventListener('click',e=>{const el=e.target.closest('[data-action]');if(!el||el.disabled)return;const fn=actions[el.dataset.action];if(fn)return fn(el.dataset.value||'');});
document.addEventListener('keydown',e=>{const sheet=$('#sheet');if(sheet.hidden)return;if(e.key==='Escape'){e.preventDefault();actions.close();return;}if(e.key!=='Tab')return;const nodes=[...sheet.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')].filter(n=>n.getClientRects().length&&!n.inert);if(!nodes.length){e.preventDefault();sheet.focus();return;}const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}});
document.addEventListener('change',e=>{
 const el=e.target;if(el.dataset.setting){const key=el.dataset.setting,value=el.type==='checkbox'?el.checked:Number(el.value);
  if(key==='notifications'&&value){el.disabled=true;Promise.resolve(window.MegaCommunity?.requestNotificationPermission?.()??true).then(ok=>{data.settings.notifications=ok===true;save();settings();if(ok!==true)notify('Device notifications were not enabled. In-app activity remains under the bell.');}).catch(()=>{data.settings.notifications=false;save();settings();notify('Device notifications are unavailable here.');});return;}
  data.settings[key]=value;save();if(key==='music')syncAudio();applyTheme();if(key==='preview')clearPreview();if(key==='notifications')settings();window.MegaCommunity?.notificationPreferencesChanged?.();paint();return;}
 if(el.id==='difficulty')difficulty=el.value;else if(el.id==='first')first=el.value;else if(el.id==='setupTimer'){data.settings.timer=Number(el.value);save();}
 else if(el.id==='statsDifficulty'){statsDifficulty=['all',...G.LEVELS].includes(el.value)?el.value:'all';render();}else if(el.id==='rankScope'){rankScope=el.value;online.rows=[];render();refreshOnline();}else if(el.id==='rankLeague'){rankLeague=el.value;online.rows=[];render();refreshOnline();}
 else if(el.id==='profileRegion'){data.profile.region=el.value;save();render();if(online.ready)NET.preferences({region:el.value},opId()).catch(()=>notify('Could not save the online preference.'));}else if(el.id==='wealthPublic'){data.profile.wealthPublic=el.checked;save();if(online.ready)NET.preferences({wealthPublic:el.checked},opId()).catch(()=>notify('Could not save the online preference.'));}else if(el.id.startsWith('challenge'))updateQuote(el.id==='challengeRated');else if(el.id.startsWith('exchange')){if(el.id==='exchangeFrom'){const coins=el.value==='coins';$('#exchangeAmount').step=coins?'10':'1';$('#exchangeAmount').min=coins?'10':'1';$('#exchangeAmount').value=coins?'10':'1';}updateExchange();}
});
for(const [id,name] of [['brandIcon','board'],['coinIcon','coin'],['crownIcon','crown'],['notificationButton','bell'],['settingsButton','settings'],['sheetClose','close'],['backIcon','back'],['matchSettings','sliders'],['routeIcon','route'],['rulesIcon','help'],['restartIcon','refresh'],['statsIcon','chart']])$('#'+id).innerHTML=icon(name);
T?.bind({getMatch:()=>match,notify,save,paint,scheduleBot,cancelBot:()=>A?.cancel(),commitBot:m=>move(m,'bot'),restart:()=>{close();startGame(true);}});
refreshIcons();applyTheme();buildBoard();render();save();renderConnectivity(window.MegaAccount?.connectivity?.()||{state:navigator.onLine===false?'offline':'online'});refreshOnline();initPowers();
if(window.MegaBilling?.products)window.MegaBilling.products().then(items=>{online.products=items.filter(p=>D.CROWN_PACKS.some(q=>q.id===p.id));if(sheetKind==='wallet')wallet();}).catch(()=>{});

// Explicit UI integration points; these never mutate a server wallet or server rating.
window.MegaApp=Object.freeze({
 render,refresh:refreshOnline,notify,open,close,tutorial,openSettings:settings,
 goRewards:()=>{close();page='rewards';render();$('#contentScroll').scrollTop=0;},
 getContext:()=>({page,mode,onlineType,sheetKind,playing:!!match&&!match.state.winner,onlineMatch:!!match?.online,waitingId}),
 getSave:()=>structuredClone(data),
 applyPractice:value=>{if(match&&!match.state.winner)throw Error('MATCH_ACTIVE');data=D.migrate(structuredClone(value));data.playSeconds=data.playSeconds||{};data.profile=data.profile||{};applyTheme();save();render();},
 goFriends:()=>actions.nav('friends'),
 challenge:async id=>{await refreshOnline();challenge(id,'friend');},
 reviewInvite:async id=>{await refreshOnline();reviewInvite(id);},
 resumeOnline:async id=>{await refreshOnline();if(!online.ready)throw Error('AUTH_REQUIRED');const m=await NET.match(id);if(m.status==='PLAYING')beginOnline(m);else if(m.status==='OFFERED')watchInvitation(id,m.terms.source==='queue'?'queue':'challenge');},
 resumeOffline:async()=>{
  const old=data.offlineMatch||(parse(KEY)?.offlineMatch);if(!old)return;data.offlineMatch=old;
  let state=G.create(old.first);
  for(const m of old.moves||[])state=G.apply(state,m);
  const isPendingLoss=!!(old.pendingTerminal&&state.winner==='O'&&old.mode==='bot'&&old.pendingTerminal.reason==='line');
  if(state.winner&&!isPendingLoss)throw Error('MATCH_FINISHED');
  T?.stop();A?.cancel();localSession?.cancel();clearTimeout(botTimer);botTimer=null;
  mode=['bot','local'].includes(old.mode)?old.mode:'bot';
  difficulty=['Impossible',...G.LEVELS].includes(old.difficulty)?old.difficulty:'Medium';
  first=old.first;
  const isNeuralMatch=(old.localAi&&old.localAi.engine==='neural')||old.difficulty==='Impossible';
  match={id:old.id,state,mode,difficulty:old.difficulty,first:old.first,practice:old.practice===true,active:Math.max(0,Math.min(86400,Number(old.active)||0)),turnLimit:[0,30,60].includes(old.turnLimit)?old.turnLimit:0,turnRemaining:Math.min([0,30,60].includes(old.turnLimit)?old.turnLimit:0,Math.max(0,Number(old.turnRemaining)||0)),last:old.moves?.at(-1)||null,recorded:false,pending:null};
  if(BR&&!isNeuralMatch)match.bot=BR.startInfo(old.bot,old.practice===true);
  if(isPendingLoss){
   match.pendingTerminal={reason:old.pendingTerminal.reason,record:old.pendingTerminal.record||null};
  }
  attachPowers(match,old);
  if(old.localAi&&LA){
   const catalog=localSession?.getCatalog?.()||BP?.APPROVED_CATALOG||[];
   try{
    const restored=LA.restore(old.localAi,catalog);
    match.version=restored.version;
    match.resultClass=restored.resultClass;
    match.difficulty=restored.difficulty;
    match.engine=restored.engine;
    match.pin={...restored.pin};
    match.seed=restored.seed;
    match.status=restored.status;
    if(restored.fallbackFrom)match.fallbackFrom=restored.fallbackFrom;
    if(restored.engine==='neural'&&restored.status==='ready'){
     try{
      const info=catalog.find(m=>m.sha256===restored.pin.modelHash&&m.version===restored.pin.packVersion);
      if(!info){match.status='pack-unavailable';}
      else{
       const manifest=BP.manifest(info,location.href);
       const bytes=await localSession.store.read(manifest);
       if(!bytes){match.status='pack-unavailable';}
       else{await localSession.runtime.configure(manifest,bytes);}
      }
     }catch{match.status='pack-unavailable';}
    }
    if(match.status==='pack-unavailable'){
     notify('The model for this Impossible match is unavailable. Choose recovery.');
     openNeuralRecovery({code:'PACK_UNAVAILABLE'});
    }
   }catch(e){
    match.status='pack-unavailable';
    notify('Saved Impossible match could not resolve model.');
    openNeuralRecovery(e);
   }
  }
  if(old.practice)T?.restore(match,old.tutorial);
  $('#gameScreen').hidden=false;
  $('#matchMode').textContent=match.practice?'Tutorial practice':match.mode==='local'?'Pass & Play':'Vs Bot';
  $('#matchLevel').textContent=match.mode==='local'?'Two players, one device':match.difficulty==='Impossible'?'Impossible \u00b7 '+(match.pin?.packVersion||'Neural'):match.difficulty+' difficulty';
  $('#playerXName').textContent=match.mode==='local'?'Player X':'You';
  $('#playerOName').textContent=match.mode==='local'?'Player O':match.difficulty==='Impossible'?'Impossible Bot':'Bot';
  lastTick=lastInput=performance.now();paint();save();
  if(isPendingLoss)offerTerminalUndo();
  else if(match.status==='ready')scheduleBot();
 },
 startImpossible:async info=>{
  if(!localSession)throw Error('LOCAL_SESSION_UNAVAILABLE');
  if(info){
   const catalog=localSession.getCatalog();
   if(!catalog.some(m=>m.sha256===info.sha256)){
    localSession.setCatalog([...catalog,info]);
   }
  }
  const manifest=info?BP.manifest(info,location.href):localSession.getLatestManifest();
  if(!manifest)throw Error('NO_APPROVED_MODEL');
  const readBytes=await localSession.store.read(manifest);
  if(!readBytes)throw Error('PACK_NOT_DOWNLOADED');
  await localSession.runtime.configure(manifest,readBytes);
  const pin=localSession.store.pin(manifest);
  mode='bot';difficulty='Impossible';
  startGame(false,false,pin);
 },
 getLocalSession:()=>localSession,
 setLocalSession:s=>{localSession=s;},
 getImpossibleStats:()=>LA?LA.stats(data):null
});

// Read-only diagnostics: no method can credit money, set rank or submit a server result.
window.MegaXO=Object.freeze({version:'3.4.0-economy-2',getState:()=>match?structuredClone(match.state):null,getSettings:()=>({...data.settings}),getTutorial:()=>T?.snapshot(match)||null,getBotInfo:()=>match?.bot?({...match.bot}):null,getBotDiagnostics:()=>match?.botDiagnostics?structuredClone(match.botDiagnostics):null,getLocalAiInfo:()=>match?.resultClass==='unverified-local-ai'?{packVersion:match.pin?.packVersion,modelHash:match.pin?.modelHash,engine:match.engine,status:match.status,fallbackFrom:match.fallbackFrom||null}:null});
try{if(!window.MegaAccount&&!localStorage.getItem('mega_v32_tutorial_seen'))tutorial();}catch{}
})();
