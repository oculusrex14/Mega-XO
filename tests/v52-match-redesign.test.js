'use strict';
// Match-only redesign regressions. The DOM harness runs the real game, powers adapter and app;
// no provider or physical-device acceptance is implied by these local tests.
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.resolve(__dirname,'..');
const G=require('../src/game.js'),R=require('../src/gameplay-rewind.js');
const BOT_LOSS=[[5,7],[7,0],[0,0],[0,1],[1,7],[7,1],[1,8],[8,0],[0,8],[8,1],[1,6],[6,0],[0,6],[6,1],[3,7],[7,2],[2,1],[6,2],[2,6],[8,2]];
const movesAfter=plies=>BOT_LOSS.slice(0,plies).map(([b,c],i)=>({b,c,player:i%2===0?'X':'O'}));
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

function card(markup,action){return markup.match(new RegExp('<button[^>]*data-action="'+action+'"[\\s\\S]*?</button>'))?.[0]||'';}
async function resumed({plies=8,charges=2,hints=1,practice=false,powersEnabled=true}={}){
 const store=new Map(),seed=createHarness({initialStore:store});
 const save=JSON.parse(store.get('mega_v32_state'));
 save.offlineMatch={id:'redesign-synthetic',first:'X',mode:'bot',difficulty:'Medium',practice,moves:movesAfter(plies),active:20,turnLimit:0,turnRemaining:0,
  powers:{...R.freshMatchPowers(),botUndo:{packages:1,charges,presses:2-charges}}};
 store.set('mega_v32_state',JSON.stringify(save));
 store.set('mega_v52_powers',JSON.stringify({version:1,inventory:{...R.freshInventory(),available:{...R.freshInventory().available,hint:hints}},pacing:R.freshPacing(0),attempt:null,lastAttempt:null}));
 const h=createHarness({initialStore:store,powersEnabled});await h.sandbox.MegaApp.resumeOffline();return h;
}

test('match markup separates its power bar from the three permanent match controls',()=>{
 const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
 assert.ok(html.indexOf('id="previewText"')<html.indexOf('id="matchPowers"'));
 assert.ok(html.indexOf('id="matchPowers"')<html.indexOf('class="match-controls"'));
 assert.match(html,/<section class="match-powers"[^>]*aria-labelledby="matchPowersTitle" hidden/);
 assert.match(html,/player-glyph x[^]*?<svg[^]*?<path/);
 assert.match(html,/player-glyph o[^]*?<svg[^]*?<circle/);
 const css=fs.readFileSync(path.join(ROOT,'src/styles.css'),'utf8');
 assert.match(css,/#gameScreen\{[\s\S]*?overflow-y:auto/);
 assert.match(css,/#gameScreen \.board-wrap\{width:100%/,'board size must depend on available width, not a shrinking viewport-height budget');
 assert.match(css,/#gameScreen \.power-cards\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
 assert.match(css,/#gameScreen[\s\S]*?:focus-visible/);
});

test('Undo stays visible before eight plies with a truthful disabled state and zero earned inventory',async()=>{
 const h=createHarness();await h.clickAction('mode','bot');await h.clickAction('start');
 const markup=h.controlsMarkup(),undo=card(markup,'botundo');
 assert.match(undo,/ disabled/);
 assert.match(undo,/Unlocks at 8 moves · 0\/8/);
 assert.match(undo,/aria-label="0 banked items"/);
 assert.equal((markup.match(/class="power-card /g)||[]).length,4);
 assert.match(markup,/Power Bar/);assert.match(markup,/Use strategically/);
 assert.doesNotMatch(markup,/aria-label="[23] banked items"/);
});

test('power badges follow actual match charges and banked hints, and Undo still rewinds through the existing action',async()=>{
 const h=await resumed();let markup=h.controlsMarkup();
 assert.match(card(markup,'botundo'),/aria-label="2 earned charges"/);
 assert.doesNotMatch(card(markup,'botundo'),/ disabled/);
 assert.match(card(markup,'bothint'),/aria-label="1 banked items"/);
 await h.clickAction('botundo');
 markup=h.controlsMarkup();
 assert.match(card(markup,'botundo'),/aria-label="1 earned charges"/);
 assert.doesNotMatch(card(markup,'botundo'),/ disabled/,'the second charge survives the board shrinking below eight plies');
 const saved=JSON.parse(h.store.get('mega_v32_state'));
 assert.equal(saved.offlineMatch.moves.length,6);
 assert.equal(saved.offlineMatch.powers.botUndo.charges,1);
});

test('spent Undo remains visible and disabled instead of inventing a new package',async()=>{
 const h=await resumed({charges:0});
 const undo=card(h.controlsMarkup(),'botundo');
 assert.match(undo,/ disabled/);
 assert.match(undo,/Both Undo charges for this match have been used|No Undo charges remain/);
 assert.match(undo,/aria-label="0 banked items"/);
});

test('both counter cards are honestly unavailable while their explanation is keyboard reachable',async()=>{
 const h=await resumed(),markup=h.controlsMarkup();
 assert.match(markup,/power-card--undoBlock[^]*? disabled[^]*?Unavailable/);
 assert.match(markup,/power-card--tacticalBlock[^]*? disabled[^]*?Unavailable/);
 assert.equal((markup.match(/aria-label="Unavailable"/g)||[]).length,2);
 assert.match(markup,/<button type="button" class="power-disclosure" data-action="powercounters">/);
 await h.clickAction('powercounters');
 assert.match(h.doc.getElementById('sheetBody').innerHTML,/two-player Casual match/);
 assert.match(h.doc.getElementById('sheetBody').innerHTML,/authoritative resolution/);
});

test('Tactical Hint uses the existing authority and marks its active suggestion without forcing a move',async()=>{
 const h=await resumed();await h.clickAction('bothint');
 assert.match(card(h.controlsMarkup(),'bothint'),/is-active/);
 assert.match(card(h.controlsMarkup(),'bothint'),/aria-pressed="true"/);
 assert.match(h.doc.getElementById('previewText').textContent,/Any legal cell still plays/);
 assert.equal(h.sandbox.MegaPowers.inventory().hint.available,0);
 const saved=JSON.parse(h.store.get('mega_v32_state'));
 assert.equal(saved.offlineMatch.moves.length,8,'a hint cannot place a player move');
});

test('tutorial practice and an explicit feature off switch retain the no-powers contract',async()=>{
 const practice=await resumed({practice:true});assert.equal(practice.controlsMarkup(),'');
 const off=await resumed({powersEnabled:false});assert.equal(off.controlsMarkup(),'');
});
