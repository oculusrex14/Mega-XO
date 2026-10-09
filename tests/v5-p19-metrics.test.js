'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {measure,summary,safeError}=require('../scripts/v5/p19/metrics.js');

test('nearest-rank p95 and p99 use actual samples, including maxima on small N',()=>{
 const hist=summary([6,4,1,9,7,5,3,8,2,10]);
 assert.equal(hist.p50Ms,5);
 assert.equal(hist.p95Ms,10);
 assert.equal(hist.p99Ms,10);
 assert.equal(hist.minMs,1);
 assert.equal(hist.maxMs,10);
 assert.equal(hist.meanMs,5.5);
 for(const samples of [[],[-1],[Infinity],[NaN],[61000]]) {
   assert.throws(()=>summary(samples),/P19_METRICS_REFUSED/);
 }
});
test('concurrency is enforced and both successful and failed attempts contribute to percentiles',async()=>{
 let active=0,peak=0;
 const tasks=['api_read','api_read','game_move','game_move','worker_poll'];
 const result=await measure({work:tasks,concurrency:2,perform:async(op,index)=>{
   active++;peak=Math.max(peak,active);
   await new Promise(r=>setTimeout(r,5));
   active--;
   if(index===1){const e=new Error('sensitive auth');e.code='BUSY';throw e;}
 }});
 assert.ok(peak<=2);
 assert.equal(result.executedOperations,5);
 assert.equal(result.completedSuccessfully,4);
 assert.equal(result.failedOperations,1);
 assert.deepEqual(result.errorClasses,{BUSY:1});
 assert.equal(result.maxInFlight,2);
 assert.equal(result.g19Accepted,false);
 assert.equal(result.launchEnvelopeProven,false);
 assert.ok(result.latency.p99Ms>=result.latency.p50Ms);
 assert.ok(result.attemptedPerSec>0);
 assert.ok(result.processHeadroomObservation.rssAfterBytes>0);
 assert.equal(result.operationGroups.api_read.failures,1);
});
test('no raw error messages or personal actor IDs enter metric labels',async()=>{
 const result=await measure({work:['api_read'],concurrency:1,perform:()=>{throw new Error('email=sensitive@user.test bearer=secret');}});
 assert.deepEqual(result.errorClasses,{ERROR:1});
 assert.doesNotMatch(JSON.stringify(result),/sensitive|email=|bearer=/);
 assert.equal(safeError({code:'CUSTOM_CREDIT_CARD_ID'}),'ERROR');
});
test('rejects unreviewed operations, unlimited concurrency and unbounded deadlines',async()=>{
 for(const options of [
   {work:['public_url'],concurrency:1},
   {work:[],concurrency:1},
   {work:['api_read'],concurrency:10000},
   {work:['api_read'],concurrency:1,deadlineMs:999999},
   {work:['api_read'],concurrency:0}
 ]) {
   await assert.rejects(measure({...options,perform:async()=>{}}),/P19_METRICS_REFUSED/);
 }
});
test('deadline never reports a partial green result',async()=>{
 await assert.rejects(
   measure({work:['game_move','api_read'],concurrency:1,deadlineMs:1,
     perform:()=>new Promise(resolve=>setTimeout(resolve,12))}),
   /P19_METRICS_REFUSED/
 );
});

test('disposable reality labels cannot masquerade as unbuilt realtime/service transport',async()=>{
 const {REAL_DISPOSABLE_OPERATIONS}=require('../scripts/v5/p19/metrics.js');
 assert.deepEqual(REAL_DISPOSABLE_OPERATIONS,[
  'api_account_read','core_currency_conversion','redis_presence','redis_rate_window'
 ]);
 const report=await measure({work:REAL_DISPOSABLE_OPERATIONS,concurrency:2,perform:async()=>{}});
 assert.equal(report.executedOperations,4);
 assert.equal(report.g19Accepted,false);
 assert.equal(report.launchEnvelopeProven,false);
 assert.ok(report.operationGroups.redis_rate_window);
});
