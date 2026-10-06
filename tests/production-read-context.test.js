'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DurableStore}=require('../server/economy-store');
const {ReadContext}=require('../server/production/read-context');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v4-reads-')),file=path.join(dir,'db'),store=new DurableStore(file),other=new DurableStore(file);store.run({actor:'operator',scope:'operator'},'create',{type:'provision',account:'a',options:{verified:true,coins:150}});const context=new ReadContext(store);t.after(()=>{context.close();other.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});return {store,other,context};}
test('request-local reads never share mutable account objects across requests',t=>{
 const {store,context}=fixture(t);let first;
 context.run(()=>{first=store.read();assert.equal(store.read(),first);first.account('a').coins=99999;});
 context.run(()=>{assert.notEqual(store.read(),first);assert.equal(store.read().account('a').coins,150);});
 assert.equal(store.read().account('a').coins,150);assert(context.hits>=1);
});
test('request reads invalidate after same-connection and external-connection writes',t=>{
 const {store,other,context}=fixture(t);
 context.run(()=>{
  const a=store.read();assert.equal(a.account('a').coins,150);
  store.run({actor:'a',scope:'player'},'coin-to-crown',{type:'convert',from:'coins',amount:10});assert.equal(store.read().account('a').coins,140);
  other.run({actor:'a',scope:'player'},'second-conversion',{type:'convert',from:'coins',amount:10});assert.equal(store.read().account('a').coins,130);
 });
});
test('financial transactions always obtain fresh state instead of a request cache',t=>{
 const {store,context}=fixture(t);
 context.run(()=>{
  store.read().account('a').coins=99999;
  store.run({actor:'a',scope:'player'},'convert',{type:'convert',from:'coins',amount:10});
  assert.equal(store.read().account('a').coins,140);
  assert.throws(()=>store.run({actor:'a',scope:'player'},'overspend',{type:'convert',from:'coins',amount:1000}),/INSUFFICIENT/);
  assert.equal(store.read().account('a').coins,140);
 });
});
