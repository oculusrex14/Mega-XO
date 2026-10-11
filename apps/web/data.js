// Same-origin read model. Browsing never creates an anonymous account session.
export const authRequired = error => ['AUTH_REQUIRED', 'LINK_ACCOUNT_REQUIRED'].includes(error?.message);
export const errorCopy = error => ({
 WEB_API_NOT_CONFIGURED: 'Account and online services are not connected in this preview. Local play is ready.',
 AUTH_REQUIRED: 'Sign in to play online.', LINK_ACCOUNT_REQUIRED: 'Sign in to play online.',
 EMAIL_DELIVERY_NOT_CONFIGURED: 'Email delivery is not available yet.',
 PROVIDER_NOT_CONFIGURED: 'This sign-in provider is not available yet.',
 INVALID_OTP: 'Check your verification code and try again.', OTP_EXPIRED: 'This code has expired. Request a new code.',
 INVALID_EMAIL: 'Enter a valid email address.', OTP_COOLDOWN: 'Please wait before requesting another code.',
 OTP_LOCKED: 'Too many code attempts. Request a new code after the waiting period.',
 INVALID_PASSWORD: 'Use at least ten characters, including a letter and a number.',
 INVALID_CREDENTIALS: 'Check your email and password and try again.',
 REQUEST_TIMEOUT: 'The service did not respond in time. Try again.',
 RATE_LIMITED: 'Please wait a moment before trying again.',
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
 let profileRevision=0, leaderboardRevision=0, destroyed=false, leaderboardAbort;
 async function profile() {
  const revision=++profileRevision;
  context.sessionStatus='loading';changed();
  try {
   const result=await request('/api/v1/profile');
   if(destroyed||revision!==profileRevision)return;
   if(!result || typeof result.id!=='string')throw Error('SERVICE_UNAVAILABLE');
   context.profile=result;context.sessionStatus='linked';
  } catch(error) {
   if(destroyed||revision!==profileRevision)return;
   context.profile=null;context.sessionStatus=authRequired(error)||error.message==='WEB_API_NOT_CONFIGURED'?'guest':'error';
   context.accountMessage=errorCopy(error);
  }
  if(!destroyed)changed();
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
 function invalidate(){profileRevision++;leaderboardRevision++;leaderboardAbort?.abort();}
 function destroy(){destroyed=true;invalidate();}
 return {profile,leaderboard,invalidate,destroy};
}
