/* Website adapter for the retained party protocol. The service owns seating,
 * eligibility, entry reservation, clocks, fixtures and settlement. */
const tournamentAuth = error => ['AUTH_REQUIRED','LINK_ACCOUNT_REQUIRED','SESSION_REVOKED','REVOKED'].includes(error?.message);
const tournamentTerminal = new Set(['COMPLETE','VOID','CANCELLED','REVIEW']);
const tournamentTransient = error => ['REQUEST_TIMEOUT','SERVICE_UNAVAILABLE','ONLINE_UNAVAILABLE','OFFLINE'].includes(error?.message);
const safeTournamentId = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x20]/.test(value);
const tournamentInteger = value => Number.isSafeInteger(value) && value >= 0;

export function tournamentRoomId(profile) {
 const active = profile?.activeMatch;
 return typeof active === 'string' && active.startsWith('tournament:') && safeTournamentId(active.slice(11)) ? active.slice(11) : null;
}

export function tournamentFixture(room, actor, fixtureId) {
 if (!room?.players?.some(player => player.id === actor)) return null;
 const fixtures = room.fixtures || [];
 if (fixtureId) return fixtures.find(fixture => fixture.id === fixtureId && fixture.players?.includes(actor)) || null;
 return fixtures.find(fixture => fixture.players?.includes(actor) && fixture.status === 'PLAYING') ||
  fixtures.find(fixture => fixture.players?.includes(actor) && fixture.status === 'READY') || null;
}

/** Presentation projection only. A lobby/READY fixture never invents a game.
 * A replay gets a new board identity because its sides/move history can reset. */
export function tournamentMatch(room, actor, fixtureId) {
 const fixture = tournamentFixture(room, actor, fixtureId);
 if (!fixture?.state || !['PLAYING','DONE'].includes(fixture.status) || !Array.isArray(fixture.players) || fixture.players.length !== 2) return null;
 const status = room.status === 'RUNNING' && fixture.status === 'PLAYING' ? 'PLAYING' : fixture.status === 'DONE' ? 'FINISHED' : 'VOID';
 return {
  id:`tournament:${room.id}:${fixture.id}:${fixture.attempt || 0}`, status,
  players:fixture.players, symbols:{X:fixture.players[0],O:fixture.players[1]},
  state:fixture.state, revision:fixture.state.moves.length,
  playerNames:Object.fromEntries(room.players.map(player => [player.id,player.name])),
  terms:{source:'tournament',roomId:room.id,fixtureId:fixture.id},
  quote:{rated:false}, receipt:fixture.status === 'DONE' ? {winner:fixture.winner,reason:fixture.reason} : null,
 };
}

function validateTournamentRoom(room, actor, expectedId, previous) {
 if (!room || !safeTournamentId(room.id) || (expectedId && room.id !== expectedId) || !tournamentInteger(room.revision) ||
     !tournamentInteger(room.rulesVersion) || !Array.isArray(room.players) || !room.players.some(player => player?.id === actor) ||
     !Array.isArray(room.fixtures) || !['LOBBY','RUNNING','PAUSED','COMPLETE','VOID','CANCELLED','REVIEW'].includes(room.status)) throw Error('INVALID_TOURNAMENT_RESPONSE');
 if (previous?.id === room.id && room.revision < previous.revision) return false;
 return true;
}

export function createTournamentsController({context, request, read = request, changed = () => {}, active = () => true,
 onAuthRequired = () => {}, operationKey = () => globalThis.crypto.randomUUID(), storage = null, session = () => null} = {}) {
 let revision = 0, actorId = null, visible = false, destroyed = false, suspended = false, readBusy = false;
 let requestedRoom = null, pending = null, boundSession = null, cancelled = new Set();
 const idle = () => ({status:'idle',tables:[],available:false,room:null,actorId:null,busy:false,message:'',errorCode:'',uncertain:false});
 context.tournaments = idle();
 const actor = () => context.sessionStatus === 'linked' && typeof context.profile?.id === 'string' ? context.profile.id : null;
 // A replaced opaque cookie/bootstrap identity fences the previous request even
 // when both sessions belong to the same permanent actor. The shared client
 // clears its cache before rejecting an expired session, so only that refusal
 // may use the null-session exception.
 const current = (token, owner, auth = false) => {
  if (destroyed || !visible || suspended || !active() || revision !== token || actor() !== owner) return false;
  const now = session();
  if (boundSession == null && now != null) boundSession = now;
  return boundSession == null || now === boundSession || (auth && now == null);
 };
 const emit = patch => { context.tournaments = {...context.tournaments,...patch}; changed(); };
 function invalidate() { revision++; readBusy = false; for (const cancel of cancelled) cancel(); cancelled.clear(); }
 async function bounded(work) {
  let timer, cancel;
  const deadline = new Promise((_resolve,reject) => {
   cancel = () => reject(Error('CANCELLED'));
   timer = setTimeout(() => reject(Error('REQUEST_TIMEOUT')),8000);
   cancelled.add(cancel);
  });
  try { return await Promise.race([Promise.resolve().then(work),deadline]); }
  finally { clearTimeout(timer); cancelled.delete(cancel); }
 }
 function remember(room) {
  try { if (room && !tournamentTerminal.has(room.status)) storage?.setItem('mega-web-tournament-room',JSON.stringify({actorId:actorId,id:room.id}));
   else storage?.removeItem('mega-web-tournament-room'); } catch {}
 }
 function remembered(owner) {
  try { const saved = JSON.parse(storage?.getItem('mega-web-tournament-room') || 'null'); return saved?.actorId === owner && safeTournamentId(saved.id) ? saved.id : null; } catch { return null; }
 }
 function failure(error, token, owner) {
  if (!current(token,owner,tournamentAuth(error))) return;
  if (tournamentAuth(error)) { onAuthRequired(error); return; }
  emit({status:'error',busy:false,errorCode:/^[A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'SERVICE_UNAVAILABLE',message:'',uncertain:Boolean(pending)});
 }
 function accept(room, owner, expectedId) {
  if (!validateTournamentRoom(room,owner,expectedId,context.tournaments.room)) return false;
  remember(room);
  emit({status:'ready',room,actorId:owner,busy:false,message:'',errorCode:'',uncertain:Boolean(pending)});
  return true;
 }
 async function load({force = false} = {}) {
  if (destroyed || !visible || suspended || !active() || readBusy || context.tournaments.busy) return false;
  const owner = actor(), token = revision;
  if (!force && context.tournaments.status !== 'idle') return false;
  readBusy = true; emit({status:'loading',message:'',errorCode:''});
  try {
   const caps = await bounded(() => read('/api/party/capabilities'));
   if (!current(token,owner)) return false;
   if (!caps || typeof caps.online !== 'boolean' || !Array.isArray(caps.tables)) throw Error('INVALID_TOURNAMENT_RESPONSE');
   const tables = caps.tables.filter(table => safeTournamentId(table?.table) && typeof table.name === 'string' && ['coins','crowns'].includes(table.currency) &&
    tournamentInteger(table.entry) && tournamentInteger(table.pool) && Array.isArray(table.payouts) && table.payouts.every(tournamentInteger));
   if (tables.length !== caps.tables.length) throw Error('INVALID_TOURNAMENT_RESPONSE');
   const available = caps.online === true && caps.publicEnabled === true;
   emit({tables,available});
   const id = requestedRoom || tournamentRoomId(context.profile) || context.tournaments.room?.id || remembered(owner);
   if (owner && id && available) {
    const room = await bounded(() => request('/api/party/rooms/'+encodeURIComponent(id)));
    if (!current(token,owner)) return false;
    accept(room,owner,id);
   } else emit({status:'ready',room:owner ? context.tournaments.room : null,actorId:owner});
   return true;
  } catch (error) { failure(error,token,owner); return false; }
  finally { if (revision === token) readBusy = false; }
 }
 function sync({roomId = null} = {}) {
  if (destroyed) return;
  if (!active()) { if (visible) { visible = false; invalidate(); context.tournaments = {...context.tournaments,busy:false,uncertain:Boolean(pending)}; } return; }
  const nextActor = actor();
  const nextSession = session();
  const nextRoom = safeTournamentId(roomId) ? roomId : null;
  if (context.sessionStatus === 'loading') {
   if (!suspended) { suspended = true; invalidate(); context.tournaments = {...context.tournaments,busy:false,uncertain:Boolean(pending)}; }
   visible = true; return;
  }
  const changedOwner = nextActor !== actorId;
  const changedRoute = nextRoom !== requestedRoom;
  const changedSession = boundSession != null && nextSession !== boundSession;
  const resumed = suspended || !visible;
  if (changedOwner) { invalidate(); actorId = nextActor; pending = null; context.tournaments = idle(); }
  if (changedRoute || changedSession) { invalidate(); context.tournaments = {...context.tournaments,busy:false,uncertain:Boolean(pending)}; }
  boundSession = nextSession;
  visible = true; suspended = false; requestedRoom = nextRoom;
  if (changedOwner || changedRoute || changedSession || resumed || context.tournaments.status === 'idle') {
   if (context.tournaments.status === 'loading') context.tournaments = {...context.tournaments,status:'idle'};
   load({force:true});
  }
 }
 async function refresh() {
  if (context.tournaments.busy || readBusy || suspended || !visible || !active()) return false;
  const owner = actor(), token = revision, room = context.tournaments.room;
  if (!room || context.tournaments.status === 'error') return load({force:true});
  if (!owner) return false;
  readBusy = true;
  try {
   const next = await bounded(() => request('/api/party/rooms/'+encodeURIComponent(room.id)));
   return current(token,owner) ? accept(next,owner,room.id) : false;
  } catch(error) { failure(error,token,owner); return false; }
  finally { if (revision === token) readBusy = false; }
 }
 async function command(body, key, explicitKey) {
  const owner = actor();
  if (!owner || !visible || suspended || !active() || context.tournaments.busy || context.tournaments.available !== true) return null;
  if (pending && !key) return null;
  const operation = key ? pending : {body:structuredClone(body),key:explicitKey || operationKey(),actorId:owner};
  if (!operation || operation.actorId !== owner) return null;
  // A command supersedes any older read. A delayed lobby poll must not clear
  // its busy/uncertain state or replace the command's canonical response.
  invalidate(); const token = revision;
  pending = operation; emit({busy:true,message:'',errorCode:'',uncertain:false});
  try {
   const result = await bounded(() => request('/api/party/command',operation.body,operation.key));
   if (!current(token,owner)) return null;
   if (operation.body.type === 'leave') {
    pending = null; remember(null); emit({status:'ready',room:null,busy:false,message:'You left the lobby. No entry is reserved.',errorCode:'',uncertain:false}); return result;
   }
   if(!validateTournamentRoom(result,owner,operation.body.id,context.tournaments.room))throw Error('INVALID_TOURNAMENT_RESPONSE');
   pending = null; return accept(result,owner,operation.body.id) ? result : null;
  } catch(error) {
   if (current(token,owner,tournamentAuth(error))) { if (!tournamentTransient(error)) pending = null; failure(error,token,owner); }
   throw error;
  }
 }
 async function action(name, value) {
  const room = context.tournaments.room, owner = actor();
  try {
   if (name === 'refresh') return refresh();
   if (name === 'retry') return pending ? command(null,pending.key) : refresh();
   if (name === 'join' && !room && context.tournaments.tables.some(table => table.table === value)) return await command({type:'publicJoin',table:value});
   if (name === 'ready' && room?.status === 'LOBBY') return await command({type:'ready',id:room.id,value:!room.players.find(player => player.id === owner)?.ready,rulesVersion:room.rulesVersion});
   if (name === 'leave' && room?.status === 'LOBBY') return await command({type:'leave',id:room.id});
   if (name === 'match-ready') {
    const fixture = tournamentFixture(room,owner,value);
    if (room?.status === 'RUNNING' && fixture?.status === 'READY' && !fixture.ready?.includes(owner) && Number(room.serverNow) >= Number(fixture.opens)) return await command({type:'matchReady',id:room.id,fixture:fixture.id});
   }
  } catch { return null; }
  return null;
 }
 async function play(operation, resign = false) {
  const room = context.tournaments.room, owner = actor();
  if (!owner) throw Error('AUTH_REQUIRED');
  if (!visible || suspended || !active() || context.tournaments.busy || context.tournaments.available !== true) throw Error('REQUEST_PENDING');
  const fixture = room?.fixtures?.find(entry => tournamentMatch(room,owner,entry.id)?.id === operation.id);
  if (!fixture || room.status !== 'RUNNING' || fixture.status !== 'PLAYING' || operation.revision !== fixture.state?.moves?.length) throw Error('STALE_REVISION');
  let result;
  if (pending) {
   if (pending.key !== operation.key) throw Error('REQUEST_PENDING');
   result = await command(null,pending.key);
  } else result = await command({type:resign ? 'resign' : 'move',id:room.id,fixture:fixture.id,...(resign ? {} : {revision:operation.revision,move:operation.move})},null,operation.key);
  if (!result) throw Error('REQUEST_PENDING');
  return tournamentMatch(context.tournaments.room,owner,fixture.id);
 }
 return {sync,load,refresh,action,play, deactivate(){visible=false;invalidate();context.tournaments={...context.tournaments,busy:false,uncertain:Boolean(pending)};},destroy(){destroyed=true;visible=false;pending=null;invalidate();}};
}
