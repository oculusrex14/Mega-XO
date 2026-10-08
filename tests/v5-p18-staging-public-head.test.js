'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {endpoint,plan,probe,run}=require('../scripts/v5/p18/staging-public-head.js');
const stage=require('../docs/v5/environments/staging.json');
const root=path.resolve(__dirname,'..'),sha='b'.repeat(40);
function topology(){
  return {
    format:'mega-v5-p18-staging-topology/v1',sourceSha:sha,environment:'staging',
    neon:{projectId:stage.projectId,branchId:stage.branchId,
      endpointId:stage.endpointId,host:stage.host,database:stage.database},
    vercel:{teamId:'team_stage_e2e99',projectId:'prj_stage_e2e999',
      deploymentId:'dpl_1234567890abcdef',origin:'https://mega-xo-stage.vercel.app/',
      domainsAssigned:false},
    redis:{resourceId:'redis_stg_megaxo42',namespace:'mega:v5:stg:acceptance:',
      host:'wss://redis-stg.internal/'},
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
test('default operator plan executes no network call and never claims G18',()=>{
 const p=plan(topology(),root,sha);
 assert.equal(p.state,'NOT_EXECUTED');
 assert.equal(p.method,'HEAD');
 assert.equal(p.request,'HEAD /livez');
 assert.equal(p.g18Accepted,false);
 assert.equal(p.crossServiceReadinessVerified,false);
 assert.equal(p.targetOrigin,'https://mega-xo-stage.vercel.app');
 assert.equal(endpoint(topology(),root,sha).pathname,'/livez');
});
test('injected transport proves only the single public HEAD, not deployment or services',async()=>{
 let calls=0;
 const p=await probe(topology(),root,sha,async url=>{
   calls++;
   assert.equal(url.href,'https://mega-xo-stage.vercel.app/livez');
   return {statusCode:204};
 });
 assert.equal(calls,1);
 assert.equal(p.httpStatus,204);
 assert.equal(p.state,'PUBLIC_STAGING_LIVENESS_ONLY');
 assert.equal(p.externallyAuthenticatedDeploymentIdentity,false);
 assert.equal(p.schemaAndProviderIsolationVerified,false);
 assert.equal(p.coreAndWorkerReadinessVerified,false);
 assert.equal(p.g18Accepted,false);
});
test('a redirect, 401, 404, 500 or missing result never counts as a green HEAD',async()=>{
 for(const response of [
   {statusCode:301,redirectLocation:'https://prod.megaxo.online/'},
   {statusCode:200,redirectLocation:'https://evil.com/'},
   {statusCode:401},{statusCode:404},{statusCode:500},null
 ])await assert.rejects(()=>probe(topology(),root,sha,async()=>response),/P18_PUBLIC_HEAD_REFUSED/);
});
test('unknown source, production origin, non-Vercel host and URL trickery cannot be probed',()=>{
 assert.throws(()=>endpoint(topology(),root,'a'.repeat(40)),/P18_PUBLIC_HEAD_REFUSED/);
 const changes=[
   t=>{t.vercel.origin='https://api.megaxo.online/';},
   t=>{t.vercel.origin='https://mega-staging.invalid/';},
   t=>{t.vercel.origin='https://mega-xo-stage.vercel.app.evil.com/';},
   t=>{t.vercel.origin='https://user:pass@mega-xo-stage.vercel.app/';},
   t=>{t.vercel.origin='https://mega-xo-stage.vercel.app/unsafe';},
   t=>{t.vercel.domainsAssigned=true;}
 ];
 for(const change of changes){
   const t=topology();change(t);
   assert.throws(()=>endpoint(t,root,sha),/P18_PUBLIC_HEAD_REFUSED|P18_TOPOLOGY_REFUSED/);
 }
});
test('CLI defaults to plan and refuses accidental live network use',async()=>{
 await assert.rejects(()=>run(['--probe','--file','.artifacts/stage.json','--sha',sha],root),
  /P18_PUBLIC_HEAD_REFUSED/);
 await assert.rejects(()=>run(['--probe','--file','/tmp/private.json','--sha',sha,
  '--authorize-public-head'],root),/P18_TOPOLOGY_REFUSED/);
});
