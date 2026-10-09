#!/usr/bin/env node
'use strict';

/**
 * P18-01 read-only public staging liveness probe.
 *
 * Network is OFF by default. --probe + --authorize-public-head deliberately
 * issues ONE HEAD /livez to an exact allowlisted Vercel staging .vercel.app
 * hostname in an operator-supplied sanitized topology manifest. No cookies,
 * authorization tokens, request bodies, redirects, provider callbacks,
 * production hosts or internal Core/worker addresses are ever used.
 *
 * A 200 HEAD proves an HTTPS endpoint responded, not correctness, G17, G18,
 * PostgreSQL authority, revision integrity or deployability.
 */
const https=require('node:https');
const {readScoped,validate}=require('./staging-topology.js');

function refuse(why){throw new Error('P18_PUBLIC_HEAD_REFUSED: '+why);}
function endpoint(topology,root,sourceSha) {
  validate(topology,root);
  if(typeof sourceSha!=='string'||!/^[a-f0-9]{40}$/.test(sourceSha) ||
     sourceSha!==topology.sourceSha)refuse('exact checked-out commit required');
  const origin=new URL(topology.vercel.origin);
  const host=origin.hostname.toLowerCase();
  if(origin.protocol!=='https:'||origin.port||
     host==='vercel.app'||!host.endsWith('.vercel.app') ||
     !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app$/.test(host)) {
    refuse('only fully scoped HTTPS Vercel staging deployment hostname is allowed');
  }
  // URL path is constant, NEVER read from untrusted manifest or shell input.
  const path='/livez';
  const target=new URL(path,origin);
  if(target.host!==origin.host || target.protocol!=='https:') {
    refuse('host or scheme changed');
  }
  return target;
}

function headPublicLivez(target){
  return new Promise((resolve,reject)=>{
    const req=https.request(target,{
      method:'HEAD',
      timeout:5000,
      headers:{'User-Agent':'MegaXO-P18-Readonly-Probe/1','Accept':'application/json'},
      rejectUnauthorized:true
    },res=>{
      res.resume();
      res.on('end',()=>resolve({statusCode:res.statusCode,redirectLocation:res.headers.location||null}));
      res.on('error',reject);
    });
    req.on('timeout',()=>req.destroy(new Error('read-only staging HEAD deadline')));
    req.on('error',reject);
    req.end();
  });
}

function plan(topology,root,sha){
  const target=endpoint(topology,root,sha);
  return {
    format:'mega-v5-p18-public-head-plan/v1',
    sourceSha:sha,
    targetOrigin:target.origin,
    request:'HEAD /livez',
    method:'HEAD',
    state:'NOT_EXECUTED',
    providerIdentityVerified:false,
    crossServiceReadinessVerified:false,
    authorizesDeployment:false,
    g18Accepted:false,
    neverProbe:['production domains','account/session GET routes',
      'Core/worker private management surfaces','provider callbacks']
  };
}

async function probe(topology,root,sha,transport=headPublicLivez){
  const proposed=plan(topology,root,sha);
  const target=endpoint(topology,root,sha);
  const response=await transport(target);
  if(!response||!Number.isSafeInteger(response.statusCode) ||
     response.redirectLocation!==null && response.redirectLocation!==undefined){
    refuse('HEAD had invalid result or attempted a redirect');
  }
  if(response.statusCode!==200 && response.statusCode!==204) {
    refuse('staging /livez not healthy via strictly read-only HEAD');
  }
  return {
    format:'mega-v5-p18-public-head-observation/v1',
    sourceSha:sha,
    targetOrigin:proposed.targetOrigin,
    path:'/livez',
    method:'HEAD',
    httpStatus:response.statusCode,
    state:'PUBLIC_STAGING_LIVENESS_ONLY',
    realEndpointResponded:true,
    externallyAuthenticatedDeploymentIdentity:false,
    schemaAndProviderIsolationVerified:false,
    serviceRevisionVerified:false,
    coreAndWorkerReadinessVerified:false,
    crossServiceReadinessVerified:false,
    authorizesDeployment:false,
    g18Accepted:false
  };
}

async function run(args,root=process.cwd()) {
  const mode=args[0];
  if(!['--plan','--probe'].includes(mode)||args[1]!=='--file'||
     args[3]!=='--sha'||typeof args[2]!=='string'||typeof args[4]!=='string') {
    refuse('usage: --plan|--probe --file .artifacts/topology.json --sha COMMIT [--authorize-public-head]');
  }
  if(mode==='--plan' && args.length!==5 ||
     mode==='--probe' && (args.length!==6||args[5]!=='--authorize-public-head')){
    refuse('live HEAD requires separate explicit --authorize-public-head flag');
  }
  const topology=readScoped(root,args[2]);
  return mode==='--plan'?plan(topology,root,args[4]):
    probe(topology,root,args[4]);
}
if(require.main===module){
  run(process.argv.slice(2)).then(report=>{
    process.stdout.write(JSON.stringify(report,null,2)+'\n');
  },error=>{process.stderr.write(error.message+'\n');process.exitCode=2;});
}
module.exports={endpoint,headPublicLivez,plan,probe,run};
