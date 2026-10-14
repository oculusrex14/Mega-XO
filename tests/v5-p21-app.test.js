'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const game = require('../src/game.js');

// Execute the actual controller and its renderer, download, SEO, board and
// read-model dependencies in browser module order inside an isolated DOM
// harness. No provider connection, session, server mutation or browser is used.
const sources = ['ui', 'downloads', 'pages', 'board', 'site', 'seo', 'data', 'friends', 'realtime', 'app'].map(name => ({ name, text: fs.readFileSync(path.join(__dirname, `../apps/web/${name}.js`), 'utf8') }));
const flush = () => new Promise(resolve => setImmediate(resolve));
const json = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function playing(state = game.create()) {
  return { id: 'queue:synthetic-match', status: 'PLAYING', players: ['synthetic-x', 'synthetic-o'], accepted: ['synthetic-x', 'synthetic-o'], symbols: { X: 'synthetic-x', O: 'synthetic-o' }, termsHash: 'synthetic-frozen-terms', terms: { source: 'queue', turnSeconds: 60 }, quote: { rated: false, contributions: [0, 0], currency: null, payout: 0, burn: 0 }, state, revision: state.moves.length };
}
function offered(accepted = []) { return { ...playing(), status: 'OFFERED', players: ['synthetic-x'], accepted, symbols: null, opponentHidden: true }; }
function snapshotFrame(snapshot) { return { protocol:'realtime/v1', operation:'snapshot', match_id:snapshot.id, expected_revision:snapshot.revision, snapshot }; }

async function harness(overrides = {}, profileExtra = {}, pageOptions = {}) {
  const documentListeners = new Map(), windowListeners = new Map(), timers = new Map();
  let timerId = 0, operation = 0, clock = 0;
  const calls = [], confirmations = [], accountCalls = [], fetchCalls = [], sockets = [];
  const replies = { ...overrides };
  const profile = { id: 'synthetic-x', name: 'Synthetic player', tier: 'wood', rating: 600, wallet: { coins: 150, crowns: 0 }, ...profileExtra };
  let accountSession = Object.hasOwn(pageOptions,'session') ? pageOptions.session : { csrf:'synthetic-csrf', linked:true };
  class FakeSocket {
    constructor(url) { this.url=url;this.readyState=0;this.sent=[];this.closeCount=0;sockets.push(this); }
    send(text) { assert.equal(this.readyState,1);this.sent.push(JSON.parse(text)); }
    close() { this.closeCount++;this.readyState=3; }
    open() { this.readyState=1;this.onopen?.(); }
    frame(value) { this.onmessage?.({data:JSON.stringify(value)}); }
  }
  class Element {
    constructor() { this.dataset = {}; this.listeners = new Map(); this.html = ''; this.attributes=new Map(); }
    hasAttribute(name) { return this.attributes.has(name); }
    setAttribute(name,value) { this.attributes.set(name,String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    set innerHTML(value) {
      this.html = value;
      if (this === main) {
        this.region = null;
        this.boardHost = value.includes('data-board-host') ? new Element() : null;
        if (this.boardHost) for (const key of ['mode', 'difficulty', 'theme']) this.boardHost.dataset['board' + key[0].toUpperCase() + key.slice(1)] = value.match(new RegExp(`data-board-${key}="([^"]+)"`))?.[1];
      }
    }
    get innerHTML() { return this.html; }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    removeEventListener(name, fn) { if (this.listeners.get(name) === fn) this.listeners.delete(name); }
    contains() { return true; }
    focus() {}
    querySelectorAll() { return []; }
    querySelector(selector) {
      if (this === main && selector === '.mx-online-controls') return this.region;
      if (this === main && selector === '.gb-game-page' && this.html.includes('gb-game-page')) return { insertAdjacentHTML() { main.region = new Element(); } };
      return null;
    }
  }
  const main = new Element(), header = new Element(), footer = new Element(), notification = new Element();
  const location = { pathname: '/game', search: '', href: 'http://localhost/game', origin: 'http://localhost', assign() {} };
  if(pageOptions.path){const url=new URL(pageOptions.path,location.origin);Object.assign(location,{pathname:url.pathname,search:url.search,href:url.href});}
  if(pageOptions.offlineFallback)main.setAttribute('data-offline-fallback','');
  const add = (collection, name, fn) => { const rows = collection.get(name) || []; rows.push(fn); collection.set(name, rows); };
  const document = {
    hidden: false, body: { dataset: {} },
    querySelector(selector) { return ({ '#main': main, '#header': header, '#footer': footer, '#notification': notification, 'meta[name="description"]': {} })[selector] || null; },
    querySelectorAll(selector) { return selector === '[data-board-host]' && main.boardHost ? [main.boardHost] : []; },
    addEventListener(name, fn) { add(documentListeners, name, fn); },
  };
  const window = { addEventListener(name, fn) { add(windowListeners, name, fn); }, scrollTo() {} };
  const defaults = { queue: () => ({ state: 'searching' }), queueStatus: () => ({ state: 'searching' }), invitations: () => [], match: () => playing(), accept: () => playing(), move: () => ({}), resign: () => ({}), cancelQueue: () => ({ state: 'cancelled' }), decline: () => ({ status: 'DECLINED' }) };
  const network = Object.fromEntries(Object.entries(defaults).map(([name, fn]) => [name, async (...args) => { calls.push({ name, args: json(args) }); return (replies[name] || fn)(...args); }]));
  const sandbox = {
    document, window, location, navigator: {}, console, URL, URLSearchParams, AbortController, structuredClone, crypto: crypto.webcrypto,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms, at:clock+ms, interval: false }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms, at:clock+ms, interval: true }); return id; },
    clearInterval(id) { timers.delete(id); },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    history: { state:null, replaceState(state) { this.state=state; }, pushState(state, _title, url) { this.state=state;const parsed = new URL(url, location.origin); location.pathname = parsed.pathname; location.search = parsed.search; location.href = parsed.href; } },
    fetch: async (resource,options) => { fetchCalls.push({resource,options});const result = replies.profile ? await replies.profile(resource,options) : profile; return { ok: true, json: async () => structuredClone(result) }; },
    MegaGame: game, MegaNetwork: network,
    confirm(message) { confirmations.push(message); return replies.confirm ? replies.confirm(message) : true; },
    MegaAccount: {
      id: () => 'operation-' + ++operation, reset() { accountSession=null; },
      peek: () => replies.peek ? replies.peek() : accountSession,
      request: async (...args) => {
        accountCalls.push({path:args[0],body:args[1]===undefined?undefined:json(args[1])});
        if(replies.accountRequest)return replies.accountRequest(...args);
        if(args[0]==='/api/v1/ticket')return replies.ticket ? replies.ticket(...args) : {ok:true,ticket:'synthetic-ticket',expiresAt:Date.now()+60000};
        if(args[0].startsWith('/realtime/v1/snapshot?'))return snapshotFrame(replies.realtimeSnapshot ? await replies.realtimeSnapshot(...args) : playing());
        return {};
      },
      session: async () => ({ providers: {}, csrf: 'synthetic-csrf' }),
    },
    legalDocuments: {},
    storeLinks: { ios: null, android: null },
  };
  if(pageOptions.realtime)sandbox.WebSocket=pageOptions.Socket || FakeSocket;
  const context = vm.createContext(sandbox);
  for (const { name, text } of sources) {
    const runnable = text.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '');
    vm.runInContext(runnable + (name === 'app' ? '\nglobalThis.appTest={state:()=>({context,onlineState,onlineBusy,onlineRevision,activePath}),poll:pollOnline,navigate,board:()=>board};' : ''), context, { filename: `apps/web/${name}.js` });
  }
  await flush();
  const qa = context.appTest;
  function clickAction(attribute, value) {
    const node = { dataset: { [attribute === 'online' ? 'onlineAction' : 'accountAction']: value } };
    const target = { closest: selector => selector === `[data-${attribute}-action]` ? node : null };
    for (const fn of documentListeners.get('click') || []) fn({ target, defaultPrevented: false, button: 0 });
  }
  return {
    qa, calls, confirmations, replies, main, location, sockets, accountCalls, fetchCalls,
    profileReads: () => fetchCalls.filter(call=>call.resource==='/api/v1/profile').length,
    session(value) { accountSession=value; },
    online: action => clickAction('online', action), account: action => clickAction('account', action),
    cell(key) { const node = { dataset: { gbCell: key }, getAttribute: () => 'false' }; main.boardHost.listeners.get('click')({ target: { closest: () => node } }); },
    boardAction(action) { const node = { dataset: { gbAction: action } }; main.boardHost.listeners.get('click')({ target: { closest: () => node } }); },
    intervals: () => [...timers.values()].filter(timer => timer.interval),
    async advance(ms) {
      const target=clock+ms;
      while(true){
        const next=[...timers].filter(([,timer])=>timer.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
        if(!next)break;
        const [id,timer]=next;clock=timer.at;
        if(timer.interval)timer.at+=timer.ms;else timers.delete(id);
        timer.fn();await flush();
      }
      clock=target;await flush();
    },
    focus() { for (const fn of windowListeners.get('focus') || []) fn(); },
    hide(persisted=true) { for (const fn of windowListeners.get('pagehide') || []) fn({persisted}); },
    show(persisted=true) { for (const fn of windowListeners.get('pageshow') || []) fn({persisted}); },
    destroy() { for (const fn of windowListeners.get('pagehide') || []) fn({ persisted: false }); },
  };
}

async function enterPlaying(ui) { ui.online('casual'); await flush(); assert.equal(ui.qa.state().onlineState.status, 'playing'); }
async function subscribeSocket(ui) {
  await flush();const socket=ui.sockets.at(-1);assert.ok(socket,'a current playing match opens a socket');
  socket.open();socket.frame({protocol:'realtime/v1',operation:'ack',match_id:playing().id,ack_revision:0});await flush();
  return socket;
}

test('P21-APP-FRIENDS-01 delayed anonymous account checks settle on Friends and remain settled across route visits',async()=>{
 for(const code of ['AUTH_REQUIRED','LINK_ACCOUNT_REQUIRED'])for(const path of ['/friends','/account']){
  const pending=deferred();
  const ui=await harness({profile:()=>pending.promise},{},{path,session:null});
  try{
   ui.qa.navigate('/friends');
   assert.equal(ui.qa.state().context.sessionStatus,'loading');
   assert.match(ui.main.innerHTML,/Checking your account…/);
   assert.doesNotMatch(ui.main.innerHTML,/data-friends-search|data-friend-action/);
   await ui.advance(7999);
   assert.equal(ui.qa.state().context.sessionStatus,'loading','an unresolved account check must not become a guest assumption');
   pending.reject(Error(code));await flush();
   assert.equal(ui.qa.state().context.sessionStatus,'guest');
   assert.equal(ui.qa.state().context.profile,null);
   assert.match(ui.main.innerHTML,/Sign in to find players and manage your friend requests here\./);
   assert.doesNotMatch(ui.main.innerHTML,/Checking your account|data-friends-search|data-friend-action/);
   for(const route of ['/settings','/account','/friends']){ui.qa.navigate(route);await flush();}
   assert.match(ui.main.innerHTML,/Sign in to find players and manage your friend requests here\./);
   assert.doesNotMatch(ui.main.innerHTML,/Checking your account|data-friends-search|data-friend-action/);
   assert.equal(ui.profileReads(),1,'route visits reuse the completed anonymous account check');
   assert.equal(ui.accountCalls.length,0,'anonymous browsing cannot bootstrap a session or request private friends');
  }finally{pending.reject(Error(code));ui.destroy();}
 }
});

test('P21-APP-FRIENDS-02 a timed-out account check offers retry without assuming a guest or exposing private Friends',async()=>{
 const pending=deferred();
 const ui=await harness({profile:()=>pending.promise},{},{path:'/friends',session:null});
 try{
  await ui.advance(8000);
  assert.equal(ui.qa.state().context.sessionStatus,'error');
  assert.equal(ui.qa.state().context.profile,null);
  assert.doesNotMatch(ui.main.innerHTML,/Checking your account|data-friends-search|data-friend-action/);
  assert.match(ui.main.innerHTML,/The service did not respond in time\. Try again\./);
  assert.match(ui.main.innerHTML,/data-account-action="retry"/);
  assert.doesNotMatch(ui.main.innerHTML,/Sign in to find players and manage your friend requests here\./);
  assert.equal(ui.accountCalls.length,0);
  ui.replies.profile=()=>{throw Error('AUTH_REQUIRED');};
  ui.account('retry');await flush();
  assert.equal(ui.profileReads(),2);
  assert.equal(ui.qa.state().context.sessionStatus,'guest');
  assert.match(ui.main.innerHTML,/Sign in to find players and manage your friend requests here\./);
  pending.resolve({id:'late-private-actor',name:'Late private actor'});await flush();
  assert.equal(ui.qa.state().context.sessionStatus,'guest');
  assert.equal(ui.qa.state().context.profile,null);
  assert.doesNotMatch(ui.main.innerHTML,/late-private-actor|Late private actor|data-friends-search|data-friend-action/);
  assert.equal(ui.accountCalls.length,0);
 }finally{pending.resolve({id:'late-private-actor'});ui.destroy();}
});

test('P21-APP-OFFLINE: verified fallback survives hydration at private, unknown and query URLs and can open practice',async()=>{
 for(const path of ['/account','/__offline_unknown__','/game?offline-qa=route']){
  const ui=await harness({profile:()=>{throw Error('REQUEST_TIMEOUT');}},{},{path,offlineFallback:true});
  try{
   assert.match(ui.main.innerHTML, /Take the next move offline\./,path);
   assert.equal(ui.qa.state().context.profile,null);
   assert.equal(ui.qa.board(),null);
   ui.qa.navigate('/game');await flush();
   assert.equal(ui.location.pathname,'/game');
   assert.equal(ui.main.hasAttribute('data-offline-fallback'),false);
   assert.ok(ui.qa.board(), 'explicit practice navigation works');
  }finally{ui.destroy();}
 }
});

test('P21-APP-01 queued acceptance uses frozen terms and discovers PLAYING after own invitation disappears', async () => {
  let snapshot = offered();
  const ui = await harness({ queueStatus: () => ({ state: 'matched', matchId: snapshot.id }), match: () => snapshot, accept: () => offered(['synthetic-x']) });
  try {
    ui.online('casual'); await flush();
    await ui.qa.poll();
    assert.equal(ui.qa.state().onlineState.status, 'review');
    assert.match(ui.main.region.innerHTML, /Review your match before accepting/);
    ui.online('accept'); await flush();
    const accepted = ui.calls.find(call => call.name === 'accept');
    assert.deepEqual(accepted?.args.slice(0, 2), [snapshot.id, snapshot.termsHash]);
    assert.equal(ui.qa.state().onlineState.status, 'waiting');
    snapshot = playing();
    await ui.qa.poll();
    assert.equal(ui.qa.state().onlineState.status, 'playing');
    assert.equal(ui.qa.board().getState().moves.length, 0);
    assert.match(ui.main.boardHost.innerHTML, /Online Mega XOXO match/);
  } finally { ui.destroy(); }
});

test('P21-APP-02 matched queue cancellation reconciles a started match and idle queue stops polling', async () => {
  const ui = await harness({ cancelQueue: () => ({ state: 'matched', matchId: playing().id }) });
  try {
    ui.online('casual'); await flush();
    ui.online('cancel'); await flush();
    assert.equal(ui.qa.state().onlineState.status, 'playing');
    assert.equal(ui.qa.state().onlineState.match.id, playing().id);
  } finally { ui.destroy(); }
  const idle = await harness({ queueStatus: () => ({ state: 'idle' }) });
  try {
    idle.online('casual'); await flush();
    await idle.qa.poll();
    assert.equal(idle.qa.state().onlineState.status, 'idle');
    assert.equal(idle.intervals().length, 0);
  } finally { idle.destroy(); }
});

test('P21-APP-03 move retry retains its original operation, authoritative revision and selected cell', async () => {
  let current = playing(), count = 0;
  const ui = await harness({ queue: () => ({ state: 'matched', matchId: current.id }), match: () => current, move: (_id, _revision, move) => { if (++count === 1) throw Error('REQUEST_TIMEOUT'); current = playing(game.apply(current.state, move)); return {}; } });
  try {
    await enterPlaying(ui);
    ui.cell('0:4'); await flush();
    assert.equal(ui.qa.board().getState().moves.length, 0);
    assert.match(ui.main.boardHost.innerHTML, /Retry move/);
    ui.boardAction('retry'); await flush();
    const moves = ui.calls.filter(call => call.name === 'move');
    assert.equal(moves.length, 2);
    assert.deepEqual(moves[0].args, moves[1].args);
    assert.deepEqual(moves[0].args.slice(0, 3), [current.id, 0, { b: 0, c: 4 }]);
    assert.equal(ui.qa.board().getState().required, 4);
  } finally { ui.destroy(); }
});

test('P21-APP-04 poll auth failure stops polling, retires online input and offers the online sign-in action', async () => {
  const ui = await harness({ queue: () => ({ state: 'matched', matchId: playing().id }) });
  try {
    await enterPlaying(ui);
    ui.replies.match = () => { throw Error('LINK_ACCOUNT_REQUIRED'); };
    await ui.qa.poll();
    assert.equal(ui.qa.state().context.sessionStatus, 'guest');
    assert.equal(ui.qa.state().onlineState.status, 'auth');
    assert.equal(ui.intervals().length, 0);
    assert.match(ui.main.region.innerHTML, /href="\/account"[^>]*>.*Sign in to play online/);
    assert.doesNotMatch(ui.main.region.innerHTML, /Your match is live|service is unavailable/);
    assert.equal(ui.main.boardHost.innerHTML.includes('Online Mega XOXO match'), false);
    assert.match(ui.main.boardHost.innerHTML, /Local Mega XOXO game/);
    const moveCount = ui.calls.filter(call => call.name === 'move').length;
    ui.cell('0:4');
    assert.equal(ui.calls.filter(call => call.name === 'move').length, moveCount);
    const before = ui.calls.length;
    await ui.qa.poll();
    assert.equal(ui.calls.length, before);
  } finally { ui.destroy(); }
});

test('P21-APP-05 an older in-flight match poll cannot regress the cache used on route remount', async () => {
  let current = playing(), reads = 0;
  const oldRead = deferred();
  const ui = await harness({ queue: () => ({ state: 'matched', matchId: current.id }), match: () => ++reads === 2 ? oldRead.promise : current, move: (_id, _revision, move) => { current = playing(game.apply(current.state, move)); return {}; } });
  try {
    await enterPlaying(ui);
    const poll = ui.qa.poll();
    ui.cell('0:4'); await flush();
    assert.equal(ui.qa.board().getState().moves.length, 1);
    oldRead.resolve(playing()); await poll;
    assert.equal(ui.qa.state().onlineState.match.state.moves.length, 1);
    ui.qa.navigate('/play');
    ui.qa.navigate('/game');
    assert.equal(ui.qa.board().getState().moves.length, 1);
  } finally { oldRead.resolve(playing()); ui.destroy(); }
});

test('P21-APP-06 route departure fences the queued POST subsequent match read and new polling lifetime', async () => {
  const read = deferred();
  const ui = await harness({ queue: () => ({ state: 'matched', matchId: playing().id }), match: () => read.promise });
  try {
    ui.online('casual'); await flush();
    ui.qa.navigate('/friends');
    read.resolve(playing()); await flush();
    assert.equal(ui.qa.state().activePath, '/friends');
    assert.equal(ui.qa.state().onlineState.match, null);
    assert.equal(ui.intervals().length, 0);
    assert.equal(ui.main.boardHost, null);
  } finally { read.resolve(playing()); ui.destroy(); }
});

test('P21-APP-07 logout retires match ownership before a pending move returns its old actor snapshot', async () => {
  const move = deferred();
  const ui = await harness({ queue: () => ({ state: 'matched', matchId: playing().id }), move: () => move.promise });
  try {
    await enterPlaying(ui);
    ui.cell('0:4');
    ui.qa.navigate('/account');
    ui.account('logout'); await flush();
    assert.equal(ui.qa.state().context.profile, null);
    move.resolve({}); await flush();
    assert.equal(ui.qa.state().context.sessionStatus, 'guest');
    assert.equal(ui.qa.state().onlineState.match, null);
    assert.equal(ui.intervals().length, 0);
  } finally { move.resolve({}); ui.destroy(); }
});

test('P21-APP-08 matched snapshots owned by another actor cannot enable online controls', async () => {
  const other = { ...playing(), players: ['other-x', 'other-o'], symbols: { X: 'other-x', O: 'other-o' } };
  const ui = await harness({ queue: () => ({ state: 'matched', matchId: other.id }), match: () => other });
  try {
    ui.online('casual'); await flush();
    assert.equal(ui.qa.state().onlineState.match, null);
    assert.equal(ui.qa.state().context.sessionStatus, 'guest');
    assert.equal(ui.intervals().length, 0);
    assert.match(ui.main.region.innerHTML, /Sign in to play online/);
  } finally { ui.destroy(); }
});

test('P21-APP-09 a fresh game route resumes the current profile published active match', async () => {
  const current = playing(game.apply(game.create(), { b: 0, c: 4 }));
  const ui = await harness({ match: () => current }, { activeMatch: current.id });
  try {
    await flush();
    assert.equal(ui.qa.state().onlineState.match?.id, current.id);
    assert.equal(ui.qa.board().getState().moves.length, 1);
    assert.match(ui.main.boardHost.innerHTML, /Online Mega XOXO match/);
    assert.equal(ui.calls.filter(call => call.name === 'queue').length, 0);
  } finally { ui.destroy(); }
});

test('P21-APP-10 a refreshed profile belonging to another actor retires the former online board', async () => {
  const ui = await harness({ queue: () => ({ state: 'matched', matchId: playing().id }) });
  try {
    await enterPlaying(ui);
    ui.replies.profile = () => ({ id: 'different-actor', name: 'Another synthetic player' });
    ui.focus(); await flush();
    assert.equal(ui.qa.state().context.profile.id, 'different-actor');
    assert.equal(ui.main.boardHost.innerHTML.includes('Online Mega XOXO match'), false);
    const moves = ui.calls.filter(call => call.name === 'move').length;
    ui.cell('0:4'); await flush();
    assert.equal(ui.calls.filter(call => call.name === 'move').length, moves);
  } finally { ui.destroy(); }
});

test('P21-APP-11 a profile read started before an auth failure cannot relink the retired actor afterward', async () => {
  const matchRead = deferred(), profileRead = deferred();
  const ui = await harness({ queue: () => ({ state: 'matched', matchId: playing().id }) });
  try {
    await enterPlaying(ui);
    ui.replies.match = () => matchRead.promise;
    const poll = ui.qa.poll();
    ui.replies.profile = () => profileRead.promise;
    ui.focus();
    matchRead.reject(Error('LINK_ACCOUNT_REQUIRED')); await poll;
    assert.equal(ui.qa.state().context.sessionStatus, 'guest');
    profileRead.resolve({ id: 'synthetic-x', name: 'Stale actor profile' }); await flush();
    assert.equal(ui.qa.state().context.sessionStatus, 'guest');
    assert.equal(ui.qa.state().context.profile, null);
    assert.equal(ui.intervals().length, 0);
    assert.equal(ui.main.boardHost.innerHTML.includes('Online Mega XOXO match'), false);
  } finally { profileRead.resolve({ id: 'synthetic-x' }); ui.destroy(); }
});

test('P21-APP-12 transient match polling can recover the latest opponent move inside the current game route', async () => {
  let current = playing(game.apply(game.create(), { b: 0, c: 4 }));
  const ui = await harness({ queue: () => ({ state: 'matched', matchId: current.id }), match: () => current }, { activeMatch: current.id });
  try {
    if (!ui.qa.state().onlineState.match) await enterPlaying(ui);
    ui.replies.match = () => { throw Error('REQUEST_TIMEOUT'); };
    await ui.qa.poll();
    assert.equal(ui.qa.state().context.sessionStatus, 'linked');
    current = playing(game.apply(current.state, { b: 4, c: 0 }));
    ui.replies.match = () => current;
    const recovery = ui.main.region.innerHTML.match(/data-online-action="(retry|reconnect|resume)"/);
    if (recovery) ui.online(recovery[1]); else ui.focus();
    await flush();
    assert.equal(ui.qa.board().getState().moves.length, 2);
    assert.equal(ui.intervals().length, 1);
    assert.equal(ui.qa.state().onlineState.match.state.moves.length, 2);
  } finally { ui.destroy(); }
});

test('P21-APP-13 online resignation confirms loss and agreed consequences before transport', async () => {
  let current = playing();
  const ui = await harness({ queue: () => ({ state: 'matched', matchId: current.id }), match: () => current, confirm: () => false, resign: () => { current = { ...current, status: 'FINISHED', receipt: { winner: 'synthetic-o', reason: 'resign' } }; return {}; } });
  try {
    await enterPlaying(ui);
    ui.boardAction('resign'); await flush();
    assert.equal(ui.calls.filter(call => call.name === 'resign').length, 0);
    assert.equal(ui.qa.state().onlineState.match.status, 'PLAYING');
    assert.match(ui.confirmations[0], /loss.*agreed pot.*Ranked rating/);
    ui.replies.confirm = () => true;
    ui.boardAction('resign'); await flush();
    const resignation = ui.calls.find(call => call.name === 'resign');
    assert.equal(resignation.args[0], current.id);
    assert.equal(typeof resignation.args[1], 'string');
    assert.ok(resignation.args[1].length > 0);
    assert.equal(ui.qa.state().onlineState.match.status, 'FINISHED');
    assert.equal(ui.qa.board().getState().winner, null);
    assert.match(ui.main.boardHost.innerHTML, /Match finished/);
    assert.equal(ui.calls.filter(call => call.name === 'move').length, 0);
  } finally { ui.destroy(); }
});

test('P21-APP-14 leaving matchmaking declines an accepted OFFERED match without resigning a live match', async () => {
  let snapshot = offered();
  const ui = await harness({ queueStatus: () => ({ state: 'matched', matchId: snapshot.id }), match: () => snapshot, accept: () => { snapshot = offered(['synthetic-x']); return snapshot; }, cancelQueue: () => ({ state: 'matched', matchId: snapshot.id }), decline: () => { snapshot = { ...snapshot, status: 'DECLINED' }; return snapshot; } });
  try {
    ui.online('casual'); await flush();
    await ui.qa.poll();
    ui.online('accept'); await flush();
    assert.equal(ui.qa.state().onlineState.status, 'waiting');
    ui.online('cancel'); await flush();
    const declines = ui.calls.filter(call => call.name === 'decline');
    assert.equal(declines.length, 1);
    assert.equal(declines[0].args[0], snapshot.id);
    assert.equal(snapshot.status, 'DECLINED');
    assert.equal(ui.qa.state().onlineState.status, 'idle');
    assert.equal(ui.intervals().length, 0);
    assert.equal(ui.calls.filter(call => call.name === 'resign').length, 0);
    assert.equal(ui.calls.filter(call => call.name === 'move').length, 0);
  } finally { ui.destroy(); }
});

test('P21-APP-15 reconnect preserves a server-settled terminal result and disables online moves', async () => {
  const terminal={...playing(),status:'FINISHED',receipt:{winner:'synthetic-x',reason:'timeout'}};
  const ui=await harness({match:()=>terminal},{activeMatch:terminal.id});
  try {
    await flush();
    assert.equal(ui.qa.state().onlineState.match.status,'FINISHED');
    assert.equal(ui.qa.state().onlineState.status,'finished');
    assert.match(ui.main.boardHost.innerHTML,/You win/);
    ui.cell('0:0');await flush();
    assert.equal(ui.calls.filter(call=>call.name==='move').length,0);
    assert.equal(ui.intervals().length,0);
  } finally {ui.destroy();}
});

test('P21-APP-16 page departure fences an unfinished queue command and cannot restart polling', async () => {
  const pending=deferred();const ui=await harness({queue:()=>pending.promise});
  ui.online('casual');await flush();const revision=ui.qa.state().onlineRevision;
  ui.destroy();pending.resolve({state:'matched',matchId:playing().id});await flush();
  assert.ok(ui.qa.state().onlineRevision>revision);
  assert.equal(ui.qa.state().onlineState.match,null);
  assert.equal(ui.calls.filter(call=>call.name==='match').length,0);
  assert.equal(ui.intervals().length,0);
});

test('P21-APP-RT-01 socket snapshots update the mounted board and cache without a game mutation',async()=>{
 const ui=await harness({queue:()=>({state:'matched',matchId:playing().id})},{},{realtime:true});
 try{
  await enterPlaying(ui);const socket=await subscribeSocket(ui);
  assert.equal(socket.url,'ws://localhost/realtime/v1');
  assert.deepEqual(socket.sent.map(frame=>frame.operation),['ticket.redeem','subscribe','resume']);
  const ticket=ui.accountCalls.find(call=>call.path==='/api/v1/ticket');assert.deepEqual(ticket.body,{matchScope:playing().id});
  const next=playing(game.apply(game.create(),{b:0,c:4}));socket.frame(snapshotFrame(next));await flush();
  assert.equal(ui.qa.board().getState().moves.length,1);assert.equal(ui.qa.state().onlineState.match.revision,1);
  assert.match(ui.main.region.innerHTML,/Live updates connected/);
  assert.equal(ui.calls.filter(call=>['move','resign'].includes(call.name)).length,0);
  assert.ok(socket.sent.every(frame=>!['move','resign'].includes(frame.operation)));
  ui.qa.navigate('/play');assert.equal(socket.closeCount,1);ui.qa.navigate('/game');
  assert.equal(ui.qa.board().getState().moves.length,1,'route remount keeps the pushed authoritative cache');
 }finally{ui.destroy();}
});

test('P21-APP-RT-02 an older in-flight HTTP match read cannot regress a newer socket snapshot',async()=>{
 const pending=deferred();let reads=0;
 const ui=await harness({queue:()=>({state:'matched',matchId:playing().id}),match:()=>++reads===2?pending.promise:playing()},{},{realtime:true});
 try{
  await enterPlaying(ui);const socket=await subscribeSocket(ui),poll=ui.qa.poll();
  const next=playing(game.apply(game.create(),{b:0,c:4}));socket.frame(snapshotFrame(next));await flush();
  pending.resolve(playing());await poll;
  assert.equal(ui.qa.state().onlineState.match.revision,1);assert.equal(ui.qa.board().getState().required,4);
  ui.qa.navigate('/play');ui.qa.navigate('/game');assert.equal(ui.qa.board().getState().moves.length,1);
 }finally{pending.resolve(playing());ui.destroy();}
});

for(const status of ['FINISHED','VOID'])test(`P21-APP-RT-03-${status} same-revision settlement refreshes the server profile once and retires match transport`,async()=>{
 const pending=deferred();let reads=0;
 const ui=await harness({queue:()=>({state:'matched',matchId:playing().id}),match:()=>++reads===2?pending.promise:playing()},{},{realtime:true});
 try{
  await enterPlaying(ui);const socket=await subscribeSocket(ui),lateMessage=socket.onmessage,poll=ui.qa.poll();
  const refreshed={id:'synthetic-x',name:'Settled synthetic profile',tier:'wood',rating:613.75,wallet:{coins:171,crowns:2},activeMatch:null};
  ui.replies.profile=()=>refreshed;
  const terminal={...playing(),status,settled:true,receipt:{winner:status==='FINISHED'?'synthetic-x':null,reason:status==='FINISHED'?'timeout':'cancelled'}};
  socket.frame(snapshotFrame(terminal));await flush();
  assert.equal(ui.qa.state().onlineState.status,'finished');assert.equal(ui.qa.state().onlineState.match.status,status);
  assert.equal(ui.profileReads(),2,'settlement triggers one protected profile refresh');
  assert.deepEqual(json(ui.qa.state().context.profile.wallet),refreshed.wallet);assert.equal(ui.qa.state().context.profile.rating,613.75);
  assert.equal(socket.closeCount,1);assert.equal(ui.intervals().length,0);
  assert.match(ui.main.boardHost.innerHTML,status==='FINISHED'?/You win/:/Match cancelled/);
  pending.resolve(playing());await poll;
  lateMessage({data:JSON.stringify(snapshotFrame(playing()))});lateMessage({data:JSON.stringify(snapshotFrame(terminal))});await flush();
  assert.equal(ui.qa.state().onlineState.match.status,status,'late same-revision PLAYING cannot reopen a settled match');
  assert.equal(ui.profileReads(),2,'stale or duplicate delivery cannot repeat settlement refresh');
  ui.cell('0:4');await flush();assert.equal(ui.calls.filter(call=>call.name==='move').length,0);
  ui.qa.navigate('/play');ui.qa.navigate('/game');assert.equal(ui.intervals().length,0);assert.equal(ui.sockets.length,1);
  ui.focus();await flush();assert.equal(ui.intervals().length,0,'focus must not restart polling for a settled match');
  assert.equal(ui.sockets.length,1);assert.equal(ui.qa.state().onlineState.match.status,status);
 }finally{pending.resolve(playing());ui.destroy();}
});

for(const departure of ['route','pagehide','logout','actor'])test(`P21-APP-RT-04-${departure} pending socket tickets cannot bind after ownership changes`,async()=>{
 const pending=deferred();const ui=await harness({queue:()=>({state:'matched',matchId:playing().id}),ticket:()=>pending.promise},{},{realtime:true});
 try{
  await enterPlaying(ui);assert.equal(ui.sockets.length,0);
  if(departure==='route')ui.qa.navigate('/play');
  if(departure==='pagehide')ui.hide(false);
  if(departure==='logout'){ui.qa.navigate('/account');ui.account('logout');await flush();}
  if(departure==='actor'){ui.replies.profile=()=>({id:'new-actor',name:'New actor'});ui.focus();await flush();}
  pending.resolve({ok:true,ticket:'synthetic-old-ticket',expiresAt:Date.now()+60000});await flush();
  assert.equal(ui.sockets.length,0);assert.equal(ui.intervals().length,0);
  if(departure==='logout')assert.equal(ui.qa.state().context.sessionStatus,'guest');
  if(departure==='actor')assert.equal(ui.qa.state().context.profile.id,'new-actor');
 }finally{pending.resolve({ok:true,ticket:'synthetic-old-ticket',expiresAt:Date.now()+60000});ui.destroy();}
});

for(const departure of ['route','pagehide','logout','actor'])test(`P21-APP-RT-04b-${departure} delayed recovery and queued socket callbacks cannot restore departed ownership`,async()=>{
 const recovery=deferred(),ui=await harness({queue:()=>({state:'matched',matchId:playing().id})},{},{realtime:true});
 try{
  await enterPlaying(ui);const socket=await subscribeSocket(ui),lateMessage=socket.onmessage;
  ui.replies.realtimeSnapshot=()=>recovery.promise;
  socket.frame({protocol:'realtime/v1',operation:'ack',match_id:playing().id,ack_revision:1});await flush();
  assert.equal(ui.accountCalls.filter(call=>call.path.startsWith('/realtime/v1/snapshot?')).length,2);
  if(departure==='route')ui.qa.navigate('/play');
  if(departure==='pagehide')ui.hide(true);
  if(departure==='logout'){ui.qa.navigate('/account');ui.account('logout');await flush();}
  if(departure==='actor'){ui.replies.profile=()=>({id:'new-actor',name:'New actor'});ui.focus();await flush();}
  const next=playing(game.apply(game.create(),{b:0,c:4}));
  if(departure==='actor')recovery.reject(Error('AUTH_REQUIRED'));else recovery.resolve(snapshotFrame(next));
  lateMessage({data:JSON.stringify(snapshotFrame(next))});
  lateMessage({data:JSON.stringify({protocol:'realtime/v1',operation:'error',code:'AUTH_REQUIRED'})});await flush();
  assert.equal(socket.closeCount,1);assert.equal(ui.intervals().length,0);
  assert.equal(ui.qa.state().onlineState.match?.revision??null,['logout','actor'].includes(departure)?null:0);
  if(departure==='logout')assert.equal(ui.qa.state().context.sessionStatus,'guest');
  else assert.equal(ui.qa.state().context.sessionStatus,'linked');
  if(departure==='actor')assert.equal(ui.qa.state().context.profile.id,'new-actor','an old recovery AUTH_REQUIRED must not retire the replacement actor');
 }finally{recovery.resolve(snapshotFrame(playing()));ui.destroy();}
});

test('P21-APP-RT-05 opaque session replacement fences queued socket state and auth callbacks',async()=>{
 const ui=await harness({queue:()=>({state:'matched',matchId:playing().id})},{},{realtime:true});
 try{
  await enterPlaying(ui);const socket=await subscribeSocket(ui),lateMessage=socket.onmessage;
  ui.session({csrf:'synthetic-new-session',linked:true});
  const next=playing(game.apply(game.create(),{b:0,c:4}));
  lateMessage({data:JSON.stringify(snapshotFrame(next))});
  lateMessage({data:JSON.stringify({protocol:'realtime/v1',operation:'error',code:'AUTH_REQUIRED'})});await flush();
  assert.equal(ui.qa.state().context.sessionStatus,'linked');assert.equal(ui.qa.state().onlineState.match.revision,0);assert.equal(ui.qa.board().getState().moves.length,0);
  ui.qa.navigate('/play');ui.qa.navigate('/game');await flush();assert.equal(socket.closeCount,1);
  const fresh=await subscribeSocket(ui);fresh.frame(snapshotFrame(next));await flush();assert.equal(ui.qa.board().getState().moves.length,1);
 }finally{ui.destroy();}
});

test('P21-APP-RT-06 an explicit current socket auth refusal retires the actor and queued peer callbacks',async()=>{
 const ui=await harness({queue:()=>({state:'matched',matchId:playing().id})},{},{realtime:true});
 try{
  await enterPlaying(ui);const socket=await subscribeSocket(ui),lateMessage=socket.onmessage;
  socket.frame({protocol:'realtime/v1',operation:'error',code:'SESSION_REVOKED'});await flush();
  assert.equal(ui.qa.state().context.sessionStatus,'guest');assert.equal(ui.qa.state().context.profile,null);assert.equal(ui.intervals().length,0);assert.equal(socket.closeCount,1);
  lateMessage({data:JSON.stringify(snapshotFrame(playing(game.apply(game.create(),{b:0,c:4}))))});await flush();
  assert.equal(ui.qa.state().context.sessionStatus,'guest');assert.equal(ui.main.boardHost.innerHTML.includes('Online Mega XOXO match'),false);
  const before=ui.calls.filter(call=>call.name==='move').length;ui.cell('0:4');await flush();assert.equal(ui.calls.filter(call=>call.name==='move').length,before);
 }finally{ui.destroy();}
});

test('P21-APP-RT-07 cached-page restoration restarts a loading profile and fences the interrupted result',async()=>{
 const first=deferred(),restored=deferred();let reads=0;
 const ui=await harness({profile:()=>++reads===1?first.promise:restored.promise},{},{path:'/account'});
 try{
  assert.equal(ui.qa.state().context.sessionStatus,'loading');ui.hide(true);ui.show(true);await flush();
  assert.equal(ui.profileReads(),2);assert.equal(ui.fetchCalls[0].options.signal.aborted,true);
  first.resolve({id:'stale-actor',name:'Interrupted actor'});await flush();assert.equal(ui.qa.state().context.sessionStatus,'loading');
  restored.resolve({id:'synthetic-x',name:'Restored actor'});await flush();
  assert.equal(ui.qa.state().context.sessionStatus,'linked');assert.equal(ui.qa.state().context.profile.id,'synthetic-x');
  assert.match(ui.main.innerHTML,/Restored actor/);assert.doesNotMatch(ui.main.innerHTML,/Checking your account|Restoring your current session/);
 }finally{first.resolve({id:'stale-actor'});restored.resolve({id:'synthetic-x'});ui.destroy();}
});

test('P21-APP-RT-08 an interrupted cached-page check reaches bounded error and the actual retry button recovers',async()=>{
 const first=deferred(),restored=deferred();let reads=0;
 const ui=await harness({profile:()=>++reads===1?first.promise:restored.promise},{},{path:'/account'});
 try{
  ui.hide(true);ui.show(true);await flush();await ui.advance(8000);
  assert.equal(ui.qa.state().context.sessionStatus,'error');assert.match(ui.main.innerHTML,/data-account-action="retry"/);
  ui.replies.profile=()=>({id:'synthetic-x',name:'Retried actor'});ui.account('retry');await flush();
  assert.equal(ui.profileReads(),3);assert.equal(ui.qa.state().context.sessionStatus,'linked');
  first.resolve({id:'stale-first'});restored.resolve({id:'stale-second'});await flush();assert.equal(ui.qa.state().context.profile.id,'synthetic-x');
  assert.doesNotMatch(ui.main.innerHTML,/Checking your account|Restoring your current session/);
 }finally{first.resolve({id:'stale-first'});restored.resolve({id:'stale-second'});ui.destroy();}
});

test('P21-APP-RT-09 browsers without WebSocket keep protected HTTP match polling',async()=>{
 let current=playing();const ui=await harness({queue:()=>({state:'matched',matchId:current.id}),match:()=>current,realtimeSnapshot:()=>current});
 try{
  await enterPlaying(ui);assert.equal(ui.sockets.length,0);assert.equal(ui.intervals().length,1);assert.match(ui.main.region.innerHTML,/Match checks continue/);
  current=playing(game.apply(current.state,{b:0,c:4}));await ui.advance(2500);
  assert.equal(ui.qa.board().getState().moves.length,1);assert.equal(ui.qa.state().context.sessionStatus,'linked');assert.equal(ui.intervals().length,1);
  assert.equal(ui.accountCalls.filter(call=>call.path==='/api/v1/ticket').length,0);
  assert.ok(ui.accountCalls.some(call=>call.path.startsWith('/realtime/v1/snapshot?')));
 }finally{ui.destroy();}
});

for(const result of ['snapshot','auth'])test(`P21-APP-RT-10-${result} a delayed recovery cannot undo newer socket state or retire its current actor`,async()=>{
 const recovery=deferred(),ui=await harness({queue:()=>({state:'matched',matchId:playing().id})},{},{realtime:true});
 try{
  await enterPlaying(ui);const socket=await subscribeSocket(ui);
  ui.replies.realtimeSnapshot=()=>recovery.promise;
  socket.frame({protocol:'realtime/v1',operation:'ack',match_id:playing().id,ack_revision:1});await flush();
  const next=playing(game.apply(game.create(),{b:0,c:4}));socket.frame(snapshotFrame(next));await flush();
  if(result==='auth')recovery.reject(Error('AUTH_REQUIRED'));else recovery.resolve(snapshotFrame(playing()));await flush();
  assert.equal(ui.qa.state().context.sessionStatus,'linked');assert.equal(ui.qa.state().context.profile.id,'synthetic-x');
  assert.equal(ui.qa.state().onlineState.match.revision,1);assert.equal(ui.qa.board().getState().moves.length,1);
  assert.equal(socket.closeCount,0);assert.equal(ui.profileReads(),1);assert.equal(ui.intervals().length,1);
 }finally{recovery.resolve(snapshotFrame(playing()));ui.destroy();}
});
