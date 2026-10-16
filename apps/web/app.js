import {icon, button, escapeHtml} from './ui.js';
import {renderPage} from './pages.js';
import {renderHeader, renderFooter, renderHome, renderRankPanel} from './site.js';
import {updateSeo} from './seo.js';
import {detectDownloadPlatform, downloadHref} from './downloads.js';
import {storeLinks} from './store-links.js';
import {renderPractice, renderGame, mountBoard} from './board.js';

import {createReadModel, createProfileEditor, readJSON, authRequired, errorCopy} from './data.js';
import {normalizeStoreStatus, WEB_PRODUCT_IDS} from './store.js';
import {legalDocuments} from './legal-documents.js';
import {createFriendsController} from './friends.js';
import {createRealtimeReader, canApplyMatchSnapshot} from './realtime.js';
import {createTournamentsController, tournamentRoomId, tournamentFixture, tournamentMatch, tournamentSpectatorMatch} from './tournaments.js';
import {renderTournamentControls} from './tournaments-view.js';
import {createTelemetryLane, telemetryPanel, setTelemetryOptIn} from './metrics.js';

let board=null;
let tab='ranked';
let toastTimer;
const main=document.querySelector('#main');
if(main?.hasAttribute?.('data-offline-fallback'))history.replaceState?.({...history.state,mxOfflineFallback:true},'',location.href);
const productIds=WEB_PRODUCT_IDS;
const context={storeLinks,profile:null, sessionStatus:'loading', providers:{}, accountView:'email',
 legalDocuments:Object.fromEntries(Object.entries(legalDocuments).map(([key,value])=>['/'+key,value])),
 products:{status:'ready',rows:productIds.map(id=>({id,enabled:false})),purchasesAvailable:false},
 leaderboard:{status:'loading',rows:[],metric:'rating',scope:'global',league:'all'}};
const balance=value=>Number.isSafeInteger(value)&&value>=0?value.toLocaleString('en-US'):'—';
const model=createReadModel({context,changed:()=>refreshSessionView()});
let profileEditor;
profileEditor=createProfileEditor({context,request:(path,body)=>globalThis.MegaAccount.request(path,body),changed:()=>renderProfileEditorView(),
 active:actor=>normalizedPath()==='/profile'&&context.sessionStatus==='linked'&&context.profile?.id===actor,
 onAuthRequired:error=>{model.invalidate();context.profile=null;context.sessionStatus='guest';context.accountMessage=errorCopy(error);renderProfileEditorView();}});
const friendsController=createFriendsController({context,request:(path,body,operation)=>globalThis.MegaAccount.request(path,body,operation),
 active:actor=>normalizedPath()==='/friends'&&context.sessionStatus==='linked'&&context.profile?.id===actor,
 changed:()=>renderFriendsView(),onAuthRequired:error=>{model.invalidate();context.profile=null;context.sessionStatus='guest';context.accountMessage=errorCopy(error);renderFriendsView();}});
let activePath='',leaderboardTimer,accountChallenge='',resetReady=false,serviceBusy=false,onlineTimer,onlineBusy=false,onlineRevision=0;
let boundOnlineActor=null,hydratingMatch='';
let onlineState={status:'idle',match:null,invitation:null,message:''};
let settledProfileRefresh='',onlineSnapshotVersion=0;
let boundTournamentMatch=null,boundSpectatorMatch=null,tournamentTimer;
let tournamentProfileActor=null;
const tournamentProfileTransitions=new Set();
const tournamentController=createTournamentsController({context,
 request:(path,body,key)=>globalThis.MegaAccount.request(path,body,key),read:path=>readJSON(path),
 active:()=>normalizedPath()==='/tournaments'||(normalizedPath()==='/game'&&Boolean(tournamentRouteRoom())),
 changed:()=>synchronizeTournamentView(),operationKey:()=>globalThis.MegaAccount.id(),storage:globalThis.localStorage,session:()=>globalThis.MegaAccount.peek?.(),
 onAuthRequired:error=>{model.invalidate();context.profile=null;context.sessionStatus='guest';context.accountMessage=errorCopy(error);refreshSessionView();},
});
const realtime=createRealtimeReader({
 getContext:()=>normalizedPath()==='/game'&&context.sessionStatus==='linked'&&visibleMatch()?.status==='PLAYING'?{actorId:context.profile.id,match:onlineState.match,epoch:onlineRevision,session:globalThis.MegaAccount.peek?.()}:null,
 request:(path,body)=>globalThis.MegaAccount.request(path,body),
 receive:snapshot=>acceptOnlineSnapshot(snapshot,onlineRevision,context.profile?.id,snapshot.id),
 changed:()=>updateOnlineControls(),onAuthRequired:()=>handleOnlineError(Error('AUTH_REQUIRED')),
});
try{const saved=JSON.parse(localStorage.getItem('mega-xoxo-sponsor-interests')||'null');if(saved?.consent===true)context.sponsorPreferences=saved;}catch{}

function header(path){document.querySelector('#header').innerHTML=renderHeader(path,context);}
function footer(){document.querySelector('#footer').innerHTML=renderFooter();}
function home(){return renderHome(context,tab);}
function rankPanel(){return renderRankPanel(context,tab);}
function configureDownloadLinks(){
 const device=detectDownloadPlatform({userAgent:navigator.userAgent,platform:navigator.platform,maxTouchPoints:navigator.maxTouchPoints});
 context.device=device;context.query=new URLSearchParams(location.search);
 document.querySelectorAll('[data-download-link]').forEach(anchor=>{anchor.href=downloadHref(device);});
}
function normalizedPath(){return main?.hasAttribute?.('data-offline-fallback')?'/offline':location.pathname.replace(/\/+$/,'')||'/';}
function gameMode(){const mode=new URLSearchParams(location.search).get('mode');return ['bot','local','ranked','casual','friends'].includes(mode)?mode:'bot';}
function tournamentRouteRoom(){const value=new URLSearchParams(location.search).get('tournament');return typeof value==='string'&&value.length>0&&value.length<=160&&!/[\x00-\x20]/.test(value)?value:null;}
function visibleTournamentMatch(){return context.sessionStatus==='linked'&&tournamentRouteRoom()===context.tournaments?.room?.id?tournamentMatch(context.tournaments.room,context.profile?.id,new URLSearchParams(location.search).get('fixture')):null;}
function visibleTournamentSpectatorMatch(){const room=context.tournaments?.room;if(context.sessionStatus!=='linked'||tournamentRouteRoom()!==room?.id)return null;const fixtureId=new URLSearchParams(location.search).get('fixture');if(!fixtureId||tournamentMatch(room,context.profile?.id,fixtureId))return null;return tournamentSpectatorMatch(room,context.profile?.id,fixtureId);}
function gameAccount(){return {linked:context.sessionStatus==='linked'&&Boolean(context.profile?.id),sessionStatus:context.sessionStatus,profile:context.profile,mode:gameMode()};}
function refreshSessionView(){
 if(normalizedPath()==='/game')synchronizeGameProfile();
 else if(normalizedPath()==='/friends')renderFriendsView();
 else if(normalizedPath()==='/'&&board){header('/');board.updateAccount?.(gameAccount());const panel=main.querySelector('.mx-ranked');if(panel)panel.outerHTML=rankPanel();}
 else renderProfileEditorView();
 tournamentController.sync({roomId:normalizedPath()==='/game'?tournamentRouteRoom():null});
}
function render({focus=false}={}){
 if(normalizedPath()==='/play'&&new URLSearchParams(location.search).get('mode')==='practice')history.replaceState?.({},'','/game?mode=bot');
 board?.destroy();board=null;
 const path=normalizedPath();
 const tournament=path==='/game'&&tournamentRouteRoom(),spectator=tournament?visibleTournamentSpectatorMatch():null,match=tournament?visibleTournamentMatch():visibleMatch();
 document.body.dataset.page=path==='/'?'home':path==='/game'?'game':'inner';
 header(path);footer();configureDownloadLinks();
 main.innerHTML=path==='/'?home():path==='/game'?(tournament&&!(match||spectator)?'<div class="gb-game-page"><section class="mx-panel" data-tournament-controls aria-live="polite"></section><a class="mx-button secondary" href="/tournaments">Back to tournaments</a></div>':renderGame({match:match||spectator,spectator:Boolean(spectator),actorId:spectator?null:context.profile?.id,...gameAccount()})):renderPage(path,context)||renderPage('/404',context);
 if(path==='/profile'){
  if(context.sessionStatus==='linked'){if(profileEditor.isSuspended())profileEditor.resume(context.profile?.id);else profileEditor.load();}
  else if(context.sessionStatus==='loading'){if(!profileEditor.suspend())profileEditor.deactivate();}
  else if(!(context.sessionStatus==='error'&&profileEditor.isSuspended()))profileEditor.deactivate();
 }else profileEditor.deactivate();
 if(path==='/friends'){
  if(context.sessionStatus==='linked'){if(friendsController.isSuspended())friendsController.resume(context.profile?.id);else friendsController.load();}
  else if(context.sessionStatus==='loading'){context.friendConfirmation=null;friendsController.suspend();}
  else{context.friendConfirmation=null;friendsController.deactivate();}
 }else{context.friendConfirmation=null;friendsController.deactivate();}
 updateSeo(path);configureDownloadLinks();
 document.querySelectorAll('[data-board-host]').forEach(host=>{board=mountBoard(host,{preview:host.dataset.boardPreview!=='false'&&path==='/',...gameAccount(),mode:path==='/game'?gameMode():host.dataset.boardMode,difficulty:host.dataset.boardDifficulty,theme:host.dataset.boardTheme,tutorial:path==='/game'&&new URLSearchParams(location.search).get('tutorial')==='guided',...(path==='/game'&&match?{online:spectator?{match:spectator,actorId:null,spectator:true}:{match,actorId:context.profile?.id,onMove:tournament?sendTournamentMove:sendOnlineMove,onResign:tournament?sendTournamentResign:sendOnlineResign,onError:handleOnlineError}}:{})})});
 if(path==='/game'){boundOnlineActor=match?context.profile.id:null;boundTournamentMatch=tournament?match:null;boundSpectatorMatch=spectator||null;updateOnlineControls();}
 if(path==='/account')loadProviders();
 if(path==='/account'&&context.sessionStatus==='linked')loadResearchConsent();
 if(path==='/privacy-choices')hydrateTelemetryPanel();
 updateTournamentControls();tournamentController.sync({roomId:tournament||null});
 realtime.sync();
 if(focus){main.focus({preventScroll:true});window.scrollTo(0,0);}
}
function updateTournamentControls(){
 const region=normalizedPath()==='/tournaments'||tournamentRouteRoom()?main.querySelector('[data-tournament-controls]')||main.querySelector('[data-online-controls]'):null;
 if(region)region.innerHTML=renderTournamentControls(context,{fixtureId:new URLSearchParams(location.search).get('fixture')});
}
function synchronizeTournamentView(){
 const room=context.tournaments?.room;
 refreshTournamentEconomyProfile(room);
 const polling=context.sessionStatus==='linked'&&(normalizedPath()==='/tournaments'||(normalizedPath()==='/game'&&tournamentRouteRoom()))&&room&&!['COMPLETE','VOID','CANCELLED','REVIEW'].includes(room.status);
 if(polling&&!tournamentTimer)tournamentTimer=setInterval(()=>{if(!document.hidden)tournamentController.refresh();},2500);
 if(!polling){clearInterval(tournamentTimer);tournamentTimer=null;}
 if(normalizedPath()==='/game'&&tournamentRouteRoom()){
  const next=visibleTournamentMatch();
  if(next&&(!boundTournamentMatch||boundTournamentMatch.id!==next.id)){render();return;}
  if(next&&boundTournamentMatch&&canApplyMatchSnapshot(next,boundTournamentMatch,context.profile?.id,next.id)&&board?.receive(next))boundTournamentMatch=next;
  else if(!next&&boundTournamentMatch){boundTournamentMatch=null;render();return;}
  const spectate=visibleTournamentSpectatorMatch();
  if(spectate&&board&&boundSpectatorMatch&&spectate.id===boundSpectatorMatch.id&&spectate.terms?.spectate===true&&board.receive(spectate))boundSpectatorMatch=spectate;
  else if(!spectate&&boundSpectatorMatch){boundSpectatorMatch=null;render();return;}
 }
 updateTournamentControls();
}
function refreshTournamentEconomyProfile(room){
 if(context.sessionStatus==='loading')return;
 const actor=context.sessionStatus==='linked'?context.profile?.id:null;
 if(actor!==tournamentProfileActor){tournamentProfileActor=actor;tournamentProfileTransitions.clear();}
 if(!actor||context.tournaments?.actorId!==actor||!room?.players?.some(player=>player.id===actor))return;
 const phase=room.settled===true&&room.receipt&&['COMPLETE','VOID','CANCELLED'].includes(room.status)?'settled':
  Number.isSafeInteger(room.escrow)&&room.escrow>0&&room.settled!==true?'reserved':null;
 if(!phase)return;
 const stamp=JSON.stringify([actor,room.id,phase]);
 if(tournamentProfileTransitions.has(stamp))return;
 tournamentProfileTransitions.add(stamp);
 // Complete the accepted room/board paint before suspending input for the
 // canonical profile read. Never calculate balances from an entry or payout DTO.
 Promise.resolve().then(()=>{
  if(context.sessionStatus!=='linked'||context.profile?.id!==actor||context.tournaments?.actorId!==actor||
   context.tournaments?.room?.id!==room.id||!['/game','/tournaments'].includes(normalizedPath())){
   tournamentProfileTransitions.delete(stamp);return;
  }
  model.profile();
 });
}
async function sendTournamentMove(operation){await tournamentController.play(operation);return visibleTournamentMatch();}
async function sendTournamentResign(operation){if(!globalThis.confirm('Resign this tournament fixture? This counts as a loss under the tournament rules.'))return false;await tournamentController.play(operation,true);return visibleTournamentMatch();}
function renderProfileEditorView(){
 const path=normalizedPath(),actor=profileEditor?.actorId?.()||context.profile?.id||null,active=document.activeElement;
 const operationFeedback=path==='/profile'&&['saving','saved','error','refresh-error'].includes(context.profileEditor?.status);
 const restoreFocus=operationFeedback||(path==='/profile'&&Boolean(active)&&Boolean(main?.contains?.(active))&&Boolean(active.closest?.('#profile-editor')));
 render();
 const currentActor=profileEditor?.actorId?.()||context.profile?.id||null;
 if(!restoreFocus||path!=='/profile'||normalizedPath()!==path||actor!==currentActor)return;
 const status=main.querySelector('#profile-editor [data-profile-message]')||main.querySelector('#profile-editor [role="status"]');
 if(status&&!status.hidden&&typeof status.focus==='function'){status.focus({preventScroll:true});return;}
 const fallback=main.querySelector('#profile-editor [name="username"]')||main.querySelector('#profile-editor [data-profile-action]')||main.querySelector('#profile-editor-title');
 fallback?.focus?.({preventScroll:true});
}
function renderFriendsView(){
 const path=normalizedPath(),actor=context.profile?.id||null,active=document.activeElement;
 const inFriends=path==='/friends'&&Boolean(main?.contains?.(active))&&Boolean(active?.closest?.('#friends-controls'));
 const inputFocus=inFriends&&active.id==='friend-query';
 const searchError=path==='/friends'&&context.friends?.searchStatus==='error';
 const selection=inputFocus?[active.selectionStart,active.selectionEnd]:null;
 render();
 if((!inFriends&&!searchError)||normalizedPath()!==path||actor!==context.profile?.id)return;
 const query=main.querySelector('#friend-query');
 if(inputFocus&&query&&!query.disabled){query.focus({preventScroll:true});if(selection)query.setSelectionRange(...selection);return;}
 const status=searchError?main.querySelector('[data-friends-search-status]'):(main.querySelector('[data-friends-status]:not([hidden])')||main.querySelector('[data-friends-search-status]'));
 status?.focus?.({preventScroll:true});
}
function navigate(href){main.removeAttribute?.('data-offline-fallback');history.pushState({},'',href);render({focus:true});activate();}
function notify(message){const el=document.querySelector('#notification');el.textContent=message;el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.hidden=true},4500);}
document.addEventListener('click',event=>{
 /* F2: the tournament roster's friend button goes straight to the existing community endpoint
  * with one durable operation key; the API owns every permission decision. */
 const friendRequest=event.target.closest('[data-friend-request]');
 if(friendRequest&&!friendRequest.disabled){const target=friendRequest.dataset.friendRequest;friendRequest.disabled=true;globalThis.MegaAccount.request('/api/community/friend',{action:'request',target},globalThis.MegaAccount.id()).then(()=>notify('Friend request sent.')).catch(error=>notify(errorCopy(error)));return;}
 const menu=event.target.closest('.mx-menu-button');if(menu){const nav=document.querySelector('#mobile-menu');nav.hidden=!nav.hidden;menu.setAttribute('aria-expanded',String(!nav.hidden));return;}
 const mode=event.target.closest('[data-mode]');if(mode){tab=mode.dataset.mode;document.querySelector('.mx-ranked').outerHTML=rankPanel();document.querySelector(`#tab-${tab}`).focus();return;}
 const action=event.target.closest('[data-page-action]');if(action){const name=action.dataset.pageAction;
  if(name==='theme-preview'){document.querySelectorAll('[data-page-action="theme-preview"]').forEach(x=>x.setAttribute('aria-pressed',String(x===action)));const label=action.dataset.theme||action.dataset.previewTheme;const preview=document.querySelector('[data-theme-preview]');if(preview)preview.dataset.theme=label;notify('Theme preview selected. Open the game to change your play theme.');}
  if(name==='copy-support-info'){const info=`Mega XOXO website\nPage: ${normalizedPath()}\nBrowser: ${navigator.userAgent}`;navigator.clipboard?.writeText(info).then(()=>notify('Support details copied.')).catch(()=>notify('Copy unavailable. Include the page URL with your support request.'));}
 }
 const anchor=event.target.closest('a[href]');if(!anchor||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||anchor.target||anchor.hasAttribute('download'))return;
 const url=new URL(anchor.href,location.href);if(url.origin!==location.origin||url.pathname.startsWith('/legacy-game')||url.pathname==='/api'||url.pathname.startsWith('/api/')||url.hash)return;
 event.preventDefault();navigate(url.pathname+url.search);
});
document.addEventListener('keydown',event=>{
 const t=event.target.closest('[data-mode]');if(t&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const modes=['ranked','casual','friends'];const i=modes.indexOf(tab);tab=event.key==='Home'?modes[0]:event.key==='End'?modes[2]:modes[(i+(event.key==='ArrowRight'?1:2))%3];document.querySelector('.mx-ranked').outerHTML=rankPanel();document.querySelector(`#tab-${tab}`).focus();}
 if(event.key==='Escape'){const nav=document.querySelector('#mobile-menu');if(nav&&!nav.hidden){nav.hidden=true;document.querySelector('.mx-menu-button').setAttribute('aria-expanded','false');document.querySelector('.mx-menu-button').focus();}}
});
function activate(){
 const path=normalizedPath();
 if(path!==activePath){activePath=path;clearInterval(leaderboardTimer);clearInterval(onlineTimer);clearInterval(tournamentTimer);tournamentTimer=null;onlineRevision++;realtime.stop();
  if(path==='/store')refreshProducts();
  if(path==='/leaderboard'){model.leaderboard();leaderboardTimer=setInterval(()=>{if(!document.hidden&&context.leaderboard.status==='ready')model.leaderboard();},30000);}
  if(path==='/game'&&['queued','waiting','playing'].includes(onlineState.status))startOnlinePolling();
 }
 tournamentController.sync({roomId:path==='/game'?tournamentRouteRoom():null});
 if(context.tournaments?.room)synchronizeTournamentView();
 realtime.sync();
}
async function accountAction(task){
 if(serviceBusy)return;serviceBusy=true;context.accountBusy=true;context.accountMessage='';refreshSessionView();
 try{await task();}catch(error){context.accountMessage=errorCopy(error);}
 finally{serviceBusy=false;context.accountBusy=false;refreshSessionView();}
}
async function linkedAccount(){
 accountChallenge='';resetReady=false;context.accountView='email';onlineRevision++;realtime.stop();globalThis.MegaAccount.reset();
 await model.profile();if(context.sessionStatus==='linked')context.accountMessage='Your profile is ready.';
}
async function refreshProducts(){
 context.products={status:'loading',rows:[],purchasesAvailable:false,webCheckoutAvailable:false};render();
 try{
  const status=await readJSON('/api/monetization/status');
  const bridge=globalThis.MegaBilling;
  const prices=bridge?.products?await bridge.products(status.storeContext||null):[];
  const normalized=normalizeStoreStatus(status);
  if(!normalized.ok)throw Error(normalized.errorCode||'STORE_UNAVAILABLE');
  context.products={status:'ready',
   purchasesAvailable:status.purchasesAvailable===true&&typeof bridge?.purchase==='function',
   webCheckoutAvailable:normalized.webCheckoutAvailable,
   pass:normalized.pass,storeContext:status.storeContext,
   rows:normalized.rows.map(row=>({...row,
    enabled:status.purchasesAvailable===true&&typeof bridge?.purchase==='function'&&!(row.id==='remove_ads'&&status.adMode!=='hybrid'),
    localizedPrice:Array.isArray(prices)?prices.find(entry=>entry.id===row.id&&typeof entry.price==='string')?.price:undefined}))};
 }catch(error){context.products={status:'error',rows:[],purchasesAvailable:false,webCheckoutAvailable:false};notify(errorCopy(error));}
 if(normalizedPath()==='/store')render();
}
let cashfreeSdkPromise=null;
function loadCashfreeSdk(){return cashfreeSdkPromise??=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://sdk.cashfree.com/js/v3/cashfree.js';script.onload=resolve;script.onerror=()=>{cashfreeSdkPromise=null;reject(Error('STORE_UNAVAILABLE'));};document.head.append(script);});}
async function cashfreeCheckout(productId){const email=(globalThis.prompt('Email for the payment receipt:',context.profile?.email||context.accountEmail||'')||'').trim();const phone=(globalThis.prompt('Phone number for the payment receipt (digits only):','')||'').trim();if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)||!/^[0-9]{8,15}$/.test(phone))throw Error('INVALID_CUSTOMER_DETAILS');await loadCashfreeSdk();const key=globalThis.crypto?.randomUUID?.()||'cf'+Date.now();const order=await globalThis.MegaAccount.request('/api/monetization/cashfree/order',{product:productId,email,phone},key);if(!order?.paymentSessionId)throw Error('STORE_UNAVAILABLE');await new globalThis.Cashfree({mode:order.environment==='sandbox'?'sandbox':'production'}).checkout({paymentSessionId:order.paymentSessionId,redirectTarget:'_self'});}
async function pollCashfreeStatus(orderId){for(let attempt=0;attempt<20;attempt++){try{const state=await readJSON('/api/monetization/cashfree/status?order_id='+encodeURIComponent(orderId));if(state?.paid){history.replaceState(null,'','/store');notify('Payment verified. Your purchase is on your profile.');await model.profile();await refreshProducts();return;}}catch(error){}await new Promise(resolve=>setTimeout(resolve,3000));}history.replaceState(null,'','/store');notify('The payment is still processing. Your profile updates the moment it clears.');}
/* A3: the Polar hosted checkout opens in a new tab (same-tab fallback when popups are blocked)
 * and the SAME durable key is reused on retry. Verification is actor-bound via /polar/status and
 * only a durable server confirmation shows success - opening the gateway proves nothing. */
let polarPending=null;
async function polarCheckout(productId){
 if(polarPending)throw Error('REQUEST_PENDING');
 const key=globalThis.crypto?.randomUUID?.()||'pl'+Date.now();
 const created=await globalThis.MegaAccount.request('/api/monetization/polar/checkout',{product:productId},key);
 if(typeof created?.checkoutUrl!=='string'||!created.checkoutUrl.startsWith('https://'))throw Error('STORE_UNAVAILABLE');
 polarPending={productId,checkoutId:typeof created.checkoutId==='string'?created.checkoutId:'',key};
 const opened=globalThis.open?.(created.checkoutUrl,'_blank','noopener');
 if(!opened)location.assign(created.checkoutUrl);
 if(polarPending&&polarPending.checkoutId)pollPolarStatus(polarPending.checkoutId);
}
async function pollPolarStatus(checkoutId){
 for(let attempt=0;attempt<40;attempt++){
  await new Promise(resolve=>setTimeout(resolve,3000));
  if(normalizedPath()!=='/store'||polarPending?.checkoutId!==checkoutId)return;
  try{const state=await readJSON('/api/monetization/polar/status?checkout_id='+encodeURIComponent(checkoutId));
   if(state?.paid){polarPending=null;notify('Payment verified. Your purchase is on your profile.');await model.profile();await refreshProducts();return;}
  }catch(error){}
 }
}
function updateOnlineControls(){
 if(normalizedPath()!=='/game')return;
 if(tournamentRouteRoom()){updateTournamentControls();return;}
 const region=main.querySelector('[data-online-controls]');
 if(!region)return;
 const linked=context.sessionStatus==='linked';const state=onlineState;
 const confirming=context.sessionStatus==='loading',mode=gameMode();
 region.hidden=['bot','local'].includes(mode)&&!['queued','waiting','review','playing','finished'].includes(state.status);
 let controls=confirming?'<p role="status">Confirming your account…</p>':linked?(mode==='friends'?button('Choose a friend to challenge','/friends','primary','users'):`<div class="pg-actions"><button class="mx-button primary" data-online-action="${mode==='casual'?'casual':'ranked'}" ${onlineBusy?'disabled':''}>${icon(mode==='casual'?'globe':'swords')} Find ${mode==='casual'?'Casual':'Ranked'} Match</button></div>`):button('Sign in to play online','/account','primary','user');
 if(['queued','waiting'].includes(state.status))controls=`<p>Finding your next rival…</p><button class="mx-button secondary" data-online-action="cancel" ${onlineBusy?'disabled':''}>Leave matchmaking</button>`;
 if(state.status==='review'&&state.invitation){const m=state.invitation;const index=m.players.indexOf(context.profile?.id);const fee=m.quote?.contributions?.[index];controls=`<p>Review your match before accepting.</p><p>${m.quote?.rated?'Ranked':'Casual'} · Entry ${typeof fee==='number'?escapeHtml(fee):'—'} ${escapeHtml(m.quote?.currency||'Coins')}</p><p>Winner receives ${balance(m.quote?.payout)} · Retired from pot ${balance(m.quote?.burn)} · Turn timer ${balance(m.terms?.turnSeconds)} seconds</p><div class="pg-actions"><button class="mx-button primary" data-online-action="accept" ${onlineBusy?'disabled':''}>Accept match</button><button class="mx-button secondary" data-online-action="decline" ${onlineBusy?'disabled':''}>Decline</button></div>`;}
 if(state.message&&linked)controls+='<button class="mx-button secondary" data-online-action="retry">Retry connection</button>';
 if(state.match&&linked)controls=state.match.status==='PLAYING'?'<p>Your match is live. Moves are confirmed by the game service.</p>':'<button class="mx-button secondary" data-online-action="new">Choose your next match</button>';
 if(state.match&&linked&&state.message)controls+='<button class="mx-button secondary" data-online-action="retry">Retry connection</button>';
 const connection=state.match?.status==='PLAYING'?({live:'Live updates connected.',connecting:'Connecting live updates. Match checks continue.',fallback:'Live updates interrupted. Match checks continue.'}[realtime.status()]||'Checking the latest match.') : '';
 if(confirming)controls='<p role="status">Confirming your account…</p>';
 region.innerHTML=`<h2 id="online-title">${mode==='friends'?'Play with friends':mode==='casual'?'Casual matchmaking':'Ranked matchmaking'}</h2>${controls}<p role="status" class="mx-online-message">${escapeHtml(state.message||connection)}</p>`;
}
function synchronizeGameProfile(){
 const actor=context.sessionStatus==='linked'?context.profile?.id:null;
 board?.updateAccount?.(gameAccount());
 if(context.sessionStatus==='loading'){realtime.stop();header('/game');updateOnlineControls();return;}
 if(boundOnlineActor&&actor!==boundOnlineActor){onlineRevision++;clearInterval(onlineTimer);onlineState.status=actor?'idle':'auth';if(!onlineState.match?.players?.includes(actor))onlineState.match=null;boundTournamentMatch=null;render();}
 if(tournamentRouteRoom()){tournamentController.sync({roomId:tournamentRouteRoom()});header('/game');updateTournamentControls();return;}
 if(actor&&tournamentRoomId(context.profile)){onlineState.message='You have an active tournament. Return to its lobby to continue.';}
 else if(actor&&typeof context.profile.activeMatch==='string'&&context.profile.activeMatch&&(!onlineState.match||onlineState.match.id!==context.profile.activeMatch))hydrateMatch(context.profile.activeMatch,actor);
 else if(actor&&visibleMatch()&&boundOnlineActor!==actor){onlineRevision++;onlineState.status='playing';render();startOnlinePolling();}
 realtime.sync();header('/game');updateOnlineControls();
}
async function hydrateMatch(id,actor){
 const revision=onlineRevision,session=globalThis.MegaAccount.peek?.(),stamp=actor+':'+id+':'+revision;if(hydratingMatch===stamp)return;hydratingMatch=stamp;
 try{const match=await globalThis.MegaNetwork.match(id);if(!onlineBindingCurrent(revision,actor,session)||(onlineState.match&&onlineState.match.id!==id))return;reconcileMatch(match,true);}catch(error){if(onlineBindingCurrent(revision,actor,session))handleOnlineError(error);}finally{if(hydratingMatch===stamp)hydratingMatch='';}
}
function visibleMatch(){return !tournamentRouteRoom()&&context.sessionStatus==='linked'&&onlineState.match?.players?.includes(context.profile?.id)?onlineState.match:null;}
function handleOnlineError(error){
 onlineState.message=errorCopy(error);
 if(authRequired(error)){clearInterval(onlineTimer);realtime.stop();onlineState.status='auth';onlineRevision++;model.invalidate();context.profile=null;context.sessionStatus='guest';refreshSessionView();}
 updateOnlineControls();
}
function onlineBindingCurrent(revision,actor,session){return revision===onlineRevision&&normalizedPath()==='/game'&&!tournamentRouteRoom()&&context.sessionStatus==='linked'&&context.profile?.id===actor&&(session===undefined||session===globalThis.MegaAccount.peek?.());}
function acceptOnlineSnapshot(snapshot,revision,actor,id,session){
 if(!onlineBindingCurrent(revision,actor,session)||onlineState.match?.id!==id)return false;
 if(!canApplyMatchSnapshot(snapshot,onlineState.match,actor,id))return false;
 if(!board?.receive(snapshot))return false;
 onlineState.match=snapshot;onlineState.message='';onlineSnapshotVersion++;realtime.record(snapshot);
 if(['FINISHED','VOID'].includes(snapshot.status))finishOnlineMatch();
 updateOnlineControls();return true;
}
function finishOnlineMatch(){
 onlineState.status='finished';onlineState.invitation=null;clearInterval(onlineTimer);realtime.stop();
 const stamp=context.profile?.id+':'+onlineState.match?.id;
 if(stamp!==settledProfileRefresh){settledProfileRefresh=stamp;model.profile();}
}
async function sendOnlineMove(operation){const revision=onlineRevision,actor=context.profile?.id,session=globalThis.MegaAccount.peek?.();if(!onlineBindingCurrent(revision,actor,session)||visibleMatch()?.id!==operation.id||visibleMatch()?.status!=='PLAYING')throw Error('SERVICE_UNAVAILABLE');await globalThis.MegaNetwork.move(operation.id,operation.revision,operation.move,operation.key);if(!onlineBindingCurrent(revision,actor,session))return null;const match=await globalThis.MegaNetwork.match(operation.id);return acceptOnlineSnapshot(match,revision,actor,operation.id,session)?match:null;}
async function sendOnlineResign(operation){const revision=onlineRevision,actor=context.profile?.id,session=globalThis.MegaAccount.peek?.();if(!onlineBindingCurrent(revision,actor,session)||visibleMatch()?.id!==operation.id||visibleMatch()?.status!=='PLAYING')throw Error('SERVICE_UNAVAILABLE');if(!globalThis.confirm('Resign this match? This counts as a loss. The agreed pot and any Ranked rating change settle normally.'))return false;await globalThis.MegaNetwork.resign(operation.id,operation.key);if(!onlineBindingCurrent(revision,actor,session))return null;const match=await globalThis.MegaNetwork.match(operation.id);return acceptOnlineSnapshot(match,revision,actor,operation.id,session)?match:null;}
function reconcileMatch(snapshot,accepted=false){
 if(!snapshot?.players?.includes(context.profile?.id))throw Error('AUTH_REQUIRED');
 if(onlineState.match?.id===snapshot.id&&!['PLAYING','FINISHED','VOID'].includes(snapshot.status))return;
 if(['PLAYING','FINISHED','VOID'].includes(snapshot.status)){
  if(!canApplyMatchSnapshot(snapshot,onlineState.match?.id===snapshot.id?onlineState.match:null,context.profile.id,snapshot.id))return;
  if(onlineState.match?.id===snapshot.id&&board){acceptOnlineSnapshot(snapshot,onlineRevision,context.profile.id,snapshot.id);return;}
  onlineState.match=snapshot;onlineSnapshotVersion++;onlineState.status=snapshot.status==='PLAYING'?'playing':'finished';render();
  if(snapshot.status==='PLAYING')startOnlinePolling();else finishOnlineMatch();
 }
 else if(snapshot.status==='OFFERED'){onlineState.invitation=snapshot;onlineState.status=accepted?'waiting':'review';if(!accepted)clearInterval(onlineTimer);}
 else{onlineState.match=null;onlineState.invitation=null;onlineState.status='idle';onlineState.message='This invitation is complete. Search again when you are ready.';clearInterval(onlineTimer);}
}
function startOnlinePolling(){clearInterval(onlineTimer);if(tournamentRouteRoom()||(onlineState.match&&onlineState.match.status!=='PLAYING'))return;onlineTimer=setInterval(()=>{if(!document.hidden)pollOnline();},2500);}
async function pollOnline(){
 if(onlineBusy||normalizedPath()!=='/game'||tournamentRouteRoom()||context.sessionStatus!=='linked')return;
 const revision=onlineRevision,actor=context.profile.id,session=globalThis.MegaAccount.peek?.(),readVersion=onlineSnapshotVersion;onlineBusy=true;
 try{
  if(onlineState.match){const id=onlineState.match.id;const match=await globalThis.MegaNetwork.match(id);if(!acceptOnlineSnapshot(match,revision,actor,id,session))return;}
  else{const queue=await globalThis.MegaNetwork.queueStatus();if(!onlineBindingCurrent(revision,actor,session))return;
   const id=onlineState.status==='waiting'?onlineState.invitation?.id:queue?.matchId;
   if(id){const snapshot=await globalThis.MegaNetwork.match(id);if(!onlineBindingCurrent(revision,actor,session))return;reconcileMatch(snapshot,onlineState.status==='waiting');}
   else if(queue?.state==='idle'){onlineState.status='idle';onlineState.message='No entry was charged. Search again when you are ready.';clearInterval(onlineTimer);}
   else{const invites=await globalThis.MegaNetwork.invitations();if(!onlineBindingCurrent(revision,actor,session))return;const invitation=Array.isArray(invites)?invites.find(m=>m.terms?.source==='queue'&&m.players?.includes(context.profile.id)):null;if(invitation)reconcileMatch(invitation,false);}

  }
 }catch(error){if(revision===onlineRevision&&normalizedPath()==='/game'&&!tournamentRouteRoom()&&context.profile?.id===actor&&(session===undefined||session===globalThis.MegaAccount.peek?.()||(authRequired(error)&&globalThis.MegaAccount.peek?.()==null))){if(authRequired(error)&&readVersion!==onlineSnapshotVersion)model.profile();else{handleOnlineError(error);clearInterval(onlineTimer);}}}
 finally{onlineBusy=false;if(revision===onlineRevision)updateOnlineControls();}
}
function syncProfileDraft(form){if(form&&profileEditor.updateDraft(profileFormDraft(form))){const message=form.querySelector('[data-profile-message]');if(message){message.textContent='';message.hidden=true;}}}
document.addEventListener('change',event=>{
 const mode=event.target.closest('[data-game-mode]');if(mode){
  const value=mode.value;if(!['bot','local','ranked','casual','friends'].includes(value))return;
  if(visibleMatch()?.status==='PLAYING'||['queued','waiting','review'].includes(onlineState.status)||context.tournaments?.room?.status==='RUNNING'){mode.value=gameMode();notify('Finish the active match or leave matchmaking before changing modes.');return;}
  navigate('/game?mode='+value);return;
 }
 syncProfileDraft(event.target.closest('[data-profile-form]'));
 const filter=event.target.closest('[data-leaderboard-filter]');if(filter)model.leaderboard({[filter.dataset.leaderboardFilter]:filter.value});
});
function profileFormDraft(form){const data=new FormData(form);return {username:String(data.get('username')||''),displayName:String(data.get('displayName')||''),statsVisibility:String(data.get('statsVisibility')||''),presenceVisibility:String(data.get('presenceVisibility')||'')};}
document.addEventListener('input',event=>{syncProfileDraft(event.target.closest('[data-profile-form]'));if(event.target.matches('#friend-query')&&friendsController.setQuery(event.target.value)){
 main.querySelector('#friend-search-results')?.remove();const form=event.target.closest('[data-friends-search]');
 if(form){form.setAttribute('aria-busy','false');const status=form.querySelector('[data-friends-search-status]');if(status)status.textContent='';const submit=form.querySelector('[type="submit"]');if(submit)submit.disabled=context.friends.busy;}
 }});
document.addEventListener('submit',event=>{
 const searchForm=event.target.closest('[data-friends-search]');if(searchForm){event.preventDefault();friendsController.search(String(new FormData(searchForm).get('query')||''));return;}
 const profileForm=event.target.closest('[data-profile-form]');
 if(profileForm){event.preventDefault();profileEditor.save(profileFormDraft(profileForm));return;}
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
 const tournament=event.target.closest('[data-tournament-action]');if(tournament&&!tournament.disabled){
  const action=tournament.dataset.tournamentAction;
  if(action==='open'){
   const room=context.tournaments?.room,actor=context.sessionStatus==='linked'?context.profile?.id:null;
   const fixture=tournamentFixture(room,actor,tournament.dataset.fixture);
   if(fixture&&['READY','PLAYING'].includes(fixture.status))navigate('/game?tournament='+encodeURIComponent(room.id)+'&fixture='+encodeURIComponent(fixture.id));
   }else if(action==='watch'){const fid=tournament.dataset.fixture,watchRoom=context.tournaments?.room;if(watchRoom&&fid)navigate('/game?tournament='+encodeURIComponent(watchRoom.id)+'&fixture='+encodeURIComponent(fid));
  }else{const tableId=tournament.dataset.table||tournament.dataset.fixture;Promise.resolve(tournamentController.action(action,tableId)).then(result=>{if(action==='join'&&result&&result.id)navigate('/game?tournament='+encodeURIComponent(result.id));}).catch(()=>{});}
  return;
 }
 const friendAction=event.target.closest('[data-friend-action]');
 if(friendAction){
  const action=friendAction.dataset.friendAction,target=friendAction.dataset.friendTarget;
  if(action==='refresh'){context.friendConfirmation=null;friendsController.reload();}
  else if(action==='page'){context.friendConfirmation=null;if(friendsController.setPage(Number(friendAction.dataset.friendPage)))main.querySelector('#friend-list-title')?.focus?.();}
  else if(action==='dismiss-confirm'){context.friendConfirmation=null;renderFriendsView();}
  else if(action==='confirm'){const pending=context.friendConfirmation;context.friendConfirmation=null;if(pending?.actorId===context.profile?.id)friendsController.action(pending.action,pending.target);}
  else if(action==='confirm-remove'||action==='confirm-block'){
   const command=action==='confirm-remove'?'remove':'block';
   const player=context.friends?.friends?.find(p=>p.id===target);
   if(player&&friendsController.allowedActions(target).includes(command)){context.friendConfirmation={actorId:context.profile.id,action:command,target,name:player.name||player.displayName||player.username};renderFriendsView();main.querySelector('[data-friend-action="confirm"]')?.focus();}
  }else{context.friendConfirmation=null;friendsController.action(action,target);}
  return;
 }
 const profileAction=event.target.closest('[data-profile-action]');if(profileAction){if(profileAction.dataset.profileAction==='retry-load')profileEditor.reload();else if(profileAction.dataset.profileAction==='retry-refresh')profileEditor.refresh();else if(profileAction.dataset.profileAction==='discard'){if(profileEditor.resetDraft())main.querySelector('#profile-username')?.focus?.({preventScroll:true});}else if(profileAction.dataset.profileAction==='keep-username'){const state=context.profileEditor;if(state?.profile&&state.draft){if(profileEditor.updateDraft({...state.draft,username:state.profile.username})){renderProfileEditorView();main.querySelector('#profile-username')?.focus?.({preventScroll:true});}}}return;}
 const refresh=event.target.closest('[data-leaderboard-action="refresh"]');if(refresh)model.leaderboard();
 const account=event.target.closest('[data-account-action]');if(account){const action=account.dataset.accountAction;
  if(action==='view'||action==='resend'){resetReady=false;accountChallenge='';context.accountView=action==='resend'?'email':account.dataset.accountView;context.accountMessage=action==='resend'?'Continue with your email and password again to request a new code.':'';render();}
  if(action==='retry')model.profile();
  if(action==='provider')accountAction(async()=>{const session=await globalThis.MegaAccount.session();if(session.providers?.[account.dataset.provider]?.web!==true)throw Error('PROVIDER_NOT_CONFIGURED');const result=await globalThis.MegaAccount.request('/api/account/start',{provider:account.dataset.provider,intent:'login'});const url=new URL(result.url);if(url.protocol!=='https:')throw Error('SERVICE_UNAVAILABLE');location.assign(url.href);});
  if(action==='logout')accountAction(async()=>{await globalThis.MegaAccount.request('/api/account/logout',{});globalThis.MegaAccount.reset();model.invalidate();context.profile=null;resetReady=false;accountChallenge='';context.sessionStatus='guest';context.accountMessage='You are signed out.';context.products.purchasesAvailable=false;onlineState={status:'idle',match:null,invitation:null,message:''};clearInterval(onlineTimer);onlineRevision++;realtime.stop();});
 /* LR17: the one-time research choice. Adult-band-only is enforced server-side (CAPTURE_CONSENT_ADULT_ONLY)
  * and pre-empted here so a youth/unknown band records its decline client-side with a clear note instead
  * of a raw provider error. Withdrawal is the same endpoint with research:false (0052 semantics). */
 if(action==='research-allow'||action==='research-decline'||action==='research-withdraw'){
  const research=action==='research-allow';
  const band=research?(document.querySelector('#research-age-band')?.value||'unknown'):'unknown';
  if(research&&band!=='adult'){context.researchMessage='Optional research is only available to adult accounts. Choose Adult (18 or older) to allow it, or select No thanks.';render();main.querySelector('[data-research-consent]')?.focus?.();return;}
  context.researchBusy=true;context.researchMessage='';render();
  accountAction(async()=>{try{await globalThis.MegaAccount.request('/api/account/research',{research,ageBand:band});}finally{context.researchBusy=false;}await loadResearchConsent(true);});
 }
 if(action==='research-edit'){context.researchOpen=true;context.researchAgeBand=context.researchConsent?.ageBand||'adult';render();}
 if(action==='metrics-optin'||action==='metrics-optout'){setTelemetryOptIn(globalThis.localStorage,action==='metrics-optin');if(telemetryLane){telemetryLane.stop();telemetryLane=null;}hydrateTelemetryPanel();}
 }
 if(event.target.closest('[data-sponsor-action="clear"]')){try{localStorage.removeItem('mega-xoxo-sponsor-interests');}catch{}context.sponsorPreferences={};context.sponsorMessage='Saved choices cleared.';render();}
 const store=event.target.closest('[data-store-action]');if(store&&store.dataset.storeAction==='refresh')refreshProducts();
 else if(store&&store.dataset.storeAction==='purchase'&&!serviceBusy){
  const id=store.dataset.productId,row=context.products.rows.find(x=>x.id===id);
  if(context.products.purchasesAvailable===true&&row?.enabled===true){accountAction(async()=>{const actor=context.profile?.id;if(!actor)throw Error('AUTH_REQUIRED');const evidence=await globalThis.MegaBilling.purchase(id,context.products.storeContext);if(actor!==context.profile?.id)throw Error('AUTH_REQUIRED');const delivered=await globalThis.MegaNetwork.purchase(evidence,globalThis.MegaAccount.id());await globalThis.MegaBilling.finish?.(evidence,delivered);await model.profile();await refreshProducts();notify('Verified purchase delivered.');});}
  else if(row&&context.products.webCheckoutAvailable===true){accountAction(async()=>{if(row.inr&&row.id!=='mega_pass')await cashfreeCheckout(id);else await polarCheckout(id);await model.profile();await refreshProducts();});}
 }
 const online=event.target.closest('[data-online-action]');if(online&&!onlineBusy&&context.sessionStatus==='linked'&&!tournamentRouteRoom()){const action=online.dataset.onlineAction;
  if(action==='retry'){realtime.reconnect();startOnlinePolling();pollOnline();return;}
  if(action==='new'){onlineRevision++;realtime.stop();onlineState={status:'idle',match:null,invitation:null,message:''};clearInterval(onlineTimer);render();return;}
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
window.addEventListener('focus',()=>{if(context.sessionStatus==='linked')model.profile().then(()=>{if(normalizedPath()==='/game'&&visibleMatch()?.status==='PLAYING'){startOnlinePolling();pollOnline();}});});
window.addEventListener('online',()=>{if(normalizedPath()==='/game'&&context.sessionStatus==='linked'){realtime.reconnect();startOnlinePolling();pollOnline();}});
document.addEventListener('gb:render',()=>{if(normalizedPath()==='/game')updateOnlineControls();});
window.addEventListener('pagehide',event=>{onlineRevision++;realtime.stop();event.persisted?model.invalidate():model.destroy();event.persisted?profileEditor.deactivate():profileEditor.destroy();event.persisted?friendsController.deactivate():friendsController.destroy();event.persisted?tournamentController.deactivate():tournamentController.destroy();clearInterval(leaderboardTimer);clearInterval(onlineTimer);clearInterval(tournamentTimer);tournamentTimer=null;board?.destroy();});
window.addEventListener('popstate',event=>{event.state?.mxOfflineFallback?main.setAttribute?.('data-offline-fallback',''):main.removeAttribute?.('data-offline-fallback');render({focus:true});activate();});
window.addEventListener('pageshow',event=>{if(event.persisted){activePath='';render();activate();if(['linked','loading','error'].includes(context.sessionStatus))model.profile();}});
function loadProviders(){
 if(context.providersLoaded)return;
 // The account page renders the Google/Apple buttons on every visit, so its provider capabilities
 // must not wait for a manual button press. Loaded when that view actually renders rather than at
 // app boot: the session read consumes the single-use capability response the realtime harness
 // (and any other one-shot session reader) is bound to, so an unconditional boot read is a real
 // regression on the game path, where no provider button exists. Failure leaves the buttons
 // honestly disabled; a later account visit retries.
 globalThis.MegaAccount.session().then(s=>{
  context.providers=s.providers||{};context.providersLoaded=true;
  if(normalizedPath()==='/account')refreshSessionView();
 }).catch(()=>{});
}
/* LR17: the research-consent card hydrates from the actor's own one-time choice. The fetch happens
 * only for a linked session on the account view, once, and failures leave the card unloaded rather
 * than fabricating a state (the API answers 401 for guests and CONSENT_READ_UNAVAILABLE surfaces
 * honestly). */
function loadResearchConsent(force){
 if(!force&&context.researchLoaded)return;
 readJSON('/api/account/research').then(state=>{
  if(state&&typeof state==='object'&&typeof state.recorded==='boolean'){context.researchConsent=state;}
  context.researchLoaded=true;context.researchOpen=false;
  if(normalizedPath()==='/account')render();
 }).catch(()=>{context.researchLoaded=true;});
}
/* LR19: the telemetry opt-in/out surface on the privacy-choices page. The panel reads the SAME
 * storage the lane uses, so the display and the lane behavior can never disagree. The lane starts
 * and stops with the choice; the counters stay empty until a player explicitly opts in. */
let telemetryLane=null;
function hydrateTelemetryPanel(){
 const host=main.querySelector('[data-metrics-host]');
 if(!host)return;
 host.innerHTML=telemetryPanel(globalThis.localStorage);
 if(telemetryOptedIn(globalThis.localStorage)&&!telemetryLane){telemetryLane=createTelemetryLane({storage:globalThis.localStorage,request:(path,body)=>globalThis.MegaAccount.request(path,body),intervalMs:60000});if(telemetryLane)telemetryLane.start();}
 if(!telemetryOptedIn(globalThis.localStorage)&&telemetryLane){telemetryLane.stop();telemetryLane=null;}
}
render();activate();model.profile().then(()=>{if(normalizedPath()==='/store')refreshProducts();});const bootOrder=new URLSearchParams(location.search).get('cf_order');if(normalizedPath()==='/store'&&bootOrder)pollCashfreeStatus(bootOrder);
