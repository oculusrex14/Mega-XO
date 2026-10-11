'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const data=import('../apps/web/data.js');
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
