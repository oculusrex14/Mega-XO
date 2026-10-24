'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {IDBFactory} = require('fake-indexeddb');

// Execute the actual app event handlers, data controller and page renderer in isolated
// browser-module scopes. All actors, transport replies, storage and navigation are synthetic.
// This exercises the rendered store, not just source strings or dictionary membership.
const names = ['ui', 'downloads', 'friends', 'friends-view', 'consent', 'pages', 'store', 'board', 'site', 'seo', 'data', 'realtime', 'tournaments', 'tournaments-view', 'app'];
const sources = names.map(name => ({name, source:fs.readFileSync(path.join(__dirname, '../apps/web/' + name + '.js'), 'utf8')}));
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }

async function browser(options = {}) {
 const documentListeners = new Map(), windowListeners = new Map(), timers = new Map();
 const calls = [], reads = [], navigations = [], popupCalls = [];
 const storage = options.storage || new Map(), states = options.states || new Map();
 const indexedDB = options.indexedDB || new IDBFactory();
 let timer = 0, sequence = 0, statusFocus = 0, profileReads = 0;
 const f = {provider:options.provider || 'dodo', disclosure:{published:false},
  profile:{id:'synthetic-a', region:'United States', wallet:{coins:17, crowns:3}},
  request:null, fetch:null};
 class Element {
  constructor() { this.dataset = {}; this.attributes = new Map(); this.innerHTML = ''; }
  hasAttribute(name) { return this.attributes.has(name); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelectorAll() { return []; }
  querySelector(selector) { return selector === '[data-checkout-status]' ? {focus:() => { statusFocus++; }} : null; }
  focus() {}
  contains() { return false; }
 }
 const main = new Element(), header = new Element(), footer = new Element(), notification = new Element();
 const location = {pathname:'/store', search:options.search || '', href:'https://megaxo.online/store' + (options.search || ''), origin:'https://megaxo.online', assign:url => { navigations.push(url); }};
 const listen = (map, name, fn) => map.set(name, [...(map.get(name) || []), fn]);
 const document = {
  hidden:false, activeElement:null, body:{dataset:{}},
  querySelector:selector => ({'#main':main, '#header':header, '#footer':footer, '#notification':notification, 'meta[name="description"]':{}})[selector] || null,
  querySelectorAll:() => [], addEventListener:(name, fn) => listen(documentListeners, name, fn),
 };
 const window = {addEventListener:(name, fn) => listen(windowListeners, name, fn), scrollTo() {}, open:url => { popupCalls.push(url); throw Error('window.open must not be used'); }};
 function catalog() {
  const products = Object.fromEntries(['crowns_100', 'crowns_525', 'crowns_1100', 'remove_ads', 'mega_pass'].map(id => [id, {amountCents:100, currency:'usd'}]));
  return {products:[], purchasesAvailable:false, webCheckoutAvailable:true, webCheckoutProvider:f.provider,
   polar:{available:f.provider === 'polar', products}, cashfree:{available:false, products:{}},
   dodo:{available:f.provider === 'dodo', products, regions:Object.fromEntries(Object.keys(products).map(id => [id, {usd:100}]))}};
 }
 const sandbox = {
  indexedDB, document, window, location, navigator:{language:'en-US'}, console, URL, URLSearchParams, AbortController, structuredClone, crypto:crypto.webcrypto,
  setTimeout(fn, ms) { const id = ++timer; timers.set(id, {fn, ms}); return id; }, clearTimeout:id => timers.delete(id),
  setInterval(fn, ms) { const id = ++timer; timers.set(id, {fn, ms}); return id; }, clearInterval:id => timers.delete(id),
  localStorage:{getItem:key => storage.get(key) ?? null, setItem:(key, value) => storage.set(key, value), removeItem:key => storage.delete(key)},
  history:{replaceState() {}, pushState() {}},
  fetch:async resource => {
   reads.push(resource);
   if (f.fetch) { const reply = await f.fetch(resource); if (reply !== undefined) return {ok:true, json:async () => reply}; }
   let result;
   if (resource === '/api/v1/profile') { profileReads++; result = f.profile; }
   else if (resource === '/api/monetization/status') result = catalog();
   else if (resource === '/api/monetization/promotion/disclosure') result = f.disclosure;
   else if (resource.includes('/disposition?')) {
    const parsed = new URL(resource, location.origin), params = parsed.searchParams, key = params.get('key');
    const ready = states.get('checkout-' + key);
    result = {actorId:f.profile.id, provider:parsed.pathname.split('/')[3], key, productId:params.get('product'), currency:params.get('currency'),
     ...(ready ? {disposition:'ready', checkoutId:ready.checkoutId, checkoutUrl:'https://checkout.example/' + ready.checkoutId} : {disposition:'ambiguous', retrySameKey:true})};
   }
   else if (/\/status\?checkout_id=/.test(resource)) result = states.get(new URL(resource, location.origin).searchParams.get('checkout_id'));
   else throw Error('Unexpected synthetic read: ' + resource);
   return {ok:true, json:async () => structuredClone(result)};
  },
  MegaAccount:{id:() => 'synthetic-operation-' + ++sequence, peek:() => null, reset() {}, session:async () => ({providers:{}}),
   request:async (url, body, key) => {
    calls.push({url, body, key});
    if (f.request) return f.request(url, body, key);
    if (url === '/api/monetization/promotion/accept') return {acceptanceHash:'synthetic-accepted'};
    if (url.endsWith('/checkout')) {
     const checkoutId = 'checkout-' + key;
     states.set(checkoutId, {checkoutId, productId:body.product, paid:false, status:'pending'});
     return {checkoutId, productId:body.product, checkoutUrl:'https://checkout.example/' + checkoutId};
    }
    throw Error('Unexpected synthetic mutation: ' + url);
   }},
  legalDocuments:{}, storeLinks:{ios:null, android:null},
 };
 const runtime = vm.createContext(sandbox);
 for (const {name, source} of sources) {
  const exported = [...source.matchAll(/^export (?:async )?(?:function|const|let|class) (\w+)/gm)].map(match => match[1]);
  const runnable = source.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '');
  const aliases = name === 'friends-view' ? 'const e=escapeHtml;\n' : '';
  const expose = name === 'app' ? 'globalThis.checkoutTest={context,render,refresh:()=>model.profile()};' : 'Object.assign(globalThis,{' + exported.join(',') + '});';
  vm.runInContext('(function(){\n' + aliases + runnable + '\n' + expose + '\n})();', runtime, {filename:'apps/web/' + name + '.js'});
 }
 await flush();
 function click(kind, value = 'purchase') {
  const node = {dataset:kind === 'store' ? {storeAction:'purchase', productId:value} : {promotionAction:value}};
  const target = {closest:selector => selector === '[data-' + kind + '-action]' ? node : null};
  for (const listener of documentListeners.get('click') || []) listener({target, defaultPrevented:false, button:0});
 }
 return {...f, control:f, main, calls, reads, states, storage, indexedDB, navigations, popupCalls, click,
  qa:runtime.checkoutTest, focusCount:() => statusFocus, profileReads:() => profileReads};
}

test('PF1 store renders a rejected create with accessible error and busy progress', async () => {
 const f = await browser(), gate = deferred();
 f.control.request = () => gate.promise;
 f.click('store', 'remove_ads'); await flush();
 assert.match(f.main.innerHTML, /data-store-checkout aria-busy="true"/);
 assert.match(f.main.innerHTML, /role="status"[^>]*>Preparing your secure checkout/);
 const buttons = [...f.main.innerHTML.matchAll(/<button\b[^>]*data-store-action="purchase"[^>]*>/g)].map(m => m[0]);
 assert.ok(buttons.length >= 4);
 assert.ok(buttons.every(html => / disabled/.test(html)), 'all purchases are disabled during I/O');
 gate.reject(Error('REQUEST_PENDING')); await flush();
 assert.match(f.main.innerHTML, /role="alert" aria-live="assertive"/);
 assert.match(f.main.innerHTML, /Try the same product again to resume that checkout/);
 assert.match(f.main.innerHTML, /data-store-checkout aria-busy="false"/);
 assert.ok(f.focusCount() > 0, 'checkout feedback receives focus after the action');
 assert.equal(f.calls.length, 1);
 assert.equal(f.navigations.length, 0);
});

test('PF1 store renders STORE_UNAVAILABLE and disclosure acceptance failures without creating checkout', async () => {
 const failedCreate = await browser();
 failedCreate.control.request = async () => { throw Error('STORE_UNAVAILABLE'); };
 failedCreate.click('store', 'remove_ads'); await flush();
 assert.match(failedCreate.main.innerHTML, /role="alert"[^>]*>The store could not be reached/);
 const acceptance = await browser();
 acceptance.control.disclosure = {published:true, token:'synthetic-token', accepted:false, remaining:100, cap:22000, ruleText:'Synthetic rule'};
 acceptance.click('store', 'crowns_100'); await flush();
 assert.match(acceptance.main.innerHTML, /data-promotion-action="accept"/);
 acceptance.control.request = async () => { throw Error('PROMOTION_ACCEPT_FAILED'); };
 acceptance.click('promotion', 'accept'); await flush();
 assert.match(acceptance.main.innerHTML, /role="alert"[^>]*>The purchase disclosure could not be accepted/);
 assert.match(acceptance.main.innerHTML, /data-promotion-action="accept"/, 'failed acceptance can be retried');
 assert.ok(acceptance.calls.every(call => !call.url.endsWith('/checkout')));
});

test('PF1 automatic disclosure reads and re-attestation failures are visible instead of swallowed', async () => {
 for (const kind of ['read', 'accept']) {
  const f = await browser();
  if (kind === 'read') f.control.fetch = async resource => { if (resource.endsWith('/disclosure')) throw Error('REQUEST_TIMEOUT'); };
  else { f.control.disclosure = {published:true, token:'synthetic-token', accepted:true}; f.control.request = async () => { throw Error('PROMOTION_ACCEPT_FAILED'); }; }
  f.click('store', 'crowns_100'); await flush();
  assert.match(f.main.innerHTML, /role="alert"/);
  assert.match(f.main.innerHTML, kind === 'read' ? /did not respond in time/ : /disclosure could not be accepted/);
  assert.ok(f.calls.every(call => !call.url.endsWith('/checkout')));
 }
});

test('PF1 checkout messages use the actual escaped store renderer and stay actor-scoped', async () => {
 const f = await browser();
 f.qa.context.checkoutState = {actorId:'synthetic-a', kind:'error', message:'<img src=x onerror=bad()> & retry'};
 f.qa.render();
 assert.match(f.main.innerHTML, /&lt;img src=x onerror=bad\(\)&gt; &amp; retry/);
 assert.doesNotMatch(f.main.innerHTML, /<img src=x/);
 f.qa.context.profile = {...f.control.profile, id:'synthetic-b'}; f.qa.render();
 assert.doesNotMatch(f.main.innerHTML, /onerror=bad/);
});

test('PF2 Dodo and dormant Polar both navigate in the same tab and resume a single hosted checkout', async () => {
 for (const provider of ['dodo', 'polar']) {
  const f = await browser({provider});
  f.click('store', 'remove_ads'); await flush();
  f.click('store', 'remove_ads'); await flush();
  assert.equal(f.calls.filter(call => call.url.endsWith('/checkout')).length, 1);
  assert.equal(f.navigations.length, 2);
  assert.equal(new Set(f.navigations).size, 1);
  assert.equal(f.popupCalls.length, 0);
  assert.doesNotMatch(f.main.innerHTML, /Payment verified/);
 }
});

test('PF2 return and reload verify the stored attempt then refresh the authoritative profile', async () => {
 const first = await browser();
 first.click('store', 'remove_ads'); await flush();
 const state = [...first.states.values()][0]; state.paid = true;
 const returned = await browser({indexedDB:first.indexedDB, storage:first.storage, states:first.states, search:'?payment=success'});
 assert.match(returned.main.innerHTML, /Payment verified/);
 assert.ok(returned.profileReads() >= 2, 'verified return refreshes canonical profile data');
 assert.equal(returned.calls.length, 0, 'no create or replacement allocation on return');
 assert.equal(returned.navigations.length, 0);
 assert.equal(returned.qa.context.profile.wallet.crowns, 3, 'no client-side currency grant');
 const forged = await browser({search:'?payment=success&checkout_id=untrusted'});
 assert.doesNotMatch(forged.main.innerHTML, /Payment verified/);
});

test('PF2 unpaid return checks status and resumes its saved URL without another create', async () => {
 const first = await browser(); first.click('store', 'remove_ads'); await flush();
 const returned = await browser({indexedDB:first.indexedDB, storage:first.storage, states:first.states, search:'?payment=success'});
 assert.ok(returned.reads.some(url => /\/dodo\/status\?checkout_id=/.test(url)));
 assert.match(returned.main.innerHTML, /Your checkout is still pending/);
 assert.doesNotMatch(returned.main.innerHTML, /Payment verified/);
 returned.click('store', 'remove_ads'); await flush();
 assert.equal(returned.calls.length, 0);
 assert.equal(returned.navigations[0], first.navigations[0]);
});

test('PF2 ambiguous create return replays its durable operation instead of replacing it', async () => {
 const first = await browser();
 first.control.request = async () => { throw Error('REQUEST_TIMEOUT'); };
 first.click('store', 'remove_ads'); await flush();
 const key = first.calls[0].key;
 const returned = await browser({indexedDB:first.indexedDB, storage:first.storage});
 assert.match(returned.main.innerHTML, /Your checkout is still pending/);
 assert.equal(returned.calls.length, 0, 'no automatic create on return');
 returned.click('store', 'remove_ads'); await flush();
 assert.equal(returned.calls.length, 1);
 assert.equal(returned.calls[0].key, key);
 assert.equal(returned.navigations.length, 1);
});

test('PF2 refunded returns show refund state without reporting delivery success', async () => {
 const first = await browser(); first.click('store', 'remove_ads'); await flush();
 Object.assign([...first.states.values()][0], {paid:true, refunded:true});
 const returned = await browser({indexedDB:first.indexedDB, storage:first.storage, states:first.states});
 assert.match(returned.main.innerHTML, /checkout was refunded/);
 assert.doesNotMatch(returned.main.innerHTML, /Payment verified/);
});

test('PF2 account change fences an in-flight checkout and clears disclosure and status', async () => {
 const f = await browser(), gate = deferred();
 f.control.request = () => gate.promise;
 f.click('store', 'remove_ads'); await flush();
 f.control.profile = {...f.control.profile, id:'synthetic-b'};
 await f.qa.refresh(); await flush();
 gate.resolve({checkoutId:'old-actor', checkoutUrl:'https://checkout.example/old-actor'}); await flush();
 assert.equal(f.navigations.length, 0);
 assert.equal(f.qa.context.promotionAcceptanceHash, null);
 assert.doesNotMatch(f.main.innerHTML, /old-actor|Payment verified|Opening the secure checkout/);
});

test('PF2 existing accepted checkout resumes at the promotion cap without re-attesting a new purchase', async () => {
 const f = await browser();
 f.control.disclosure = {published:true, token:'synthetic-token', accepted:true};
 f.click('store', 'crowns_100'); await flush();
 const disclosureReads = f.reads.filter(url => url.endsWith('/disclosure')).length;
 f.control.fetch = async url => { if (url.endsWith('/disclosure')) throw Error('PROMOTION_LIMIT'); };
 f.click('store', 'crowns_100'); await flush();
 assert.equal(f.reads.filter(url => url.endsWith('/disclosure')).length, disclosureReads);
 assert.equal(f.calls.filter(call => call.url.endsWith('/checkout')).length, 1);
 assert.equal(f.calls.find(call => call.url.endsWith('/checkout')).body.promotionAcceptanceHash, 'synthetic-accepted');
 assert.equal(f.navigations.length, 2);
});
