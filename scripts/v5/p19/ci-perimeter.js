'use strict';

/* P19 CI must never load-test public hosts or mislabel GitHub PR merge SHA
 * as the candidate source commit. This is structural defense-in-depth,
 * separate from actual GitHub branch protection and provider/IAM policy.
 */
const fs=require('node:fs');
const path=require('node:path');
function deny(why){throw Error('P19_CI_PERIMETER_REFUSED: '+why);}
function inspect(text){
 if(typeof text!=='string'||text.length<200||
   !/^name: V5 P19 disposable load and chaos foundations$/m.test(text)||
   !/^on:\s*$/m.test(text)||!/^  push:\s*$/m.test(text)||
   !/^  pull_request:\s*$/m.test(text))deny('only V5 PR and push triggers are permitted');
 if(/^\s*(?:pull_request_target|workflow_dispatch|workflow_run|repository_dispatch):/m.test(text)) {
  deny('privileged event trigger');
 }
 if((text.match(/branches: \[V5-platform\]/g)||[]).length!==2)deny('wrong base/push branch');
 if(!/^permissions:\n  contents: read$/m.test(text)||
   /^\s+[a-z_-]+: write\s*$/m.test(text))deny('non-read-only workflow permission');
 const secretExpression='$'+'{{ secrets.';
 if(text.includes(secretExpression)||
    /\b(?:VERCEL_TOKEN|NEON_DATABASE_URL|REDIS_PRODUCTION_URL):/.test(text)){
   deny('a provider/production secret must not enter an untrusted PR build');
 }
 const actions=[...text.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)].map(x=>x[1]);
 if(actions.length<6||actions.some(x=>!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+@[a-f0-9]{40}$/.test(x))) {
  deny('an unpinned GitHub Action was introduced');
 }
 const expectedRef='$'+'{{ github.event.pull_request.head.sha || github.sha }}';
 if(text.split('ref: '+expectedRef).length-1!==2 ||
    text.split('persist-credentials: false').length-1!==2||
    !text.includes('P19_SOURCE_SHA: '+expectedRef)||
    !text.includes('test "$(git rev-parse HEAD)" = "$P19_SOURCE_SHA"')||
    !text.includes('--sha "$P19_SOURCE_SHA"')) {
   deny('measurement checkout/evidence must match exact PR source head');
 }
 for(const required of ["V5_P19_DISPOSABLE: '1'","V5_PG_DISPOSABLE: '1'",
   "V5_REDIS_DISPOSABLE: '1'",'127.0.0.1:5432:5432','127.0.0.1:6379:6379']) {
   if(!text.includes(required))deny('unowned, public or remote test service');
 }
 if(!/image: postgres:16@sha256:[a-f0-9]{64}/.test(text)||
    !/image: redis:7\.4@sha256:[a-f0-9]{64}/.test(text))deny('mutable disposable database image');
 if(/^\s*(?:-\s*)?(?:run:\s*)?(?:vercel deploy|vercel promote|docker push|git push|curl https:\/\/|wget https:\/\/)/m.test(text)) {
  deny('network release or public probe forbidden in PR load job');
 }
 const lines=text.split('\n'),captures=[];
 for(let i=0;i<lines.length;i++){
  if(lines[i].trim()==='path: |'){
   const files=[];
   for(let j=i+1;j<lines.length&&/^ {12}\S/.test(lines[j]);j++)files.push(lines[j].trim());
   captures.push(files);
  }
 }
 const expected=['.artifacts/p19-real-disposable.json','.artifacts/p19-chaos-disposable.json',
   '.artifacts/p19-capacity-local-only.json'];
 if(captures.length!==1||captures[0].length!==expected.length||
    captures[0].sort().join('\0')!==expected.sort().join('\0')||
    !/path: \.artifacts\/p19-unexecuted-workload\.json\s*$/m.test(text)) {
   deny('unexpected CI artifact, secret path or broad glob');
 }
 return {exactPrHeadCheckouts:2,sourceArtifactChecks:true,pinnedActionCount:actions.length,
  allowedEvidenceFiles:4,productionCredentialInputs:false};
}
function run(root=process.cwd()){
 return inspect(fs.readFileSync(path.join(root,'.github/workflows/v5-p19-load-chaos.yml'),'utf8'));
}
if(require.main===module){
 try{const x=run();process.stdout.write('P19_CI_PERIMETER_OK '+x.pinnedActionCount+' pinned actions\n');}
 catch(e){process.stderr.write(e.message+'\n');process.exitCode=2;}
}
module.exports={inspect,run};
