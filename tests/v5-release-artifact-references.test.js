'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {verifyRefs,FORMAT,CI_NAMES}=require('../scripts/v5/release-artifact-references.js');
const sha='c'.repeat(40);
function fixture(){
 return {
   format:FORMAT,sourceSha:sha,version:'5.5.0-rc.1',
   api:{deploymentId:'dpl_1234567890abcdef1234',sourceSha:sha,
     buildEnvironment:'production',domainsAssigned:false},
   core:{image:'ghcr.io/oculusrex14/mega-xo-core@sha256:'+'a'.repeat(64),
     sourceSha:sha,platforms:['linux/amd64','linux/arm64']},
   worker:{image:'ghcr.io/oculusrex14/mega-xo-worker@sha256:'+'b'.repeat(64),
     sourceSha:sha,platforms:['linux/amd64','linux/arm64']},
   ciEvidence:CI_NAMES.map((workflow,n)=>({workflow,runId:1000+n,sourceSha:sha}))
 };
}
function denied(change){
 const input=change(fixture());
 assert.throws(()=>verifyRefs(input,sha),/V5_ARTIFACT_REFUSED|V5_COMPATIBILITY_REFUSED/);
}

test('full immutable Vercel/Core/worker and CI references remain unverified until provider checks',()=>{
 const result=verifyRefs(fixture(),sha);
 assert.equal(result.hasImmutableReferenceStructure,true);
 assert.equal(result.registryAndCIVerifiedOnline,false);
 assert.equal(result.authorizesDeployment,false);
 assert.match(result.fingerprint,/^[a-f0-9]{64}$/);
 assert.ok(result.requirements.length>=4);
});

test('mutable tags, wrong registry and lacking Oracle ARM64 image are all rejected',()=>{
 denied(x=>{x.core.image='ghcr.io/oculusrex14/mega-xo-core:v5';return x;});
 denied(x=>{x.core.image='docker.io/oculusrex14/core@sha256:'+'a'.repeat(64);return x;});
 denied(x=>{x.core.platforms=['linux/amd64'];return x;});
 denied(x=>{x.worker.image=x.core.image;return x;});
 denied(x=>{x.worker.sourceSha='b'.repeat(40);return x;});
});

test('preview Vercel build cannot be promoted as an already-tested production deployment',()=>{
 denied(x=>{x.api.buildEnvironment='preview';return x;});
 denied(x=>{x.api.domainsAssigned=true;return x;});
 denied(x=>{x.api.deploymentId='preview-url';return x;});
 denied(x=>{x.api.sourceSha='b'.repeat(40);return x;});
});

test('missing, duplicated and other-commit CI runs refuse release references',()=>{
 denied(x=>{x.ciEvidence.pop();return x;});
 denied(x=>{x.ciEvidence[1]={...x.ciEvidence[0]};return x;});
 denied(x=>{x.ciEvidence[2].runId=0;return x;});
 denied(x=>{x.ciEvidence[1].sourceSha='b'.repeat(40);return x;});
});

test('source candidate, secret fields and fake online readiness never become a release',()=>{
 denied(x=>{x.format='mega-v5-source-candidate/v1';return x;});
 denied(x=>{x.accessToken='SECRET';return x;});
 denied(x=>{x.ciEvidence[0].passed=true;return x;});
 denied(x=>{x.ready=true;return x;});
 denied(x=>{x.api.secretKey='redact';return x;});
 assert.throws(()=>verifyRefs(fixture(),'d'.repeat(40)),/V5_ARTIFACT_REFUSED/);
});

test('fingerprint is independent of CI entry order but identifies artifact differences',()=>{
 const a=fixture(),b=fixture();
 b.ciEvidence.reverse();
 assert.equal(verifyRefs(a,sha).fingerprint,verifyRefs(b,sha).fingerprint);
 b.worker.image='ghcr.io/oculusrex14/mega-xo-worker@sha256:'+'d'.repeat(64);
 assert.notEqual(verifyRefs(a,sha).fingerprint,verifyRefs(b,sha).fingerprint);
});

test('CI evidence cannot reuse a run ID across independently required workflows',()=>{
 denied(x=>{x.ciEvidence[1].runId=x.ciEvidence[0].runId;return x;});
});

test('GHCR image reference cannot include nested repository paths',()=>{
 denied(x=>{x.core.image='ghcr.io/oculusrex14/other/core@sha256:'+'a'.repeat(64);return x;});
});
