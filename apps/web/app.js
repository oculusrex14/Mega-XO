import {icon, button, escapeHtml, rankEmblem} from './ui.js';
import {routes, renderPage} from './pages.js';
import {renderPreview, renderPractice, renderGame, mountBoard} from './board.js';

import {createReadModel, readJSON, authRequired, errorCopy} from './data.js';
import {legalDocuments} from './legal-documents.js';

const navigation=[['/','Play'],['/ranked','Ranked'],['/tournaments','Tournaments'],['/rewards','Rewards'],['/themes','Themes'],['/leaderboard','Leaderboard'],['/store','Store']];
let board=null;
let tab='ranked';
let toastTimer;
const main=document.querySelector('#main');
const productIds=['crowns_100','crowns_525','crowns_1100','remove_ads'];
const context={profile:null, sessionStatus:'loading', providers:{}, accountView:'email',
 legalDocuments:Object.fromEntries(Object.entries(legalDocuments).map(([key,value])=>['/'+key,value])),
 products:{status:'ready',rows:productIds.map(id=>({id,enabled:false})),purchasesAvailable:false},
 leaderboard:{status:'loading',rows:[],metric:'rating',scope:'global',league:'all'}};
const tierIds=['wood','stone','iron','bronze','silver','gold','diamond','emerald','champion','master','grandmaster'];
const balance=value=>Number.isSafeInteger(value)&&value>=0?value.toLocaleString('en-US'):'—';
const model=createReadModel({context,changed:()=>{if(normalizedPath()==='/game')synchronizeGameProfile();else render();}});
let activePath='',leaderboardTimer,accountChallenge='',resetReady=false,serviceBusy=false,onlineTimer,onlineBusy=false,onlineRevision=0;
let boundOnlineActor=null,hydratingMatch='';
let onlineState={status:'idle',match:null,invitation:null,message:''};
try{const saved=JSON.parse(localStorage.getItem('mega-xoxo-sponsor-interests')||'null');if(saved?.consent===true)context.sponsorPreferences=saved;}catch{}

function header(path) {
 const wallet=context.profile?.wallet;
 const coins=balance(wallet?.coins),crowns=balance(wallet?.crowns);
 document.querySelector('#header').innerHTML=`<a class="mx-brand" href="/" aria-label="Mega XOXO home"><img src="/assets/art/header.webp" width="236" height="70" alt="Mega XOXO" fetchpriority="high"></a><nav class="mx-desktop-nav" aria-label="Main navigation">${navigation.map(([href,label])=>`<a href="${href}" ${href===path?'aria-current="page"':''}>${label}</a>`).join('')}</nav><div class="mx-wallet"><a href="/store" class="mx-wallet-pill" aria-label="Coins ${coins}${wallet?'':' — sign in to see your balance'}">${icon('coin','mx-coin')}<b>${coins}</b>${icon('plus')}</a><a href="/store" class="mx-wallet-pill" aria-label="Crowns ${crowns}${wallet?'':' — sign in to see your balance'}">${icon('crown','mx-crown')}<b>${crowns}</b>${icon('plus')}</a><a class="mx-avatar" href="/account" aria-label="Your account">${icon('user')}</a><button class="mx-menu-button" aria-expanded="false" aria-controls="mobile-menu" aria-label="Open navigation">${icon('menu')}</button></div><nav id="mobile-menu" class="mx-mobile-nav" aria-label="Mobile navigation" hidden>${navigation.map(([href,label])=>`<a href="${href}" ${href===path?'aria-current="page"':''}>${label}</a>`).join('')}<a href="/sponsors">Sponsors</a><a href="/friends">Friends</a><a href="/settings">Settings</a><a href="/support">Support</a></nav>`;
}
function platformStrip(){return `<div class="mx-platform-strip"><span class="mx-platform-icons">${icon('monitor')}${icon('apple')}${icon('android')}</span><span>Play on Browser, iOS, Android</span><span class="mx-platform-divider"></span><span>Same account. Anywhere.</span></div>`;}
function miniTheme(mark='X') {return `<div class="mx-art-board ${mark==='O'?'pink':''}" aria-hidden="true">${Array.from({length:9},(_,i)=>`<span>${[0,4,8].includes(i)?mark:''}</span>`).join('')}</div>`;}
function deviceArt(){return `<img class="mx-device-art mx-device-image" src="/assets/art/devices.webp" width="245" height="162" alt="" aria-hidden="true">`;}
function features(){return `<section class="mx-features" aria-label="A bigger way to play"><a class="mx-feature trophy-feature" href="/ranked"><img class="mx-trophy-art" src="/assets/art/trophy.webp" width="220" height="240" alt="" loading="eager"><div class="mx-feature-copy"><h2>Ranked Matches</h2><p>Climb the ranks, prove your skill,<br>and compete in seasonal ladders.</p><div class="mx-season-chip"><span class="mx-status-dot"></span><div><b>Every move matters</b><small>Explore the Ranked leagues</small></div></div></div><span class="mx-feature-arrow">${icon('chevron-right')}</span></a><a class="mx-feature devices-feature" href="/about"><div class="mx-feature-icon">${icon('cloud')}</div><div class="mx-feature-copy"><h2>Cross-Platform Progress</h2><p>Play on web, iOS, and Android.<br>Your stats, rank, and rewards<br>sync with your linked account.</p></div>${deviceArt()}</a><a class="mx-feature themes-feature" href="/themes"><div class="mx-feature-icon">${icon('palette')}</div><div class="mx-feature-copy"><h2>Themes &amp; Rewards</h2><p>Explore five themes, earn rewards,<br>and make every move your own.</p><div class="mx-reward-icons"><span>${icon('coin','mx-coin')}</span><span>${rankEmblem()}</span><span>${icon('crown','mx-crown')}</span><span>${icon('star')}</span></div></div><div class="mx-themes-art">${miniTheme('X')}${miniTheme('O')}</div><span class="mx-feature-arrow">${icon('chevron-right')}</span></a></section>`;}
function rankPanel(){return `<aside class="mx-ranked mx-panel" aria-label="Online play"><div class="mx-mode-tabs" role="tablist" aria-label="Online mode">${['ranked','casual','friends'].map(mode=>`<button role="tab" id="tab-${mode}" aria-selected="${tab===mode}" aria-controls="mode-panel" tabindex="${tab===mode?0:-1}" data-mode="${mode}">${mode[0].toUpperCase()+mode.slice(1)}</button>`).join('')}</div><div id="mode-panel" role="tabpanel" aria-labelledby="tab-${tab}">${rankPanelContent()}</div></aside>`;}
function rankPanelContent(){if(tab==='ranked'){
 const profile=context.sessionStatus==='linked'?context.profile:null;
 const tier=typeof profile?.tier==='string'&&tierIds.includes(profile.tier.toLowerCase())?profile.tier.toLowerCase():null;
 const name=tier?tier[0].toUpperCase()+tier.slice(1):'Your rank is unpublished';
 const art=profile?(tier?`<img class="mx-rank-art" src="/assets/art/ranks/${tier}.webp" width="171" height="154" alt="${escapeHtml(name)} league">`:icon('shield','mx-rank-art')):'<img class="mx-rank-art" src="/assets/art/ranks/diamond.webp" width="171" height="154" alt="Decorative crystal league emblem">';
 const rating=typeof profile?.rating==='number'&&Number.isFinite(profile.rating)?profile.rating.toLocaleString('en-US',{maximumFractionDigits:2}):'—';
 return `<div class="mx-rank-badge" data-rank-tier="${tier||''}">${art}</div><h2>${profile?name:'Climb the ranks'} <a href="/ranked" aria-label="Learn about Ranked">${icon('info')}</a></h2><p class="mx-rank-rating">${profile?`${rating} Rating`:'Your journey starts here'}</p><div class="mx-rank-track" aria-hidden="true"><span></span></div><p class="mx-rank-hint">${profile?(profile.season?.qualified?'Season qualified':'Complete your season qualification'):'Sign in to see your rating'}</p><a class="mx-season-card" href="/season">${icon('trophy')}<span><b>Quarterly seasons</b><small>New rivals. Bigger ambitions.</small></span><span class="mx-chip">Explore</span></a>${button(profile?'Find Ranked Match':'Sign in to play online',profile?'/game?online=ranked':'/account','blue','swords')}`;
 }
 if(tab==='casual')return `<div class="mx-rank-badge">${icon('globe')}</div><h2>Play your way</h2><p class="mx-rank-rating">All the strategy. No Elo at stake.</p><p class="mx-tab-description">Warm up in offline practice, or sign in for a Casual match.</p>${button('Start practice','/play?mode=practice','blue','arrow-right')}${button('Play Casual online','/game/','secondary','globe')}`;
 return `<div class="mx-rank-badge">${icon('people')}</div><h2>Better with a rival</h2><p class="mx-rank-rating">One friend. Nine boards.</p><p class="mx-tab-description">Link your account to find friends and send a direct challenge.</p>${button('Find your friends','/friends','blue','people')}${button('Try local practice','/play?mode=practice','secondary','swords')}`;}
function home(){return `<div class="mx-home"><section class="mx-hero" aria-labelledby="hero-title"><div class="mx-hero-copy"><p class="mx-eyebrow">BIGGER MOVES. BRIGHTER MINDS.</p><h1 id="hero-title">The Ultimate<br>Tic-tac-toe.<br><span class="mx-accent">Think bigger.</span></h1><p class="mx-hero-description">Win the small boards to win the big one.<br> Every move also decides where your opponent plays next.</p><div class="mx-hero-actions">${button('Play Now','/play?mode=practice','primary','chevron-right')}${button('Play in Browser','/game','secondary','globe')}</div>${platformStrip()}</div><div class="mx-preview" data-board-host>${renderPreview()}</div>${rankPanel()}</section>${features()}</div>`;}
function footer(){document.querySelector('#footer').innerHTML=`<div class="mx-footer-brand"><img src="/assets/art/mark.webp" width="40" height="40" alt=""><span>Mega XOXO <small>by Antimatter Innovations</small></span></div><nav aria-label="Footer navigation"><a href="/how-to-play">How to play</a><a href="/friends">Friends</a><a href="/store">Store</a><a href="/sponsors">Sponsors</a><a href="/about">About</a><a href="/support">Support</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/settings">Settings</a></nav><span class="mx-footer-note">Nine small boards. One bigger game.</span>`;}
function normalizedPath(){return location.pathname.replace(/\/+$/,'')||'/';}
function render({focus=false}={}){
 board?.destroy();board=null;
 const path=normalizedPath();
 const route=path==='/game'?{title:'Play in Browser',description:'Play Mega XOXO in your browser.'}:routes.find(item=>item.path===path);
 document.body.dataset.page=path==='/'?'home':'inner';
 header(path);footer();
 main.innerHTML=path==='/'?home():path==='/game'?renderGame({match:visibleMatch(),actorId:context.profile?.id}):path==='/play'&&new URLSearchParams(location.search).get('mode')==='practice'?renderPractice():renderPage(path,context)||renderPage('/404',context);
 document.title=path==='/'?'Mega XOXO — Think bigger.':`${route?.title||'Page not found'} — Mega XOXO`;
 const desc=document.querySelector('meta[name="description"]');if(desc)desc.content=route?.description||'The Ultimate Tic-tac-toe. Nine small boards. One bigger game.';
 document.querySelectorAll('[data-board-host]').forEach(host=>{board=mountBoard(host,{preview:host.dataset.boardPreview!=='false'&&path==='/',mode:host.dataset.boardMode,difficulty:host.dataset.boardDifficulty,theme:host.dataset.boardTheme,...(path==='/game'&&visibleMatch()?{online:{match:visibleMatch(),actorId:context.profile?.id,onMove:sendOnlineMove,onResign:sendOnlineResign,onError:handleOnlineError}}:{})})});
 if(path==='/game'){boundOnlineActor=visibleMatch()?context.profile.id:null;updateOnlineControls();}
 if(path==='/store'&&context.products.status!=='error')main.querySelector('[data-store-products]')?.insertAdjacentHTML('afterend','<div class="pg-actions"><button class="mx-button secondary" data-store-action="refresh">Check store availability</button></div>');
 if(path==='/account'&&context.sessionStatus==='guest'&&!context.providersLoaded){main.querySelector('.pg-auth-card')?.insertAdjacentHTML('beforeend','<button class="mx-button secondary" type="button" data-account-action="options">Check sign-in options</button>');}
 if(focus){main.focus({preventScroll:true});window.scrollTo(0,0);}
}
function navigate(href){history.pushState({},'',href);render({focus:true});activate();}
function notify(message){const el=document.querySelector('#notification');el.textContent=message;el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.hidden=true},4500);}
document.addEventListener('click',event=>{
 const menu=event.target.closest('.mx-menu-button');if(menu){const nav=document.querySelector('#mobile-menu');nav.hidden=!nav.hidden;menu.setAttribute('aria-expanded',String(!nav.hidden));return;}
 const mode=event.target.closest('[data-mode]');if(mode){tab=mode.dataset.mode;document.querySelector('.mx-ranked').outerHTML=rankPanel();document.querySelector(`#tab-${tab}`).focus();return;}
 const action=event.target.closest('[data-page-action]');if(action){const name=action.dataset.pageAction;
  if(name==='theme-preview'){document.querySelectorAll('[data-page-action="theme-preview"]').forEach(x=>x.setAttribute('aria-pressed',String(x===action)));const label=action.dataset.theme||action.dataset.previewTheme;const preview=document.querySelector('[data-theme-preview]');if(preview)preview.dataset.theme=label;notify('Theme preview selected. Open the game to change your play theme.');}
  if(name==='copy-support-info'){const info=`Mega XOXO website\nPage: ${normalizedPath()}\nBrowser: ${navigator.userAgent}`;navigator.clipboard?.writeText(info).then(()=>notify('Support details copied.')).catch(()=>notify('Copy unavailable. Include the page URL with your support request.'));}
  if(name==='reset-appearance')notify('Website appearance reset. Your game settings stay in the game.');
 }
 const anchor=event.target.closest('a[href]');if(!anchor||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||anchor.target||anchor.hasAttribute('download'))return;
 const url=new URL(anchor.href,location.href);if(url.origin!==location.origin||url.pathname.startsWith('/legacy-game')||url.hash)return;
 event.preventDefault();navigate(url.pathname+url.search);
});
document.addEventListener('keydown',event=>{
 const t=event.target.closest('[data-mode]');if(t&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const modes=['ranked','casual','friends'];const i=modes.indexOf(tab);tab=event.key==='Home'?modes[0]:event.key==='End'?modes[2]:modes[(i+(event.key==='ArrowRight'?1:2))%3];document.querySelector('.mx-ranked').outerHTML=rankPanel();document.querySelector(`#tab-${tab}`).focus();}
 if(event.key==='Escape'){const nav=document.querySelector('#mobile-menu');if(nav&&!nav.hidden){nav.hidden=true;document.querySelector('.mx-menu-button').setAttribute('aria-expanded','false');document.querySelector('.mx-menu-button').focus();}}
});
function activate(){
 const path=normalizedPath();
 if(path!==activePath){activePath=path;clearInterval(leaderboardTimer);clearInterval(onlineTimer);onlineRevision++;
  if(path==='/store'&&context.sessionStatus==='linked')refreshProducts();
  if(path==='/leaderboard'){model.leaderboard();leaderboardTimer=setInterval(()=>{if(!document.hidden&&context.leaderboard.status==='ready')model.leaderboard();},30000);}
  if(path==='/game'&&['queued','waiting','playing'].includes(onlineState.status))startOnlinePolling();
 }
}
async function accountAction(task){
 if(serviceBusy)return;serviceBusy=true;context.accountBusy=true;context.accountMessage='';render();
 try{await task();}catch(error){context.accountMessage=errorCopy(error);}
 finally{serviceBusy=false;context.accountBusy=false;render();}
}
async function linkedAccount(){
 accountChallenge='';resetReady=false;context.accountView='email';globalThis.MegaAccount.reset();
 await model.profile();if(context.sessionStatus==='linked')context.accountMessage='Your profile is ready.';
}
async function refreshProducts(){
 context.products={status:'loading',rows:[],purchasesAvailable:false};render();
 try{
  const status=await readJSON('/api/monetization/status');
  const bridge=globalThis.MegaBilling;
  const prices=bridge?.products?await bridge.products(status.storeContext||null):[];
  context.products={status:'ready',purchasesAvailable:status.purchasesAvailable===true&&typeof bridge?.purchase==='function',storeContext:status.storeContext,
   rows:productIds.map(id=>({id,owned:Array.isArray(status.products)&&status.products.includes(id),enabled:status.purchasesAvailable===true&&typeof bridge?.purchase==='function'&&!(id==='remove_ads'&&status.adMode!=='hybrid'),localizedPrice:Array.isArray(prices)?prices.find(row=>row.id===id&&typeof row.price==='string')?.price:undefined}))};
 }catch(error){context.products={status:'error',rows:[],purchasesAvailable:false};notify(errorCopy(error));}
 if(normalizedPath()==='/store')render();
}
function updateOnlineControls(){
 if(normalizedPath()!=='/game')return;
 let region=main.querySelector('.mx-online-controls');
 if(!region){main.querySelector('.gb-game-page')?.insertAdjacentHTML('beforeend','<section class="mx-panel mx-online-controls" aria-labelledby="online-title"></section>');region=main.querySelector('.mx-online-controls');}
 if(!region)return;
 const linked=context.sessionStatus==='linked';const state=onlineState;
 let controls=linked?`<div class="pg-actions"><button class="mx-button primary" data-online-action="ranked" ${onlineBusy?'disabled':''}>${icon('swords')} Find Ranked Match</button><button class="mx-button secondary" data-online-action="casual" ${onlineBusy?'disabled':''}>${icon('globe')} Find Casual Match</button></div>`:button('Sign in to play online','/account','primary','user');
 if(['queued','waiting'].includes(state.status))controls=`<p>Finding your next rival…</p><button class="mx-button secondary" data-online-action="cancel" ${onlineBusy?'disabled':''}>Leave matchmaking</button>`;
 if(state.status==='review'&&state.invitation){const m=state.invitation;const index=m.players.indexOf(context.profile?.id);const fee=m.quote?.contributions?.[index];controls=`<p>Review your match before accepting.</p><p>${m.quote?.rated?'Ranked':'Casual'} · Entry ${typeof fee==='number'?escapeHtml(fee):'—'} ${escapeHtml(m.quote?.currency||'Coins')}</p><p>Winner receives ${balance(m.quote?.payout)} · Retired from pot ${balance(m.quote?.burn)} · Turn timer ${balance(m.terms?.turnSeconds)} seconds</p><div class="pg-actions"><button class="mx-button primary" data-online-action="accept" ${onlineBusy?'disabled':''}>Accept match</button><button class="mx-button secondary" data-online-action="decline" ${onlineBusy?'disabled':''}>Decline</button></div>`;}
 if(state.message&&linked)controls+='<button class="mx-button secondary" data-online-action="retry">Retry connection</button>';
 if(state.match&&linked)controls=state.match.status==='PLAYING'?'<p>Your match is live. Moves are confirmed by the game service.</p>':'<button class="mx-button secondary" data-online-action="new">Choose your next match</button>';
 if(state.match&&linked&&state.message)controls+='<button class="mx-button secondary" data-online-action="retry">Retry connection</button>';
 region.innerHTML=`<h2 id="online-title">Bring your strategy online.</h2><p class="mx-muted">One profile. The same Ranked and Casual competition.</p>${controls}<p role="status" class="mx-online-message">${escapeHtml(state.message)}</p>`;
}
function synchronizeGameProfile(){
 const actor=context.sessionStatus==='linked'?context.profile?.id:null;
 if(context.sessionStatus==='loading'){header('/game');updateOnlineControls();return;}
 if(boundOnlineActor&&actor!==boundOnlineActor){onlineRevision++;clearInterval(onlineTimer);onlineState.status=actor?'idle':'auth';if(actor&&!onlineState.match?.players?.includes(actor))onlineState.match=null;render();}
 if(actor&&typeof context.profile.activeMatch==='string'&&context.profile.activeMatch&&(!onlineState.match||onlineState.match.id!==context.profile.activeMatch))hydrateMatch(context.profile.activeMatch,actor);
 else if(actor&&visibleMatch()&&boundOnlineActor!==actor){onlineRevision++;onlineState.status='playing';render();startOnlinePolling();}
 header('/game');updateOnlineControls();
}
async function hydrateMatch(id,actor){
 const revision=onlineRevision,stamp=actor+':'+id+':'+revision;if(hydratingMatch===stamp)return;hydratingMatch=stamp;
 try{const match=await globalThis.MegaNetwork.match(id);if(revision!==onlineRevision||normalizedPath()!=='/game'||context.sessionStatus!=='linked'||context.profile?.id!==actor)return;reconcileMatch(match,true);}catch(error){if(revision===onlineRevision)handleOnlineError(error);}finally{if(hydratingMatch===stamp)hydratingMatch='';}
}
function visibleMatch(){return context.sessionStatus==='linked'&&onlineState.match?.players?.includes(context.profile?.id)?onlineState.match:null;}
function handleOnlineError(error){
 onlineState.message=errorCopy(error);
 if(authRequired(error)){clearInterval(onlineTimer);onlineState.status='auth';onlineRevision++;model.invalidate();context.profile=null;context.sessionStatus='guest';render();}
 updateOnlineControls();
}
function acceptOnlineSnapshot(snapshot,revision,actor,id){
 if(revision!==onlineRevision||normalizedPath()!=='/game'||context.sessionStatus!=='linked'||context.profile?.id!==actor||onlineState.match?.id!==id)return false;
 if(!board?.receive(snapshot))return false;
 onlineState.match=snapshot;onlineState.message='';return true;
}
async function sendOnlineMove(operation){const revision=onlineRevision,actor=context.profile?.id;await globalThis.MegaNetwork.move(operation.id,operation.revision,operation.move,operation.key);const match=await globalThis.MegaNetwork.match(operation.id);return acceptOnlineSnapshot(match,revision,actor,operation.id)?match:null;}
async function sendOnlineResign(operation){if(!globalThis.confirm('Resign this match? This counts as a loss. The agreed pot and any Ranked rating change settle normally.'))return false;const revision=onlineRevision,actor=context.profile?.id;await globalThis.MegaNetwork.resign(operation.id,operation.key);const match=await globalThis.MegaNetwork.match(operation.id);return acceptOnlineSnapshot(match,revision,actor,operation.id)?match:null;}
function reconcileMatch(snapshot,accepted=false){
 if(!snapshot?.players?.includes(context.profile?.id))throw Error('AUTH_REQUIRED');
 if(snapshot.status==='PLAYING'){onlineState.match=snapshot;onlineState.status='playing';render();startOnlinePolling();}
 else if(['FINISHED','VOID'].includes(snapshot.status)){onlineState.match=snapshot;onlineState.invitation=null;onlineState.status='finished';clearInterval(onlineTimer);render();}
 else if(snapshot.status==='OFFERED'){onlineState.invitation=snapshot;onlineState.status=accepted?'waiting':'review';if(!accepted)clearInterval(onlineTimer);}
 else{onlineState.match=null;onlineState.invitation=null;onlineState.status='idle';onlineState.message='This invitation is complete. Search again when you are ready.';clearInterval(onlineTimer);}
}
function startOnlinePolling(){clearInterval(onlineTimer);onlineTimer=setInterval(()=>{if(!document.hidden)pollOnline();},2500);}
async function pollOnline(){
 if(onlineBusy||normalizedPath()!=='/game'||context.sessionStatus!=='linked')return;
 const revision=onlineRevision;onlineBusy=true;
 try{
  if(onlineState.match){const id=onlineState.match.id,actor=context.profile.id;const match=await globalThis.MegaNetwork.match(id);if(!acceptOnlineSnapshot(match,revision,actor,id))return;if(match.status!=='PLAYING'){onlineState.status='finished';clearInterval(onlineTimer);}}
  else{const queue=await globalThis.MegaNetwork.queueStatus();if(revision!==onlineRevision)return;
   const id=onlineState.status==='waiting'?onlineState.invitation?.id:queue?.matchId;
   if(id){const snapshot=await globalThis.MegaNetwork.match(id);if(revision!==onlineRevision||context.sessionStatus!=='linked')return;reconcileMatch(snapshot,onlineState.status==='waiting');}
   else if(queue?.state==='idle'){onlineState.status='idle';onlineState.message='No entry was charged. Search again when you are ready.';clearInterval(onlineTimer);}
   else{const invites=await globalThis.MegaNetwork.invitations();if(revision!==onlineRevision)return;const invitation=Array.isArray(invites)?invites.find(m=>m.terms?.source==='queue'&&m.players?.includes(context.profile.id)):null;if(invitation)reconcileMatch(invitation,false);}

  }
 }catch(error){if(revision===onlineRevision){handleOnlineError(error);clearInterval(onlineTimer);}}
 finally{onlineBusy=false;if(revision===onlineRevision)updateOnlineControls();}
}
document.addEventListener('change',event=>{
 const filter=event.target.closest('[data-leaderboard-filter]');if(filter)model.leaderboard({[filter.dataset.leaderboardFilter]:filter.value});
});
document.addEventListener('submit',event=>{
 const sponsor=event.target.closest('[data-sponsor-preferences]');
 if(sponsor){event.preventDefault();const data=new FormData(sponsor);if(data.get('consent')!=='on')return;context.sponsorPreferences={consent:true,interests:data.getAll('interest').filter(x=>['Strategy games','Technology','Creative tools','Learning','Gaming gear','Entertainment'].includes(x))};try{localStorage.setItem('mega-xoxo-sponsor-interests',JSON.stringify(context.sponsorPreferences));context.sponsorMessage='Your choices are saved in this browser.';}catch{context.sponsorMessage='Your browser could not save these choices.';}render();return;}
 const form=event.target.closest('[data-account-form]');if(!form)return;event.preventDefault();
 const data=new FormData(form),type=form.dataset.accountForm;const email=String(data.get('email')||''),password=String(data.get('password')||''),code=String(data.get('code')||'');
 if(type==='reset'&&password!==String(data.get('confirmPassword')||'')){context.accountMessage='The passwords do not match.';render();return;}
 if(email)context.accountEmail=email;
 accountAction(async()=>{
  const client=globalThis.MegaAccount;let result;
  if(type==='email')result=await client.request('/api/account/email',{action:'continue',email,password});
  if(type==='verify')result=await client.request('/api/account/email',{action:'verify',challengeId:accountChallenge,code});
  if(type==='recover')result=await client.request('/api/account/email',{action:'forgot',email});
  if(type==='reset'){if(!resetReady){const verified=await client.request('/api/account/email',{action:'verify',challengeId:accountChallenge,code});if(verified.resetReady!==true)throw Error('INVALID_OTP');resetReady=true;}result=await client.request('/api/account/email',{action:'reset',challengeId:accountChallenge,password});}
  if(result.linked)await linkedAccount();
  else if(type==='recover'){resetReady=false;accountChallenge=result.challengeId||'';context.accountView='reset';context.accountMessage=result.message||'If this email has an account, a recovery code has been sent.';}
  else if(result.verificationRequired){accountChallenge=result.challengeId;context.accountView='verify';context.accountMessage='Check your mailbox for a verification code.';}
 });
});
document.addEventListener('click',event=>{
 const refresh=event.target.closest('[data-leaderboard-action="refresh"]');if(refresh)model.leaderboard();
 const account=event.target.closest('[data-account-action]');if(account){const action=account.dataset.accountAction;
  if(action==='view'||action==='resend'){resetReady=false;accountChallenge='';context.accountView=action==='resend'?'email':account.dataset.accountView;context.accountMessage=action==='resend'?'Continue with your email and password again to request a new code.':'';render();}
  if(action==='retry')model.profile();
  if(action==='options')accountAction(async()=>{const session=await globalThis.MegaAccount.session();context.providers=session.providers||{};context.providersLoaded=true;if(session.linked)await model.profile();else context.accountMessage='Choose an available sign-in method.';});
  if(action==='provider')accountAction(async()=>{const session=await globalThis.MegaAccount.session();if(session.providers?.[account.dataset.provider]?.web!==true)throw Error('PROVIDER_NOT_CONFIGURED');const result=await globalThis.MegaAccount.request('/api/account/start',{provider:account.dataset.provider,intent:'login'});const url=new URL(result.url);if(url.protocol!=='https:')throw Error('SERVICE_UNAVAILABLE');location.assign(url.href);});
  if(action==='logout')accountAction(async()=>{await globalThis.MegaAccount.request('/api/account/logout',{});globalThis.MegaAccount.reset();model.invalidate();context.profile=null;resetReady=false;accountChallenge='';context.sessionStatus='guest';context.accountMessage='You are signed out.';context.products.purchasesAvailable=false;onlineState={status:'idle',match:null,invitation:null,message:''};clearInterval(onlineTimer);onlineRevision++;});
 }
 if(event.target.closest('[data-sponsor-action="clear"]')){try{localStorage.removeItem('mega-xoxo-sponsor-interests');}catch{}context.sponsorPreferences={};context.sponsorMessage='Saved choices cleared.';render();}
 const store=event.target.closest('[data-store-action]');if(store){if(store.dataset.storeAction==='refresh')refreshProducts();else if(store.dataset.storeAction==='purchase'&&context.products.purchasesAvailable&&!serviceBusy){accountAction(async()=>{const actor=context.profile?.id,id=store.dataset.productId,row=context.products.rows.find(x=>x.id===id);if(!actor||!row?.enabled||!row.localizedPrice)throw Error('STORE_UNAVAILABLE');const evidence=await globalThis.MegaBilling.purchase(id,context.products.storeContext);if(actor!==context.profile?.id)throw Error('AUTH_REQUIRED');const delivered=await globalThis.MegaNetwork.purchase(evidence,globalThis.MegaAccount.id());await globalThis.MegaBilling.finish?.(evidence,delivered);await model.profile();await refreshProducts();notify('Verified purchase delivered.');});}}
 const online=event.target.closest('[data-online-action]');if(online&&!onlineBusy){const action=online.dataset.onlineAction;
  if(action==='retry'){startOnlinePolling();pollOnline();return;}
  if(action==='new'){onlineState={status:'idle',match:null,invitation:null,message:''};clearInterval(onlineTimer);render();return;}
  onlineBusy=true;onlineState.message='';updateOnlineControls();const revision=onlineRevision;
  (async()=>{try{
   const net=globalThis.MegaNetwork,key=globalThis.MegaAccount.id();
   if(['ranked','casual'].includes(action)){const result=await net.queue(action,key);if(revision!==onlineRevision)return;onlineState.status='queued';if(result?.matchId){const snapshot=await net.match(result.matchId);if(revision!==onlineRevision)return;reconcileMatch(snapshot);}if(onlineState.status==='queued')startOnlinePolling();}
   if(action==='cancel'){const result=await net.cancelQueue(key);if(revision!==onlineRevision)return;if(result?.state==='matched'&&result.matchId){const snapshot=await net.match(result.matchId);if(revision!==onlineRevision)return;if(snapshot.status==='OFFERED'){await net.decline(snapshot.id,globalThis.MegaAccount.id());if(revision!==onlineRevision)return;const terminal=await net.match(snapshot.id);if(revision!==onlineRevision)return;reconcileMatch(terminal);}else reconcileMatch(snapshot,onlineState.status==='waiting');}else{onlineState.status='idle';onlineState.invitation=null;clearInterval(onlineTimer);}}
   if(action==='decline'){await net.decline(onlineState.invitation.id,key);if(revision!==onlineRevision)return;onlineState.status='idle';onlineState.invitation=null;}
   if(action==='accept'){const invitation=onlineState.invitation;const accepted=await net.accept(invitation.id,invitation.termsHash,key);if(revision!==onlineRevision)return;onlineState.invitation=accepted;reconcileMatch(accepted,true);if(onlineState.status==='waiting')startOnlinePolling();}
  }catch(error){if(revision===onlineRevision)handleOnlineError(error);}finally{onlineBusy=false;if(revision===onlineRevision)updateOnlineControls();}})();
 }
});
window.addEventListener('focus',()=>{if(context.sessionStatus==='linked')model.profile().then(()=>{if(normalizedPath()==='/game'&&visibleMatch()){startOnlinePolling();pollOnline();}});});
window.addEventListener('online',()=>{if(normalizedPath()==='/game'&&context.sessionStatus==='linked'){startOnlinePolling();pollOnline();}});
window.addEventListener('pagehide',event=>{onlineRevision++;event.persisted?model.invalidate():model.destroy();clearInterval(leaderboardTimer);clearInterval(onlineTimer);board?.destroy();});
window.addEventListener('popstate',()=>{render({focus:true});activate();});
window.addEventListener('pageshow',event=>{if(event.persisted){activePath='';render();activate();if(context.sessionStatus==='linked')model.profile();}});
render();activate();model.profile().then(()=>{if(normalizedPath()==='/store'&&context.sessionStatus==='linked')refreshProducts();});
