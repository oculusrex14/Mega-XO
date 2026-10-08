#!/usr/bin/env node
'use strict';

/**
 * P18-01 proposed INTEGRATED staging topology safety contract. It consumes
 * only an operator-supplied restricted, nonsecret manifest. No credentials,
 * provider calls or writes. The declared topology is NOT external proof.
 */
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const { inspect,load }=require('./staging-isolation.js');
const FORMAT='mega-v5-p18-staging-topology/v1';
const ID=/^[a-zA-Z][a-zA-Z0-9._-]{7,100}$/;
function deny(why){throw new Error('P18_TOPOLOGY_REFUSED: '+why);}
function exact(value,fields,label){
 if(!value||typeof value!=='object'||Array.isArray(value)||
   Object.keys(value).sort().join('\0')!==[...fields].sort().join('\0')) deny('unexpected '+label+' fields');
}
function noSecrets(value,level=0){
 if(level>12)deny('manifest nested too deeply');
 if(value&&typeof value==='object'){
  for(const [name,v] of Object.entries(value)){
   if(/(?:password|secret|token|apiKey|cookie|receipt|privateKey|connectionString|credential)/i.test(name)) {
     deny('sensitive field included in topology');
   }
   noSecrets(v,level+1);
  }
 }
}
function safeId(s,label){if(typeof s!=='string'||!ID.test(s))deny('missing or invalid '+label);}
function parseOrigin(text,label,{allowInternal=false}={}){
 let url;
 try{url=new URL(text);}catch{deny('invalid '+label+' URL');}
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||
   !(url.protocol==='https:' || (allowInternal && url.protocol==='wss:'))) {
   deny('unexpected credentials/path/scheme in '+label);
 }
 const host=url.hostname.toLowerCase();
 if(net.isIP(host)) deny('public IP-based stage origin must be explicitly reviewed');
 if(host==='megaxo.online'||host==='api.megaxo.online'||
   host==='play.antimatterinnovations.com'||host.endsWith('.antimatterinnovations.com')||
   host.endsWith('.neon.tech')||!(/staging|stage|stg|\.vercel\.app$/.test(host))) {
   deny('non-staging or authority host in '+label);
 }
 return url.origin;
}
function validate(topology,root) {
 noSecrets(topology);
 exact(topology,['format','sourceSha','environment','neon','vercel','redis','core','worker',
   'callbacks','clients','safety'],'topology');
 if(topology.format!==FORMAT||!(/^[a-f0-9]{40}$/.test(topology.sourceSha))||
   topology.environment!=='staging')deny('only SHA-pinned staging topology');
 const inventory=load(root),prepared=inspect(inventory);
 if(prepared.g18Accepted!==false)deny('static inventory cannot certify G18');
 const stage=inventory.staging,prod=inventory.production;
 exact(topology.neon,['projectId','branchId','endpointId','host','database'],'Neon');
 for(const [key,actual] of Object.entries(topology.neon)){
   if(actual!==stage[key]||actual===prod[key])deny('Neon does not match the isolated staging inventory');
 }
 exact(topology.vercel,['teamId','projectId','deploymentId','origin','domainsAssigned'],'Vercel');
 for(const id of ['teamId','projectId'])safeId(topology.vercel[id],'Vercel identity');
 if(!/^dpl_[a-zA-Z0-9]{12,}$/.test(topology.vercel.deploymentId))deny('staged Vercel deployment identity missing');
 if(topology.vercel.domainsAssigned!==false)deny('unapproved domain assignment cannot be part of staging');
 parseOrigin(topology.vercel.origin,'Vercel');
 exact(topology.redis,['resourceId','namespace','host'],'Redis');
 safeId(topology.redis.resourceId,'Redis resource');
 if(typeof topology.redis.namespace!=='string' ||
   !/^mega:v5:stg:[a-z0-9_-]{4,40}:$/.test(topology.redis.namespace)) {
   deny('staging Redis namespace missing');
 }
 parseOrigin(topology.redis.host,'Redis',{allowInternal:true});
 for(const service of ['core','worker']){
   exact(topology[service],['serviceId','origin','sourceSha'],'service');
   safeId(topology[service].serviceId,service);
   if(topology[service].sourceSha!==topology.sourceSha)deny('split service source revisions');
   parseOrigin(topology[service].origin,service,{allowInternal:true});
 }
 if(topology.core.serviceId===topology.worker.serviceId ||
   topology.core.origin===topology.worker.origin)deny('Core and worker are not independent');
 exact(topology.callbacks,['email','store','ads','callbackOrigin'],'callback effects');
 if(topology.callbacks.email!=='sink'||topology.callbacks.store!=='fixture'||
   topology.callbacks.ads!=='fixture')deny('real outbound effects forbidden during acceptance');
 parseOrigin(topology.callbacks.callbackOrigin,'sandbox callbacks');
 exact(topology.clients,['retainedBrowserOrigin','androidAudience','iosAudience'],'clients');
 parseOrigin(topology.clients.retainedBrowserOrigin,'retained browser staging facade');
 if(topology.clients.androidAudience!=='mega-android'||
    topology.clients.iosAudience!=='mega-ios')deny('cross-client identity audiences differ');
 exact(topology.safety,['syntheticActorsOnly','productionWritersUntouched',
   'productionSecretsAbsent','providerDeliverySandboxed'],'isolation declarations');
 if(Object.values(topology.safety).some(value=>value!==true))deny('unsafe staging intent');
 return {
   format:'mega-v5-p18-topology-review/v1',
   sourceSha:topology.sourceSha,
   structuralIsolationDeclared:true,
   observedExternalProviders:false,
   outboundActuallyProbed:false,
   g18Accepted:false,
   stageExecutionAuthorized:false,
   requires:['provider-side identities/permissions observed','real isolated callback negative probes',
     'P17 acceptance and private environment owner review','end-to-end staged service routing proof']
 };
}
function readScoped(root,relative){
 if(typeof relative!=='string'||!/^\.artifacts\/[a-z0-9][a-z0-9._-]{0,100}\.json$/.test(relative)) {
   deny('topology must be a scoped nonsecret JSON artifact');
 }
 const file=path.join(root,relative),stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>131072)deny('unbounded or untrusted topology file');
 return JSON.parse(fs.readFileSync(file,'utf8'));
}
function run(args,root=process.cwd()){
 if(args.length!==2||args[0]!=='--file')deny('usage: staging-topology.js --file .artifacts/topology.json');
 return validate(readScoped(root,args[1]),root);
}
if(require.main===module){
 try{process.stdout.write(JSON.stringify(run(process.argv.slice(2)),null,2)+'\n');}
 catch(e){process.stderr.write(e.message+'\n');process.exitCode=2;}
}
module.exports={FORMAT,validate,parseOrigin,readScoped,run};
