'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const P=require('../../src/bot/pack.js'),C=require('../../src/bot/contracts.js');
const bytes=new Uint8Array([1,2,3,4]),hash=crypto.createHash('sha256').update(bytes).digest('hex'),info={schemaVersion:1,version:'test-v1',ruleset:C.RULESET,encodingVersion:P.ENCODING,sha256:hash,url:'/game/ai/'+hash+'.onnx',bytes:4,gzipBytes:4,deploymentStatus:'APPROVED'};
function fixture(fetcher=async()=>new Response(bytes)){const data=new Map(),cache={async match(k){return data.get(k)?.clone();},async put(k,v){data.set(k,v.clone());},async delete(k){return data.delete(k);}};const states=[];return {data,states,store:new P.Store({baseURL:'https://game.example/game/index.html',cacheStorage:{open:async()=>cache},fetcher,catalog:[info],onState:s=>states.push(s)})};}
test('no network download without explicit consent; approved pin survives a new store and offline cache read',async()=>{let calls=0;const f=fixture(async()=>{calls++;return new Response(bytes);});await assert.rejects(f.store.download(info),/CONSENT/);assert.equal(calls,0);await f.store.download(info,{consent:true});const pin=f.store.pin(info);assert.equal(pin.modelHash,hash);const second=new P.Store({baseURL:f.store.baseURL,cacheStorage:f.store.caches,fetcher:async()=>{throw Error('offline');}});assert.deepEqual(await second.read(info),bytes);assert.equal(P.resolvePinned(pin,[info]),info);await second.remove(info);assert.equal(await second.read(info),null);});
test('corrupt, oversized and incompatible artifacts never become a ready pack',async()=>{for(const body of [new Uint8Array([9,2,3,4]),new Uint8Array(5)]){const f=fixture(async()=>new Response(body));await assert.rejects(f.store.download(info,{consent:true}));assert.equal(f.data.size,0);assert.equal(f.store.state.status,'corrupt');}assert.throws(()=>P.manifest({...info,url:'https://other.example/'+hash+'.onnx'},'https://game.example/'),/URL_INVALID/);assert.throws(()=>P.manifest({...info,encodingVersion:'other'},'https://game.example/'),/INCOMPATIBLE/);});
test('pause cancels pending bytes and late replies cannot mark a pack ready',async()=>{let reply;const f=fixture(()=>new Promise(resolve=>{reply=resolve;}));const pending=f.store.download(info,{consent:true});while(!reply)await new Promise(resolve=>setImmediate(resolve));f.store.pause();reply(new Response(bytes));await assert.rejects(pending,{name:'AbortError'});assert.equal(f.store.state.status,'paused');assert.equal(f.data.size,0);});
test('cached corruption is removed and an unapproved model is never labeled playable Impossible',async()=>{const f=fixture();await f.store.download(info,{consent:true});const key=[...f.data.keys()][0];f.data.set(key,new Response(new Uint8Array([0,0,0,0])));await assert.rejects(f.store.read(info),/HASH/);assert.equal(f.data.size,0);await f.store.download(info,{consent:true});assert.throws(()=>f.store.pin({...info,deploymentStatus:'UNAPPROVED'}),/NOT_APPROVED_READY/);assert.equal(P.APPROVED_CATALOG.length,0);});
test('remove waits for all old cache writes and cannot be undone by a late download',async()=>{
 const data=new Map(),writes=[];
 const cache={async match(k){return data.get(k)?.clone();},async delete(k){return data.delete(k);},async put(k,v){await new Promise(resolve=>writes.push(resolve));data.set(k,v.clone());}};
 const store=new P.Store({baseURL:'https://game.example/',cacheStorage:{open:async()=>cache},fetcher:async()=>new Response(bytes)});
 const first=store.download(info,{consent:true}),firstRejected=assert.rejects(first,{name:'AbortError'});
 while(writes.length<1)await new Promise(r=>setImmediate(r));
 const second=store.download(info,{consent:true}),secondRejected=assert.rejects(second,{name:'AbortError'});
 while(writes.length<2)await new Promise(r=>setImmediate(r));
 const removed=store.remove(info);await assert.rejects(store.download(info,{consent:true}),/PACK_BUSY/);
 writes[1]();writes[0]();await Promise.all([removed,firstRejected,secondRejected]);assert.equal(data.size,0);assert.equal(store.state.status,'unavailable');
});
test('a default catalog never approves arbitrary metadata or cached oversized content',async()=>{
 const f=fixture();await f.store.download(info,{consent:true});f.store.catalog=[];assert.throws(()=>f.store.pin(info),/NOT_APPROVED_READY/);
 const key=[...f.data.keys()][0];f.data.set(key,new Response(new Uint8Array(5)));await assert.rejects(f.store.read(info),/SIZE/);assert.equal(f.data.size,0);
});
