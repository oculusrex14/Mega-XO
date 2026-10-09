#!/usr/bin/env node
'use strict';

// P17-02 immutable artifact *reference* validation only. An uploaded JSON
// claiming a digest/CI run is not the actual image/CI result. No publish,
// deployment, remote registry call, provider credentials or ready signal.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {parseVersion}=require('./release-compatibility.js');
const FORMAT='mega-v5-artifact-references/v1';
const SHA40=/^[a-f0-9]{40}$/;
const DIGEST=/^ghcr\.io\/oculusrex14\/[a-z0-9][a-z0-9._-]*@sha256:[a-f0-9]{64}$/;
const CI_NAMES=[
  'Mega XO validation','V5 PostgreSQL integration','V5 release engineering'
];
function assert(ok,message){if(!ok)throw new Error('V5_ARTIFACT_REFUSED: '+message);}
function shape(value,names,label) {
  assert(value && typeof value==='object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\0')===[...names].sort().join('\0'),
    label+' has missing or unapproved fields');
}
function scanSecrets(value,depth=0) {
  assert(depth<=8,'artifact descriptor nested too deeply');
  if(!value || typeof value!=='object')return;
  for(const [key,data] of Object.entries(value)) {
    assert(!/(?:secret|password|privatekey|credential|cookie|receipt|bearer|accesstoken|refreshtoken)/i.test(key),
      'private credential field is prohibited');
    scanSecrets(data,depth+1);
  }
}
function verifyComponent(name,component,sourceSha) {
  shape(component,['image','sourceSha','platforms'],name);
  assert(component.sourceSha===sourceSha,name+' built from another commit');
  assert(typeof component.image==='string' && DIGEST.test(component.image),name+' must use immutable GHCR digest');
  assert(Array.isArray(component.platforms) && component.platforms.length===2 &&
    [...component.platforms].sort().join(',')==='linux/amd64,linux/arm64',
    name+' must include tested AMD64 and Oracle ARM64 images');
}
function verifyRefs(record,expectedSha) {
  scanSecrets(record);
  shape(record,['format','sourceSha','version','api','core','worker','ciEvidence'], 'artifact references');
  assert(record.format===FORMAT,'format not recognized');
  assert(SHA40.test(expectedSha) && record.sourceSha===expectedSha,'exact reviewed SHA mismatch');
  parseVersion(record.version);
  shape(record.api,['deploymentId','sourceSha','buildEnvironment','domainsAssigned'], 'Vercel API');
  assert(record.api.sourceSha===record.sourceSha,'API source differs');
  assert(typeof record.api.deploymentId==='string' &&
    /^dpl_[a-zA-Z0-9]{12,}$/.test(record.api.deploymentId),'real Vercel deployment ID required');
  assert(record.api.buildEnvironment==='production' && record.api.domainsAssigned===false,
    'must stage a production-configured API build without switching domains');
  verifyComponent('Core',record.core,record.sourceSha);
  verifyComponent('worker',record.worker,record.sourceSha);
  assert(record.core.image!==record.worker.image,'worker/Core images must be independent');
  assert(Array.isArray(record.ciEvidence) && record.ciEvidence.length===CI_NAMES.length,'three independent test runs required');
  const names=new Set();
  for(const entry of record.ciEvidence) {
    shape(entry,['workflow','runId','sourceSha'],'CI evidence reference');
    assert(CI_NAMES.includes(entry.workflow) && !names.has(entry.workflow),'missing/duplicate required CI name');
    assert(Number.isSafeInteger(entry.runId) && entry.runId>0,'CI run ID invalid');
    assert(!record.ciEvidence.some(other => other!==entry && other.runId===entry.runId),
      'CI run IDs must be independent');
    assert(entry.sourceSha===record.sourceSha,'CI result belongs to another SHA');
    names.add(entry.workflow);
  }
  assert(names.size===CI_NAMES.length,'not all required tests referenced');
  const canonical={
    format:record.format,sourceSha:record.sourceSha,version:record.version,
    api:record.api,core:record.core,worker:record.worker,
    ciEvidence:[...record.ciEvidence].sort((a,b)=>a.workflow.localeCompare(b.workflow))
  };
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return {
    format:'mega-v5-artifact-reference-review/v1',
    sourceSha:record.sourceSha,
    fingerprint,
    hasImmutableReferenceStructure:true,
    registryAndCIVerifiedOnline:false,
    authorizesDeployment:false,
    requirements:[
      'verify exact GitHub run conclusions against GitHub, not uploaded JSON',
      'verify GHCR private pull and multi-arch manifests by digest',
      'verify production Vercel deployment identity and configuration',
      'verify P16/P17 staging, protected environment and compatibility gate'
    ]
  };
}
function run(args,root=process.cwd()){
  assert(args.length===4 && args[0]==='--file' && args[2]==='--source-sha',
    'usage: --file .artifacts/name.json --source-sha COMMIT');
  const rel=args[1],sha=args[3];
  assert(/^\.artifacts\/[a-z0-9][a-z0-9._-]*\.json$/.test(rel),'file must be a scoped artifact');
  const location=path.join(root,rel);
  const stat=fs.lstatSync(location);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size<=131072,'invalid artifact descriptor file');
  return verifyRefs(JSON.parse(fs.readFileSync(location,'utf8')),sha);
}
if(require.main===module){
  try{process.stdout.write(JSON.stringify(run(process.argv.slice(2)),null,2)+'\n');}
  catch(e){process.stderr.write(e.message+'\n');process.exitCode=2;}
}
module.exports={FORMAT,CI_NAMES,verifyRefs,run};
