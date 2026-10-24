'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const data = import(pathToFileURL(path.join(__dirname, '../apps/web/data.js')).href);
const choice = {provider:'dodo', productId:'crowns_100', currency:'usd', country:'US', acceptanceHash:'synthetic-acceptance'};
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return {promise, resolve}; };

async function fixture() {
 const {createHostedCheckout} = await data;
 const saved = new Map(), requests = [], reads = [], navigations = [];
 let actor = 'synthetic-a', sequence = 0;
 const storage = {getItem:key => saved.get(key) ?? null, setItem:(key, value) => saved.set(key, value)};
 const states = new Map();
 const options = {
  actor:() => actor, storage:() => storage, locks:null,
  operationKey:() => 'synthetic-op-' + ++sequence,
  request:async (url, body, key) => {
   requests.push({url, body, key});
   const checkoutId = 'checkout-' + key;
   states.set(checkoutId, {checkoutId, productId:body.product, paid:false, status:'pending'});
   return {checkoutId, productId:body.product, checkoutUrl:'https://checkout.example/' + checkoutId};
  },
  read:async url => { reads.push(url); return states.get(new URL(url, 'https://megaxo.online').searchParams.get('checkout_id')); },
  navigate:url => navigations.push(url),
 };
 return {saved, storage, requests, reads, navigations, states, options,
  actor:value => { actor = value; }, fresh:extra => createHostedCheckout({...options, ...extra})};
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
 assert.equal(client.pending()[0].key, first.record.key);
});

test('PF2 lost create reply persists the key before I/O and replays it after reload', async () => {
 const f = await fixture();
 let durableKey;
 const first = f.fresh({request:async (_url, _body, key) => {
  durableKey = f.fresh().pending()[0].key;
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
 assert.equal(f.navigations[0], restored.pending()[0].checkoutUrl);
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
 assert.equal(client.pending().length, 4);
 assert.equal(new Set(f.requests.map(r => r.key)).size, 4);
 await client.start(choice);
 assert.equal(f.requests.length, 4, 'the original product still resumes its own checkout');
});

test('PF2 another actor cannot recover or navigate a prior actor checkout', async () => {
 const f = await fixture(), client = f.fresh();
 const first = await client.start(choice);
 f.actor('synthetic-b'); client.invalidate();
 assert.deepEqual(client.pending(), []);
 assert.deepEqual(await client.recover(), []);
 const other = await client.start(choice);
 assert.notEqual(other.record.key, first.record.key);
 assert.notEqual(other.record.checkoutUrl, first.record.checkoutUrl);
 f.actor('synthetic-a'); client.invalidate();
 assert.equal(client.pending()[0].key, first.record.key);
});

test('PF2 late create responses are fenced across account changes, including A-B-A', async () => {
 const f = await fixture(), gate = deferred();
 const client = f.fresh({request:() => gate.promise});
 const pending = client.start(choice);
 const key = client.pending()[0].key;
 f.actor('synthetic-b'); client.invalidate();
 f.actor('synthetic-a'); client.invalidate();
 gate.resolve({checkoutId:'late', checkoutUrl:'https://checkout.example/late'});
 await assert.rejects(pending, /AUTH_REQUIRED/);
 assert.equal(f.navigations.length, 0);
 assert.equal(client.pending()[0].key, key, 'ambiguous old attempt stays recoverable');
 assert.equal(client.pending()[0].checkoutUrl, null);
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
 assert.deepEqual(client.pending().map(r => r.productId), ['crowns_525']);
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
  assert.equal(client.pending().length, 0);
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
  assert.equal(client.pending()[0].key, record.key);
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
 assert.deepEqual(client.pending().map(r => r.key), [first.record.key]);
});

test('PF2 replay with no URL verifies through status rather than treating create status as paid', async () => {
 const f = await fixture();
 const client = f.fresh({
  request:async () => ({checkoutId:'completed', productId:choice.productId, status:'succeeded'}),
  read:async () => ({checkoutId:'completed', productId:choice.productId, paid:true}),
 });
 assert.equal((await client.start(choice)).outcome, 'verified');
 assert.equal(f.navigations.length, 0);
 assert.equal(client.pending().length, 0);
});

test('PF2 unavailable or corrupt durable storage refuses a new create', async () => {
 const f = await fixture();
 for (const storage of [
  {getItem:() => null, setItem:() => { throw Error('quota'); }},
  {getItem:() => '{broken'},
  {getItem:() => JSON.stringify({version:1, records:[{actorId:'another-actor'}]})},
 ]) await assert.rejects(f.fresh({storage:() => storage}).start(choice), /CHECKOUT_RECOVERY_UNAVAILABLE/);
 assert.equal(f.requests.length, 0);
});

test('PF2 duplicate in-flight attempts report REQUEST_PENDING and preserve the original operation', async () => {
 const f = await fixture(), gate = deferred();
 const client = f.fresh({request:async (...args) => { await gate.promise; return f.options.request(...args); }});
 const first = client.start(choice);
 await assert.rejects(client.start(choice), /REQUEST_PENDING/);
 gate.resolve(); await first;
 assert.equal(f.requests.length, 1);
});

test('PF2 Web Locks serialize recovery from two tabs against shared durable state', async () => {
 const f = await fixture();
 let tail = Promise.resolve();
 const locks = {request(_name, callback) { const next = tail.then(callback); tail = next.catch(() => {}); return next; }};
 await Promise.all([f.fresh({locks}).start(choice), f.fresh({locks}).start(choice)]);
 assert.equal(f.requests.length, 1);
 assert.equal(new Set(f.navigations).size, 1);
});

test('PF2 unsafe URLs never navigate and malformed create replies retain the same key', async () => {
 for (const checkoutUrl of ['http://checkout.example/', 'javascript:alert(1)', 'https://user:password@checkout.example/']) {
  const f = await fixture();
  const client = f.fresh({request:async () => ({checkoutUrl})});
  await assert.rejects(client.start(choice), /STORE_UNAVAILABLE/);
  const key = client.pending()[0].key;
  assert.equal(f.navigations.length, 0);
  await f.fresh().start(choice);
  assert.equal(f.requests[0].key, key);
 }
});
