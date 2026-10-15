// Protected, memory-only social state. The shared client owns cookie/CSRF and
// idempotent transport retries; this controller never creates an account.
const LISTS = ['friends', 'incoming', 'outgoing', 'blocked'];
const ACTIONS = ['request', 'accept', 'decline', 'cancel', 'remove', 'block', 'unblock'];
const RELATIONS = ['none', 'friend', 'incoming', 'outgoing'];
const AVATARS = ['cross', 'ring', 'board', 'rook', 'crown', 'star'];
const TIERS = ['wood', 'stone', 'iron', 'bronze', 'silver', 'gold', 'diamond', 'emerald', 'champion', 'master', 'grandmaster'];
const ONLINE = ['online', 'in-match', 'queued', 'in-lobby'];
const PRESENCE = [...ONLINE, 'hidden', 'offline', 'away'];
export const FRIENDS_PAGE_SIZE = 10;
const isAuth = error => ['AUTH_REQUIRED', 'LINK_ACCOUNT_REQUIRED'].includes(error?.message);
const codeOf = error => /^[A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'SERVICE_UNAVAILABLE';
const copy = error => ({
 AUTH_REQUIRED:'Sign in again to view your Friends lists.',
 LINK_ACCOUNT_REQUIRED:'Sign in to view your Friends lists.',
 WEB_API_NOT_CONFIGURED:'Friends are not connected in this preview. Try again when account services are available.',
 SEARCH_TOO_SHORT:'Enter at least 3 username characters or an exact player tag.',
 INVALID_SEARCH:'Use a username or player tag of up to 64 characters.',
 REQUEST_TIMEOUT:'The service did not respond in time. Try again.',
 OFFLINE:'You are offline. Reconnect and try again.',
 RATE_LIMITED:'Please wait a moment before trying again.',
 FRIEND_LIMIT:'A friend or request limit was reached. Reload your Friends lists before trying again.',
 NO_FRIEND_REQUEST:'This friend request is no longer available. Reload your Friends lists.',
 PROFILE_NOT_FOUND:'This player is no longer available. Reload your Friends lists.',
 ACCOUNT_UNAVAILABLE:'Friends are unavailable for this account right now.',
})[codeOf(error)] || 'Friends are unavailable right now. Please try again.';

export function emptyFriendsState() {
 return {
  status:'idle', actorId:null, friends:[], incoming:[], outgoing:[], blocked:[], truncated:false, page:1,
  query:'', results:[], resultQuery:'', searchStatus:'idle', searchMessage:'', searchErrorCode:'',
  busy:false, pendingAction:null, actionStatus:'idle', message:'', errorCode:'',
 };
}

function validText(value, max) {
 return typeof value === 'string' && value.length > 0 && value.length <= max &&
  value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
// Match account-policy.safeText's Unicode code-point bound for display names.
function validName(value) {
 return typeof value === 'string' && value.trim().length > 0 && [...value.trim()].length <= 28 &&
  !/[\u0000-\u001f\u007f<>]/.test(value);
}
function invalid() { throw Error('SERVICE_UNAVAILABLE'); }

// Project only fields the Friends page needs. Even a misconfigured response must
// not retain self-profile fields, wallets, private stats or unrelated payloads.
function player(row, actor, kind) {
 if (!row || typeof row !== 'object' || Array.isArray(row) || !validText(row.id, 160) || row.id === actor ||
     !validText(row.username, 64)) invalid();
 if (kind === 'blocked') return Object.freeze({id:row.id, username:row.username});
 const name = row.name ?? row.displayName;
 if (!validName(name) || !validText(row.tag, 64) || !/^MEGA-[A-Z0-9]+$/.test(row.tag) ||
     !AVATARS.includes(row.avatar) || !RELATIONS.includes(row.relation) ||
     !row.presence || !PRESENCE.includes(row.presence.state) || typeof row.presence.online !== 'boolean' ||
     row.presence.online !== ONLINE.includes(row.presence.state)) invalid();
 if (kind === 'friends' && row.relation !== 'friend') invalid();
 // Crossed requests can exist in both lists; the service gives incoming relation
 // precedence when projecting either copy of that player.
 if (['incoming', 'outgoing'].includes(kind) && !['incoming', 'outgoing'].includes(row.relation)) invalid();
 const projected = {
  id:row.id, username:row.username, name, displayName:name, tag:row.tag, avatar:row.avatar,
  relation:row.relation, presence:Object.freeze({state:row.presence.state, online:row.presence.online}),
 };
 if (row.rating !== undefined) {
  if (!Number.isFinite(row.rating) || row.rating < 0 || row.rating > Number.MAX_SAFE_INTEGER) invalid();
  projected.rating = row.rating;
 }
 if (row.games !== undefined) {
  if (!Number.isSafeInteger(row.games) || row.games < 0) invalid();
  projected.games = row.games;
 }
 if (row.tier !== undefined) {
  if (!TIERS.includes(row.tier)) invalid();
  projected.tier = row.tier;
 }
 return Object.freeze(projected);
}
function rows(value, actor, kind, limit) {
 if (!Array.isArray(value) || value.length > limit) invalid();
 const ids = new Set();
 return Object.freeze(value.map(row => {
  const projected = player(row, actor, kind);
  if (ids.has(projected.id)) invalid();
  ids.add(projected.id);
  return projected;
 }));
}
function lists(value, actor) {
 if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.truncated !== 'boolean') invalid();
 const out = {truncated:value.truncated};
 for (const kind of LISTS) out[kind] = rows(value[kind], actor, kind, 500);
 const blocked = new Set(out.blocked.map(row => row.id));
 const friends = new Set(out.friends.map(row => row.id));
 if ([...out.friends, ...out.incoming, ...out.outgoing].some(row => blocked.has(row.id)) ||
     [...out.incoming, ...out.outgoing].some(row => friends.has(row.id))) invalid();
 return Object.freeze(out);
}

/**
 * `active(actor)` must include the route fence. `onAuthRequired` is invoked only
 * for a response that still belongs to this actor, route, query and revision.
 * `search()` is an explicit submit operation; typing only calls `setQuery()`.
 */
export function createFriendsController({context, request = (...args) => globalThis.MegaAccount.request(...args),
 operationKey = () => globalThis.MegaAccount.id(), changed = () => {}, active = () => true, onAuthRequired = () => {}}) {
 let revision = 0, searchRevision = 0, activeActor = null, visible = false, suspended = false, destroyed = false;
 let query = '', page = 1, protectedLists = null, protectedResults = Object.freeze([]);
 context.friends = emptyFriendsState();

 function current(actor, token = revision) {
  return !destroyed && visible && !suspended && revision === token && activeActor === actor &&
   context.sessionStatus === 'linked' && context.profile?.id === actor && active(actor);
 }
 function clearRows() {
  protectedLists = null; protectedResults = Object.freeze([]); searchRevision++;
  return {friends:[], incoming:[], outgoing:[], blocked:[], truncated:false, page:1,
   results:[], resultQuery:'', searchStatus:'idle', searchMessage:'', searchErrorCode:''};
 }
 function clearSearch() {
  protectedResults = Object.freeze([]); searchRevision++;
  return {results:[], resultQuery:'', searchStatus:'idle', searchMessage:'', searchErrorCode:''};
 }
 function deactivate() {
  revision++; searchRevision++; activeActor = null; visible = false; suspended = false; query = ''; page = 1;
  protectedLists = null; protectedResults = Object.freeze([]);
  context.friends = emptyFriendsState();
 }
 function suspend() {
  if (destroyed || !visible) return false;
  if (suspended) return true;
  suspended = true; revision++;
  context.friends = {...emptyFriendsState(), ...clearRows(), actorId:activeActor, query,
   status:'refreshing', busy:true, message:'Confirming your account before Friends can continue…'};
  changed();
  return true;
 }
 function resume(actor) {
  if (destroyed || !suspended || typeof actor !== 'string' || context.sessionStatus !== 'linked' ||
      context.profile?.id !== actor || !active(actor)) return false;
  if (activeActor !== actor) { deactivate(); return load(); }
  suspended = false;
  return load({force:true});
 }
 function fail(error, actor, token, operation, extras = {}) {
  if (!current(actor, token)) return false;
  context.friends = {...context.friends, ...clearRows(), ...extras, busy:false, pendingAction:null,
   errorCode:codeOf(error)};
  if (isAuth(error)) {
   onAuthRequired(error, {actor, operation});
   if (!current(actor, token)) return false;
  }
  changed();
  return false;
 }

 async function load({force = false} = {}) {
  const actor = context.sessionStatus === 'linked' ? context.profile?.id : null;
  if (destroyed || !validText(actor, 160) || !active(actor)) { deactivate(); return false; }
  const sameActor = visible && activeActor === actor;
  if (sameActor && context.friends.busy && context.friends.pendingAction) return false;
  if (!force && sameActor && context.friends.status !== 'idle') return false;
  if (!sameActor) { query = ''; page = 1; }
  const refresh = sameActor;
  visible = true; activeActor = actor; suspended = false;
  const token = ++revision;
  context.friends = {...emptyFriendsState(), ...clearRows(), actorId:actor, query,
   status:refresh ? 'refreshing' : 'loading', busy:true};
  changed();
  try {
   const result = await request('/api/community/friends');
   if (!current(actor, token)) return false;
   protectedLists = lists(result, actor);
   page = Math.min(page, Math.max(1, Math.ceil(protectedLists.friends.length / FRIENDS_PAGE_SIZE)));
   context.friends = {...context.friends, ...protectedLists, page, status:'ready', busy:false,
    message:protectedLists.truncated ? 'These lists are partial. The service has more players than it can show here.' : ''};
   changed();
   return true;
  } catch (error) {
   return fail(error, actor, token, refresh ? 'reload' : 'load', {
    status:refresh ? 'refresh-error' : 'error', message:copy(error),
   });
  }
 }

 // Pages are a view over the protected, bounded service response. Moving between
 // them never sends another request or grants permission to mutate a player.
 function setPage(value) {
  if (!current(activeActor) || context.friends.busy || context.friends.status !== 'ready' ||
      !protectedLists || !Number.isSafeInteger(value) || value < 1) return false;
  const next = Math.min(value, Math.max(1, Math.ceil(protectedLists.friends.length / FRIENDS_PAGE_SIZE)));
  if (page !== next) {
   page = next;
   context.friends = {...context.friends, page};
   changed();
  }
  return true;
 }

 function setQuery(value) {
  if (!current(activeActor) || context.friends.busy || typeof value !== 'string' || value.length > 64) return false;
  if (value === query) return true;
  query = value;
  context.friends = {...context.friends, ...clearSearch(), query};
  // Typing updates the draft without replacing its focused DOM input.
  return true;
 }
 async function search(value = query) {
  if (!current(activeActor) || context.friends.busy || !protectedLists) return false;
  if (value !== query && !setQuery(value)) return false;
  const actor = activeActor, token = revision, submitted = query, q = submitted.trim();
  const normalized = q.replace(/^#|^@/, '');
  context.friends = {...context.friends, ...clearSearch()};
  if (normalized.length < 3 || submitted.length > 64) {
   const error = Error(normalized.length < 3 ? 'SEARCH_TOO_SHORT' : 'INVALID_SEARCH');
   context.friends = {...context.friends, searchStatus:'error', searchMessage:copy(error), searchErrorCode:error.message};
   changed();
   return false;
  }
  const operation = searchRevision;
  const currentSearch = () => current(actor, token) && operation === searchRevision && query === submitted;
  context.friends = {...context.friends, searchStatus:'loading'};
  changed();
  try {
   const result = await request('/api/community/search?q=' + encodeURIComponent(q));
   if (!currentSearch()) return false;
   protectedResults = rows(result, actor, 'search', 20);
   context.friends = {...context.friends, results:protectedResults, resultQuery:q, searchStatus:'ready'};
   changed();
   return true;
  } catch (error) {
   if (!currentSearch()) return false;
   if (isAuth(error)) return fail(error, actor, token, 'search', {status:'error', message:copy(error)});
   protectedResults = Object.freeze([]);
   context.friends = {...context.friends, results:[], resultQuery:'', searchStatus:'error',
    searchMessage:copy(error), searchErrorCode:codeOf(error)};
   changed();
   return false;
  }
 }

 function allowedActions(target) {
  if (!current(activeActor) || context.friends.busy || !protectedLists || context.friends.status !== 'ready' ||
      typeof target !== 'string' || target === activeActor) return [];
  const has = kind => protectedLists[kind].some(row => row.id === target);
  if (has('blocked')) return ['unblock'];
  const allowed = new Set();
  if (has('friends')) { allowed.add('remove'); allowed.add('block'); }
  if (has('incoming')) { allowed.add('accept'); allowed.add('decline'); allowed.add('block'); }
  if (has('outgoing')) { allowed.add('cancel'); allowed.add('block'); }
  const found = protectedResults.find(row => row.id === target);
  if (found && context.friends.searchStatus === 'ready' && context.friends.resultQuery === query.trim()) {
   for (const name of ({none:['request', 'block'], friend:['remove', 'block'],
    incoming:['accept', 'decline', 'block'], outgoing:['cancel', 'block']})[found.relation]) allowed.add(name);
  }
  return ACTIONS.filter(name => allowed.has(name));
 }
 async function action(name, target) {
  if (!ACTIONS.includes(name) || !allowedActions(target).includes(name)) return false;
  const actor = activeActor, token = ++revision;
  let accepted = false;
  context.friends = {...context.friends, ...clearSearch(), busy:true,
   pendingAction:{action:name, target}, actionStatus:'pending', message:'Updating your Friends lists…', errorCode:''};
  changed();
  try {
   // The social route consumes body.key; the shared client consumes the third
   // argument. Bind both to this one user operation before its transport retries.
   const key = operationKey();
   if (typeof key !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(key)) invalid();
   const result = await request('/api/community/friend', {action:name, target, key}, key);
   if (!current(actor, token)) return false;
   if (!result || result.ok !== true) invalid();
   accepted = true;
   context.friends = {...context.friends, ...clearRows(), status:'refreshing', actionStatus:'saved',
    message:'Your change was accepted. Updating your Friends lists…'};
   changed();
   const canonical = await request('/api/community/friends');
   if (!current(actor, token)) return false;
   protectedLists = lists(canonical, actor);
   page = Math.min(page, Math.max(1, Math.ceil(protectedLists.friends.length / FRIENDS_PAGE_SIZE)));
   context.friends = {...context.friends, ...protectedLists, page, status:'ready', busy:false, pendingAction:null,
    message:protectedLists.truncated ? 'Your change was accepted. These lists are partial; more players are available on the service.' : 'Your Friends lists are up to date.', errorCode:''};
   changed();
   return true;
  } catch (error) {
   return fail(error, actor, token, 'action', {
    status:accepted ? 'refresh-error' : 'error', actionStatus:accepted ? 'saved' : 'error',
    message:accepted ? 'Your change was accepted, but the updated lists could not be loaded. Reload your Friends lists.' : copy(error),
   });
  }
 }
 function clearError() {
  if (!current(activeActor) || context.friends.busy) return false;
  context.friends = {...context.friends, message:'', errorCode:'', searchMessage:'', searchErrorCode:''};
  changed();
  return true;
 }
 function destroy() { destroyed = true; deactivate(); }
 return {load, reload:() => load({force:true}), setQuery, search, setPage, action, allowedActions, clearError,
  suspend, resume, isSuspended:() => suspended, actorId:() => activeActor, deactivate, destroy};
}
