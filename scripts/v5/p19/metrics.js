#!/usr/bin/env node
'use strict';

/**
 * P19-02: bounded, monotonic, no-identifying-data measurements.
 *
 * The caller supplies actual test operations and a disposable, verified
 * execution environment. Returned throughput/latency is *only* for that
 * adapter, hardware and fixture size; never an inferred launch envelope.
 * The test runner does not contain URL dispatch or production credentials.
 */
const {performance}=require('node:perf_hooks');
const {MAX_CLIENTS,MAX_OPS,OPERATIONS}=require('./workload-profile.js');
const KNOWN_ERRORS=new Set(['BUSY','TIMEOUT','CONFLICT','RATE_LIMITED','UNAVAILABLE','REJECTED','ERROR']);
function refuse(why){throw Error('P19_METRICS_REFUSED: '+why);}
function numeric(n){return typeof n==='number'&&Number.isFinite(n);}
function summary(samples) {
 if(!Array.isArray(samples)||samples.length<1||samples.length>MAX_OPS||
    samples.some(value=>!numeric(value)||value<0||value>60000))refuse('latency sample missing, negative or unbounded');
 const sorted=[...samples].sort((a,b)=>a-b);
 const at=p=>sorted[Math.max(0,Math.ceil((p/100)*sorted.length)-1)];
 return {
   samples:sorted.length,
   minMs:sorted[0],p50Ms:at(50),p95Ms:at(95),p99Ms:at(99),maxMs:sorted.at(-1),
   meanMs:samples.reduce((a,b)=>a+b,0)/samples.length,
   percentileMethod:'nearest-rank'
 };
}
function safeError(error) {
 const code=error&&typeof error==='object'&&typeof error.code==='string'?error.code:'ERROR';
 return KNOWN_ERRORS.has(code)?code:'ERROR';
}
function snapshot() {
 const mem=process.memoryUsage(),cpu=process.cpuUsage(),elu=performance.eventLoopUtilization();
 return {rss:mem.rss,heap:mem.heapUsed,userUs:cpu.user,systemUs:cpu.system,elu};
}
async function measure({work,concurrency,perform,deadlineMs=60000,clock=()=>performance.now()}={}) {
 if(!Array.isArray(work)||work.length<1||work.length>MAX_OPS||
    !Number.isSafeInteger(concurrency)||concurrency<1||concurrency>MAX_CLIENTS||
    typeof perform!=='function'||typeof clock!=='function'||
    !Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>60000)refuse('invalid synthetic workload bounds');
 const allowed=new Set(OPERATIONS.map(o=>o.name));
 for(const task of work) {
   if(typeof task!=='string'||!allowed.has(task))refuse('unrecognized operation class');
 }
 const before=snapshot(),start=clock(),results=[],controller=new AbortController();
 if(!numeric(start))refuse('nonmonotonic clock');
 let next=0,inflight=0,peak=0,expired=false;
 const ticker=setTimeout(()=>{expired=true;controller.abort();},deadlineMs);
 try {
   const workers=Array.from({length:Math.min(concurrency,work.length)},async()=>{
     while(next<work.length&&!controller.signal.aborted){
       const index=next++,op=work[index],began=clock();
       inflight++;peak=Math.max(peak,inflight);
       try {
         await perform(op,index,controller.signal);
         const ended=clock();
         if(!numeric(ended)||ended<began)refuse('nonmonotonic operation clock');
         results.push({op,ms:ended-began,ok:true});
       }catch(error){
         const ended=clock();
         if(!numeric(ended)||ended<began)refuse('nonmonotonic failure clock');
         results.push({op,ms:ended-began,ok:false,code:safeError(error)});
       }finally{inflight--;}
     }
   });
   await Promise.all(workers);
 }finally{clearTimeout(ticker);}
 const elapsed=clock()-start,after=snapshot();
 if(expired||controller.signal.aborted)refuse('deadline reached; capacity test was incomplete');
 if(!numeric(elapsed)||elapsed<=0||results.length!==work.length||inflight!==0) {
   refuse('incomplete or invalid measurement');
 }
 const errors={},byOp={};
 for(const o of OPERATIONS){
   const rows=results.filter(r=>r.op===o.name);
   if(!rows.length)continue;
   byOp[o.name]={
     attempted:rows.length,ok:rows.filter(r=>r.ok).length,
     failures:rows.filter(r=>!r.ok).length,
     latency:summary(rows.map(r=>r.ms))
   };
 }
 for(const r of results)if(!r.ok)errors[r.code]=(errors[r.code]||0)+1;
 const successful=results.filter(x=>x.ok).length;
 return {
   format:'mega-v5-p19-executor-metrics/v1',
   result:'MEASURED_ADAPTER_ONLY_NOT_LAUNCH_CAPACITY',
   executedOperations:results.length,completedSuccessfully:successful,
   failedOperations:results.length-successful,
   errorClasses:errors,
   latency:summary(results.map(x=>x.ms)),
   elapsedMs:elapsed,
   attemptedPerSec:Number((results.length/(elapsed/1000)).toFixed(4)),
   successfulPerSec:Number((successful/(elapsed/1000)).toFixed(4)),
   maxInFlight:peak,requestedConcurrency:concurrency,
   processHeadroomObservation:{
     cpuUserDeltaUs:Math.max(0,after.userUs-before.userUs),
     cpuSystemDeltaUs:Math.max(0,after.systemUs-before.systemUs),
     rssBeforeBytes:before.rss,rssAfterBytes:after.rss,
     heapAfterBytes:after.heap,
     eventLoopUtilization:performance.eventLoopUtilization(after.elu,before.elu).utilization
   },
   operationGroups:byOp,
   latencyScope:'single_process_test_operation_including_executor_queue/service_wait',
   g19Accepted:false,
   launchEnvelopeProven:false,
   claimsNotSupported:['real network p95/p99','Vercel/API/Core/worker process saturation',
     'Oracle host capacity','sustainable player forecast','P18 staging acceptance']
 };
}
module.exports={KNOWN_ERRORS,safeError,summary,measure};
