'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const data=import('../apps/web/data.js');
const pages=import('../apps/web/pages.js');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
test('P21-DATA-01 browsing profile never bootstraps a session and auth state stops',async()=>{
 const {createReadModel}=await data;const context={};const paths=[];let changes=0;
 const model=createReadModel({context,changed:()=>changes++,request:async path=>{paths.push(path);throw Error('LINK_ACCOUNT_REQUIRED');}});
 await model.profile();assert.deepEqual(paths,['/api/v1/profile']);assert.equal(context.sessionStatus,'guest');assert.equal(context.profile,null);assert.equal(changes,2);model.destroy();
});
test('P21-DATA-02 linked profile preserves server tier, precise rating and wallet',async()=>{
 const {createReadModel}=await data;const context={};const profile={id:'synthetic',tier:'emerald',rating:1968.25,wallet:{coins:2450,crowns:12}};
 const model=createReadModel({context,changed:()=>{},request:async()=>profile});await model.profile();assert.equal(context.profile,profile);assert.equal(context.sessionStatus,'linked');model.destroy();
});
test('P21-DATA-03 filter changes fence stale standings and preserve server ordering',async()=>{
 const {createReadModel}=await data;const context={};const pending=[];
 const model=createReadModel({context,changed:()=>{},request:path=>new Promise(resolve=>pending.push({path,resolve}))});
 const first=model.leaderboard({metric:'rating'}),second=model.leaderboard({metric:'wealth',league:'gold',scope:'region'});
 assert.match(pending[1].path,/metric=wealth&scope=local&league=gold/);
 const rows=[{id:'b',wealth:200},{id:'a',wealth:100}];pending[1].resolve(rows);await second;pending[0].resolve([{id:'old'}]);await first;
 assert.equal(context.leaderboard.rows,rows);assert.equal(context.leaderboard.metric,'wealth');assert.equal(context.leaderboard.status,'ready');model.destroy();
});
test('P21-DATA-04 auth-required standings remain inside the website and destroy fences late data',async()=>{
 const {createReadModel}=await data;const context={};let resolve;
 const model=createReadModel({context,changed:()=>{},request:async()=>{throw Error('AUTH_REQUIRED');}});await model.leaderboard();assert.equal(context.leaderboard.error,'AUTH_REQUIRED');assert.deepEqual(context.leaderboard.rows,[]);model.destroy();
 const other=createReadModel({context,changed:()=>{},request:()=>new Promise(r=>resolve=r)});const work=other.profile();other.destroy();resolve({id:'late'});await work;assert.notEqual(context.sessionStatus,'linked');
});
test('P21-DATA-05 transport keeps protected same-origin cookies and sanitizes errors',async()=>{
 const {readJSON}=await data;let options;
 await assert.rejects(readJSON('/api/v1/profile',{fetcher:async(path,opts)=>{options=opts;return{ok:false,json:async()=>({error:'secret-bearing upstream details'})};}}),/SERVICE_UNAVAILABLE/);
 assert.equal(options.credentials,'same-origin');assert.equal(options.headers.Accept,'application/json');assert.equal(options.method,undefined);
});

test('P21-DATA-06 an unresponsive profile client reaches a retryable error after eight seconds',async t=>{
 const {createReadModel}=await data;const {renderPage}=await pages;
 t.mock.timers.enable({apis:['setTimeout']});
 const context={profile:{id:'previous-actor'},sessionStatus:'linked'},changes=[];let signal,calls=0;
 const model=createReadModel({context,changed:()=>changes.push(context.sessionStatus),request:(path,options)=>{
  calls++;assert.equal(path,'/api/v1/profile');signal=options.signal;return new Promise(()=>{});
 }});
 const work=model.profile();
 assert.equal(context.sessionStatus,'loading');
 t.mock.timers.tick(7999);await flush();assert.equal(context.sessionStatus,'loading');assert.equal(signal.aborted,false);
 t.mock.timers.tick(1);await work;
 assert.equal(context.sessionStatus,'error');assert.equal(context.profile,null);assert.equal(signal.aborted,true);
 assert.equal(context.accountMessage,'The service did not respond in time. Try again.');
 const html=renderPage('/account',context);assert.match(html,/data-account-action="retry"/);assert.doesNotMatch(html,/Checking your account|Restoring your current session/);
 assert.deepEqual(changes,['loading','error']);assert.equal(calls,1,'the website does not loop or bootstrap a session on failure');
 model.destroy();
});

test('P21-DATA-07 the profile deadline also bounds a stalled response body that ignores abort',async t=>{
 const {createReadModel,readJSON}=await data;
 t.mock.timers.enable({apis:['setTimeout']});
 const context={};let signal,bodyReads=0;
 const fetcher=async(_path,options)=>{
  signal=options.signal;assert.equal(options.credentials,'same-origin');
  return {ok:true,json:()=>{bodyReads++;return new Promise(()=>{});}};
 };
 const model=createReadModel({context,changed:()=>{},request:(path,options)=>readJSON(path,{...options,fetcher})});
 const work=model.profile();await flush();assert.equal(bodyReads,1);
 t.mock.timers.tick(8000);await work;
 assert.equal(signal.aborted,true);assert.equal(context.sessionStatus,'error');assert.equal(context.profile,null);
 assert.equal(context.accountMessage,'The service did not respond in time. Try again.');model.destroy();
});

test('P21-DATA-08 retry uses a fresh check and a late timed-out response cannot replace its actor',async t=>{
 const {createReadModel}=await data;
 t.mock.timers.enable({apis:['setTimeout']});
 const context={},first=deferred(),signals=[],changes=[];
 const current={id:'current-actor',rating:1968.25,wallet:{coins:2450,crowns:12}};
 const model=createReadModel({context,changed:()=>changes.push(context.sessionStatus),request:(_path,{signal})=>{
  signals.push(signal);return signals.length===1?first.promise:Promise.resolve(current);
 }});
 const work=model.profile();t.mock.timers.tick(8000);await work;assert.equal(context.sessionStatus,'error');
 await model.profile();assert.equal(context.sessionStatus,'linked');assert.equal(context.profile,current);assert.equal(context.accountMessage,'');
 assert.notEqual(signals[0],signals[1]);assert.equal(signals[0].aborted,true);assert.equal(signals[1].aborted,false);
 first.resolve({id:'late-actor',wallet:{coins:99999,crowns:999}});await flush();
 t.mock.timers.tick(16000);await flush();
 assert.equal(context.profile,current);assert.equal(signals[1].aborted,false,'a completed check releases its deadline');
 assert.deepEqual(changes,['loading','error','loading','linked']);model.destroy();
});

test('P21-DATA-09 replacing a pending restoration releases the old wait and fences late failure',async()=>{
 const {createReadModel}=await data;const first=deferred(),second=deferred(),context={},signals=[],changes=[];
 const model=createReadModel({context,changed:()=>changes.push(context.sessionStatus),request:(_path,{signal})=>{
  signals.push(signal);return signals.length===1?first.promise:second.promise;
 }});
 const old=model.profile(),current=model.profile();await old;
 assert.equal(signals[0].aborted,true);assert.equal(context.sessionStatus,'loading');
 second.resolve({id:'current-actor'});await current;
 first.reject(Error('AUTH_REQUIRED'));await flush();
 assert.equal(context.sessionStatus,'linked');assert.equal(context.profile.id,'current-actor');
 assert.deepEqual(changes,['loading','loading','linked']);model.destroy();
});

test('P21-DATA-10 logout invalidation releases a stalled wait and late data cannot restore the account',async t=>{
 const {createReadModel}=await data;
 t.mock.timers.enable({apis:['setTimeout']});
 const pending=deferred(),context={profile:{id:'actor-one'},sessionStatus:'linked'};let signal,changes=0;
 const model=createReadModel({context,changed:()=>changes++,request:(_path,options)=>{signal=options.signal;return pending.promise;}});
 const work=model.profile();model.invalidate();context.profile=null;context.sessionStatus='guest';context.accountMessage='You are signed out.';
 await work;assert.equal(signal.aborted,true);
 pending.resolve({id:'actor-one',wallet:{coins:100,crowns:5}});await flush();t.mock.timers.tick(16000);await flush();
 assert.equal(context.sessionStatus,'guest');assert.equal(context.profile,null);assert.equal(context.accountMessage,'You are signed out.');assert.equal(changes,1);
 model.destroy();
});

test('P21-DATA-11 destroying the model releases the wait and stops new or late profile checks',async()=>{
 const {createReadModel}=await data;const pending=deferred(),context={};let signal,calls=0,changes=0;
 const model=createReadModel({context,changed:()=>changes++,request:(_path,options)=>{calls++;signal=options.signal;return pending.promise;}});
 const work=model.profile();model.destroy();await work;assert.equal(signal.aborted,true);
 context.sessionStatus='guest';context.profile=null;
 await model.profile();pending.resolve({id:'late'});await flush();
 assert.equal(calls,1);assert.equal(changes,1);assert.equal(context.sessionStatus,'guest');assert.equal(context.profile,null);
});
