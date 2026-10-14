'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const G = require('../src/game.js');
const R = require('../src/gameplay-rewind.js');
const M = require('../src/monetization.js');
const PowersUI = require('../src/powers-ui.js');

/* 20 committed plies: X then O every turn, the Bot completes Mini Boards 6-7-8 and wins the line. */
const BOT_LOSS = [[5,7],[7,0],[0,0],[0,1],[1,7],[7,1],[1,8],[8,0],[0,8],[8,1],[1,6],[6,0],[0,6],[6,1],[3,7],[7,2],[2,1],[6,2],[2,6],[8,2]];

function buildState(moves, first = 'X') {
 let s = G.create(first);
 for (const m of moves) {
  s = G.apply(s, Array.isArray(m) ? { b: m[0], c: m[1] } : { b: m.b, c: m.c });
 }
 return s;
}

/* ==============================================================================================
   PART 1: PURE DOM-FREE ADAPTER CONTRACT TESTS (src/powers-ui.js)
   ============================================================================================== */

test('window.MegaPowers frozen contract matches exact names and shapes', () => {
 const powers = PowersUI.createPowers({ enabled: () => true });
 assert.equal(powers.version, 'powers/v1');
 assert.deepEqual(Object.keys(powers).sort(), ['apply', 'eligibility', 'inventory', 'pacing', 'request', 'version']);
 const inv = powers.inventory();
 assert.equal(inv.version, 'powers/inventory/v1');
 for (const k of ['undo', 'hint', 'undoBlock', 'tacticalBlock']) {
  assert.ok(k in inv, 'missing kind ' + k);
  assert.equal(typeof inv[k].available, 'number');
  assert.equal(inv[k].reserved, null);
 }
 const pac = powers.pacing();
 assert.equal(typeof pac.rewardedShownToday, 'number');
 assert.equal(pac.rewardedDayCap, 10);
 assert.equal(typeof pac.nextEligibleAt, 'number');
});

test('eligibility is pure and side-effect free, refusing denied modes', () => {
 const powers = PowersUI.createPowers({ enabled: () => true });
 const terminalState = buildState(BOT_LOSS);
 const baseMatch = {
  id: 'match-1',
  state: terminalState,
  mode: 'bot',
  first: 'X',
  practice: false,
  online: false,
  reason: 'line',
  charges: 0,
  used: 0
 };

 const snapshotBefore = JSON.stringify(baseMatch);
 const elig1 = powers.eligibility(baseMatch);
 assert.equal(JSON.stringify(baseMatch), snapshotBefore, 'eligibility must not mutate its input');
 assert.equal(elig1.undo.eligible, true, 'terminal bot line loss should be eligible for offer');
 assert.equal(elig1.undo.charges, 0);
 assert.equal(elig1.undo.ply, 20);

 /* Denied modes */
 for (const mode of ['ranked', 'queue', 'direct', 'staked', 'tournament', 'party', 'lan', 'practice']) {
  const res = powers.eligibility({ ...baseMatch, mode });
  assert.equal(res.undo.eligible, false, 'mode ' + mode + ' must be refused');
 }
 for (const flag of ['practice', 'online', 'ranked', 'queued', 'party', 'tournament', 'lan', 'direct', 'staked']) {
  const res = powers.eligibility({ ...baseMatch, [flag]: true });
  assert.equal(res.undo.eligible, false, 'flag ' + flag + ' must refuse eligibility');
 }
});

test('the 8-ply first-use threshold and second charge surviving shrink', () => {
 const powers = PowersUI.createPowers({ enabled: () => true });
 /* 6 plies with 0 used charges => not eligible for first use */
 const sixPlies = buildState(BOT_LOSS.slice(0, 6));
 const elig6First = powers.eligibility({
  state: sixPlies,
  mode: 'bot',
  first: 'X',
  charges: 2,
  used: 0
 });
 assert.equal(elig6First.undo.eligible, false, '6 plies must not be eligible for first press');

 /* 8 plies with 0 used charges => eligible for first use */
 const eightPlies = buildState(BOT_LOSS.slice(0, 8));
 const elig8First = powers.eligibility({
  state: eightPlies,
  mode: 'bot',
  first: 'X',
  charges: 2,
  used: 0
 });
 assert.equal(elig8First.undo.eligible, true, '8 plies must be eligible for first press');

 /* After board shrinks: 6 plies with 1 used charge and 1 remaining => second charge IS usable */
 const elig6Second = powers.eligibility({
  state: sixPlies,
  mode: 'bot',
  first: 'X',
  charges: 1,
  used: 1
 });
 assert.equal(elig6Second.undo.eligible, true, 'second charge must remain usable after board shrinks');

 /* 2 used charges, 0 remaining => cap reached */
 const eligCapped = powers.eligibility({
  state: sixPlies,
  mode: 'bot',
  first: 'X',
  charges: 0,
  used: 2
 });
 assert.equal(eligCapped.undo.eligible, false, 'cap reached must not be eligible');
});

test('request fails closed without native bridge, inventory or quota, and handles shown-not-earned', async () => {
 let now = Date.parse('2026-10-14T12:00:00Z');
 const terminalState = buildState(BOT_LOSS);
 const context = {
  id: 'm-req-1',
  state: terminalState,
  mode: 'bot',
  first: 'X',
  practice: false,
  online: false,
  reason: 'line',
  charges: 0,
  used: 0,
  revision: 20
 };

 /* 1. No native bridge => fails closed */
 const noBridgePowers = PowersUI.createPowers({ enabled: () => true, clock: () => now, bridge: null });
 const noBridgeRes = await noBridgePowers.request('undo', context);
 assert.equal(noBridgeRes.earned, false);
 assert.equal(noBridgeRes.reason, 'NATIVE_BRIDGE_UNAVAILABLE');
 assert.equal(noBridgeRes.entitlement, null);

 /* 2. Bridge reports shown but not earned (e.g. user skipped ad) => exposure consumed, NO item granted */
 let bridgeOutcome = 'skipped';
 const fakeBridge = {
  present: async () => ({ outcome: bridgeOutcome }),
  ready: () => true,
  consent: () => true
 };

 const powersWithBridge = PowersUI.createPowers({ enabled: () => true, clock: () => now, bridge: fakeBridge });
 const skippedRes = await powersWithBridge.request('undo', context);
 assert.equal(skippedRes.earned, false, 'skipped ad must not grant');
 assert.equal(skippedRes.entitlement, null);
 assert.equal(powersWithBridge.pacing().rewardedShownToday, 1, 'skipped ad MUST consume exposure slot');
 assert.equal(powersWithBridge.inventory().undo.available, 0, 'skipped ad must NOT grant inventory');

 /* 3. Bridge reports no-fill or failed => consumes NOTHING */
 bridgeOutcome = 'no-fill';
 now += 3 * 60 * 1000; // pass spacing
 const noFillRes = await powersWithBridge.request('undo', context);
 assert.equal(noFillRes.earned, false);
 assert.equal(powersWithBridge.pacing().rewardedShownToday, 1, 'no-fill must NOT consume exposure slot');

 /* 4. Native confirmed EARNED => grants entitlement and consumes slot */
 bridgeOutcome = 'earned';
 now += 3 * 60 * 1000;
 const earnedRes = await powersWithBridge.request('undo', context);
 assert.equal(earnedRes.earned, true);
 assert.equal(earnedRes.entitlement, 'undo');
 assert.equal(powersWithBridge.pacing().rewardedShownToday, 2);
 assert.equal(powersWithBridge.inventory().undo.available, 1, 'earned ad must grant banked inventory');

 /* 5. Bank is now full (capacity 1). Next request before using it fails closed with BANK_FULL */
 now += 3 * 60 * 1000;
 const bankFullRes = await powersWithBridge.request('undo', context);
 assert.equal(bankFullRes.earned, false);
 assert.equal(bankFullRes.reason, 'BANK_FULL');
});

test('two earned presses per package and revision fencing in apply', () => {
 const now = Date.parse('2026-10-14T12:00:00Z');
 const terminalState = buildState(BOT_LOSS);
 let liveState = terminalState;
 let committedRewinds = 0;

 const storageData = {};
 const powers = PowersUI.createPowers({
  enabled: () => true,
  clock: () => now,
  storage: { read: () => storageData.powers, write: s => { storageData.powers = s; } },
  commit: cmd => {
   if (cmd.type === 'grant') return true;
   if (cmd.type === 'rewind') {
    committedRewinds++;
    liveState = cmd.state;
    return true;
   }
   return false;
  }
 });

 /* Pre-grant a package of 2 charges (as if an ad was earned and package granted) */
 const matchContext = {
  id: 'match-apply-1',
  state: liveState,
  mode: 'bot',
  first: 'X',
  practice: false,
  online: false,
  reason: 'line',
  revision: 20,
  powers: {
   version: 1,
   botUndo: { packages: 1, charges: 2, presses: 0 }
  }
 };

 /* 1. Stale revision refusal */
 const staleRes = powers.apply('undo', { ...matchContext, revision: 19 });
 assert.equal(staleRes.applied, false);
 assert.equal(staleRes.reason, 'STALE_REVISION');

 /* 2. First press from terminal loss: 20 plies -> 18 plies */
 const firstApply = powers.apply('undo', matchContext);
 assert.equal(firstApply.applied, true);
 assert.equal(firstApply.reason, null);
 assert.equal(firstApply.revision, 21);
 assert.equal(committedRewinds, 1);
 assert.equal(liveState.moves.length, 18);
 assert.equal(liveState.turn, 'X');
 assert.equal(liveState.winner, null);

 /* 3. Second press from 18 plies (charges 1 remaining, board shrank) */
 const secondMatchContext = {
  ...matchContext,
  state: liveState,
  revision: 21,
  reason: null,
  powers: {
   version: 1,
   botUndo: { packages: 1, charges: 1, presses: 1 }
  }
 };

 const secondApply = powers.apply('undo', secondMatchContext);
 assert.equal(secondApply.applied, true);
 assert.equal(secondApply.reason, null);
 assert.equal(committedRewinds, 2);
 assert.equal(liveState.moves.length, 16);

 /* 4. Third press: charges exhausted (0 left) => refused */
 const thirdMatchContext = {
  ...matchContext,
  state: liveState,
  revision: 22,
  powers: {
   version: 1,
   botUndo: { packages: 1, charges: 0, presses: 2 }
  }
 };
 const thirdApply = powers.apply('undo', thirdMatchContext);
 assert.equal(thirdApply.applied, false);
 assert.equal(thirdApply.reason, 'NO_CHARGES');
});

test('aggregate 10-per-UTC-day ceiling across mixed kinds and UTC rollover', async () => {
 let now = Date.parse('2026-10-14T08:00:00Z');
 const fakeBridge = {
  present: async () => ({ outcome: 'earned' }),
  ready: () => true,
  consent: () => true
 };

 const storageData = {};
 const powers = PowersUI.createPowers({
  enabled: () => true,
  clock: () => now,
  storage: { read: () => storageData.powers, write: s => { storageData.powers = s; } },
  bridge: fakeBridge
 });

 /* Earn 10 presentations across mixed kinds, 2 minutes apart.
    After each earned undo, we empty the bank so the next request is not blocked by BANK_FULL. */
 for (let i = 0; i < 10; i++) {
  const pac = powers.pacing();
  assert.equal(pac.rewardedShownToday, i, 'presentation ' + i + ' pacing count');
  assert.equal(pac.rewardedDayCap, 10);

  const context = {
   id: 'match-pacing-' + i,
   state: buildState(BOT_LOSS),
   mode: 'bot',
   first: 'X',
   reason: 'line',
   revision: 20
  };

  const res = await powers.request('undo', context);
  assert.equal(res.earned, true, 'presentation ' + i + ' must earn');

  /* Redeem / clear the banked entitlement so bank is ready for the next slot */
  const inv = storageData.powers.inventory;
  inv.available.undo = 0; // empty bank to allow next ad

  now += 2 * 60 * 1000 + 100; // pass 2-minute spacing
 }

 /* 11th request on the same UTC day must be refused by DAY_CAP */
 const context11 = {
  id: 'match-pacing-11',
  state: buildState(BOT_LOSS),
  mode: 'bot',
  first: 'X',
  reason: 'line',
  revision: 20
 };
 const res11 = await powers.request('undo', context11);
 assert.equal(res11.earned, false);
 assert.equal(res11.reason, 'DAY_CAP');
 assert.equal(powers.pacing().rewardedShownToday, 10);

 /* Roll over past UTC midnight (2026-10-15T00:00:01Z) */
 now = Date.parse('2026-10-15T00:00:01Z');
 const rolloverPacing = powers.pacing();
 assert.equal(rolloverPacing.rewardedShownToday, 0, 'daily count must roll over to 0 at UTC midnight');
 assert.equal(rolloverPacing.rewardedDayCap, 10);

 /* A fresh request is now permitted on the new day */
 const resRollover = await powers.request('undo', context11);
 assert.equal(resRollover.earned, true, 'request on new UTC day must succeed');
 assert.equal(powers.pacing().rewardedShownToday, 1);
});

test('kill switch defaults to OFF and leaves observable behaviour unchanged', async () => {
 const offPowers = PowersUI.createPowers({ enabled: () => false });
 assert.equal(offPowers.version, 'powers/v1');

 const context = {
  id: 'match-off-1',
  state: buildState(BOT_LOSS),
  mode: 'bot',
  first: 'X',
  reason: 'line',
  revision: 20
 };

 const elig = offPowers.eligibility(context);
 assert.equal(elig.undo.eligible, false);
 assert.equal(elig.undo.reason, 'FEATURE_DISABLED');

 const req = await offPowers.request('undo', context);
 assert.equal(req.earned, false);
 assert.equal(req.reason, 'FEATURE_DISABLED');

 const app = offPowers.apply('undo', context);
 assert.equal(app.applied, false);
 assert.equal(app.reason, 'FEATURE_DISABLED');
});

/* ==============================================================================================
   PART 2: LIVE APP HARNESS INTEGRATION TESTS (src/app.js)
   ============================================================================================== */

function createHarness({ powersEnabled = false, initialStore = new Map() } = {}) {
 const byId = new Map();
 const makeEl = tag => {
  const el = {
   tagName: tag, dataset: {}, style: {}, attributes: new Map(), listeners: new Map(), children: [],
   hidden: false, inert: false, textContent: '', innerHTML: '', value: '', disabled: false, type: '',
   className: '', scrollTop: 0, isConnected: true,
   classList: {
    _s: new Set(),
    add(...c) { c.forEach(x => this._s.add(x)); },
    remove(...c) { c.forEach(x => this._s.delete(x)); },
    toggle(c, v) { if (v === undefined ? v : !v) this.add(c); else this.remove(c); },
    contains(c) { return this._s.has(c); }
   },
   addEventListener(t, f) { (this.listeners.get(t) || (this.listeners.set(t, []), this.listeners.get(t))).push(f); },
   removeEventListener(t, f) { const a = this.listeners.get(t); if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } },
   setAttribute(k, v) { this.attributes.set(k, String(v)); },
   removeAttribute(k) { this.attributes.delete(k); },
   getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; },
   appendChild(c) { this.children.push(c); return c; },
   append(...c) { this.children.push(...c); },
   replaceChildren(...c) { this.children = [...c]; },
   querySelector() { return null; },
   querySelectorAll() { return []; },
   closest() { return null; },
   focus() {},
   getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
   getClientRects() { return []; }
  };
  return el;
 };

 const doc = makeEl('document');
 doc.documentElement = makeEl('html');
 doc.body = makeEl('body');
 doc.getElementById = id => {
  if (!byId.has(id)) byId.set(id, makeEl('div'));
  return byId.get(id);
 };
 doc.createElement = tag => makeEl(tag);
 doc.querySelector = sel => {
  if (sel && sel.startsWith('#')) return doc.getElementById(sel.slice(1));
  return makeEl('div');
 };
 doc.querySelectorAll = () => [];

 const store = initialStore;
 if (!store.has('mega_v32_tutorial_seen')) store.set('mega_v32_tutorial_seen', '1');
 if (powersEnabled) store.set('mega_v52_powers_enabled', 'on');

 const localStorage = {
  getItem: k => store.has(k) ? store.get(k) : null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k)
 };

 let clock = 1000000, nextId = 1;
 const timers = new Map();
 const setTimeoutFn = (fn, ms = 0) => {
  const id = nextId++;
  timers.set(id, { fn, at: clock + Math.max(0, Number(ms) || 0), repeat: null });
  return id;
 };
 const clearTimeoutFn = id => { timers.delete(id); };
 const setIntervalFn = (fn, ms = 0) => {
  const id = nextId++;
  timers.set(id, { fn, at: clock + Math.max(0, Number(ms) || 0), repeat: Math.max(1, Number(ms) || 0) });
  return id;
 };
 const clearIntervalFn = id => { timers.delete(id); };

 const advance = ms => {
  const target = clock + ms;
  for (;;) {
   let pick = null;
   for (const [id, t] of timers) {
    if (t.at <= target && (!pick || t.at < pick[1].at)) pick = [id, t];
   }
   if (!pick) break;
   clock = pick[1].at;
   if (pick[1].repeat === null) timers.delete(pick[0]);
   else pick[1].at = clock + pick[1].repeat;
   pick[1].fn(clock);
  }
  clock = target;
 };

 let dCompleteCalls = 0;
 const completeRecords = [];

 const sandbox = {
  console, Math, JSON, Date, Number, String, Object, Array, Error, TypeError, Promise, Set, Map, RegExp,
  isNaN, parseInt, parseFloat,
  MEGA_POWERS_ENABLED: powersEnabled
 };
 sandbox.globalThis = sandbox;
 sandbox.window = sandbox;
 sandbox.self = sandbox;
 sandbox.document = doc;
 doc.defaultView = sandbox;
 sandbox.localStorage = localStorage;
 sandbox.navigator = { onLine: true, vibrate() {}, clipboard: null };
 sandbox.location = { href: 'https://megaxo.online/' };
 sandbox.setTimeout = setTimeoutFn;
 sandbox.clearTimeout = clearTimeoutFn;
 sandbox.setInterval = setIntervalFn;
 sandbox.clearInterval = clearIntervalFn;
 sandbox.requestAnimationFrame = fn => setTimeoutFn(() => fn(clock), 16);
 sandbox.performance = { now: () => clock };
 sandbox.crypto = globalThis.crypto;
 sandbox.structuredClone = globalThis.structuredClone;
 sandbox.getComputedStyle = () => ({ getPropertyValue: () => '#fff' });
 sandbox.Event = class { constructor(type) { this.type = type; } };
 sandbox.MutationObserver = class { observe() {} disconnect() {} };
 sandbox.AudioContext = undefined;
 sandbox.matchMedia = () => null;

 const winListeners = new Map();
 sandbox.addEventListener = (t, f) => { (winListeners.get(t) || (winListeners.set(t, []), winListeners.get(t))).push(f); };
 sandbox.removeEventListener = (t, f) => { const a = winListeners.get(t); if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } };
 sandbox.dispatchEvent = e => { for (const f of winListeners.get(e?.type) || []) f(e); return true; };

 vm.createContext(sandbox);

 /* Load scripts in browser order */
 const scripts = ['src/game.js', 'src/domain.js', 'src/monetization.js', 'src/gameplay-rewind.js', 'src/powers-ui.js', 'src/icons.js', 'src/bot/contracts.js'];
 for (const f of scripts) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
 }

 /* Spy on domain.complete */
 const realDomainComplete = sandbox.MegaDomain.complete;
 sandbox.MegaDomain.complete = (data, record) => {
  dCompleteCalls++;
  completeRecords.push(structuredClone(record));
  return realDomainComplete(data, record);
 };

 /* Load app.js */
 vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8'), sandbox, { filename: 'src/app.js' });

 const clickAction = async (action, value = '') => {
  const clickListeners = doc.listeners.get('click') || [];
  let res;
  for (const fn of clickListeners) {
   res = fn({
    target: {
     closest: sel => sel === '[data-action]' ? { dataset: { action, value }, disabled: false } : null
    },
    preventDefault() {},
    stopPropagation() {}
   });
  }
  return res;
 };

 return {
  sandbox, doc, byId, store, advance, clickAction,
  getCompleteCalls: () => dCompleteCalls,
  getCompleteRecords: () => completeRecords
 };
}

test('exactly one D.complete per real result and kill switch preserves immediate finish when off', () => {
 /* With powers disabled (kill switch OFF):
    Preseed an offline match with 20 plies of BOT_LOSS.
    Finishing it via prepareTerminalResult/finalizeTerminalResult must call D.complete synchronously once. */
 const h = createHarness({ powersEnabled: false });
 assert.equal(h.sandbox.window.MegaPowers, undefined, 'MegaPowers should not be installed when kill switch is OFF');

 /* Start a Beginner bot match */
 h.clickAction('mode', 'bot');
 h.clickAction('difficulty', 'Beginner');
 h.clickAction('start');

 /* Resigning a live match ends as a loss and finalizes immediately with exactly one D.complete */
 assert.equal(h.getCompleteCalls(), 0);
 h.clickAction('resignyes');
 assert.equal(h.getCompleteCalls(), 1, 'resignation must complete exactly once');
 assert.equal(h.getCompleteRecords().length, 1);
 assert.equal(h.getCompleteRecords()[0].result, 'loss');
 assert.equal(h.getCompleteRecords()[0].reason, 'resign');
});

test('a pending Bot loss survives a simulated restart and completes D.complete exactly once on accept', async () => {
 const store = new Map();
 const h1 = createHarness({ powersEnabled: true, initialStore: store });
 assert.ok(h1.sandbox.window.MegaPowers, 'MegaPowers must be exposed when feature is enabled');

 /* Preseed an offline match in pending-terminal loss state */
 const terminalMoves = BOT_LOSS.map(([b, c], i) => ({ b, c, player: i % 2 === 0 ? 'X' : 'O' }));
 const offlineMatchData = {
  id: 'pending-bot-match-1',
  first: 'X',
  mode: 'bot',
  difficulty: 'Medium',
  practice: false,
  moves: terminalMoves,
  active: 45,
  turnLimit: 0,
  turnRemaining: 0,
  pendingTerminal: { reason: 'line' },
  powers: {
   version: 1,
   botUndo: { packages: 0, charges: 0, presses: 0 }
  }
 };

 const localData = JSON.parse(store.get('mega_v32_state'));
 localData.offlineMatch = offlineMatchData;
 store.set('mega_v32_state', JSON.stringify(localData));

 /* Resume offline match in harness 1 */
 await h1.sandbox.MegaApp.resumeOffline();
 assert.equal(h1.getCompleteCalls(), 0, 'D.complete must NOT be called while pending terminal loss');
 assert.equal(h1.sandbox.document.getElementById('sheetTitle').textContent, 'One more try?');

 /* Check snapshot persisted to store preserves pendingTerminal, plies, and id */
 const saved1 = JSON.parse(store.get('mega_v32_state')).offlineMatch;
 assert.equal(saved1.id, 'pending-bot-match-1');
 assert.equal(saved1.pendingTerminal.reason, 'line');
 assert.equal(saved1.moves.length, 20);

 /* SIMULATE RESTART: create a brand new harness with the exact same localStorage */
 const h2 = createHarness({ powersEnabled: true, initialStore: store });
 assert.equal(h2.getCompleteCalls(), 0, 'restarted client must not have completed anything yet');

 await h2.sandbox.MegaApp.resumeOffline();
 assert.equal(h2.getCompleteCalls(), 0, 'D.complete must still NOT be called after restart');
 assert.equal(h2.sandbox.document.getElementById('sheetTitle').textContent, 'One more try?');

 /* Now player clicks "Accept loss" */
 h2.clickAction('acceptloss');

 /* D.complete must be called EXACTLY ONCE across the entire lifecycle */
 assert.equal(h2.getCompleteCalls(), 1, 'Accept loss must call D.complete exactly once');
 const record = h2.getCompleteRecords()[0];
 assert.equal(record.id, 'pending-bot-match-1');
 assert.equal(record.result, 'loss');
 assert.equal(record.reason, 'line');
 assert.equal(record.moves, 20);

 /* offlineMatch must now be deleted since match is recorded */
 const finalData = JSON.parse(store.get('mega_v32_state'));
 assert.equal(finalData.offlineMatch, undefined, 'recorded match must clear offlineMatch save');
});

test('undo after a Bot terminal loss returns to human turn and does NOT award the discarded result', async () => {
 const store = new Map();
 const h = createHarness({ powersEnabled: true, initialStore: store });

 const terminalMoves = BOT_LOSS.map(([b, c], i) => ({ b, c, player: i % 2 === 0 ? 'X' : 'O' }));
 const localData = JSON.parse(store.get('mega_v32_state'));
 localData.offlineMatch = {
  id: 'undo-match-1',
  first: 'X',
  mode: 'bot',
  difficulty: 'Medium',
  practice: false,
  moves: terminalMoves,
  active: 60,
  turnLimit: 0,
  turnRemaining: 0,
  pendingTerminal: { reason: 'line' },
  powers: {
   version: 1,
   botUndo: { packages: 0, charges: 0, presses: 0 }
  }
 };
 store.set('mega_v32_state', JSON.stringify(localData));

 /* Set up native bridge that confirms EARNED */
 h.sandbox.window.MegaNativeReward = {
  present: async () => ({ outcome: 'earned' }),
  isReady: () => true,
  privacyState: () => ({ canRequestAds: true })
 };

 await h.sandbox.MegaApp.resumeOffline();
 assert.equal(h.getCompleteCalls(), 0);

 /* Click "Undo with a rewarded ad" */
 await h.clickAction('undooffer');

 /* After rewind:
    1. D.complete was NOT called (0 calls)
    2. Board rewound from 20 to 18 plies
    3. Human turn ('X'), winner is null
    4. 1 remaining charge out of the 2-charge package */
 assert.equal(h.getCompleteCalls(), 0, 'rewound match must NOT award the discarded loss');
 const liveMatch = h.sandbox.MegaXO.getState();
 assert.equal(liveMatch.moves.length, 18, 'last human/bot pair must be removed (20 -> 18)');
 assert.equal(liveMatch.turn, 'X', 'board must return to human turn');
 assert.equal(liveMatch.winner, null, 'terminal winner must be cleared');

 /* Verify package charges: 2 granted, 1 used => 1 charge remaining */
 const saved = JSON.parse(store.get('mega_v32_state')).offlineMatch;
 assert.equal(saved.powers.botUndo.charges, 1, 'second charge must remain in package');
 assert.equal(saved.powers.botUndo.presses, 1);
});

test('stale Worker reply arriving after an undo is rejected by revision fencing', async () => {
 const store = new Map();
 const h = createHarness({ powersEnabled: true, initialStore: store });

 const terminalMoves = BOT_LOSS.map(([b, c], i) => ({ b, c, player: i % 2 === 0 ? 'X' : 'O' }));
 const localData = JSON.parse(store.get('mega_v32_state'));
 localData.offlineMatch = {
  id: 'stale-match-1',
  first: 'X',
  mode: 'bot',
  difficulty: 'Medium',
  practice: false,
  moves: terminalMoves,
  active: 50,
  turnLimit: 0,
  turnRemaining: 0,
  pendingTerminal: { reason: 'line' },
  powers: {
   version: 1,
   botUndo: { packages: 0, charges: 0, presses: 0 }
  }
 };
 store.set('mega_v32_state', JSON.stringify(localData));

 h.sandbox.window.MegaNativeReward = {
  present: async () => ({ outcome: 'earned' }),
  isReady: () => true,
  privacyState: () => ({ canRequestAds: true })
 };

 await h.sandbox.MegaApp.resumeOffline();

 /* Rewind the loss: 20 -> 18 plies */
 await h.clickAction('undooffer');
 assert.equal(h.sandbox.MegaXO.getState().moves.length, 18);

 /* Simulate a stale Worker reply arriving late from the pre-undo revision (revision 20) */
 let ghostMoveLanded = false;
 const staleWorkerResult = {
  gameId: 'stale-match-1',
  revision: 20, /* stale revision! */
  move: { b: 8, c: 2 }
 };

 /* If the stale result is validated, it would try to apply to the 18-ply state */
 const currentMovesLength = h.sandbox.MegaXO.getState().moves.length;

 /* Verify via pure contract: BC.accept throws STALE_BOT_RESULT on revision mismatch */
 assert.throws(
  () => h.sandbox.window.MegaBotContract.accept({ state: h.sandbox.MegaXO.getState(), gameId: 'stale-match-1', revision: 20 }, staleWorkerResult),
  /STALE_BOT_RESULT/
 );

 /* Verify board state remains at 18 plies untouched */
 assert.equal(h.sandbox.MegaXO.getState().moves.length, currentMovesLength);
 assert.equal(h.sandbox.MegaXO.getState().turn, 'X');
});

/* ------------------------------------------------------------------------------------------- *
 * The SHIPPED native lane, window.MegaAds. The injected-`bridge` tests above never exercise the
 * adapter's own nativeBridge() wrapper, which is what actually runs on a signed Android/iOS build.
 * The bug this covers: the native bridges resolve showRewarded with {earned, shown, outcome} and
 * reject on ok:false, and ok === earned - so a shown-then-skipped ad arrived as a rejection and the
 * exposure allowance plus the two-minute spacing were never consumed, silently bypassing the
 * owner's frozen rule that "a shown and skipped ad consumes exposure and grants no item".
 * ------------------------------------------------------------------------------------------- */
test('the shipped window.MegaAds lane counts a shown-then-skipped ad as exposure and grants nothing', async () => {
 let now = Date.parse('2026-10-14T12:00:00Z');
 const terminalState = buildState(BOT_LOSS);
 const context = {
  id: 'm-megaaads-1', state: terminalState, mode: 'bot', first: 'X',
  practice: false, online: false, reason: 'line', charges: 0, used: 0, botPending: false
 };

 /* Exactly what nativeBridge() wraps: platform, privacyState, isReady and showRewarded, with the
    honest payload the native bridge produces when the ad was presented but the reward was skipped. */
 const shownNotEarned = { earned: false, shown: true, outcome: 'DISMISSED' };
 const host = {
  MegaAds: {
   platform: 'android',
   privacyState: () => ({ canRequestAds: true, privacyOptionsRequired: false }),
   isReady: () => true,
   showRewarded: async () => shownNotEarned
  }
 };
 const powers = PowersUI.createPowers({
  enabled: () => true, clock: () => now, host,
  issueTicket: async () => 'TICKET-1'
 });

 const skipped = await powers.request('undo', { match: context });
 assert.equal(skipped.earned, false, 'a shown-skipped ad must not grant');
 assert.equal(skipped.entitlement, null, 'no entitlement from a skipped ad');
 assert.equal(powers.pacing().rewardedShownToday, 1, 'a shown ad MUST consume an exposure slot');
 assert.equal(powers.inventory().undo.available, 0, 'a skipped ad must not bank an entitlement');
 assert.ok(powers.pacing().nextEligibleAt > now, 'the two-minute spacing must advance after a shown ad');

 /* And a genuine earned reward through the same lane still grants exactly one. */
 host.MegaAds.showRewarded = async () => ({ earned: true, shown: true, outcome: 'EARNED' });
 now = powers.pacing().nextEligibleAt; /* respect the spacing we just earned */
 const earned = await powers.request('undo', { match: context });
 assert.equal(earned.earned, true, 'an earned reward through window.MegaAds must grant');
 assert.equal(earned.entitlement, 'undo');
 assert.equal(powers.inventory().undo.available, 1, 'exactly one entitlement banked');
 assert.equal(powers.pacing().rewardedShownToday, 2, 'the earned ad also counts as exposure');

 /* A call that never presented anything must still count as nothing. */
 now = powers.pacing().nextEligibleAt;
 host.MegaAds.showRewarded = async () => ({ earned: false, shown: false, outcome: 'FAILED' });
 const failed = await powers.request('undo', { match: context });
 assert.equal(failed.earned, false);
 assert.equal(powers.pacing().rewardedShownToday, 2, 'a never-presented ad consumes nothing');
});

test('the aggregate rewarded ceiling is shared with the cosmetic lane, not a separate powers ledger', async () => {
 let now = Date.parse('2026-10-14T12:00:00Z');
 const terminalState = buildState(BOT_LOSS);
 const context = {
  id: 'm-agg-1', state: terminalState, mode: 'bot', first: 'X',
  practice: false, online: false, reason: 'line', charges: 0, used: 0, botPending: false
 };
 /* The cosmetic lane already booked nine presentations today. The powers lane must see them, or a
    player could watch nine Credits ads and then ten Undo ads against a "ten per day" ceiling. */
 let cosmeticShown = 9;
 const host = {
  MegaAds: {
   platform: 'android', privacyState: () => ({ canRequestAds: true }),
   isReady: () => true, showRewarded: async () => ({ earned: true, shown: true, outcome: 'EARNED' })
  }
 };
 const powers = PowersUI.createPowers({
  enabled: () => true, clock: () => now, host,
  issueTicket: async () => 'TICKET-AGG',
  otherShown: () => cosmeticShown
 });

 assert.equal(powers.pacing().rewardedShownToday, 9, 'the cosmetic lane is counted in the aggregate');

 const tenth = await powers.request('undo', { match: context });
 assert.equal(tenth.earned, true, 'the tenth presentation overall is still allowed');
 assert.equal(powers.pacing().rewardedShownToday, 10, 'and the aggregate now reads ten');

 /* The eleventh must be refused before any ad is shown. */
 now = powers.pacing().nextEligibleAt;
 let shown = 0;
 host.MegaAds.showRewarded = async () => { shown++; return { earned: true, shown: true, outcome: 'EARNED' }; };
 const eleventh = await powers.request('undo', { match: context });
 assert.equal(eleventh.earned, false, 'the eleventh presentation must be refused');
 assert.equal(eleventh.reason, 'DAY_CAP', 'refused for the daily ceiling');
 assert.equal(shown, 0, 'and refused BEFORE any ad is presented');
});
