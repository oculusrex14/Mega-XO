'use strict';
/* The shipped, player-visible rewarded-power controls: the Bot Undo and Tactical Power buttons in the
   match control zone, the disclosure that the two counter kinds cannot exist yet, and the reward copy
   that promises the earned item before an ad starts. Everything here drives the REAL src/app.js and
   the REAL src/powers-ui.js through the same browser-order script load the product uses. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const G = require('../src/game.js');
const R = require('../src/gameplay-rewind.js');
const PowersUI = require('../src/powers-ui.js');

/* Twenty committed plies: X then O every turn, the Bot completes Mini Boards 6-7-8 and wins the line. */
const BOT_LOSS = [[5, 7], [7, 0], [0, 0], [0, 1], [1, 7], [7, 1], [1, 8], [8, 0], [0, 8], [8, 1], [1, 6], [6, 0], [0, 6], [6, 1], [3, 7], [7, 2], [2, 1], [6, 2], [2, 6], [8, 2]];
const stateAfter = plies => BOT_LOSS.slice(0, plies).reduce((s, [b, c]) => G.apply(s, { b, c }), G.create('X'));
const movesAfter = plies => BOT_LOSS.slice(0, plies).map(([b, c], i) => ({ b, c, player: i % 2 === 0 ? 'X' : 'O' }));

/* ==============================================================================================
   PART 1: the shipped Tactical Power in the pure adapter (src/powers-ui.js)
   ============================================================================================== */

test('Tactical Power is shipped while the two counter kinds stay refused', async () => {
 assert.deepEqual([...PowersUI.SHIPPED], ['undo', 'hint']);
 const powers = PowersUI.createPowers({ enabled: () => true });
 assert.equal(powers.version, 'powers/v1');
 assert.deepEqual(Object.keys(powers).sort(), ['apply', 'eligibility', 'inventory', 'pacing', 'request', 'version']);

 /* A counter answers another player's power use, so it must not become earnable in Bot mode. */
 for (const kind of ['undoBlock', 'tacticalBlock']) {
  const asked = await powers.request(kind, { id: 'm-counters', state: stateAfter(10), mode: 'bot', first: 'X', revision: 10 });
  assert.equal(asked.earned, false, kind + ' must not be earnable');
  assert.equal(asked.reason, 'POWER_NOT_SHIPPED');
  assert.equal(powers.apply(kind, { id: 'm-counters', state: stateAfter(10), mode: 'bot', first: 'X', revision: 10 }).reason, 'POWER_NOT_SHIPPED');
 }
});

test('hint eligibility is pure, mode-gated and never available outside a Bot match', () => {
 const powers = PowersUI.createPowers({ enabled: () => true });
 const base = { id: 'm-1', state: stateAfter(10), mode: 'bot', first: 'X', practice: false, online: false, revision: 10 };
 const before = JSON.stringify(base);
 const seen = powers.eligibility(base);
 assert.equal(JSON.stringify(base), before, 'eligibility must not mutate its summary');
 assert.equal(seen.hint.eligible, true);
 assert.equal(seen.hint.activations, 0);
 assert.equal(seen.hint.deliveries, 0);
 assert.equal(seen.hint.remaining, 2, 'two deliveries per player per game');
 assert.equal(typeof seen.undo.eligible, 'boolean', 'the frozen undo shape is unchanged');

 /* Ranked, staked, direct, tournament, party, LAN, tutorial and practice: refused, and an unstated
    mode is not permission. */
 for (const mode of ['ranked', 'queue', 'direct', 'challenge', 'friend-stake', 'staked', 'tournament', 'party', 'lan', 'practice', 'tutorial', 'impossible', 'local', 'casual', undefined]) {
  const refused = powers.eligibility({ ...base, mode });
  assert.equal(refused.hint.eligible, false, 'mode ' + mode + ' must refuse Tactical Power');
  assert.equal(refused.hint.reason, 'MODE_NOT_ELIGIBLE');
 }
 for (const flag of ['practice', 'tutorial', 'online', 'ranked', 'queued', 'party', 'tournament', 'lan', 'direct', 'staked']) {
  assert.equal(powers.eligibility({ ...base, [flag]: true }).hint.eligible, false, 'flag ' + flag + ' must refuse Tactical Power');
 }
 /* A finished match, the Bot still thinking, and the opponent's turn are all refusals. */
 assert.equal(powers.eligibility({ ...base, state: stateAfter(20), revision: 20 }).hint.reason, 'MATCH_FINISHED');
 assert.equal(powers.eligibility({ ...base, botPending: true }).hint.reason, 'BOT_DECISION_IN_FLIGHT');
});

test('the Expert engine is the only source of the recommendation and it is always a legal square', () => {
 const bank = () => ({ version: 1, inventory: { ...R.freshInventory(), available: { ...R.freshInventory().available, hint: 1 } }, pacing: R.freshPacing(0), attempt: null, lastAttempt: null });
 const store = { state: bank() };
 const commits = [];
 const powers = PowersUI.createPowers({
  enabled: () => true, recommender: info => G.choose(info.state, 'Expert'),
  storage: { read: () => store.state, write: v => { store.state = v; } },
  commit: cmd => { commits.push(cmd); return true; }
 });
 const summary = { id: 'm-hint', state: stateAfter(10), mode: 'bot', first: 'X', revision: 10 };
 const applied = powers.apply('hint', summary);
 assert.equal(applied.applied, true);
 /* The recommendation is exactly what the canonical Expert engine returns for this board. */
 const engine = G.choose(stateAfter(10), 'Expert');
 assert.deepEqual(applied.square, { b: engine.b, c: engine.c });
 assert.ok(G.legal(stateAfter(10)).some(m => m.b === engine.b && m.c === engine.c));
 /* And the no-bank path refuses instead of inventing a suggestion. */
 const empty = PowersUI.createPowers({ enabled: () => true, recommender: info => G.choose(info.state, 'Expert') });
 assert.equal(empty.inventory().hint.available, 0);
 assert.equal(empty.apply('hint', summary).reason, 'NO_ENTITLEMENT');
 /* A ranked match is refused by the module's own mode gate, before any offer exists. */
 for (const mode of ['ranked', 'staked', 'tournament', 'lan', 'practice']) {
  assert.equal(powers.eligibility({ ...summary, mode }).hint.eligible, false, 'mode ' + mode + ' must refuse the control');
 }
 const gated = PowersUI.createPowers({ enabled: () => true, bridge: { present: async () => ({ outcome: 'earned' }), ready: () => true, consent: () => true } });
 return gated.request('hint', { ...summary, mode: 'ranked' }).then(refused => {
  assert.equal(refused.earned, false, 'a ranked match must never earn a Tactical Power');
  assert.equal(refused.entitlement, null);
 });
});

test('a hinted square comes from the engine, is legal, and caps refuse with the module reason', () => {
 const bankOne = () => ({ version: 1, inventory: { ...R.freshInventory(), available: { ...R.freshInventory().available, hint: 1 } }, pacing: R.freshPacing(0), attempt: null, lastAttempt: null });
 const store = { state: bankOne() };
 const commits = [];
 const powers = PowersUI.createPowers({
  enabled: () => true,
  recommender: info => G.choose(info.state, 'Expert'),
  storage: { read: () => store.state, write: v => { store.state = v; } },
  clock: () => 0,
  commit: cmd => { commits.push(cmd); return true; }
 });
 const context = () => ({ id: 'm-hint', state: stateAfter(10), mode: 'bot', first: 'X', revision: 10 });

 const applied = powers.apply('hint', context());
 assert.equal(applied.applied, true);
 const legal = G.legal(stateAfter(10)).map(m => m.b * 9 + m.c);
 assert.ok(legal.includes(applied.square.b * 9 + applied.square.c), 'the recommendation must be a legal square');
 assert.deepEqual(commits.map(c => c.type), ['hint']);
 /* The recommendation is advice: it changed no board, no turn and no move log. */
 assert.equal(commits[0].expectedRevision, 10);
 assert.equal(commits[0].powers.hint.X.delivered, 1, 'one delivery recorded');
 assert.equal(commits[0].powers.hint.X.activations, 1, 'one activation recorded');
 assert.equal(store.state.inventory.available.hint, 0, 'the earned item was consumed exactly once');

 /* The per-match caps are the pure module's: two deliveries inside three activations. */
 const powers2 = PowersUI.createPowers({
  enabled: () => true, recommender: () => G.legal(stateAfter(10))[0],
  storage: (s => ({ read: () => s.state, write: v => { s.state = v; } }))({ state: bankOne() }),
  commit: () => true
 });
 assert.equal(powers2.apply('hint', context()).applied, true);
 assert.equal(powers2.apply('hint', context()).reason, 'NO_ENTITLEMENT', 'no second earned item is invented');
});

test('the recommendation is re-validated and a bad engine answer is refused rather than shown', () => {
 const store = { state: { version: 1, inventory: { ...R.freshInventory(), available: { ...R.freshInventory().available, hint: 1 } }, pacing: R.freshPacing(0), attempt: null, lastAttempt: null } };
 let committed = null;
 const powers = PowersUI.createPowers({
  enabled: () => true,
  recommender: () => ({ b: 8, c: 8 }), /* a plausible square that is NOT legal here */
  storage: { read: () => store.state, write: v => { store.state = v; } },
  commit: cmd => { committed = cmd; return true; }
 });
 const refused = powers.apply('hint', { id: 'm-bad', state: stateAfter(10), mode: 'bot', first: 'X', revision: 10 });
 assert.equal(refused.applied, false);
 assert.equal(refused.reason, 'ENGINE_ILLEGAL_RECOMMENDATION');
 assert.equal(committed, null, 'an illegal recommendation must not reach the match');
 assert.equal(store.state.inventory.available.hint, 1, 'and must not consume the earned item');
 assert.equal(store.state.inventory.reserved.hint, null, 'nor leave a dangling reservation');

 const empty = PowersUI.createPowers({ enabled: () => true, recommender: () => null, storage: { read: () => store.state, write: v => { store.state = v; } }, commit: () => true });
 assert.equal(empty.apply('hint', { id: 'm-bad', state: stateAfter(10), mode: 'bot', first: 'X', revision: 10 }).reason, 'ENGINE_ILLEGAL_RECOMMENDATION');
});

test('a stale revision refuses the hint and a refused commit preserves the earned item', () => {
 const bankOne = () => ({ version: 1, inventory: { ...R.freshInventory(), available: { ...R.freshInventory().available, hint: 1 } }, pacing: R.freshPacing(0), attempt: null, lastAttempt: null });
 const store = { state: bankOne() };
 const powers = PowersUI.createPowers({
  enabled: () => true, recommender: () => G.legal(stateAfter(10))[0],
  storage: { read: () => store.state, write: v => { store.state = v; } },
  commit: () => false /* the live match moved underneath us */
 });
 const refused = powers.apply('hint', { id: 'm-late', state: stateAfter(10), mode: 'bot', first: 'X', revision: 10 });
 assert.equal(refused.applied, false);
 assert.equal(refused.reason, 'LIVE_MATCH_CHANGED');
 assert.equal(store.state.inventory.available.hint, 1, 'a technical failure returns the earned item');
 assert.equal(store.state.inventory.reserved.hint, null);

 const stale = PowersUI.createPowers({ enabled: () => true, recommender: () => null, live: () => ({ id: 'm-late', revision: 12 }), commit: () => true });
 assert.equal(stale.apply('hint', { id: 'm-late', state: stateAfter(10), mode: 'bot', first: 'X', revision: 10 }).reason, 'STALE_REVISION');
});

test('the Tactical Power ad promise is what the native lane settles, and a skipped ad grants nothing', async () => {
 let now = Date.parse('2026-10-14T12:00:00Z');
 let outcome = 'skipped';
 const host = { MegaAds: { platform: 'android', privacyState: () => ({ canRequestAds: true }), isReady: () => true, showRewarded: async () => ({ earned: outcome === 'earned', shown: true, outcome }) } };
 const store = { state: null };
 const powers = PowersUI.createPowers({
  enabled: () => true, clock: () => now, host, issueTicket: async () => 'TICKET-HINT',
  storage: { read: () => store.state, write: v => { store.state = v; } }
 });
 const context = { id: 'm-ad', state: stateAfter(10), mode: 'bot', first: 'X', revision: 10, consentReady: true, adReady: true };

 const skipped = await powers.request('hint', context);
 assert.equal(skipped.earned, false);
 assert.equal(skipped.entitlement, null, 'a shown-then-skipped ad must not bank a Tactical Power');
 assert.equal(powers.pacing().rewardedShownToday, 1, 'a shown ad still consumes one of the ten daily views');

 now = powers.pacing().nextEligibleAt;
 outcome = 'earned';
 const earned = await powers.request('hint', context);
 assert.equal(earned.earned, true);
 assert.equal(earned.entitlement, 'hint');
 assert.equal(powers.inventory().hint.available, 1);

 /* The refused counter kinds never even reach the provider: nothing is presented for them. */
 now = powers.pacing().nextEligibleAt;
 let presented = 0;
 host.MegaAds.showRewarded = async () => { presented++; return { earned: true, shown: true, outcome: 'EARNED' }; };
 const counter = await powers.request('tacticalBlock', context);
 assert.equal(counter.reason, 'POWER_NOT_SHIPPED');
 assert.equal(presented, 0, 'an unshipped counter must not start an ad');
});

/* ==============================================================================================
   PART 2: the player-visible controls in the live client (src/app.js)
   ============================================================================================== */

function createHarness({ powersEnabled = true, initialStore = new Map(), nativeBridge = null } = {}) {
 const bySelector = new Map();
 const makeEl = tag => {
  const el = {
   tagName: tag, dataset: {}, style: {}, attributes: new Map(), listeners: new Map(), children: [],
   hidden: false, inert: false, textContent: '', innerHTML: '', value: '', disabled: false, type: '',
   className: '', scrollTop: 0, isConnected: true,
   classList: {
    _s: new Set(),
    add(...c) { c.forEach(x => this._s.add(x)); }, remove(...c) { c.forEach(x => this._s.delete(x)); },
    toggle(c, v) { if (v) this.add(c); else this.remove(c); }, contains(c) { return this._s.has(c); }
   },
   addEventListener(t, f) { (this.listeners.get(t) || (this.listeners.set(t, []), this.listeners.get(t))).push(f); },
   removeEventListener(t, f) { const a = this.listeners.get(t); if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } },
   setAttribute(k, v) { this.attributes.set(k, String(v)); }, removeAttribute(k) { this.attributes.delete(k); },
   getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; },
   appendChild(c) { this.children.push(c); return c; }, append(...c) { this.children.push(...c); },
   replaceChildren(...c) { this.children = [...c]; },
   querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
   focus() {}, getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }, getClientRects() { return []; }
  };
  return el;
 };

 const doc = makeEl('document');
 doc.documentElement = makeEl('html'); doc.body = makeEl('body');
 doc.getElementById = id => { if (!bySelector.has('#' + id)) bySelector.set('#' + id, makeEl('div')); return bySelector.get('#' + id); };
 doc.createElement = tag => makeEl(tag);
 doc.querySelector = sel => { if (!bySelector.has(sel)) bySelector.set(sel, makeEl('div')); return bySelector.get(sel); };
 doc.querySelectorAll = () => [];

 const store = initialStore;
 if (!store.has('mega_v32_tutorial_seen')) store.set('mega_v32_tutorial_seen', '1');
 /* index.html ships the sheet and its backdrop hidden; mirror that so sheet state is honest. */
 doc.getElementById('sheet').hidden = true;
 doc.getElementById('sheetBackdrop').hidden = true;
 const localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };

 let clock = 1000000, nextId = 1;
 const timers = new Map();
 const setTimeoutFn = (fn, ms = 0) => { const id = nextId++; timers.set(id, { fn, at: clock + Math.max(0, Number(ms) || 0), repeat: null }); return id; };
 const clearTimeoutFn = id => timers.delete(id);
 const setIntervalFn = (fn, ms = 0) => { const id = nextId++; timers.set(id, { fn, at: clock + Math.max(0, Number(ms) || 0), repeat: Math.max(1, Number(ms) || 0) }); return id; };
 const clearIntervalFn = id => timers.delete(id);

 const sandbox = {
  console, Math, JSON, Date, Number, String, Object, Array, Error, TypeError, Promise, Set, Map, RegExp,
  isNaN, parseInt, parseFloat, MEGA_POWERS_ENABLED: powersEnabled
 };
 sandbox.globalThis = sandbox; sandbox.window = sandbox; sandbox.self = sandbox;
 sandbox.document = doc; doc.defaultView = sandbox;
 sandbox.localStorage = localStorage;
 sandbox.navigator = { onLine: true, vibrate() {}, clipboard: null };
 sandbox.location = { href: 'https://megaxo.online/' };
 sandbox.setTimeout = setTimeoutFn; sandbox.clearTimeout = clearTimeoutFn;
 sandbox.setInterval = setIntervalFn; sandbox.clearInterval = clearIntervalFn;
 sandbox.requestAnimationFrame = fn => setTimeoutFn(() => fn(clock), 16);
 sandbox.performance = { now: () => clock };
 sandbox.crypto = globalThis.crypto; sandbox.structuredClone = globalThis.structuredClone;
 sandbox.getComputedStyle = () => ({ getPropertyValue: () => '#fff' });
 sandbox.Event = class { constructor(type) { this.type = type; } };
 sandbox.MutationObserver = class { observe() {} disconnect() {} };
 sandbox.AudioContext = undefined; sandbox.matchMedia = () => null;
 if (nativeBridge) sandbox.MegaNativeReward = nativeBridge;

 const winListeners = new Map();
 sandbox.addEventListener = (t, f) => { (winListeners.get(t) || (winListeners.set(t, []), winListeners.get(t))).push(f); };
 sandbox.removeEventListener = (t, f) => { const a = winListeners.get(t); if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } };
 sandbox.dispatchEvent = e => { for (const f of winListeners.get(e?.type) || []) f(e); return true; };

 vm.createContext(sandbox);
 for (const file of ['src/game.js', 'src/domain.js', 'src/monetization.js', 'src/gameplay-rewind.js', 'src/powers-ui.js', 'src/icons.js', 'src/bot/contracts.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
 }
 vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8'), sandbox, { filename: 'src/app.js' });

 const clickAction = async (action, value = '') => {
  const listeners = doc.listeners.get('click') || [];
  let res;
  for (const fn of listeners) res = fn({ target: { closest: sel => (sel === '[data-action]' ? { dataset: { action, value }, disabled: false } : null) }, preventDefault() {}, stopPropagation() {} });
  return res;
 };
 const zone = doc.querySelector('.match-controls');
 return {
  sandbox, doc, store, zone, clickAction,
  controlsMarkup: () => doc.querySelector('#matchPowers').innerHTML,
  /* The real board: `buildBoard()` appends 9 Mini Boards to #board, each holding 9 cell buttons, so
     a click here is the same handler path a player's tap uses. */
  playCell(b, c) {
   const board = doc.getElementById('board');
   const cell = board.children[b] && board.children[b].children[c];
   assert.ok(cell, 'the board must expose cell ' + b + ',' + c);
   for (const fn of cell.listeners.get('click') || []) fn({ preventDefault() {}, stopPropagation() {} });
  }
 };
}

test('the Bot Undo control is visible in the match control zone with its charges, not buried in the sheet', async () => {
 const store = new Map();
 const h = createHarness({ initialStore: store });
 h.clickAction('mode', 'bot');
 h.clickAction('difficulty', 'Beginner');
 h.clickAction('start');

 /* Two plies is below the eight-ply floor, so no control is offered yet. */
 const markup = h.controlsMarkup();
 assert.match(markup, /data-action="botundo"[^>]* disabled/, 'Undo is visible but disabled before the first-use ply');

 /* Preseed an eight-ply live Bot match with one banked Undo package and one banked Tactical Power. */
 const live = JSON.parse(store.get('mega_v32_state'));
 live.offlineMatch = {
  id: 'ui-bot-match', first: 'X', mode: 'bot', difficulty: 'Medium', practice: false,
  moves: movesAfter(8), active: 20, turnLimit: 0, turnRemaining: 0,
  powers: { ...R.freshMatchPowers(), botUndo: { packages: 1, charges: 2, presses: 0 } }
 };
 store.set('mega_v32_state', JSON.stringify(live));
 store.set('mega_v52_powers', JSON.stringify({ version: 1, inventory: { ...R.freshInventory(), available: { ...R.freshInventory().available, hint: 1 } }, pacing: R.freshPacing(0), attempt: null, lastAttempt: null }));

 const h2 = createHarness({ initialStore: store });
 await h2.sandbox.MegaApp.resumeOffline();
 const markup2 = h2.controlsMarkup();
 assert.ok(markup2.includes('data-action="botundo"'), 'the visible Undo control must render in the match control zone');
 assert.ok(markup2.includes('data-action="bothint"'), 'the visible Tactical Power control must render');
 assert.ok(markup2.includes('2 earned charges'), 'the control must show its remaining charges');
 /* It is the match control zone that carries it, beside Rules/Restart/Stats — not only the sheet. */
 const bar = h2.sandbox.document.querySelector('#matchPowers');
 assert.equal(bar.hidden, false, 'the dedicated bar above the control zone is visible');
 const sheet = h2.sandbox.document.getElementById('sheet');
 assert.equal(sheet.hidden, true, 'and it is visible without opening the stats sheet');
});

test('a Tutorial practice and an online match never render a rewarded control', async () => {
 const store = new Map();
 const h = createHarness({ initialStore: store });
 const live = JSON.parse(store.get('mega_v32_state'));
 live.offlineMatch = { id: 'ui-practice-match', first: 'X', mode: 'bot', difficulty: 'Beginner', practice: true, moves: movesAfter(10), active: 20, turnLimit: 0, turnRemaining: 0 };
 store.set('mega_v32_state', JSON.stringify(live));
 store.set('mega_v52_powers', JSON.stringify({ version: 1, inventory: { ...R.freshInventory(), available: { ...R.freshInventory().available, hint: 1 } }, pacing: R.freshPacing(0), attempt: null, lastAttempt: null }));

 const h2 = createHarness({ initialStore: store });
 await h2.sandbox.MegaApp.resumeOffline();
 assert.equal(h2.controlsMarkup(), '', 'tutorial practice must offer no rewarded control at all');
});

test('no charge banked: the control offers the ad and states exactly what it earns before it starts', async () => {
 const h = createHarness({ nativeBridge: { present: async () => ({ outcome: 'earned' }), isReady: () => true, privacyState: () => ({ canRequestAds: true }) } });
 const store = h.store;
 const live = JSON.parse(store.get('mega_v32_state'));
 live.offlineMatch = { id: 'ui-ad-match', first: 'X', mode: 'bot', difficulty: 'Medium', practice: false, moves: movesAfter(10), active: 20, turnLimit: 0, turnRemaining: 0, powers: R.freshMatchPowers() };
 store.set('mega_v32_state', JSON.stringify(live));

 const h2 = createHarness({ initialStore: store, nativeBridge: { present: async () => ({ outcome: 'earned' }), isReady: () => true, privacyState: () => ({ canRequestAds: true }) } });
 await h2.sandbox.MegaApp.resumeOffline();
 const before = h2.sandbox.MegaXO.getState();
 assert.ok(h2.controlsMarkup().includes('Optional rewarded ad'), 'with no charge the control offers the ad');

 /* The promise is stated BEFORE the ad starts, in the sheet the player answers. */
 const pendingClick = h2.clickAction('botundo');
 const sheetBody = h2.sandbox.document.getElementById('sheetBody').innerHTML;
 assert.ok(sheetBody.includes('Watch one optional ad to rewind your last move and the Bot\'s reply'), 'the earned rewind must be promised first');
 assert.ok(sheetBody.includes('two Undo presses'), 'the earned item is what is promised, not an unconditional rewind');
 assert.ok(sheetBody.includes('Skipping the ad earns nothing'), 'a skipped ad must be disclosed as earning nothing');
 assert.equal(h2.sandbox.MegaXO.getState().moves.length, 10, 'nothing is rewound before the player starts the ad');

 await h2.clickAction('rewardyes');
 await pendingClick;
 /* The earned package is redeemed and the real rewind landed: 10 -> 8 plies. */
 assert.equal(h2.sandbox.MegaXO.getState().moves.length, 8, 'a completed ad must actually deliver the earned rewind');
 const saved = JSON.parse(h2.store.get('mega_v32_state')).offlineMatch;
 assert.equal(saved.powers.botUndo.charges, 1, 'the two-charge package leaves one press');
 assert.notEqual(before, h2.sandbox.MegaXO.getState());
});

test('a declined ad and a shown-then-skipped ad both change the board by nothing', async () => {
 const store = new Map();
 const h = createHarness({ nativeBridge: { present: async () => ({ outcome: 'skipped' }), isReady: () => true, privacyState: () => ({ canRequestAds: true }) } });
 const live = JSON.parse(h.store.get('mega_v32_state'));
 live.offlineMatch = { id: 'ui-skip-match', first: 'X', mode: 'bot', difficulty: 'Medium', practice: false, moves: movesAfter(10), active: 20, turnLimit: 0, turnRemaining: 0, powers: R.freshMatchPowers() };
 h.store.set('mega_v32_state', JSON.stringify(live));
 store.set('mega_v32_state', JSON.stringify(live));

 const h2 = createHarness({ initialStore: store, nativeBridge: { present: async () => ({ outcome: 'skipped' }), isReady: () => true, privacyState: () => ({ canRequestAds: true }) } });
 await h2.sandbox.MegaApp.resumeOffline();

 /* 1. The player declines at the disclosure: no ad, no grant, no board change. */
 const decline = h2.clickAction('botundo');
 await h2.clickAction('rewardno');
 await decline;
 assert.equal(h2.sandbox.MegaXO.getState().moves.length, 10, 'declining must not rewind anything');
 assert.equal(JSON.parse(h2.store.get('mega_v32_state')).offlineMatch.powers.botUndo.charges, 0, 'declining must not grant a charge');

 /* 2. The player starts the ad but skips it: still no grant and still no board change. */
 const skip = h2.clickAction('botundo');
 await h2.clickAction('rewardyes');
 await skip;
 assert.equal(h2.sandbox.MegaXO.getState().moves.length, 10, 'a skipped ad must not rewind the board');
 assert.equal(JSON.parse(h2.store.get('mega_v32_state')).offlineMatch.powers.botUndo.charges, 0, 'a skipped ad must not grant');
 /* The exposure was booked truthfully rather than silently discarded. */
 assert.equal(JSON.parse(h2.store.get('mega_v52_powers')).pacing.shown, 1, 'a shown ad consumes one daily view');
});

test('Tactical Power highlights an engine-legal square and still leaves every legal square playable', async () => {
 const store = new Map();
 const h = createHarness();
 const live = JSON.parse(h.store.get('mega_v32_state'));
 live.offlineMatch = { id: 'ui-hint-match', first: 'X', mode: 'bot', difficulty: 'Medium', practice: false, moves: movesAfter(10), active: 20, turnLimit: 0, turnRemaining: 0, powers: R.freshMatchPowers() };
 h.store.set('mega_v32_state', JSON.stringify(live));
 store.set('mega_v32_state', JSON.stringify(live));
 store.set('mega_v52_powers', JSON.stringify({ version: 1, inventory: { ...R.freshInventory(), available: { ...R.freshInventory().available, hint: 1 } }, pacing: R.freshPacing(0), attempt: null, lastAttempt: null }));

 const h2 = createHarness({ initialStore: store });
 await h2.sandbox.MegaApp.resumeOffline();
 const state = h2.sandbox.MegaXO.getState();
 const legal = G.legal(state);
 assert.ok(h2.controlsMarkup().includes('data-action="bothint"'), 'Tactical Power is offered when a banked item exists');

 await h2.clickAction('bothint');
 const chosen = h2.sandbox.MegaXO.getState();
 /* The recommendation came from the canonical Expert engine for this exact board. */
 const expected = G.choose(state, 'Expert');
 const recommended = legal.find(m => m.b === expected.b && m.c === expected.c);
 assert.ok(recommended, 'the engine recommendation must be a legal square');
 const note = h2.sandbox.document.getElementById('previewText').textContent;
 assert.ok(note.includes('Tactical Power recommends'), 'the recommendation is shown as text');
 assert.ok(note.includes(G.NAMES[recommended.b].toLowerCase()) && note.includes(G.NAMES[recommended.c].toLowerCase()), 'the text names the square');
 assert.ok(note.includes('Any legal cell still plays'), 'the player keeps every legal choice');
 /* It is advice, not a forced move: the board, the turn and the move log are untouched, and any
    other legal square is still accepted by the same move path. */
 assert.equal(chosen.moves.length, state.moves.length, 'a hint is not a move');
 assert.equal(chosen.turn, state.turn);
 assert.equal(JSON.parse(store.get('mega_v52_powers')).inventory.available.hint, 0, 'exactly one earned item was consumed');
 const alternative = legal.find(m => m.b !== recommended.b || m.c !== recommended.c);
 assert.ok(alternative, 'the fixture must have more than one legal square');
 /* Every legal square stays available: the recommendation forbids nothing, so the alternative the
    player might prefer is still legal and a real tap on it is actually played. */
 const after = G.legal(chosen);
 assert.equal(after.length, legal.length, 'a hint must not remove any legal square');
 assert.ok(after.some(m => m.b === alternative.b && m.c === alternative.c), 'the player may still choose another square');
 h2.playCell(alternative.b, alternative.c);
 const played = h2.sandbox.MegaXO.getState();
 assert.equal(played.moves.length, chosen.moves.length + 1, 'a legal tap after a hint must be accepted');
 assert.deepEqual({ b: played.moves.at(-1).b, c: played.moves.at(-1).c }, { b: alternative.b, c: alternative.c }, 'the player played their own square, not the recommendation');
});

test('an exhausted Undo package stays disabled, and the stats sheet keeps its own entry point', async () => {
 const store = new Map();
 const h = createHarness();
 const live = JSON.parse(h.store.get('mega_v32_state'));
 /* The package is already granted and both presses are spent: the control must not pretend a third
    press exists, and the honest ad path must refuse it too. */
 live.offlineMatch = { id: 'ui-capped-match', first: 'X', mode: 'bot', difficulty: 'Medium', practice: false, moves: movesAfter(10), active: 20, turnLimit: 0, turnRemaining: 0, powers: { ...R.freshMatchPowers(), botUndo: { packages: 1, charges: 0, presses: 2 } } };
 h.store.set('mega_v32_state', JSON.stringify(live));
 store.set('mega_v32_state', JSON.stringify(live));
 store.set('mega_v52_powers', JSON.stringify({ version: 1, inventory: { ...R.freshInventory(), available: { ...R.freshInventory().available, hint: 1 } }, pacing: R.freshPacing(0), attempt: null, lastAttempt: null }));

 const h2 = createHarness({ initialStore: store, nativeBridge: { present: async () => ({ outcome: 'earned' }), isReady: () => true, privacyState: () => ({ canRequestAds: true }) } });
 await h2.sandbox.MegaApp.resumeOffline();
 const markup = h2.controlsMarkup();
 assert.match(markup, /data-action="botundo"[^>]* disabled/, 'a spent package must not offer an enabled Undo');
 assert.ok(markup.includes('data-action="bothint"'), 'Tactical Power is still offered by its own caps');
 assert.ok(markup.includes('data-action="powercounters"'), 'the counter disclosure stays reachable');

 /* The stats sheet keeps the same gated Undo entry point for a banked charge. */
 const h3store = new Map();
 const h3 = createHarness();
 const h3live = JSON.parse(h3.store.get('mega_v32_state'));
 h3live.offlineMatch = { id: 'ui-sheet-match', first: 'X', mode: 'bot', difficulty: 'Medium', practice: false, moves: movesAfter(10), active: 20, turnLimit: 0, turnRemaining: 0, powers: { ...R.freshMatchPowers(), botUndo: { packages: 1, charges: 1, presses: 1 } } };
 h3.store.set('mega_v32_state', JSON.stringify(h3live));
 h3store.set('mega_v32_state', JSON.stringify(h3live));
 const h4 = createHarness({ initialStore: h3store });
 await h4.sandbox.MegaApp.resumeOffline();
 h4.clickAction('matchstats');
 const body = h4.sandbox.document.getElementById('sheetBody').innerHTML;
 assert.ok(body.includes('data-action="undoingame"'), 'the sheet still offers the banked Undo');
 assert.ok(body.includes('Undo last turn (1 left)'));
});

test('the two counter kinds are disclosed as unavailable and are never offered as controls', async () => {
 const h = createHarness();
 const store = h.store;
 const live = JSON.parse(store.get('mega_v32_state'));
 live.offlineMatch = { id: 'ui-counter-match', first: 'X', mode: 'bot', difficulty: 'Medium', practice: false, moves: movesAfter(10), active: 20, turnLimit: 0, turnRemaining: 0, powers: R.freshMatchPowers() };
 store.set('mega_v32_state', JSON.stringify(live));
 store.set('mega_v52_powers', JSON.stringify({ version: 1, inventory: R.freshInventory(), pacing: R.freshPacing(0), attempt: null, lastAttempt: null }));

 const h2 = createHarness({ initialStore: store });
 await h2.sandbox.MegaApp.resumeOffline();
 const markup = h2.controlsMarkup();
 assert.match(markup, /power-card--undoBlock[^>]* disabled/, 'Undo Block stays visibly unavailable');
 assert.match(markup, /power-card--tacticalBlock[^>]* disabled/, 'Hint Block stays visibly unavailable');
 assert.ok(markup.includes('data-action="powercounters"'), 'the honest disclosure entry point is present');

 /* The disclosure states the real reason instead of faking a counter. */
 h2.clickAction('powercounters');
 const body = h2.sandbox.document.getElementById('sheetBody').innerHTML;
 assert.ok(body.includes('Counter controls are unavailable until authoritative resolution is supported'));
 assert.ok(body.includes('two-player Casual match with authoritative resolution'));
 assert.ok(body.includes('The Bot never secretly gains counter powers'));
});

test('the kill switch off removes every control and leaves observable behaviour as it is today', async () => {
 const store = new Map();
 const h = createHarness({ powersEnabled: false, initialStore: store });
 assert.equal(h.sandbox.window.MegaPowers, undefined, 'no powers object is installed with the switch off');

 const live = JSON.parse(store.get('mega_v32_state'));
 live.offlineMatch = { id: 'ui-off-match', first: 'X', mode: 'bot', difficulty: 'Medium', practice: false, moves: movesAfter(10), active: 20, turnLimit: 0, turnRemaining: 0 };
 store.set('mega_v32_state', JSON.stringify(live));
 store.set('mega_v52_powers', JSON.stringify({ version: 1, inventory: { ...R.freshInventory(), available: { ...R.freshInventory().available, hint: 1 } }, pacing: R.freshPacing(0), attempt: null, lastAttempt: null }));

 const h2 = createHarness({ powersEnabled: false, initialStore: store });
 await h2.sandbox.MegaApp.resumeOffline();
 assert.equal(h2.controlsMarkup(), '', 'with the switch off no control markup may exist');
 assert.equal(h2.sandbox.document.querySelector('.match-controls').children.length, 0, 'and no host row is added');
 const state = h2.sandbox.MegaXO.getState();
 assert.equal(state.moves.length, 10, 'the board behaves exactly as before');
});

test('the localStorage kill switch is a real off switch and the host flag can disable the lane', async () => {
 const store = new Map();
 const h = createHarness({ powersEnabled: true, initialStore: store });
 store.set('mega_v52_powers_enabled', 'off');
 const h2 = createHarness({ powersEnabled: true, initialStore: store });
 assert.equal(h2.sandbox.window.MegaPowers, undefined, 'localStorage off must disable the lane');

 /* And the host flag alone is enough, which the previously non-tri-state check ignored. */
 const off = createHarness({ powersEnabled: false });
 assert.equal(off.sandbox.window.MegaPowers, undefined);
 assert.ok(h.sandbox.window.MegaPowers, 'an unset preference keeps the shipped feature available');
});
