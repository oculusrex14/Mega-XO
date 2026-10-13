'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCaptureWorker,safeCode,transient}=require('../packages/learning/worker.js');
const C=require('../packages/learning/capture.js');
test('disabled collection never claims a job',async()=>{let n=0;const w=createCaptureWorker({query:async()=>{n++;return {rows:[{value:{enabled:false}}]};}},{workerId:'test'});assert.equal((await w.tick()).disabled,true);assert.equal(n,1);});
test('wrong deployed rules fail before claims',async()=>{const w=createCaptureWorker({query:async()=>({rows:[{value:{enabled:true,rulesHash:'a'.repeat(64)}}]})},{workerId:'test'});await assert.rejects(w.tick(),/CAPTURE_RULES_DEPLOYMENT_MISMATCH/);});
test('missing committed source quarantines with sanitized error, not a fabricated game',async()=>{
 const calls=[];const w=createCaptureWorker({query:async(s,a)=>{calls.push([s,a]);if(s.includes('configuration'))return {rows:[{value:{enabled:true,rulesHash:C.RULES_HASH}}]};if(s.includes('claim'))return {rows:[{capture_id:'b'.repeat(64),lease_token:'2'}]};if(s.includes('project'))return {rows:[{value:{source:null,rulesHash:C.RULES_HASH}}]};return {rows:[{value:'quarantined'}]};}},{workerId:'test'});
 assert.equal((await w.tick()).quarantined,1);assert.equal(calls.at(-1)[1][3],'CAPTURE_SOURCE_MISSING');assert.ok(calls.every(([s])=>!s.includes('ops.outbox')));
});
test('unexpected driver messages are never retained as error text',()=>{assert.equal(safeCode({message:'password=foo SELECT secret FROM auth'}),'CAPTURE_SOURCE_INVALID');assert.equal(transient({code:'08006'}),true);});
test('bounded worker arguments and reconcile cursors',async()=>{assert.throws(()=>createCaptureWorker({},{}));assert.throws(()=>createCaptureWorker({query(){}},{workerId:'bad id'}));const w=createCaptureWorker({query(){}},{workerId:'ok'});await assert.rejects(w.reconcile({limit:null}));await assert.rejects(w.reconcile({kind:'all'}));});
