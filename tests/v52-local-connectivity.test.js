'use strict';
// Execute the shared account client and the real app connectivity handlers with synthetic hosts.
// No browser screenshots, network, provider sessions or device claims.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
const accountSource=fs.readFileSync(path.join(ROOT,'src/account-client.js'),'utf8');
const appSource=fs.readFileSync(path.join(ROOT,'src/app.js'),'utf8');
const profile={id:'synthetic-actor',providers:['google']};
const json=(body,status=200)=>({ok:status<400,status,headers:new Headers(),json:async()=>body});

function fixture({marked=false,host=null,fetcher=()=>json({csrf:'synthetic-csrf',linked:false})}={}){
 const calls=[],listeners=new Map(),nodes=new Map();
 for(const id of ['networkStatus','networkStatusTitle','networkStatusText','networkStatusAction']){
  nodes.set(id,{hidden:false,dataset:{},textContent:'',removeAttribute(name){if(name==='data-state')delete this.dataset.state;}});
 }
 const context={
  console,Date,Headers,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,crypto,
  navigator:{onLine:true},location:{href:'http://127.0.0.1:4186/capture/bundle-index.html',origin:'http://127.0.0.1:4186'},
  MegaNativeApi:host,
  CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},
  addEventListener(type,fn){listeners.set(type,fn);},
  document:{
   querySelector(selector){if(selector==='meta[name="mega-account-transport"]')return marked?{content:'native'}:null;return null;},
   dispatchEvent(event){if(event.type==='mega:connectivity')context.renderConnectivity(event.detail);}
  },
  fetch:async(resource,options={})=>{calls.push({path:String(resource),options});return fetcher(resource,options);},
  $:selector=>nodes.get(selector.slice(1)),
  online:{ready:false},connectionState:'online',onlinePoll:null,onlinePollBusy:false,
 };
 context.window=context;vm.createContext(context);
 const start=appSource.indexOf('function renderConnectivity(');
 const end=appSource.indexOf('async function retryNetwork(',start);
 vm.runInContext(appSource.slice(start,end),context,{filename:'src/app.js:renderConnectivity'});
 vm.runInContext(accountSource,context,{filename:'src/account-client.js'});
 context.renderConnectivity(context.MegaAccount.connectivity());
 return {context,calls,nodes,account:context.MegaAccount,emit:type=>listeners.get(type)?.()};
}

test('marked static/native shell without an API stays local and never attempts cookie fetch',async()=>{
 const f=fixture({marked:true,fetcher:()=>{throw Error('UNEXPECTED_NETWORK');}});
 assert.equal(f.account.connectivity().state,'local');
 assert.equal(f.nodes.get('networkStatus').hidden,true);
 for(const operation of [()=>f.account.session(),()=>f.account.request('/api/v1/profile'),
  ()=>f.account.request('/api/account/start',{provider:'google'}),()=>f.account.logout(true)]){
  await assert.rejects(operation,error=>error.message==='ONLINE_NOT_CONFIGURED');
 }
 assert.equal(f.calls.length,0);
 assert.equal(f.account.peek(),null,'local mode never invents an account or CSRF session');
 f.emit('offline');f.emit('online');
 assert.equal(f.account.connectivity().state,'local','network reachability does not configure an API');
 assert.equal(f.nodes.get('networkStatus').hidden,true);
});

test('marked shell with a configured native bridge uses it and reports an actual online failure',async()=>{
 const requests=[];
 const f=fixture({marked:true,host:{session:async()=>({online:true,linked:true,expiresAt:Date.now()+300000}),
  request:async(path,method,body,key)=>{requests.push({path,method,body,key});return path==='/api/account/profile'
   ?{ok:true,data:profile}:{ok:false,status:503,error:'SERVICE_UNAVAILABLE'};}}});
 assert.equal((await f.account.session()).profile.id,profile.id);
 await assert.rejects(()=>f.account.request('/api/v1/move',{id:'synthetic-match'},'synthetic-key'),
  error=>error.message==='SERVICE_UNAVAILABLE');
 assert.equal(f.calls.length,0,'native failure never falls back to cookies');
 assert.equal(f.account.connectivity().state,'degraded');
 assert.equal(f.nodes.get('networkStatus').hidden,false);
 assert.equal(f.nodes.get('networkStatusTitle').textContent,'Connection interrupted');
 assert.ok(requests.slice(1).every(r=>r.key==='synthetic-key'),'retry retains its operation key');
});

test('a failing configured native bootstrap is visible rather than classified as local',async()=>{
 const f=fixture({marked:true,host:{session:async()=>({online:true,linked:true,expiresAt:Date.now()+300000}),
  request:async()=>({ok:false,status:503,error:'SERVICE_UNAVAILABLE'})}});
 await assert.rejects(()=>f.account.session(),error=>error.message==='SERVICE_UNAVAILABLE');
 assert.equal(f.account.connectivity().state,'degraded');
 assert.equal(f.nodes.get('networkStatus').hidden,false);
 assert.equal(f.calls.length,0);
});

test('a native bridge appearing after local startup takes precedence over the bundle marker',async()=>{
 const f=fixture({marked:true});
 f.context.MegaNativeApi={session:async()=>({online:true,linked:true,expiresAt:Date.now()+300000}),
  request:async()=>({ok:true,data:profile})};
 assert.equal((await f.account.session()).profile.id,profile.id);
 assert.equal(f.account.connectivity().state,'online');
 assert.equal(f.calls.length,0);
});

test('unmarked web/P21 pages keep the cookie and CSRF transport even on a loopback origin',async()=>{
 const f=fixture({fetcher:resource=>String(resource)==='/api/account/session'
  ?json({linked:true,csrf:'synthetic-csrf',profile}):json({accepted:true})});
 assert.equal((await f.account.session()).linked,true);
 await f.account.request('/api/account/profile',{displayName:'Synthetic'},'synthetic-update');
 assert.deepEqual(f.calls.map(c=>c.path),['/api/account/session','/api/account/profile']);
 assert.equal(f.calls[1].options.credentials,'same-origin');
 assert.equal(f.calls[1].options.headers['X-CSRF-Token'],'synthetic-csrf');
 assert.equal(f.calls[1].options.headers['Idempotency-Key'],'synthetic-update');
 assert.equal(f.account.connectivity().state,'online');
});

test('unmarked web bootstrap failure and authenticated auth failure remain visible',async()=>{
 const broken=fixture({fetcher:()=>({ok:false,status:404,headers:new Headers(),json:async()=>{throw Error('HTML_NOT_JSON');}})});
 await assert.rejects(()=>broken.account.session(),error=>error.message==='SERVICE_UNAVAILABLE');
 assert.equal(broken.calls.length,2,'a URL or HTTP error never silently selects local mode');
 assert.equal(broken.account.connectivity().state,'degraded');
 assert.equal(broken.nodes.get('networkStatus').hidden,false);
 const auth=fixture({fetcher:()=>json({error:'AUTH_REQUIRED'},401)});
 await assert.rejects(()=>auth.account.request('/api/v1/profile'),error=>error.message==='AUTH_REQUIRED');
 assert.equal(auth.account.connectivity().state,'auth');
 assert.equal(auth.nodes.get('networkStatusTitle').textContent,'Session expired');
 assert.equal(auth.nodes.get('networkStatus').hidden,false);
});

test('local home skips online polling while configured service failures still attempt refresh',async()=>{
 const f=fixture({marked:true});let attempts=0;
 Object.assign(f.context,{refreshSerial:0,rankScope:'global',rankLeague:'all',rankMetric:'rating',page:'play',data:{profile:{region:'India'}},
  NET:{profile:async()=>{attempts++;throw Error('SERVICE_UNAVAILABLE');}},render(){},renderWalletSummary(){}});
 const start=appSource.indexOf('async function refreshOnline(){');
 const end=appSource.indexOf('\nfunction quests()',start);
 vm.runInContext(appSource.slice(start,end),f.context,{filename:'src/app.js:refreshOnline'});
 await f.context.refreshOnline();assert.equal(attempts,0);
 f.context.MegaAccount={connectivity:()=>({state:'degraded'})};
 await f.context.refreshOnline();assert.equal(attempts,1);
 assert.equal(f.context.online.ready,false);
});
