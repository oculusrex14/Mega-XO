/* V3.3.3 account and social UI. Existing game rendering is used via MegaApp;
 * the module never writes authoritative currency, Elo or game results. */
(()=>{
'use strict';
const API=window.MegaAccount,APP=window.MegaApp,NET=window.MegaNetwork,D=window.MegaDomain,I=window.MegaIcons;
if(!API||!APP)return;
const $=(s,root=document)=>root.querySelector(s),esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/* B2/APP-002: account surfaces open the canonical public documents. */
const publicLink=(key,text,cls='')=>'<a'+(cls?' class="'+cls+'"':'')+' '+(window.MegaPublicLinks?.attributes?.(key)||'href="https://megaxo.online/'+key+'" target="_blank" rel="noopener noreferrer"')+'>'+esc(text)+'</a>';
const KEY='mega_v32_state',OWNER='mega_v333_owner',META='mega_v333_sync',NOTICE='mega_v334_notice_delivered';
const get=k=>{try{return JSON.parse(localStorage.getItem(k)||'null');}catch{return null;}},put=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));return true;}catch{return false;}},drop=k=>{try{localStorage.removeItem(k);return true;}catch{return false;}};
const icon=n=>I?.icon(n)||'',btn=(text,action,id='',quiet=false)=>'<button type="button" class="button full '+(quiet?'quiet':'')+'" data-c="'+action+'" data-id="'+esc(id)+'">'+text+'</button>';
const label={online:'Online',away:'Away',offline:'Offline',hidden:'Status hidden','in-match':'In a match','in-lobby':'In a lobby',queued:'Finding a match'};
let session=null,social={friends:[],incoming:[],outgoing:[],blocked:[]},invites=[],challenges=[],panel=null,profile=null,emailChallenge=null,previousFocus=null,profileMode='ranked',selectedAvatar='board',syncRevision=0,syncState='device',dirty=false,saving=false,suppressSave=false,syncTimer=null,lastPresence=0,queuedAt=0,bootVersion=0,conflict=null,refreshing=false,lastError='',friendsQuery='',searchRows=[],reconnecting=false,delivered=new Set(get(NOTICE)||[]),decision=null;
function error(e){return ({SERVICE_UNAVAILABLE:'You are offline, or online features are unavailable. You can still play on this device.',ONLINE_UNAVAILABLE:'Online features are unavailable right now.',PROVIDER_NOT_CONFIGURED:'This sign-in method is unavailable right now.',AUTH_REQUIRED:'Sign in again to continue.',LINK_ACCOUNT_REQUIRED:'Create or link a profile first.',INVALID_USERNAME:'Use 3-20 letters, numbers or underscores. Start with a letter.',USERNAME_TAKEN:'That username is already taken.',USERNAME_COOLDOWN:'You can change your username again after seven days.',INVALID_DISPLAY_NAME:'Use a display name of up to 28 characters.',ACCOUNT_LINKED_ELSEWHERE:'That login belongs to another profile. Sign out and restore that profile instead; nothing has been merged.',PROVIDER_ALREADY_LINKED:'This profile already has a different login from that sign-in service.',LAST_LOGIN_METHOD:'Link another sign-in method before removing this one.',REAUTH_REQUIRED:'Verify your account again before continuing.',REAUTH_ACCOUNT_MISMATCH:'Choose a login already linked to this profile. Nothing has been changed.',SAVE_CONFLICT:'A newer cloud save exists. Choose which practice save to keep.',PROFILE_NOT_FOUND:'This player is unavailable.',FRIENDSHIP_REQUIRED:'Both players must accept the friend request first.',RATE_LIMITED:'Please wait a moment and try again.',MATCH_ACTIVE:'Finish or leave your current match first.',CSRF_FAILED:'Your session changed. Sign in again to continue.',SIGNIN_CANCELLED:'Sign-in was cancelled. Your device progress is unchanged.',INVALID_EMAIL:'Enter a valid email address.',PASSWORD_WEAK:'Use at least 10 characters with at least one letter and one number.',EMAIL_IN_USE:'That email is already linked to a Mega XOXO profile.',EMAIL_ALREADY_LINKED:'This profile already has an email login.',INVALID_CREDENTIALS:'Email or password is incorrect.',ALREADY_LINKED:'Sign out before signing in to a different profile.',EMAIL_DELIVERY_NOT_CONFIGURED:'Email verification is temporarily unavailable.',EMAIL_DELIVERY_FAILED:'We could not send the verification email. Please try again.',OTP_COOLDOWN:'A code was just sent. Wait a minute before requesting another.',INVALID_OTP:'That verification code is incorrect.',OTP_EXPIRED:'That verification code has expired. Go back and request a new one.',OTP_LOCKED:'Too many incorrect code attempts. Go back and request a new code.',OTP_USED:'That verification code has already been used.',RESET_NOT_AUTHORIZED:'This password reset is no longer valid. Start again.',INVALID_REPORT_CATEGORY:'Choose a report reason.',INVALID_REPORT_DETAIL:'Keep the report note under 280 characters.',REPORT_DETAIL_REQUIRED:'Add a short note explaining the issue.',CANNOT_REPORT_SELF:'You cannot report your own profile.',ACCOUNT_DELETION_UNAVAILABLE:'Account deletion is unavailable right now.',DELETE_CONFIRMATION_REQUIRED:'Type your exact player tag to confirm deletion.',ACCOUNT_BUSY:'Finish or leave your active match, queue or room before deleting your account.',PROOF_REQUIRED:'That password did not match the existing profile. Nothing has been changed.',DECISION_UNAVAILABLE:'This choice is no longer available. Start again.',INVALID_AUTH_STATE:'That sign-in request has expired. Start again; no profile changes were made.',EMAIL_RESPONSE_INVALID:'Email sign-in returned an unexpected response. Update the app and try again.',NATIVE_SESSION_INVALID_RESPONSE:'The secure sign-in response was invalid. Please retry.',INVALID:'Secure sign-in could not be completed. Try again.',UNAVAILABLE:'Secure sign-in is temporarily unavailable. Try again.',REVOKED:'Your session is no longer valid. Sign in again.',RATE_LIMIT_UNAVAILABLE:'Email sign-in is temporarily unavailable. Try again shortly.',REQUEST_TIMEOUT:'Email sign-in timed out. Check your connection and retry.',INVALID_OPERATION:'Email sign-in requires an updated app. Please install the latest APK.'})[e?.message]||(/^[A-Z][A-Z0-9_]{0,63}$/.test(String(e?.message||''))?'Could not complete that action (code: '+e.message+'). Please try again.':'Could not complete that action. Please try again.');}
function announce(text,bad=false){lastError=text;const el=$('#identityStatus');if(el){el.textContent=text;el.classList.toggle('error',bad);}else APP.notify(text);}
function loader(small=false){const x='<span class="mark-layer x xo-loader-mark"><svg viewBox="0 0 40 40" stroke="currentColor" aria-hidden="true"><path d="M10 10 30 30M30 10 10 30"/></svg></span>',o='<span class="mark-layer o xo-loader-mark"><svg viewBox="0 0 40 40" stroke="currentColor" aria-hidden="true"><circle cx="20" cy="20" r="11"/></svg></span>',marks={0:' xo-step-1',1:' xo-step-2',4:' xo-step-3',5:' xo-step-4',8:' xo-step-5'};return '<div class="theme-loader xo-win-loader '+(small?'small':'')+'" aria-hidden="true"><div class="xo-loader-board">'+Array.from({length:9},(_,i)=>'<span class="xo-loader-cell'+(marks[i]||'')+'">'+(i===0||i===4||i===8?x:i===1||i===5?o:'')+'</span>').join('')+'<svg class="xo-loader-strike" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M12 12 88 88"/></svg></div></div>';}
function avatar(kind='board',small=false){const glyph={cross:'<path d="M6 6 18 18M18 6 6 18"/>',ring:'<circle cx="12" cy="12" r="7"/>',board:'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>',rook:'<path d="M6 21h12M7 18h10L16 8h2V3h-3v3h-2V3h-2v3H9V3H6v5h2z"/>',crown:'<path d="m3 7 4 3 5-7 5 7 4-3-3 13H6z"/>',star:'<path d="m12 3 3 6 6 1-4 5 1 6-6-3-6 3 1-6-4-5 6-1z"/>'}[kind]||'';return '<span class="profile-avatar '+(small?'small':'')+'"><svg viewBox="0 0 24 24" aria-hidden="true">'+glyph+'</svg></span>';}
function state(p){const v=p.presence||{state:'offline',online:false};return '<span class="presence" data-online="'+(v.online===true)+'">'+esc(label[v.state]||'Offline')+'</span>';}
function frame(title,html,kind='profile',canClose=true){if(!panel){previousFocus=document.activeElement;panel=document.createElement('section');panel.id='identityScreen';$('#app').append(panel);}panel.className='identity-screen '+kind;panel.dataset.kind=kind;panel.setAttribute('aria-label',title||'Opening Mega XOXO');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.innerHTML=(title?'<div class="identity-top"><h2 tabindex="-1">'+esc(title)+'</h2>'+(canClose?'<button class="icon-button" data-c="dismiss" aria-label="Close">'+icon('close')+'</button>':'')+'</div>':'')+html+'<span id="identityStatus" class="identity-status" role="status" aria-live="polite"></span>';I?.refresh?.();}
function dismiss(){panel?.remove();panel=null;profile=null;lastError='';if(previousFocus?.isConnected)previousFocus.focus?.();}
function loading(text,allowGuest=false){frame('',loader()+'<h1>MEGA XOXO</h1><p role="status">'+esc(text)+'</p>'+(allowGuest?btn('Play on this device','guest','',true):''),'startup',false);}
/* Provider buttons (device-bug fix 2026-10-19): on a native host the capability map is an
 * OPTIMIZATION, not the authority - a transient ensure() failure (bridge hiccup, refresh
 * timeout) must never REMOVE the sign-in options, which is exactly the "Continue with Google
 * is missing" device report. With MegaNativeIdentity installed the provider challenge itself
 * fails honestly, so render Google/Apple ENABLED whenever the host could plausibly serve them,
 * and let the challenge answer truthfully. The WEB keeps the exact capability gating. */
/* Provider buttons (device-bug fix 2026-10-19, Sol-reviewed): on a native host both buttons
 * ALWAYS render - a transient ensure() failure must never HIDE a sign-in option (the 1.0.5
 * "Continue with Google is missing" device report). But they ENABLE strictly by the capability
 * map: an empty/failed check renders them DISABLED with the boot error code shown, never falsely
 * enabled (the Android bridge serves Google only - a falsely enabled Apple button is a dead end).
 * The retry control re-runs the availability check without a page reload. */
function providerButtons(intent='login'){const caps=session?.providers||{};const nativeHost=!!window.MegaNativeApi;const enabled=p=>!nativeHost?!!caps[p]?.web:!!(caps[p]&&(caps[p].web||caps[p].native));const listed=[['google','Continue with Google']];if(!nativeHost&&caps.apple)listed.push(['apple','Sign in with Apple']);return '<div class="signin-options"><button class="provider-button" data-c="email-form" data-id="continue">Continue with email</button>'+listed.map(([provider,text])=>'<button class="provider-button" data-c="signin" data-id="'+provider+'" data-intent="'+intent+'" '+(enabled(provider)?'':'disabled')+'>'+esc(text)+'</button>').join('')+(nativeHost&&bootError?'<button class="provider-button" data-c="signin-retry" data-id="">Retry sign-in check</button>':'')+'</div>';}
function landing(link=false){frame(link?'Save your progress':'Welcome to Mega XOXO','<div class="signin-art">'+loader()+'</div><span class="identity-eyebrow">YOUR GAME. YOUR PROFILE.</span><h1>Play now.<br>Keep it with you.</h1><p>Create or restore a profile with email, Google or Apple. Your player tag, friends and cloud practice save stay with the profile.</p>'+providerButtons(link?'link':'login')+btn('Continue as guest','guest','',true)+'<div class="signin-foot">'+(bootError?'<p role="status">Sign-in availability check failed (code '+esc(bootError)+'). You can still play as a guest or retry.</p>':'')+'<p>Guest progress stays on this device. Uninstalling the app or clearing its storage can erase it. Sign-in is optional for offline play.</p><p>Mega XOXO is developed by <strong>Antimatter Innovations</strong>.</p><p>'+publicLink('privacy','Privacy Policy')+' · '+publicLink('terms','Terms')+' · '+publicLink('support','Support')+'</p></div>','signin',true);if(!session){announce('Checking sign-in availability...');API.session(true).then(s=>{session=s;if(panel?.dataset.kind==='signin'){const el=$('.signin-options',panel);if(el)el.outerHTML=providerButtons(link?'link':'login');announce('');}}).catch(e=>{bootError=/^[A-Z0-9_]{3,}$/.test(e&&e.message||'')?e.message:'';announce('Sign-in needs a connection'+(bootError?' ('+bootError+')':'')+'. Guest play is available.');});}}
function emailForm(action='continue',preset=''){
 const link=action==='link',reauth=action==='reauth',change=action==='change',continuing=action==='continue',title=link?'Add email login':reauth?'Verify with email':change?'Change email':'Continue with email';
 const confirm=link?'<label>Confirm password<input id="cEmailPasswordConfirm" type="password" autocomplete="new-password" maxlength="128"></label>':'';
 const password=change?'':'<label>Password<input id="cEmailPassword" type="password" autocomplete="'+(link?'new-password':'current-password')+'" maxlength="128"><small>'+(continuing?'If this email already has a verified profile, we will sign you in. If it is new, we will email a one-time code before creating the profile.':link?'We will verify this mailbox with a one-time code before linking it.':'Use the password for this Mega XOXO profile.')+'</small></label>'+confirm;
 frame(title,'<div class="profile-fields"><label>'+(change?'New email':'Email')+'<input id="cEmailAddress" type="email" inputmode="email" autocomplete="email" maxlength="254" placeholder="you@example.com" value="'+esc(change?'':preset)+'"></label>'+password+'</div>'+btn(reauth?'Verify email login':link||change?'Send verification code':'Continue','email-submit',action)+(continuing?btn('Forgot password?','email-forgot','',true):'')+btn('Back','email-back','',true)+(change?'<p class="caption">Verify your identity first, then we will confirm the new mailbox before replacing your current email. Other signed-in devices will be signed out after the change.</p>':continuing?'<p class="caption">New email accounts are activated only after the code sent to that mailbox is confirmed. Codes expire after 10 minutes.</p>':''),'email-auth');
}
function otpForm(result,purpose='verify',typedEmail=''){
 emailChallenge={...result,purpose};const reset=purpose==='reset';
 // The V5 API returns the privacy-safe masked recipient in 'email'. Earlier Android builds
 // lost that field while projecting the challenge. Keep the typed address as a fallback for
 // the non-enumerating password recovery path, which intentionally omits the recipient.
 const recipient=result.email||result.maskedEmail||typedEmail||'your email address';
 frame(reset?'Reset your password':purpose==='change'?'Verify your new email':'Verify your email','<p>Enter the 6-digit code sent to <strong>'+esc(recipient)+'</strong>.</p><div class="profile-fields"><label>Verification code<input id="cEmailOtp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" placeholder="000000"></label></div>'+btn(reset?'Verify reset code':'Verify email','email-otp',purpose)+btn('Back','email-back','',true)+'<p class="caption">The code expires after 10 minutes and can be used once. If it expires, go back and request a new code.</p>','email-auth');
}
function forgotForm(preset=''){frame('Forgot password','<p>Enter the email address for your Mega XOXO profile. For privacy, the response is the same whether or not an account exists.</p><div class="profile-fields"><label>Email<input id="cEmailAddress" type="email" inputmode="email" autocomplete="email" maxlength="254" value="'+esc(preset)+'"></label></div>'+btn('Send reset code','email-forgot-submit')+btn('Back','email-back','',true),'email-auth');}
/* Owner-decided account-link choice (2026-10-16), copy from the Sol review. A provider-verified
   email matched an existing profile: nothing changes until the player proves ownership of that
   profile with its existing email login. 'link' then adds the new provider to the old profile;
   'new' creates a fresh profile and only schedules the old one for deletion when the SAME proof
   succeeds and the separate confirmation screen was shown. Without proof, 'new' never deletes. */
function providerName(id){return id==='google'?'Google':id==='apple'?'Apple':'the sign-in service';}
function decisionChoice(){
 const d=decision;if(!d)return landing();
 frame('We found an existing profile',
  '<p>A Mega XOXO profile is associated with <strong>'+esc(d.maskedEmail||'this email')+'</strong>.</p>'+
  '<p>Log in to keep its progress, or create a new profile. A new profile starts fresh, and we can schedule the old one for deletion 30 days later — but only after you verify the old profile belongs to you.</p>'+
  (d.ambiguous?'':'<div class="profile-fields">'+btn('Log in to that account','decision-link')+'</div>')+
  '<div class="profile-fields">'+btn('Create new profile','decision-new','',true)+'</div>'+
  btn('Not now','decision-dismiss','',true)+
  (d.ambiguous?'<p class="caption">We couldn\'t safely tell which profile matches this email. You can still create a new profile; to use an existing one, sign in with its current login method and add '+esc(providerName(d.provider))+' from Linked accounts. No profiles have been changed.</p>':'<p class="caption">We\'ll ask you to verify the existing profile before anything changes.</p>'),
  'decision');
}
function decisionProof(mode){
 const d=decision;if(!d)return landing();
 frame(mode==='link'?'Verify your existing profile':'Verify the old profile (optional)',
  '<p>Enter the <strong>email address and password of your existing Mega XOXO profile</strong>'+(mode==='link'?' to sign in to it.':' to schedule its deletion 30 days from now.')+'</p>'+
  '<div class="profile-fields"><label>Email<input id="cProofEmail" type="email" inputmode="email" autocomplete="email" maxlength="254"></label><label>Password<input id="cProofPassword" type="password" autocomplete="current-password" maxlength="128"></label></div>'+
  btn(mode==='link'?'Verify and log in':'Verify and continue','decision-proof',mode)+btn('Back','decision-back','',true)+
  (mode==='link'?'<p class="caption">Verification uses the profile\'s existing email login. '+esc(providerName(d.provider))+' is added as a new sign-in method after this.</p>':'<p class="caption">Not sure, or forgot the password? Skip verification and we\'ll create a fresh profile without touching the old one. You can always delete the old profile later from its own settings.</p>'),
  'decision');
}
function decisionConfirmNew(){
 const d=decision;if(!d||!d.existing)return decisionProof('new');
 const date=new Date(Date.now()+30*86400000).toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'});
 frame('Create a new profile and delete the old one?',
  '<p>Your new profile will start fresh. Progress, Coins, Crowns, rank and friends won\'t carry over, and purchases stay with the profile that bought them.</p>'+
  '<p>Your existing profile, <strong>'+esc(d.existing.username||'your profile')+' ('+esc(d.existing.tag||'')+')</strong>, will be scheduled for permanent deletion on <strong>'+esc(date)+'</strong> — 30 days from now. every sign-in method on that profile stops working immediately and there is no in-app cancellation. If this was a mistake, contact '+esc('contact@antimatterinnovations.com')+' before the window closes.</p>'+
  '<p>Some purchase and security records are retained as explained in our '+publicLink('privacy','Privacy Policy')+'.</p>'+
  btn('Create profile and schedule deletion','decision-new-confirm')+
  btn('Go back','decision-back','',true),
  'decision');
}
function decisionProofValues(){return {email:$('#cProofEmail')?.value?.trim()||'',password:$('#cProofPassword')?.value||''};}
async function decisionVerify(mode){
 const d=decision;if(!d)return;
 const proof=decisionProofValues();if(!proof.email||!proof.password)return announce('Enter the email and password of your existing profile.',true);
 announce('Verifying the existing profile...');
 try{const out=await API.request('/api/account/decision/verify',{state:d.state,proof});
  d.existing=out.existing||null;d.proof=proof;
  if(mode==='link'){await decisionApply('link',proof);return;}
  decisionConfirmNew();
 }catch(e){announce(error(e),true);}
}
async function decisionApply(choice,proof=null){
 const d=decision;if(!d)return;
 announce(choice==='link'?'Signing you in...':'Creating your new profile...');
 try{const out=await API.request('/api/account/decision',{state:d.state,choice,proof});decision=null;API.reset();await boot();return out;}
 catch(e){announce(error(e),true);}
}
function resetPasswordForm(challengeId){emailChallenge={...(emailChallenge||{}),challengeId,purpose:'reset-ready'};frame('Choose a new password','<p>Your email code was accepted. Set a new password for this Mega XOXO profile.</p><div class="profile-fields"><label>New password<input id="cResetPassword" type="password" autocomplete="new-password" maxlength="128"><small>At least 10 characters with at least one letter and one number.</small></label><label>Confirm new password<input id="cResetPasswordConfirm" type="password" autocomplete="new-password" maxlength="128"></label></div>'+btn('Reset password','email-reset')+btn('Cancel','email-back','',true),'email-auth');}
async function emailAuth(action){
 if(APP.getContext().playing)return announce('Finish your current game before changing profiles.',true);
 const email=$('#cEmailAddress')?.value||'',password=$('#cEmailPassword')?.value||'',confirm=$('#cEmailPasswordConfirm')?.value;
 if(confirm!==undefined&&password!==confirm)return announce('Passwords do not match.',true);
 if(action==='continue')archiveCurrent();announce(action==='continue'?'Checking your profile...':'Sending verification code...');
 try{
  const ne=window.MegaNativeApi&&typeof window.MegaNativeApi.email==='function'?window.MegaNativeApi.email:null;
  const out=ne?await ne({action,email,password}):await API.request('/api/account/email',{action,email,password});
  if(ne&&out.ok!==true)throw Error(out.error||'NATIVE_SIGNIN_FAILED');
  if(out.verificationRequired){otpForm(out,action==='link'?'link':action==='change'?'change':'verify',email);return;}
  if(action==='continue'){API.reset();await boot();return;}
  session=await API.session(true);profile=session.profile;if(action==='reauth')return connections();connections();
 }catch(e){announce(error(e),true);}
}
async function verifyEmailOtp(purpose){
 if(!emailChallenge)return emailForm();
 const code=$('#cEmailOtp')?.value||'';announce('Checking code...');
 try{const ne=window.MegaNativeApi&&typeof window.MegaNativeApi.email==='function'?window.MegaNativeApi.email:null;
  const out=ne?await ne({action:'verify',challengeId:emailChallenge.challengeId,code}):await API.request('/api/account/email',{action:'verify',challengeId:emailChallenge.challengeId,code});
  if(ne&&out.ok!==true)throw Error(out.error||'NATIVE_SIGNIN_FAILED');
  if(out.resetReady){resetPasswordForm(out.challengeId);return;}
  if(out.linked&&out.profile&&!out.csrf&&!ne){session=await API.session(true);profile=session.profile;emailChallenge=null;connections();return;}
  if(out.linked){emailChallenge=null;API.reset();await boot();}
 }catch(e){announce(error(e),true);}
}
async function forgotPassword(){
 const email=$('#cEmailAddress')?.value||'';announce('Sending reset instructions...');
 try{const ne=window.MegaNativeApi&&typeof window.MegaNativeApi.email==='function'?window.MegaNativeApi.email:null;
  const out=ne?await ne({action:'forgot',email}):await API.request('/api/account/email',{action:'forgot',email});
  if(ne&&out.ok!==true)throw Error(out.error||'NATIVE_SIGNIN_FAILED');
  otpForm(out,'reset',email);announce(out.message||'If this email has an account, a code has been sent.');}catch(e){announce(error(e),true);}
}
async function resetPassword(){
 if(!emailChallenge)return forgotForm();const password=$('#cResetPassword')?.value||'',confirm=$('#cResetPasswordConfirm')?.value||'';if(password!==confirm)return announce('Passwords do not match.',true);announce('Updating password...');
 try{const ne=window.MegaNativeApi&&typeof window.MegaNativeApi.email==='function'?window.MegaNativeApi.email:null;
  if(ne){const out=await ne({action:'reset',challengeId:emailChallenge.challengeId,password});if(out.ok!==true)throw Error(out.error||'NATIVE_SIGNIN_FAILED');}
  else await API.request('/api/account/email',{action:'reset',challengeId:emailChallenge.challengeId,password});
  emailChallenge=null;API.reset();await boot();APP.notify('Password updated. Other signed-in sessions were revoked.');}catch(e){announce(error(e),true);}
}
function archiveCurrent(){const owner=get(OWNER)||'guest';put('mega_v333_archive:'+owner,APP.getSave());}
async function becomeGuest(){bootVersion++;if(!session)try{session=await API.session();}catch{}if(APP.getContext().playing&&get(OWNER))return announce('Finish your current match before switching profiles.',true);
 if(session?.linked){await saveNow();if(dirty||syncState==='conflict')return announce('Back up or resolve the current profile before switching to guest.',true);await API.request('/api/account/logout',{});}
 if(get(OWNER)){archiveCurrent();const previous=get('mega_v333_archive:guest')||D.fresh();previous.settings.theme=APP.getSave().settings.theme;suppressSave=true;put(OWNER,null);APP.applyPractice(previous);suppressSave=false;}
 API.reset();session=null;social={friends:[],incoming:[],outgoing:[],blocked:[]};invites=[];challenges=[];syncState='device';put('mega_v333_welcomed',true);updateNotificationButton();dismiss();APP.refresh();APP.render();}

function hasProgress(p){return !!p?.records?.length||!!p?.offlineMatch||!!p?.wallet?.owned?.length||Object.values(p?.playSeconds||{}).some(n=>Number(n)>0)||(p?.wallet?.ledger||[]).some(e=>e.id!=='welcome');}
async function adoptCloud(remote){suppressSave=true;archiveCurrent();const p=remote.practice||D.fresh();if(!remote.practice)p.settings.theme=APP.getSave().settings.theme;APP.applyPractice(p);put(OWNER,session.profile.id);syncRevision=remote.revision||0;dirty=!remote.practice;put(META,{actor:session.profile.id,revision:syncRevision,dirty});suppressSave=false;syncState=dirty?'pending':'saved';if(dirty)await saveNow();dismiss();APP.refresh();APP.render();}
async function useDevice(){const remote=conflict?.remote||{revision:syncRevision};archiveCurrent();put(OWNER,session.profile.id);syncRevision=remote.revision;dirty=true;conflict=null;await saveNow();if(syncState==='saved'){dismiss();APP.refresh();APP.render();}}
function chooseSave(remote){conflict={remote};frame('Choose your practice save','<p>'+ (remote.practice?'This profile already has a cloud save. Choose which practice progress to use.':'This is a different profile with no cloud backup yet. Start fresh or explicitly bring this device practice across.') +' Your current device copy stays saved on this device.</p><div class="profile-card"><b>'+(remote.practice?'Cloud save':'New practice save')+'</b><p>'+Number(remote.practice?.records?.length||0)+' completed practice games</p></div><div class="profile-card"><b>This device</b><p>'+APP.getSave().records.length+' completed practice games</p></div>'+btn(remote.practice?'Restore cloud save':'Start fresh for this profile','restore-choice')+btn('Keep this device practice save','device-choice','',true)+'<p>Your Coins, Crowns, rank and online results are unchanged by either choice.</p>','conflict',false);}
async function saveNow(){if(!session?.linked||saving||suppressSave||!dirty)return;const owner=get(OWNER);if(owner!==session.profile.id)return;const snapshot=APP.getSave();saving=true;syncState='saving';
 try{const saved=await API.request('/api/account/save',{revision:syncRevision,practice:snapshot});syncRevision=saved.revision;dirty=JSON.stringify(APP.getSave())!==JSON.stringify(snapshot);put(META,{actor:owner,revision:syncRevision,dirty});put('mega_v333_archive:'+owner,snapshot);syncState=dirty?'pending':'saved';}
 catch(e){syncState=e.message==='SAVE_CONFLICT'?'conflict':'offline';if(e.message==='SAVE_CONFLICT'){conflict={remote:await API.request('/api/account/save').catch(()=>null)};if(panel?.dataset.kind==='profile')announce('A newer save is available. Resolve it before syncing.',true);}}finally{saving=false;}
}
async function syncBoot(generation){const resolved=await API.session(true);if(generation!==bootVersion)return;session=resolved;if(!session.linked)return;const remote=await API.request('/api/account/save');if(generation!==bootVersion)return;const owner=get(OWNER),meta=get(META);syncRevision=remote.revision;
 if(owner!==session.profile.id){if((remote.practice||owner)&&hasProgress(APP.getSave())){chooseSave(remote);return 'conflict';}if(remote.practice){await adoptCloud(remote);return;}archiveCurrent();put(OWNER,session.profile.id);dirty=true;await saveNow();}
 else if(meta?.revision!==undefined&&remote.revision>meta.revision){if(meta.dirty){chooseSave(remote);return 'conflict';}if(remote.practice)await adoptCloud(remote);}
 else if(meta?.dirty){dirty=true;await saveNow();}
 if(!dirty)syncState='saved';put(META,{actor:session.profile.id,revision:syncRevision,dirty});
}
async function boot(){const id=++bootVersion;loading('Opening your board',true);try{await syncBoot(id);if(id!==bootVersion)return;if(panel?.dataset.kind==='conflict')return;
  if(session?.linked){dismiss();await presence();await refreshFriends();if(session.profile.profileVersion===1)await openProfile();else if(session.profile.activeMatch&&!session.profile.activeMatch.startsWith('tournament:'))resumePrompt(session.profile.activeMatch);}
  else if(get(OWNER)){landing();announce('Sign in to reconnect your saved profile, or continue separately as a guest.');}else if(get('mega_v333_welcomed')){dismiss();if(APP.getSave().offlineMatch)frame('Continue your game?','<p>Your unfinished game is saved on this device.</p>'+btn('Resume game','resume-offline')+btn('Back to home','dismiss','',true),'resume');}else landing();
 }catch(err){if(id!==bootVersion)return;syncState='offline';session=null;bootError=/^[A-Z0-9_]{3,}$/.test(err?.message||'')?err.message:'';if(get('mega_v333_welcomed'))dismiss();else landing();}
 const params=new URLSearchParams(location.search);if(params.has('authError')){APP.notify(error({message:params.get('authError')}));history.replaceState(null,'',location.pathname+location.hash);}else if(params.has('account'))history.replaceState(null,'',location.pathname+location.hash);
 else if(params.has('accountChoice')){decision={state:params.get('accountChoice')||'',maskedEmail:params.get('masked')||'',provider:params.get('provider')||'',ambiguous:params.get('ambiguous')==='1'};history.replaceState(null,'',location.pathname+location.hash);decisionChoice();return;}
 if(location.hash.startsWith('#player=')){const tag=decodeURIComponent(location.hash.slice(8));if(session?.linked)openProfile(tag);else landing();}
 decorate();}
async function signIn(provider,intent){if(APP.getContext().playing)return announce('Finish your current game before switching or linking profiles.',true);archiveCurrent();announce('Opening secure sign-in...');try{
 if(window.MegaNativeApi&&typeof window.MegaNativeApi.signIn==='function'){
  // P20-03 native host: the challenge, the provider credential and the bearer exchange all run in
  // Kotlin. No ID token and no session credential ever reaches this scope.
  const result=await window.MegaNativeApi.signIn(provider,intent);
  if(!result||result.ok!==true)throw Error(result?.error||'NATIVE_SIGNIN_FAILED');
  if(result.choiceRequired===true){decision={state:result.state||'',maskedEmail:result.maskedEmail||'',provider,ambiguous:result.ambiguous===true};decisionChoice();return;}
  API.reset();await boot();
 }
 else if(window.MegaNativeIdentity&&session?.providers?.[provider]?.native){const c=await API.request('/api/account/native/challenge',{provider,intent});const credential=await window.MegaNativeIdentity.getCredential({provider,nonce:c.nonce});const logged=await API.request('/api/account/native/finish',{provider,state:c.state,idToken:credential.idToken});
  if(logged.choiceRequired===true){decision={state:c.state,maskedEmail:logged.maskedEmail||'',provider,ambiguous:logged.ambiguous===true};decisionChoice();return;}
  API.reset();await boot();}
 else {const out=await API.request('/api/account/start',{provider,intent});location.assign(out.url);}
 }catch(e){announce(error(e),true);}}
async function openProfile(id){if(!session?.linked){landing();return;}try{const p=await API.request('/api/community/profile/'+encodeURIComponent(id||session.profile.id));profile=p;profileMode='ranked';selectedAvatar=p.avatar;showProfile();}catch(e){APP.notify(error(e));}}
function fmtTime(n){if(n===null||n===undefined)return '--';const s=Math.round(n);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');}
function showProfile(){if(!profile)return;const p=profile,own=p.id===session.profile.id,stats=p.stats?.[profileMode],creditLine=own?'<div class="profile-card"><b>Cosmetic Credits</b><p>'+Number(p.cosmeticCredits||0)+'</p></div>':'';const statHTML=stats?(profileMode==='tournament'?'<div class="stats-grid">'+[['Entered',stats.entered],['Wins',stats.wins],['Runner-up',stats.runnerUp],['Top 3',stats.top3],['Top 5',stats.top5],['Best',stats.bestFinish===null?'--':'#'+stats.bestFinish],['Average',stats.averageFinish===null?'--':stats.averageFinish.toFixed(1)],['Premium wins',stats.premiumWins]].map(([k,v])=>'<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('')+'</div>':'<div class="stats-grid">'+[['Games',stats.games],['Wins',stats.wins],['Win rate',stats.winRate===null?'--':(100*stats.winRate).toFixed(1)+'%'],['Average game',fmtTime(stats.averageSeconds)],['Hours played',stats.hours.toFixed(2)],['Draws',stats.draws]].map(([k,v])=>'<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('')):'<p>These stats are private. Friends can see them when the player allows it.</p>';
 let actions='';if(own)actions=btn('Edit profile','edit')+btn('Linked accounts & recovery','connections','',true)+(APP.getSave().offlineMatch?btn('Resume offline game','resume-offline','',true):'')+btn(syncState==='conflict'?'Resolve cloud save':'Save progress now','sync','',true)+'<p>Cloud save: '+esc(syncState)+'. Offline practice and online competitive balances are stored separately.</p>';
 else if(p.relation==='friend')actions=btn(icon('swords')+'Challenge (1v1)','challenge',p.id)+btn('Remove friend','social','remove:'+p.id,true)+btn('Block player','social','block:'+p.id,true);
 else if(p.relation==='incoming')actions=btn('Accept friend request','social','accept:'+p.id)+btn('Decline','social','decline:'+p.id,true);
 else if(p.relation==='outgoing')actions=btn('Cancel friend request','social','cancel:'+p.id,true);else actions=btn('Add friend','social','request:'+p.id);
 if(!own)actions+=btn('Report player','report-player',p.id,true);
 const seasonLine=p.games>=D.POLICY.placements&&p.season?'<small>'+(p.season.qualified?esc(p.season.id.replace('-', ' '))+' qualified':esc(p.season.id.replace('-', ' '))+' requalification · '+Math.min(p.season.games,5)+'/5')+'</small>':'';frame(own?'Your profile':'Player profile','<div class="profile-card"><div class="profile-heading">'+avatar(p.avatar)+'<div><h3>'+esc(p.name)+'</h3><small>@'+esc(p.username)+'</small>'+state(p)+'</div></div><div class="tag-row"><code>'+esc(p.tag)+'</code><button class="icon-button" data-c="copy" data-id="'+esc(p.tag)+'" aria-label="Copy player tag">'+icon('copy')+'</button><button class="icon-button" data-c="share" data-id="'+esc(p.tag)+'" aria-label="Share profile">'+icon('link')+'</button></div><small>'+esc(p.games>=10?D.tier(p.tier).name+' - '+p.rating+' Elo':'Unranked - '+p.games+'/10 placements')+'</small>'+seasonLine+'</div>'+creditLine+'<div class="profile-modes">'+[['ranked','Ranked'],['casual','Casual'],['friend','Friends'],['tournament','Tournaments']].map(([id,n])=>'<button class="tab '+(profileMode===id?'active':'')+'" data-c="statsmode" data-id="'+id+'">'+n+'</button>').join('')+'</div>'+statHTML+actions,'profile');}
function reportPlayerForm(id){
 const name=profile?.id===id?profile.name:'this player';
 frame('Report player','<p>Tell us what you are reporting about '+esc(name)+'. Reports are reviewed; sending a report does not automatically punish a player.</p><div class="profile-fields"><label>Reason<select id="cReportCategory"><option value="cheating">Cheating or unfair play</option><option value="username">Username or profile</option><option value="harassment">Harassment</option><option value="unsportsmanlike">Unsportsmanlike conduct</option><option value="other">Other</option></select></label><label>Optional details<textarea id="cReportDetail" maxlength="280" rows="4" placeholder="Add useful context"></textarea><small>Do not include passwords, email codes or other private information.</small></label></div>'+btn('Submit report','report-submit',id)+btn('Cancel','profile',id,true),'report');
}
async function submitReport(id){
 const category=$('#cReportCategory')?.value||'',detail=$('#cReportDetail')?.value||'';
 const out=await API.request('/api/community/report',{target:id,category,detail});
 APP.notify(out.duplicate?'You already reported this issue.':'Report submitted. Thank you.');
 await openProfile(id);
}
function editProfile(){const p=profile||session.profile;selectedAvatar=p.avatar;frame('Make it yours','<div class="profile-fields"><label>Username<input id="cUsername" value="'+esc(p.username)+'" maxlength="20" autocapitalize="none" autocomplete="off"><small>Unique, 3-20 characters. Changes are limited to once every 7 days.</small></label><label>Display name<input id="cDisplayName" value="'+esc(p.name)+'" maxlength="28" autocomplete="nickname"></label><label>Avatar<div class="avatar-choices">'+['cross','ring','board','rook','crown','star'].map(v=>'<button class="avatar-choice" data-c="avatar" data-id="'+v+'" aria-label="'+v+' avatar" aria-pressed="'+(selectedAvatar===v)+'">'+avatar(v)+'</button>').join('')+'</div></label><label>Who can see my stats<select id="cStatsPrivacy"><option value="public" '+(p.statsVisibility==='public'?'selected':'')+'>Everyone</option><option value="friends" '+(p.statsVisibility==='friends'?'selected':'')+'>Friends</option><option value="private" '+(p.statsVisibility==='private'?'selected':'')+'>Only me</option></select></label><label>Online status<select id="cPresencePrivacy"><option value="friends" '+(p.presenceVisibility==='friends'?'selected':'')+'>Visible to friends</option><option value="hidden" '+(p.presenceVisibility==='hidden'?'selected':'')+'>Hidden</option></select></label></div>'+btn('Save profile','saveprofile')+'<p>Your player tag never changes, even if your username does.</p>','edit');}
async function downloadMyData(){
 const data=await API.request('/api/account/export',{});
 const blob=new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'});
 const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='mega-xo-data-'+new Date().toISOString().slice(0,10)+'.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 APP.notify('Your Mega XOXO data export is ready.');
}
function deleteAccountForm(){
 const tag=session?.profile?.tag;if(!tag)return connections();
 frame('Delete account','<p>This permanently deletes your Mega XOXO profile and removes your sign-in methods, cloud practice save, friends and active profile data.</p><p>This cannot be undone. Purchases or security records that must be retained may remain only as non-profile records under the applicable policy.</p><div class="profile-fields"><label>Type your player tag to confirm<input id="cDeleteConfirmation" autocomplete="off" spellcheck="false" placeholder="'+esc(tag)+'"></label></div>'+btn('Permanently delete account','delete-account-confirm')+btn('Cancel','connections','',true),'delete-account');
}
async function deleteAccount(){
 if(APP.getContext().playing)return announce('Finish your current match before deleting your account.',true);
 const actor=session?.profile?.id,confirmation=$('#cDeleteConfirmation')?.value.trim()||'';
 if(!actor)return;
 const result=await API.request('/api/account/delete',{confirmation});
 drop('mega_v333_archive:'+actor);drop(META);drop(OWNER);API.reset();session=null;social={friends:[],incoming:[],outgoing:[],blocked:[]};invites=[];challenges=[];profile=null;conflict=null;dirty=false;syncRevision=0;syncState='device';updateNotificationButton();
 suppressSave=true;APP.applyPractice(get('mega_v333_archive:guest')||D.fresh());suppressSave=false;dismiss();APP.refresh();APP.render();APP.notify('Your Mega XOXO account has been deleted.');
 return result;
}
async function connections(){
 const available=p=>session?.providers?.[p]?.web||window.MegaNativeIdentity&&session?.providers?.[p]?.native;
 const linked=session.profile.providers,emailLinked=linked.includes('email');let active=[],deletion={available:false};
 try{[active,deletion]=await Promise.all([API.request('/api/account/sessions').then(x=>x.sessions||[]),API.request('/api/account/deletion')]);}catch{}
 const when=value=>{try{return new Date(value).toLocaleString();}catch{return 'Unknown';}};
 const sessions='<h3 class="identity-section">Active sessions</h3>'+(active.length?active.map(x=>'<div class="profile-card"><b>'+(x.current?'This device':'Signed-in device')+'</b><p>Signed in '+esc(when(x.created))+'<br><small>Expires '+esc(when(x.expires))+'</small></p>'+(x.current?'':'<button class="button full quiet" data-c="revoke-session" data-id="'+esc(x.id)+'">Sign out this device</button>')+'</div>').join(''):'<p class="caption">No other active sessions.</p>')+(active.some(x=>!x.current)?btn('Sign out all other devices','revoke-other-sessions','',true):'');
 const emailCard='<div class="profile-card"><b>Email & password</b><p>'+(emailLinked?(session.profile.emailVerified?'Verified':'Verification required')+(session.profile.email?' · '+esc(session.profile.email):''):'Not linked')+'</p>'+(emailLinked?
  '<button class="button full quiet" data-c="email-form" data-id="reauth">Re-authenticate with email</button><button class="button full quiet" data-c="email-form" data-id="change">Change email</button><button class="button full quiet" data-c="unlink" data-id="email" '+(linked.length<=1?'disabled':'')+'>Unlink</button>':
  '<button class="button full quiet" data-c="email-form" data-id="link">Link email & password</button>')+'</div>';
 frame('Keep your progress','<p>Restore this profile with any linked sign-in method. Your player tag, friends and rank stay the same.</p>'+emailCard+['google','apple'].filter(provider=>!window.MegaNativeApi||available(provider)).map(provider=>{
  const name=provider==='google'?'Google':'Apple',exists=linked.includes(provider);
  return '<div class="profile-card"><b>'+name+'</b><p>'+(exists?'Linked':'Not linked')+'</p>'+(exists?
   '<button class="button full quiet" data-c="signin" data-id="'+provider+'" data-intent="reauth" '+(available(provider)?'':'disabled')+'>Verify with '+name+'</button><button class="button full quiet" data-c="unlink" data-id="'+provider+'" '+(linked.length<=1?'disabled':'')+'>Unlink</button>':
   '<button class="button full quiet" data-c="signin" data-id="'+provider+'" data-intent="link" '+(available(provider)?'':'disabled')+'>Link '+name+'</button>')+'</div>';
 }).join('')+'<p>Verify again before changing linked accounts. At least one sign-in method must remain linked.</p>'+sessions+'<h3 class="identity-section">Privacy</h3>'+btn('Download my data','download-data','',true)+(deletion.available?btn('Delete account','delete-account-form','',true):'')+btn('Sign out on this device','signout','',true)+btn('Sign out everywhere','signout-all','',true),'connections');
}
function person(p){return '<button type="button" class="friend-person" data-c="profile" data-id="'+esc(p.id)+'">'+avatar(p.avatar,true)+'<span class="person-copy"><strong>'+esc(p.name)+'</strong><small>@'+esc(p.username)+'</small>'+state(p)+'</span>'+icon('arrow')+'</button>';}
function requestCard(p,kind){return '<div class="friend-request">'+person(p)+'<div class="request-actions">'+(kind==='incoming'?btn('Accept','social','accept:'+p.id)+btn('Decline','social','decline:'+p.id,true):btn('Cancel request','social','cancel:'+p.id,true))+'</div></div>';}
function friendsMarkup(){return '<div class="panel-head friends-head"><div class="eyebrow">Social</div><h2>Friends</h2><p>Find your people. Start a friendly rivalry.</p></div>'+(!session?.linked?'<button class="community-profile-cta" data-c="login">'+icon('shield')+'<span><strong>Create your profile</strong><small>Use email, Google or Apple to save progress and add friends.</small></span>'+icon('arrow')+'</button><div class="friend-empty"><b>Guest on this device</b><p>You can play offline without an account.</p></div>':
 '<button class="community-profile-cta" data-c="profile">'+avatar(session.profile.avatar,true)+'<span><strong>'+esc(session.profile.name)+'</strong><small>@'+esc(session.profile.username)+' - View / edit your profile</small></span>'+icon('arrow')+'</button><form class="community-search" id="cSearch"><input id="cQuery" aria-label="Search usernames or player tags" placeholder="Username or MEGA-tag" maxlength="64" value="'+esc(friendsQuery)+'"><button class="button quiet" type="submit">Search</button></form><div class="friend-code-card"><div><span>YOUR PLAYER TAG</span><div class="friend-code">'+esc(session.profile.tag)+'</div></div><button class="copy-friend" data-c="copy" data-id="'+esc(session.profile.tag)+'" aria-label="Copy tag">'+icon('copy')+'</button><button class="copy-friend" data-c="share" data-id="'+esc(session.profile.tag)+'" aria-label="Share profile">'+icon('link')+'</button></div>'+(friendsQuery?'<h3 class="identity-section">Search results</h3>'+ (searchRows.length?searchRows.map(person).join(''):'<p class="caption">No matching player found.</p>'):'')+
 '<div class="section-title friends-section-title"><span>Friends</span><small>'+social.friends.filter(p=>p.presence.online).length+' ONLINE</small></div>'+(social.friends.length?social.friends.map(person).join(''):'<div class="friend-empty"><div class="friend-empty-icon">'+icon('usersRound')+'</div><b>Your squad is empty</b><p>Add someone by username or share your player tag.</p></div>')+
 (social.incoming.length?'<h3 class="identity-section">Friend requests</h3>'+social.incoming.map(p=>requestCard(p,'incoming')).join(''):'')+(social.outgoing.length?'<h3 class="identity-section">Sent requests</h3>'+social.outgoing.map(p=>requestCard(p,'outgoing')).join(''):'')+
 (invites.length?'<h3 class="identity-section">Challenges</h3>'+invites.map(m=>'<div class="friend-request"><b>'+esc(m.challengerName)+'</b><p class="caption">'+(m.quote.rated?'Ranked challenge':'Free friendly game')+'</p>'+btn('Review invitation','review',m.id,true)+'</div>').join(''):'')+(social.blocked.length?'<details><summary>Blocked players</summary>'+social.blocked.map(p=>'<div class="ledger"><span>'+esc(p.username)+'</span><button class="button quiet" data-c="social" data-id="unblock:'+esc(p.id)+'">Unblock</button></div>').join('')+'</details>':''));}
function notificationPrefs(){return APP.getSave()?.settings||{};}
function directIncoming(){return invites.filter(m=>m.terms?.source==='direct');}
function directOutgoing(){if(!session?.linked)return [];return challenges.filter(m=>m.terms?.source==='direct'&&m.status==='OFFERED'&&m.players?.[0]===session.profile.id);}
function updateNotificationButton(){const el=$('#notificationButton');if(!el)return;const count=session?.linked?(social.incoming.length+directIncoming().length):0;el.innerHTML=icon('bell')+'<span class="notification-badge" id="notificationBadge" '+(count?'':'hidden')+'>'+Math.min(99,count)+'</span>';el.setAttribute('aria-label',count?'Notifications, '+count+' pending':'Notifications');I?.refresh?.();}
function rememberNotice(id){delivered.add(id);if(delivered.size>200)delivered=new Set([...delivered].slice(-160));put(NOTICE,[...delivered]);}
async function deviceAlert(group,title,body,id){if(delivered.has(id))return false;const p=notificationPrefs();if(!p.notifications||!p[group]||!document.hidden)return false;try{if(window.MegaNativeNotifications?.notify){await window.MegaNativeNotifications.notify({title,body,tag:id});rememberNotice(id);return true;}if('Notification' in window&&Notification.permission==='granted'){new Notification(title,{body,tag:id});rememberNotice(id);return true;}}catch{}return false;}
async function requestNotificationPermission(){try{if(window.MegaNativeNotifications?.requestPermission)return (await window.MegaNativeNotifications.requestPermission())===true;if(!('Notification' in window))return false;if(Notification.permission==='granted')return true;if(Notification.permission==='denied')return false;return (await Notification.requestPermission())==='granted';}catch{return false;}}
function alertPending(){for(const p of social.incoming)deviceAlert('notifySocial','Friend request from '+p.name,'Open Mega XOXO to review the request.','friend:'+p.id);for(const m of directIncoming()){const ranked=m.quote?.rated===true,name=m.challengerName||'A player';deviceAlert('notifyMatches',(ranked?'Ranked challenge':'Challenge')+' from '+name,ranked?'You pay 0 Crowns. Review the exact pot and Elo terms before accepting.':'Free unranked challenge.','challenge:'+m.id);}}
function rewardReminder(){const p=notificationPrefs(),now=new Date();if(!p.notifications||!p.notifyRewards||now.getHours()<19)return;const id='quest-reminder:'+now.toISOString().slice(0,10);if(delivered.has(id))return;const save=APP.getSave(),daily=D.getDaily(save),open=D.QUESTS.filter(q=>!q.online).some(q=>!(daily.claimed||[]).includes(q.id)&&Math.min(q.target,daily[q.metric]||0)<q.target);if(open)deviceAlert('notifyRewards','Daily quests are still open','Finish any remaining quests before the 00:00 UTC reset.',id);}
function expiresLabel(m){const ms=Math.max(0,(m.expires||0)-Date.now()),mins=Math.ceil(ms/60000);return mins<=1?'Expires soon':'Expires in '+mins+' min';}
function notificationCenter(){if(!session?.linked){APP.open('Notifications','<div class="notification-empty">'+icon('bell')+'<h3>No linked profile</h3><p>Sign in to receive friend requests and direct challenges across devices.</p>'+btn('Save your profile','login')+'</div>','notifications');return;}
 const incoming=directIncoming(),outgoing=directOutgoing(),parts=[];
 if(incoming.length)parts.push('<div class="notification-group"><h3>Challenges</h3>'+incoming.map(m=>'<div class="notification-item"><span class="notification-symbol">'+icon('swords')+'</span><div><b>'+esc(m.challengerName||'Player')+'</b><small>'+(m.quote.rated?'Ranked · '+m.quote.pool+' Crowns · you pay 0':'Unranked · free')+'</small><small>'+expiresLabel(m)+'</small></div><button class="button quiet" data-c="review" data-id="'+esc(m.id)+'">Review</button></div>').join('')+'</div>');
 if(social.incoming.length)parts.push('<div class="notification-group"><h3>Social</h3>'+social.incoming.map(p=>'<div class="notification-item"><span class="notification-symbol">'+icon('userPlus')+'</span><div><b>'+esc(p.name)+'</b><small>@'+esc(p.username)+' · friend request</small></div><button class="button quiet" data-c="open-friends">Open</button></div>').join('')+'</div>');
 if(outgoing.length)parts.push('<div class="notification-group"><h3>Sent challenges</h3>'+outgoing.map(m=>{const other=m.players?.[1],name=m.playerNames?.[other]||'Opponent';return '<div class="notification-item sent"><span class="notification-symbol">'+icon('clock')+'</span><div><b>'+esc(name)+'</b><small>'+(m.quote.rated?'Ranked · '+m.quote.pool+' Crowns':'Unranked · free')+'</small><small>'+expiresLabel(m)+'</small></div><button class="button quiet" data-c="cancel-challenge" data-id="'+esc(m.id)+'">Cancel</button></div>';}).join('')+'</div>');
 APP.open('Notifications','<div class="notification-center">'+(parts.length?parts.join(''):'<div class="notification-empty">'+icon('bell')+'<h3>All caught up</h3><p>New friend requests and direct challenges will appear here.</p></div>')+'<button class="notification-preferences-link" data-c="notification-settings">'+icon('settings')+'<span><b>Notification preferences</b><small>Device alerts are off until you enable them.</small></span>'+icon('arrow')+'</button></div>','notifications');I?.refresh?.();}
async function refreshFriends(render=true){if(!session?.linked||refreshing){updateNotificationButton();return;}refreshing=true;try{[social,invites,challenges]=await Promise.all([API.request('/api/community/friends'),NET.invitations(),API.request('/api/community/challenges')]);invites=invites.filter(m=>m.terms.source!=='queue');updateNotificationButton();alertPending();rewardReminder();if(render&&APP.getContext().page==='friends'&&!$('#cQuery')?.matches(':focus'))APP.render();if(render&&APP.getContext().sheetKind==='notifications')notificationCenter();}catch(e){if(e.message==='AUTH_REQUIRED'){API.reset();session=null;social={friends:[],incoming:[],outgoing:[],blocked:[]};invites=[];challenges=[];updateNotificationButton();}else if(render)lastError=error(e);}finally{refreshing=false;}}
async function socialAction(value){const pos=value.indexOf(':'),action=value.slice(0,pos),target=value.slice(pos+1);if(['remove','block'].includes(action)&&!confirm(action==='block'?'Block this player and remove the friendship?':'Remove this friend?'))return;await API.request('/api/community/friend',{action,target});await APP.refresh();await refreshFriends();if(APP.getContext().sheetKind==='notifications')notificationCenter();if(profile&&profile.id===target){if(['remove','block','unblock'].includes(action))dismiss();else await openProfile(target);}}
function decorate(){let changed=false;const sheet=$('#sheet');if(sheet&&!sheet.hidden&&['queue','waiting'].includes(sheet.dataset.kind)&&!$('.theme-loader',sheet)){const host=$('#sheetBody');host.insertAdjacentHTML('afterbegin',loader()+'<div class="theme-loader-label">'+(sheet.dataset.kind==='queue'?'FINDING YOUR MATCH':'WAITING FOR ACCEPTANCE')+'</div><div class="queue-time" data-queue-time role="timer">0:00</div>');queuedAt=performance.now();changed=true;}
 if(sheet&&!sheet.hidden&&sheet.dataset.kind==='settings'&&!$('.community-profile-cta',sheet)){const groups=sheet.querySelectorAll('.setting-group');const group=[...groups].find(g=>g.querySelector('h4')?.textContent==='PROFILE');if(group){group.insertAdjacentHTML('afterbegin','<button class="community-profile-cta" data-c="'+(session?.linked?'profile':'login')+'">'+icon('usersRound')+'<span><strong>'+(session?.linked?'Your profile':'Save your progress')+'</strong><small>'+(session?.linked?esc(session.profile.username):'Email, Google or Apple')+'</small></span>'+icon('arrow')+'</button>');changed=true;}}
 const party=$('#partyScreen');if(party?.dataset.view==='room'){
  const roster=$('.party-roster',party);if(roster&&!$('.lobby-wait',party)){const joined=roster.querySelectorAll('.ledger').length,ready=[...roster.querySelectorAll('.ledger b')].filter(x=>x.textContent==='Ready').length;roster.insertAdjacentHTML('afterend','<div class="lobby-wait">'+loader(true)+'<div><b>Waiting in the lobby</b><small>'+joined+' joined - '+ready+' ready</small><small>The game starts when everyone is ready.</small></div></div>');changed=true;}
 }
 /* The home page owns its three cards (app.js). Keep the Save-your-progress card in step with the
  * session without re-rendering the page or appending a second CTA. */
 const homeAccount=$('#page .home-account');
 if(homeAccount){const linked=session?.linked===true,name=linked?(session.profile?.name||session.profile?.username||'Your profile'):'',action=linked?'profile':'login',label=linked?'View profile':'Sign in';
  const nameNode=$('.home-account-name',homeAccount),entry=$('[data-c]',homeAccount);
  if(nameNode){if(nameNode.textContent!==name)nameNode.textContent=name;if(nameNode.hidden!==!linked)nameNode.hidden=!linked;}
  if(entry){if(entry.dataset.c!==action)entry.dataset.c=action;if(entry.textContent!==label)entry.textContent=label;}}
 if(changed)I?.refresh?.();}
function resumePrompt(id){frame('Your match is still running','<p>Reconnect to continue. Online clocks do not pause when you leave the app.</p>'+btn('Reconnect to match','resume-online',id),'resume',true);}
async function presence(){if(!session?.linked)return;try{await API.request('/api/community/presence',{foreground:!document.hidden});lastPresence=Date.now();}catch{} }
const actions={
 dismiss,guest:becomeGuest,login:()=>landing(),profile:id=>openProfile(id),edit:editProfile,connections,notifications:notificationCenter,
 'email-form':action=>emailForm(action),'email-submit':emailAuth,'email-otp':verifyEmailOtp,'email-forgot':()=>forgotForm($('#cEmailAddress')?.value||''),'email-forgot-submit':forgotPassword,'email-reset':resetPassword,'email-back':()=>{emailChallenge=null;session?.linked?connections():landing();},
 'decision-link':()=>decisionProof('link'),'decision-new':()=>decisionProof('new'),
 'decision-proof':mode=>decisionVerify(mode),'decision-new-confirm':()=>decisionApply('new',decision?.proof||null),
 'decision-back':()=>decisionChoice(),'decision-dismiss':()=>{decision=null;dismiss();landing();},
 signin:(id,el)=>signIn(id,el.dataset.intent||'login'),'signin-retry':()=>{bootError='';announce('Checking sign-in availability...');API.session(true).then(s=>{session=s;if(panel&&panel.dataset.kind==='signin'){const el=$('.signin-options',panel);if(el)el.outerHTML=providerButtons();announce('');}else{dismiss();boot();}}).catch(e=>{bootError=/^[A-Z0-9_]{3,}$/.test(e&&e.message||'')?e.message:'';announce('Sign-in check failed'+(bootError?' ('+bootError+')':'')+'. Guest play is available.');if(panel&&panel.dataset.kind==='signin'){const el=$('.signin-options',panel);if(el)el.outerHTML=providerButtons();}});},
 statsmode:id=>{profileMode=id;showProfile();},avatar:id=>{selectedAvatar=id;document.querySelectorAll('.avatar-choice').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.id===id)));},
 saveprofile:async()=>{const p=await API.request('/api/account/profile',{username:$('#cUsername').value,displayName:$('#cDisplayName').value,avatar:selectedAvatar,statsVisibility:$('#cStatsPrivacy').value,presenceVisibility:$('#cPresencePrivacy').value});session.profile=p;profile=p;APP.refresh();await refreshFriends();showProfile();},
 copy:async tag=>{try{await navigator.clipboard.writeText(tag);APP.notify('Player tag copied.');}catch{APP.notify(tag);}},
 share:async tag=>{const url=location.origin+location.pathname+'#player='+encodeURIComponent(tag);try{if(navigator.share)await navigator.share({title:'Mega XOXO player',text:tag,url});else{await navigator.clipboard.writeText(url);APP.notify('Profile link copied.');}}catch(e){if(e.name!=='AbortError')APP.notify(tag);}},
 social:socialAction,'report-player':reportPlayerForm,'report-submit':submitReport,challenge:async id=>{dismiss();await APP.challenge(id);},review:async id=>{APP.close();await APP.reviewInvite(id);},'open-friends':async()=>{APP.close();APP.goFriends();await refreshFriends();},'cancel-challenge':async id=>{await NET.cancel(id,API.id());await refreshFriends(false);notificationCenter();},'notification-settings':()=>{APP.close();APP.openSettings();},
 unlink:async provider=>{if(!confirm('Remove this sign-in method?'))return;await API.request('/api/account/unlink',{provider});session=await API.session(true);connections();},
 'revoke-session':async id=>{if(!confirm('Sign out this device?'))return;await API.request('/api/account/sessions/revoke',{id});await connections();APP.notify('Device signed out.');},
 'revoke-other-sessions':async()=>{if(!confirm('Sign out all other devices?'))return;const out=await API.request('/api/account/sessions/revoke',{allOthers:true});await connections();APP.notify(out.revoked+' other device'+(out.revoked===1?' was':'s were')+' signed out.');},
 'download-data':downloadMyData,'delete-account-form':deleteAccountForm,'delete-account-confirm':deleteAccount,
 signout:async()=>signOut(false),'signout-all':async()=>signOut(true),
 sync:async()=>{if(syncState==='conflict'&&conflict?.remote)return chooseSave(conflict.remote);dirty=true;await saveNow();announce(syncState==='saved'?'Progress saved.':syncState==='conflict'?'A newer cloud save needs your choice.':'Will retry when connected.',syncState!=='saved');},
 'restore-choice':async()=>{await adoptCloud(conflict.remote);conflict=null;},'device-choice':useDevice,
 'resume-online':async id=>{dismiss();await APP.resumeOnline(id);},'resume-offline':()=>{dismiss();APP.resumeOffline();}
};
async function signOut(all){if(APP.getContext().playing)return announce('Finish your current match before signing out.',true);if(!confirm('Sign out'+(all?' on all devices':'')+'? Your account progress remains saved.'))return;await saveNow();if(syncState==='conflict'||dirty)return announce('Resolve your cloud save before signing out.',true);archiveCurrent();await API.logout(all);API.reset();session=null;social={friends:[],incoming:[],outgoing:[],blocked:[]};invites=[];challenges=[];updateNotificationButton();put(OWNER,null);suppressSave=true;APP.applyPractice(get('mega_v333_archive:guest')||D.fresh());suppressSave=false;syncState='device';APP.refresh();APP.render();landing();}
document.addEventListener('click',async e=>{const el=e.target.closest('[data-c]');if(!el||el.disabled)return;const fn=actions[el.dataset.c];if(!fn)return;e.preventDefault();e.stopImmediatePropagation();el.disabled=true;try{await fn(el.dataset.id||'',el);}catch(err){announce(error(err),true);}finally{if(el.isConnected)el.disabled=false;}},true);
document.addEventListener('keydown',e=>{if(!panel)return;if(e.key==='Escape'&&$('[data-c="dismiss"]',panel)){e.preventDefault();dismiss();return;}if(e.key==='Tab'){const nodes=[...panel.querySelectorAll('button:not([disabled]),input,select,[tabindex="0"]')].filter(n=>n.getClientRects().length);if(nodes.length){const i=nodes.indexOf(document.activeElement);if(e.shiftKey&&(i<=0)){e.preventDefault();nodes.at(-1).focus();}else if(!e.shiftKey&&(i===nodes.length-1||i<0)){e.preventDefault();nodes[0].focus();}}}},true);
document.addEventListener('submit',async e=>{if(e.target.id!=='cSearch')return;e.preventDefault();friendsQuery=$('#cQuery').value.trim();try{searchRows=friendsQuery?await API.request('/api/community/search?q='+encodeURIComponent(friendsQuery)):[];APP.render();}catch(err){APP.notify(error(err));}});
window.addEventListener('mega:local-save',()=>{
 if(suppressSave)return;archiveCurrent();const owner=get(OWNER);if(!owner)return;
 const meta=get(META),active=session?.linked&&session.profile.id===owner;
 dirty=true;put(META,{actor:owner,revision:active?syncRevision:(meta?.actor===owner?meta.revision:0),dirty:true});
 if(!active){syncState='offline';return;}
 clearTimeout(syncTimer);syncTimer=setTimeout(saveNow,3000);
});
/* Bounded restore backoff (infrastructure brief 2026-10-19, part F): a signed-out client with a
 * durable owner used to retry the session restore every 15s forever - the "thousands of refresh
 * tokens from a handful of session families" finding. Attempts now back off exponentially to a
 * 5-minute ceiling, never run in a hidden document, and reset on a successful relink. */
let reconnectAttempts=0,lastReconnectAt=0;
/* Device-diagnostic (2026-10-19): the last boot failure's honest error code, surfaced on the
 * sign-in screen so a device report names the actual failure instead of a silent capability
 * loss. Never contains player data - only the frozen error vocabulary. */
let bootError='';
async function reconnectSync(){
 if(reconnecting||session?.linked||document.hidden||!get(OWNER)||APP.getContext().playing||panel)return;
 const waitMs=Math.min(15000*2**reconnectAttempts,300000);
 if(reconnectAttempts>0&&Date.now()-lastReconnectAt<waitMs)return;
 reconnecting=true;lastReconnectAt=Date.now();
 try{const linked=await API.session(true);if(!linked.linked||linked.profile.id!==get(OWNER)){reconnectAttempts++;return;}reconnectAttempts=0;await syncBoot(bootVersion);await presence();await refreshFriends();}catch{syncState='offline';reconnectAttempts++;}finally{reconnecting=false;}
}
window.addEventListener('online',()=>{if(session?.linked){if(dirty)saveNow();presence();refreshFriends();}else reconnectSync();});
window.addEventListener('mega:sheet',decorate);
const observer=new MutationObserver(()=>{if(!panel)decorate();});observer.observe($('#app'),{childList:true,subtree:true});
document.addEventListener('mega:party-transport',e=>{const party=$('#partyScreen');if(!party)return;party.setAttribute('aria-busy',String(e.detail.pending));});
document.addEventListener('visibilitychange',()=>{presence();if(!document.hidden){refreshFriends();if(dirty)saveNow();}});
window.addEventListener('pagehide',()=>{if(!session?.linked)return;fetch('/api/community/presence',{method:'POST',credentials:'same-origin',keepalive:true,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify({foreground:false})}).catch(()=>{});});
/* Background-tab gating (part F): a hidden document makes zero community requests - the
 * visibilitychange handler re-syncs immediately on return, and the pagehide handler has already
 * sent the single foreground:false presence beat. Active gameplay clocks are unaffected. */
setInterval(()=>{if(document.hidden)return;presence();refreshFriends();if(dirty)saveNow();if(!session?.linked)reconnectSync();},15000);
setInterval(()=>{const q=$('[data-queue-time]');if(q)q.textContent=fmtTime((performance.now()-queuedAt)/1000);},1000);
window.MegaCommunity=Object.freeze({friendsMarkup,openProfile,login:landing,loader,refresh:refreshFriends,requestNotificationPermission,notificationPreferencesChanged:()=>{updateNotificationButton();rewardReminder();},challengeAccepted:(id,name='Opponent')=>deviceAlert('notifyMatches','Challenge accepted',name+' accepted your challenge. Your match is starting now.','challenge-start:'+id),getStatus:()=>({linked:!!session?.linked,profileName:session?.linked?(session.profile?.name||session.profile?.username||'Your profile'):'',syncState,revision:syncRevision,pendingNotifications:(session?.linked?social.incoming.length+directIncoming().length:0)})});
APP.render();updateNotificationButton();
/* SAGAN-003: the website account card deep-links here (/game?security=1) so the
 * Linked accounts and recovery button opens the real panel instead of dropping
 * the player on the bot workspace. */
const securityDeepLink=(typeof location!=='undefined')&&new URLSearchParams(location.search||'').get('security')==='1';
const booted=boot();if(securityDeepLink)booted.then(()=>{if(session?.linked)connections();}).catch(()=>{});
})();
