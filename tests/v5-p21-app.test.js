'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const game = require('../src/game.js');

// Execute the actual app, board, page and read-model modules in an isolated DOM
// harness. No provider connection, session, server mutation or browser is used.
const sources = ['ui', 'pages', 'board', 'data', 'app'].map(name => ({ name, text: fs.readFileSync(path.join(__dirname, `../apps/web/${name}.js`), 'utf8') }));
const flush = () => new Promise(resolve => setImmediate(resolve));
const json = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function playing(state = game.create()) {
  return { id: 'queue:synthetic-match', status: 'PLAYING', players: ['synthetic-x', 'synthetic-o'], accepted: ['synthetic-x', 'synthetic-o'], symbols: { X: 'synthetic-x', O: 'synthetic-o' }, termsHash: 'synthetic-frozen-terms', terms: { source: 'queue', turnSeconds: 60 }, quote: { rated: false, contributions: [0, 0], currency: null, payout: 0, burn: 0 }, state, revision: state.moves.length };
}
function offered(accepted = []) { return { ...playing(), status: 'OFFERED', players: ['synthetic-x'], accepted, symbols: null, opponentHidden: true }; }

async function harness(overrides = {}, profileExtra = {}) {
  const documentListeners = new Map(), windowListeners = new Map(), timers = new Map();
  let timerId = 0, operation = 0;
  const calls = [], confirmations = [];
  const replies = { ...overrides };
  const profile = { id: 'synthetic-x', name: 'Synthetic player', tier: 'wood', rating: 600, wallet: { coins: 150, crowns: 0 }, ...profileExtra };
  class Element {
    constructor() { this.dataset = {}; this.listeners = new Map(); this.html = ''; }
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
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms, interval: false }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms, interval: true }); return id; },
    clearInterval(id) { timers.delete(id); },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    history: { pushState(_state, _title, url) { const parsed = new URL(url, location.origin); location.pathname = parsed.pathname; location.search = parsed.search; location.href = parsed.href; } },
    fetch: async () => { const result = replies.profile ? await replies.profile() : profile; return { ok: true, json: async () => structuredClone(result) }; },
    MegaGame: game, MegaNetwork: network,
    confirm(message) { confirmations.push(message); return replies.confirm ? replies.confirm(message) : true; },
    MegaAccount: { id: () => 'operation-' + ++operation, reset() {}, request: async () => ({}), session: async () => ({ providers: {}, csrf: 'synthetic-csrf' }) },
    legalDocuments: {},
  };
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
    qa, calls, confirmations, replies, main,
    online: action => clickAction('online', action), account: action => clickAction('account', action),
    cell(key) { const node = { dataset: { gbCell: key }, getAttribute: () => 'false' }; main.boardHost.listeners.get('click')({ target: { closest: () => node } }); },
    boardAction(action) { const node = { dataset: { gbAction: action } }; main.boardHost.listeners.get('click')({ target: { closest: () => node } }); },
    intervals: () => [...timers.values()].filter(timer => timer.interval),
    focus() { for (const fn of windowListeners.get('focus') || []) fn(); },
    destroy() { for (const fn of windowListeners.get('pagehide') || []) fn({ persisted: false }); },
  };
}

async function enterPlaying(ui) { ui.online('casual'); await flush(); assert.equal(ui.qa.state().onlineState.status, 'playing'); }

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
