'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const {IDBFactory} = require('fake-indexeddb');
const data = import(pathToFileURL(path.join(__dirname, '../apps/web/data.js')).href);
const choice = {provider:'dodo', productId:'crowns_100', currency:'usd', country:'US', acceptanceHash:'synthetic-acceptance'};
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return {promise, resolve}; };

async function fixture() {
 const {createHostedCheckout, createHostedCheckoutStore} = await data;
 const saved = new Map(), requests = [], reads = [], navigations = [];
 const indexedDB = new IDBFactory();
 let actor = 'synthetic-a', sequence = 0;
 const storage = {getItem:key => saved.get(key) ?? null, setItem:(key, value) => saved.set(key, value)};
 const states = new Map();
 const options = {
  actor:() => actor, store:createHostedCheckoutStore({indexedDB, legacyStorage:() => storage}),
  operationKey:() => 'synthetic-op-' + ++sequence,
  request:async (url, body, key) => {
   requests.push({url, body, key});
   const checkoutId = 'checkout-' + key;
   states.set(checkoutId, {checkoutId, productId:body.product, paid:false, status:'pending'});
   return {checkoutId, productId:body.product, checkoutUrl:'https://checkout.example/' + checkoutId};
  },
  read:async url => {
   reads.push(url); const parsed = new URL(url, 'https://megaxo.online');
   if (parsed.pathname.endsWith('/disposition')) {
    const params = parsed.searchParams, key = params.get('key');
    const ready = states.get('checkout-' + key);
    return {actorId:actor, provider:parsed.pathname.split('/')[3], key, productId:params.get('product'), currency:params.get('currency'),
     ...(ready ? {disposition:'ready', checkoutId:ready.checkoutId, checkoutUrl:'https://checkout.example/' + ready.checkoutId} : {disposition:'ambiguous', retrySameKey:true})};
   }
   return states.get(parsed.searchParams.get('checkout_id'));
  },
  navigate:url => navigations.push(url),
 };
 return {saved, storage, indexedDB, requests, reads, navigations, states, options,
  store:() => createHostedCheckoutStore({indexedDB, legacyStorage:() => storage}),
  actor:value => { actor = value; }, fresh:extra => createHostedCheckout({...options, store:createHostedCheckoutStore({indexedDB, legacyStorage:() => storage}), ...extra})};
}

test('PF2 same-product retry after two minutes and reload reopens one checkout with one key', async t => {
 const f = await fixture();
 let now = 0; t.mock.method(Date, 'now', () => now);
 const client = f.fresh();
 const first = await client.start(choice);
 assert.equal(first.outcome, 'opening');
 now = 120001;
 await client.start(choice);
 now = 86400000 * 30;
 await f.fresh().start(choice);
 assert.equal(f.requests.length, 1, 'no second create or promotion allocation');
 assert.equal(new Set(f.navigations).size, 1);
 assert.equal(f.navigations.length, 3);
 assert.equal((await client.pending())[0].key, first.record.key);
});

test('PF2 lost create reply persists the key before I/O and replays it after reload', async () => {
 const f = await fixture();
 let durableKey;
 const first = f.fresh({request:async (_url, _body, key) => {
  durableKey = (await f.fresh().pending())[0].key;
  assert.equal(durableKey, key);
  throw Error('REQUEST_TIMEOUT');
 }});
 await assert.rejects(first.start(choice), /REQUEST_TIMEOUT/);
 const resumed = await f.fresh().start({...choice, country:'GB'});
 assert.equal(resumed.record.key, durableKey);
 assert.equal(f.requests[0].key, durableKey);
 assert.equal(f.requests[0].body.country, 'US', 'preserve the original quote request');
 assert.equal(f.requests[0].body.promotionAcceptanceHash, choice.acceptanceHash);
});

test('PF2 interrupted same-tab navigation preserves the URL for return and reload', async () => {
 const f = await fixture();
 await assert.rejects(f.fresh({navigate:() => { throw Error('navigation interrupted'); }}).start(choice), /interrupted/);
 const restored = f.fresh();
 assert.equal((await restored.recover())[0].outcome, 'pending');
 assert.equal(f.navigations.length, 0, 'return recovery does not auto-redirect');
 await restored.start(choice);
 assert.equal(f.requests.length, 1);
 assert.equal(f.navigations[0], (await restored.pending())[0].checkoutUrl);
});

test('a newly created server checkout redirects without waiting for an additional provider status read', async()=>{
 const f=await fixture();
 const client=f.fresh({request:async(...args)=>({...await f.options.request(...args),status:'created'})});
 assert.equal((await client.start(choice)).outcome,'opening');
 assert.equal(f.reads.length,0);
 assert.equal(f.navigations.length,1);
});

test('PF2 different product, provider and currency are independent intentional purchases', async () => {
 const f = await fixture(), client = f.fresh();
 await client.start(choice);
 await client.start({...choice, productId:'crowns_525'});
 await client.start({...choice, provider:'polar'});
 await client.start({...choice, currency:'inr', country:'IN'});
 assert.equal((await client.pending()).length, 4);
 assert.equal(new Set(f.requests.map(r => r.key)).size, 4);
 await client.start(choice);
 assert.equal(f.requests.length, 4, 'the original product still resumes its own checkout');
});

test('PF2 another actor cannot recover or navigate a prior actor checkout', async () => {
 const f = await fixture(), client = f.fresh();
 const first = await client.start(choice);
 f.actor('synthetic-b'); client.invalidate();
 assert.deepEqual((await client.pending()), []);
 assert.deepEqual(await client.recover(), []);
 const other = await client.start(choice);
 assert.notEqual(other.record.key, first.record.key);
 assert.notEqual(other.record.checkoutUrl, first.record.checkoutUrl);
 f.actor('synthetic-a'); client.invalidate();
 assert.equal((await client.pending())[0].key, first.record.key);
});

test('PF2 late create responses are fenced across account changes, including A-B-A', async () => {
 const f = await fixture(), gate = deferred(), entered = deferred();
 const client = f.fresh({request:() => { entered.resolve(); return gate.promise; }});
 const pending = client.start(choice); await entered.promise;
 const key = (await client.pending())[0].key;
 f.actor('synthetic-b'); client.invalidate();
 f.actor('synthetic-a'); client.invalidate();
 gate.resolve({checkoutId:'late', checkoutUrl:'https://checkout.example/late'});
 await assert.rejects(pending, /AUTH_REQUIRED/);
 assert.equal(f.navigations.length, 0);
 assert.equal((await client.pending())[0].key, key, 'ambiguous old attempt stays recoverable');
 assert.equal((await client.pending())[0].checkoutUrl, null);
});

test('PF2 verified completion closes only that attempt and never starts a second purchase in the same click', async () => {
 const f = await fixture(), client = f.fresh();
 const first = await client.start(choice);
 await client.start({...choice, productId:'crowns_525'});
 f.states.get(first.record.checkoutId).paid = true;
 const result = await client.start(choice);
 assert.equal(result.outcome, 'verified');
 assert.equal(f.requests.length, 2);
 assert.equal(f.navigations.length, 2);
 assert.deepEqual((await client.pending()).map(r => r.productId), ['crowns_525']);
 const intentional = await client.start(choice);
 assert.notEqual(intentional.record.key, first.record.key);
});

test('PF2 actor-bound terminal and refunded results permit a subsequent intentional purchase', async () => {
 for (const status of ['expired', 'canceled', 'cancelled', 'refunded']) {
  const f = await fixture(), client = f.fresh();
  const first = await client.start(choice);
  Object.assign(f.states.get(first.record.checkoutId), status === 'refunded' ? {paid:true, refunded:true} : {status});
  const [result] = await client.recover();
  assert.equal(result.outcome, status === 'refunded' ? 'refunded' : 'terminal');
  assert.equal((await client.pending()).length, 0);
  assert.equal(f.requests.length, 1);
  assert.notEqual((await client.start(choice)).record.key, first.record.key);
 }
});

test('PF2 success-like statuses, read failures and malformed verification never invent completion', async () => {
 const f = await fixture(), client = f.fresh();
 const {record} = await client.start(choice);
 const state = f.states.get(record.checkoutId);
 state.status = 'succeeded';
 assert.equal((await client.recover())[0].outcome, 'pending', 'paid:true is mandatory');
 for (const extra of [
  {read:async () => { throw Error('REQUEST_TIMEOUT'); }},
  {read:async () => ({...state, paid:'true'})},
  {read:async () => ({...state, paid:true, productId:'crowns_1100'})},
  {read:async () => ({...state, paid:true, checkoutId:'someone-else'})},
 ]) {
  assert.equal((await f.fresh(extra).recover())[0].outcome, 'error');
  assert.equal((await client.pending())[0].key, record.key);
 }
});

test('PF2 failed payment remains resumable under its existing session instead of allocating again', async () => {
 const f = await fixture(), client = f.fresh();
 const first = await client.start(choice);
 f.states.get(first.record.checkoutId).status = 'failed';
 assert.equal((await client.recover())[0].outcome, 'pending');
 assert.equal((await client.start(choice)).record.key, first.record.key);
 assert.equal(f.requests.length, 1);
});

test('PF2 unavailable status for one checkout does not hide another verified checkout', async () => {
 const f = await fixture(), client = f.fresh();
 const first = await client.start(choice);
 const second = await client.start({...choice, productId:'crowns_525'});
 f.states.get(second.record.checkoutId).paid = true;
 const returned = f.fresh({read:async url => {
  if (url.includes(first.record.checkoutId)) throw Error('REQUEST_TIMEOUT');
  return f.options.read(url);
 }});
 const results = await returned.recover();
 assert.deepEqual(results.map(r => r.outcome), ['error', 'verified']);
 assert.deepEqual((await client.pending()).map(r => r.key), [first.record.key]);
});

test('PF2 replay with no URL verifies through status rather than treating create status as paid', async () => {
 const f = await fixture();
 const client = f.fresh({
  request:async () => ({checkoutId:'completed', productId:choice.productId, status:'succeeded'}),
  read:async () => ({checkoutId:'completed', productId:choice.productId, paid:true}),
 });
 assert.equal((await client.start(choice)).outcome, 'verified');
 assert.equal(f.navigations.length, 0);
 assert.equal((await client.pending()).length, 0);
});

test('PF2 unavailable IndexedDB or corrupt legacy data refuses a new create', async () => {
 const f = await fixture(), {createHostedCheckoutStore} = await data;
 for (const settings of [
  {indexedDB:null},
  {indexedDB:new IDBFactory(), legacyStorage:() => ({getItem:() => '{broken'})},
  {indexedDB:new IDBFactory(), legacyStorage:() => ({getItem:() => JSON.stringify({version:1, records:[{actorId:'another-actor'}]})})},
 ]) await assert.rejects(f.fresh({store:createHostedCheckoutStore(settings)}).start(choice), /CHECKOUT_RECOVERY_UNAVAILABLE/);
 assert.equal(f.requests.length, 0);
});

test('PF24-R1 a proven non-created checkout retires and the next click starts a fresh purchase', async () => {
 const f = await fixture();
 let disposition = 'ambiguous';
 const attempts = [];
 const failingRequest = async (url, body, key) => { attempts.push(key); throw Error('DODO_CONFIG'); };
 const scopedReader = extra => f.fresh({read:async url => {
  const reply = await f.options.read(url);
  return url.includes('/disposition') ? {...reply, disposition} : reply;
 }, ...extra});
 // A terminal provider rejection with no checkout is retained as ambiguous by
 // default: the server may have created something the reply did not carry.
 const stranded = scopedReader({request:failingRequest});
 await assert.rejects(stranded.start(choice), /DODO_CONFIG/);
 const strandedKey = attempts[0];
 // Retry BEFORE the disposition confirms non-creation reuses the same key.
 const retried = scopedReader({request:failingRequest});
 await assert.rejects(retried.start(choice), /DODO_CONFIG/);
 assert.deepEqual(attempts, [strandedKey, strandedKey], 'the stranded key is still the operation');
 // Once the actor-bound disposition proves non-creation, the identity retires.
 disposition = 'not_created';
 const recovered = await scopedReader({}).recover();
 assert.equal(recovered[0].outcome, 'not-created');
 // The NEXT explicit purchase is a new operation, not a replay of the poison.
 const fresh = await f.fresh({}).start(choice);
 assert.equal(fresh.outcome, 'opening');
 assert.notEqual(fresh.record.key, strandedKey);
});

test('PF24-R2 interleaved different-scope writes keep every live checkout identity', async () => {
 const f = await fixture(), gate = deferred();
 const first = f.fresh({request:async (...args) => { await gate.promise; return f.options.request(...args); }});
 const slow = first.start(choice);
 // A second tab buys a different product while the first create is in flight.
 const other = await f.fresh().start({...choice, productId:'crowns_525'});
 gate.resolve({checkoutId:'late', productId:choice.productId, checkoutUrl:'https://checkout.example/late'});
 const resumed = await slow;
 const pending = await f.fresh().pending();
 assert.deepEqual(pending.map(r => r.productId).sort(), ['crowns_100', 'crowns_525'],
  'the late reply must not erase the other scope and vice versa');
 assert.equal(pending.find(r => r.productId === 'crowns_100').key, resumed.record.key);
 assert.equal(pending.find(r => r.productId === 'crowns_525').key, other.record.key);
});

test('PF24-R2 a retired attempt cannot overwrite a newer intentional purchase', async () => {
 const f = await fixture();
 const store = f.store();
 const record = key => ({actorId:'synthetic-a', provider:'dodo', productId:'crowns_100',
  currency:'usd', key, checkoutId:'', checkoutUrl:null});
 await store.claim(record('K1'));
 const resumed = await store.claim(record('K2'));
 assert.equal(resumed.created, false, 'an existing attempt is resumed, not replaced');
 assert.equal(resumed.record.key, 'K1');
 // A NEW intentional purchase after the old one ended replaces the identity.
 await store.retire(record('K1'));
 await store.claim(record('K2'));
 // A stale tab still holding K1 can neither overwrite nor retire K2.
 await assert.rejects(store.put(record('K1')), /CHECKOUT_RECOVERY_CONFLICT/);
 assert.equal(await store.retire(record('K1')), false, 'a stale retire is a no-op');
 const pending = await f.fresh().pending();
 assert.equal(pending.length, 1);
 assert.equal(pending[0].key, 'K2', 'compare-and-set keeps the newer operation');
});

test('PF2 duplicate in-flight attempts report REQUEST_PENDING and preserve the original operation', async () => {
 const f = await fixture(), gate = deferred();
 const client = f.fresh({request:async (...args) => { await gate.promise; return f.options.request(...args); }});
 const first = client.start(choice);
 await assert.rejects(client.start(choice), /REQUEST_PENDING/);
 gate.resolve(); await first;
 assert.equal(f.requests.length, 1);
});

test('PF2 unsafe URLs never navigate and malformed create replies retain the same key', async () => {
 for (const checkoutUrl of ['http://checkout.example/', 'javascript:alert(1)', 'https://user:password@checkout.example/']) {
  const f = await fixture();
  const client = f.fresh({request:async () => ({checkoutUrl})});
  await assert.rejects(client.start(choice), /STORE_UNAVAILABLE/);
  const key = (await client.pending())[0].key;
  assert.equal(f.navigations.length, 0);
  await f.fresh().start(choice);
  assert.equal(f.requests[0].key, key);
 }
});
