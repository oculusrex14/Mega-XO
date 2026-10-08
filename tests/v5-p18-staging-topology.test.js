'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {FORMAT,validate,parseOrigin}=require('../scripts/v5/p18/staging-topology.js');
const root=path.resolve(__dirname,'..');
const stg=require('../docs/v5/environments/staging.json');
const sha='d'.repeat(40);
function sample(){
 return {
  format:FORMAT,sourceSha:sha,environment:'staging',
  neon:{projectId:stg.projectId,branchId:stg.branchId,endpointId:stg.endpointId,
    host:stg.host,database:stg.database},
  vercel:{teamId:'team_stage_e2e99',projectId:'prj_stage_e2e999',
    deploymentId:'dpl_1234567890abcdef',
    origin:'https://mega-xo-stage.vercel.app/',domainsAssigned:false},
  redis:{resourceId:'redis_stg_megaxo42',
    namespace:'mega:v5:stg:acceptance:',host:'wss://redis-stg.internal/'},
  core:{serviceId:'core_stage_service01',origin:'wss://core-stg.internal/',sourceSha:sha},
  worker:{serviceId:'worker_stage_service01',origin:'https://worker-stg.internal/',sourceSha:sha},
  callbacks:{email:'sink',store:'fixture',ads:'fixture',
    callbackOrigin:'https://callbacks-stage.megaxo.online/'},
  clients:{retainedBrowserOrigin:'https://legacy-staging.megaxo.online/',
    androidAudience:'mega-android',iosAudience:'mega-ios'},
  safety:{syntheticActorsOnly:true,productionWritersUntouched:true,
    productionSecretsAbsent:true,providerDeliverySandboxed:true}
 };
}
function fail(change){
 const s=sample();change(s);
 assert.throws(()=>validate(s,root),/P18_TOPOLOGY_REFUSED/);
}
test('integrated topology must be externally proven even when structurally safe',()=>{
 const out=validate(sample(),root);
 assert.equal(out.structuralIsolationDeclared,true);
 assert.equal(out.observedExternalProviders,false);
 assert.equal(out.stageExecutionAuthorized,false);
 assert.equal(out.g18Accepted,false);
});
test('production URLs, real delivery, assigned public domains and shared durable targets are refused',()=>{
 fail(o=>{o.neon.projectId='blue-sun-85454968';});
 fail(o=>{o.vercel.origin='https://api.megaxo.online/';});
 fail(o=>{o.vercel.domainsAssigned=true;});
 fail(o=>{o.callbacks.email='live';});
 fail(o=>{o.callbacks.store='production';});
 fail(o=>{o.callbacks.ads='live';});
 fail(o=>{o.clients.retainedBrowserOrigin='https://play.antimatterinnovations.com/';});
 fail(o=>{o.redis.namespace='mega:v5:production:';});
 fail(o=>{o.safety.syntheticActorsOnly=false;});
});
test('independent Core/worker and actor audience must agree on exact source SHA',()=>{
 fail(o=>{o.worker.sourceSha='a'.repeat(40);});
 fail(o=>{o.worker.origin=o.core.origin;});
 fail(o=>{o.worker.serviceId=o.core.serviceId;});
 fail(o=>{o.clients.androidAudience='mega-browser';});
 fail(o=>{o.clients.iosAudience='mega-android';});
});
test('credentials embedded anywhere in topology are rejected',()=>{
 fail(o=>{o.vercel.apiKey='sensitive';});
 fail(o=>{o.callbacks.storeReceipt='sensitive';});
 fail(o=>{o.redis.connectionString='redis://password@host';});
});
test('staging topology validator allows no URLs with credentials, paths or query strings',()=>{
 assert.throws(()=>parseOrigin('https://user:pass@core-stg.internal/','Core'),/P18_TOPOLOGY_REFUSED/);
 assert.throws(()=>parseOrigin('https://core-stg.internal/private','Core'),/P18_TOPOLOGY_REFUSED/);
 assert.throws(()=>parseOrigin('https://core-stg.internal/?x=1','Core'),/P18_TOPOLOGY_REFUSED/);
 assert.throws(()=>parseOrigin('https://prod.antimatterinnovations.com/','Core'),/P18_TOPOLOGY_REFUSED/);
});
