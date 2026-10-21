// Same-origin read model. Browsing never creates an anonymous account session.
export const authRequired = error => ['AUTH_REQUIRED', 'LINK_ACCOUNT_REQUIRED', 'SESSION_REVOKED', 'REVOKED'].includes(error?.message);
export const errorCopy = error => ({
 WEB_API_NOT_CONFIGURED: 'Account and online services are not connected in this preview. Local play is ready.',
 AUTH_REQUIRED: 'Sign in to play online.', LINK_ACCOUNT_REQUIRED: 'Sign in to play online.',
 SESSION_REVOKED: 'Your session has expired. Sign in again to continue.', REVOKED: 'Your session has expired. Sign in again to continue.',
 EMAIL_DELIVERY_NOT_CONFIGURED: 'Email delivery is not available yet.',
 PROVIDER_NOT_CONFIGURED: 'This sign-in provider is not available yet.',
 INVALID_OTP: 'Check your verification code and try again.', OTP_EXPIRED: 'This code has expired. Request a new code.',
 INVALID_EMAIL: 'Enter a valid email address.', OTP_COOLDOWN: 'Please wait before requesting another code.',
 OTP_LOCKED: 'Too many code attempts. Request a new code after the waiting period.',
 INVALID_PASSWORD: 'Use at least ten characters, including a letter and a number.',
 INVALID_CREDENTIALS: 'Check your email and password and try again.',
 INVALID_USERNAME: 'Use 3–20 letters, numbers or underscores, starting with a letter. Some names are reserved.',
 USERNAME_TAKEN: 'That username is already in use. Choose another.',
 USERNAME_COOLDOWN: 'Your username can change once every 7 days. This update was not saved; remove the username change to save your other edits.',
 INVALID_DISPLAY_NAME: 'Choose a display name of up to 28 characters using supported text.',
 INVALID_PRIVACY: 'Choose one of the available visibility options.',
 PROFILE_NOT_FOUND: 'This profile is no longer available. Sign in again to continue.',
 REQUEST_TIMEOUT: 'The service did not respond in time. Try again.',
 RATE_LIMITED: 'Please wait a moment before trying again.',
 REQUEST_PENDING: 'You already have a checkout in progress. Finish that payment, or wait two minutes and try again.',
 STORE_UNAVAILABLE: 'The store could not be reached just now. Check your connection and try again.',
})[error?.message] || 'The service is unavailable right now. Please try again.';

export async function readJSON(path, {fetcher = globalThis.fetch, signal} = {}) {
 const controller = new AbortController();
 const abort = () => controller.abort();
 signal?.addEventListener('abort', abort, {once:true});
 if(signal?.aborted)controller.abort();
 const timer = setTimeout(abort, 8000);
 try {
  const response = await fetcher(path, {credentials:'same-origin', signal:controller.signal, headers:{Accept:'application/json'}});
  const out = await response.json();
  if(!response.ok)throw Error(typeof out?.error === 'string' ? out.error : 'SERVICE_UNAVAILABLE');
  return out;
 } catch(error) {
  if(error.name === 'AbortError')throw Error(signal?.aborted ? 'CANCELLED' : 'REQUEST_TIMEOUT');
  throw Error(/^[A-Z_]+$/.test(error.message) ? error.message : 'SERVICE_UNAVAILABLE');
 } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

export function createReadModel({context, changed, request = readJSON}) {
 let profileRevision=0, leaderboardRevision=0, destroyed=false, leaderboardAbort, cancelProfile;
 async function profile() {
  if(destroyed)return;
  const revision=++profileRevision;
  cancelProfile?.();
  const controller=new AbortController();
  let cancel,timer;
  // An abort signal alone cannot settle a stalled transport or body reader.
  // This deadline also bounds an injected shared client that ignores signals.
  const deadline=new Promise((_resolve,reject)=>{
   cancel=()=>{clearTimeout(timer);reject(Error('CANCELLED'));controller.abort();};
   timer=setTimeout(()=>{reject(Error('REQUEST_TIMEOUT'));controller.abort();},8000);
  });
  cancelProfile=cancel;
  context.accountMessage='';
  context.sessionStatus='loading';changed();
  try {
   const result=await Promise.race([request('/api/v1/profile',{signal:controller.signal}),deadline]);
   if(destroyed||revision!==profileRevision)return;
   if(!result || typeof result.id!=='string')throw Error('SERVICE_UNAVAILABLE');
   context.profile=result;context.sessionStatus='linked';
  } catch(error) {
   if(destroyed||revision!==profileRevision)return;
   context.profile=null;context.sessionStatus=authRequired(error)||error.message==='WEB_API_NOT_CONFIGURED'?'guest':'error';
   context.accountMessage=errorCopy(error);
  } finally {
   clearTimeout(timer);
   if(cancelProfile===cancel)cancelProfile=null;
  }
  if(!destroyed&&revision===profileRevision)changed();
 }
 async function leaderboard(filters={}) {
  const old=context.leaderboard||{};
  const metric=['rating','wealth'].includes(filters.metric)?filters.metric:old.metric||'rating';
  const scope=['global','region','local'].includes(filters.scope)?filters.scope:old.scope||'global';
  const league=/^(all|wood|stone|iron|bronze|silver|gold|diamond|emerald|champion|master|grandmaster)$/.test(filters.league||'')?filters.league:old.league||'all';
  const revision=++leaderboardRevision;
  leaderboardAbort?.abort();leaderboardAbort=new AbortController();
  context.leaderboard={status:'loading',rows:[],metric,scope,league};changed();
  const query=new URLSearchParams({metric,scope:scope==='region'?'local':scope,league});
  if(scope!=='global'&&/^[A-Z]{2}$/.test(context.profile?.region||''))query.set('region',context.profile.region);
  try {
   const out=await request('/api/v1/leaderboard?'+query,{signal:leaderboardAbort.signal});
   if(destroyed||revision!==leaderboardRevision)return;
   const rows=Array.isArray(out)?out:out?.rows||out?.data;
   if(!Array.isArray(rows))throw Error('SERVICE_UNAVAILABLE');
   context.leaderboard={status:'ready',rows,metric,scope,league,updatedAt:Date.now()};
  } catch(error) {
   if(destroyed||revision!==leaderboardRevision)return;
   context.leaderboard={status:'error',rows:[],metric,scope,league,error:authRequired(error)?'AUTH_REQUIRED':errorCopy(error)};
  }
  if(!destroyed)changed();
 }
 function invalidate(){profileRevision++;leaderboardRevision++;cancelProfile?.();cancelProfile=null;leaderboardAbort?.abort();}
 function destroy(){destroyed=true;invalidate();}
 return {profile,leaderboard,invalidate,destroy};
}

const PROFILE_STATS_VISIBILITY = ['public', 'friends', 'private'];
const PROFILE_PRESENCE_VISIBILITY = ['friends', 'hidden'];

function profileDraft(profile) {
 const displayName = profile?.displayName ?? profile?.name;
 if (!profile || typeof profile.id !== 'string' || typeof profile.username !== 'string' || !profile.username.trim() || typeof displayName !== 'string' || !displayName.trim() ||
     !PROFILE_STATS_VISIBILITY.includes(profile.statsVisibility) || !PROFILE_PRESENCE_VISIBILITY.includes(profile.presenceVisibility)) {
  throw Error('SERVICE_UNAVAILABLE');
 }
 return {
  username: profile.username,
  displayName,
  statsVisibility: profile.statsVisibility,
  presenceVisibility: profile.presenceVisibility,
 };
}

function profilePayload(draft) {
 return {
  username: String(draft?.username ?? '').trim().toLowerCase(),
  displayName: String(draft?.displayName ?? '').trim(),
  statsVisibility: draft?.statsVisibility,
  presenceVisibility: draft?.presenceVisibility,
 };
}

/**
 * Protected self-profile editor. The caller supplies MegaAccount.request so POSTs
 * keep the shared cookie/CSRF/idempotency behavior instead of using raw fetch.
 * Drafts are memory-only and every response is fenced by actor, page and revision.
 */
export function createProfileEditor({context, changed = () => {}, request = readJSON, active = () => true, onAuthRequired = () => {}}) {
 let revision = 0, saveRevision = 0, activeActor = null, visible = false, suspended = false, destroyed = false;
 const idle = () => ({status:'idle', actorId:null, profile:null, draft:null, message:'', errorCode:''});
 context.profileEditor = idle();

 function isCurrent(actor, token) {
  return !destroyed && visible && activeActor === actor && revision === token &&
   context.sessionStatus === 'linked' && context.profile?.id === actor && active(actor);
 }

 function deactivate() {
  if (!visible && context.profileEditor?.status === 'idle') return;
  revision++; saveRevision++; activeActor = null; visible = false; suspended = false;
  context.profileEditor = idle();
 }

 function suspend() {
  if (destroyed || !visible) return false;
  if (suspended) return true;
  suspended = true; revision++; saveRevision++;
  const state = context.profileEditor || idle();
  context.profileEditor = {...state, status:'refreshing', message:'Confirming your account before profile changes can continue…', errorCode:''};
  changed();
  return true;
 }

 function resume(actor) {
  if (destroyed || !suspended || context.sessionStatus !== 'linked' || typeof actor !== 'string' || context.profile?.id !== actor) return false;
  if (activeActor !== actor) { deactivate(); return load(); }
  const state = context.profileEditor;
  suspended = false;
  return load({force:true, preserveDraft:Boolean(state?.profile && state?.draft)});
 }

 async function load({force = false, preserveDraft = false} = {}) {
  const actor = context.sessionStatus === 'linked' ? context.profile?.id : null;
  if (destroyed || typeof actor !== 'string' || !actor || !active(actor)) { deactivate(); return false; }
  const currentState = context.profileEditor;
  if (!force && visible && activeActor === actor && currentState?.status !== 'idle') return false;

  const retainedProfile = preserveDraft && currentState?.actorId === actor && currentState?.profile ? currentState.profile : null;
  const retainedDraft = retainedProfile && currentState?.draft ? currentState.draft : null;
  visible = true; activeActor = actor;
  suspended = false;
  const token = ++revision;
  saveRevision++;
  context.profileEditor = retainedDraft
   ? {status:'refreshing', actorId:actor, profile:retainedProfile, draft:retainedDraft, message:'Confirming your account before profile changes can continue…', errorCode:''}
   : {status:'loading', actorId:actor, profile:null, draft:null, message:'', errorCode:''};
  changed();
  try {
   const result = await request('/api/account/profile');
   if (!isCurrent(actor, token)) return false;
   if (!result || result.id !== actor) throw Error(result?.id ? 'ACTOR_CHANGED' : 'SERVICE_UNAVAILABLE');
   const draft = profileDraft(result);
   context.profileEditor = {status:'ready', actorId:actor, profile:result, draft:retainedDraft || draft, message:'', errorCode:''};
  } catch (error) {
   if (!isCurrent(actor, token)) return false;
   if (authRequired(error)) {
    onAuthRequired(error, {actor, operation:retainedDraft ? 'refresh' : 'load'});
    if (!isCurrent(actor, token)) return false;
   }
   context.profileEditor = {
    status:retainedDraft ? 'refresh-error' : 'error', actorId:actor, profile:retainedProfile, draft:retainedDraft,
    message:errorCopy(error), errorCode:error?.message || 'SERVICE_UNAVAILABLE',
   };
  }
  if (isCurrent(actor, token)) changed();
  return context.profileEditor.status === 'ready';
 }

 function updateDraft(draft) {
  const state = context.profileEditor;
  if (!visible || suspended || !state?.profile || state.actorId !== activeActor || ['saving','refreshing','refresh-error'].includes(state.status) ||
      context.sessionStatus !== 'linked' || context.profile?.id !== activeActor || !active(activeActor)) return false;
  context.profileEditor = {
   ...state,
   status:'ready',
   draft:{
    username:String(draft?.username ?? ''),
    displayName:String(draft?.displayName ?? ''),
    statsVisibility:String(draft?.statsVisibility ?? ''),
    presenceVisibility:String(draft?.presenceVisibility ?? ''),
   },
   message:'', errorCode:'',
  };
  return true;
 }

 function resetDraft() {
  const state = context.profileEditor;
  if (!state?.profile || suspended || state.actorId !== activeActor || ['saving','refreshing','refresh-error'].includes(state.status)) return false;
  context.profileEditor = {...state, status:'ready', draft:profileDraft(state.profile), message:'', errorCode:''};
  changed();
  return true;
 }

 async function save(draft = context.profileEditor?.draft) {
  let state = context.profileEditor;
  if (!visible || suspended || !state?.profile || state.actorId !== activeActor || ['saving','refreshing','refresh-error'].includes(state.status) ||
      context.sessionStatus !== 'linked' || context.profile?.id !== activeActor || !active(activeActor)) return false;
  if (draft) updateDraft(draft);
  state = context.profileEditor;
  const actor = activeActor, token = revision, operation = ++saveRevision;
  const submittedDraft = {...state.draft};
  const body = profilePayload(submittedDraft);
  context.profileEditor = {...state, status:'saving', message:'Saving your profile…', errorCode:''};
  changed();
  try {
   const updated = await request('/api/account/profile', body);
   if (!isCurrent(actor, token) || operation !== saveRevision) return false;
   if (!updated || updated.id !== actor) throw Error(updated?.id ? 'ACTOR_CHANGED' : 'SERVICE_UNAVAILABLE');
   const savedDraft = profileDraft(updated);
   context.profile = {
    ...context.profile,
    username:updated.username,
    displayName:updated.displayName ?? updated.name,
    name:updated.name ?? updated.displayName,
    avatar:updated.avatar ?? context.profile.avatar,
    statsVisibility:updated.statsVisibility,
    presenceVisibility:updated.presenceVisibility,
   };
   context.profileEditor = {status:'saved', actorId:actor, profile:updated, draft:savedDraft, message:'Your profile changes are saved.', errorCode:''};
  } catch (error) {
   if (!isCurrent(actor, token) || operation !== saveRevision) return false;
   if (authRequired(error)) {
    onAuthRequired(error, {actor, operation:'save'});
    if (!isCurrent(actor, token) || operation !== saveRevision) return false;
   }
   context.profileEditor = {
    ...context.profileEditor,
    status:'error', actorId:actor, draft:submittedDraft,
    message:errorCopy(error), errorCode:error?.message || 'SERVICE_UNAVAILABLE',
   };
  }
  if (isCurrent(actor, token) && operation === saveRevision) changed();
  return context.profileEditor.status === 'saved';
 }

 function destroy() { destroyed = true; deactivate(); }
 return {
  load, reload:() => load({force:true}), refresh:() => load({force:true,preserveDraft:true}),
  updateDraft, resetDraft, save, suspend, resume,
  isSuspended:() => suspended, actorId:() => activeActor,
  deactivate, destroy,
 };
}
