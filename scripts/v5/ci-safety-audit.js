#!/usr/bin/env node
'use strict';
// P17 PR workflow security checks. Static inspection, not a replacement for
// protected environment reviewers or exact deployment authorization.
const fs=require('node:fs');
const path=require('node:path');
function reject(reason){ throw new Error('V5_CI_PERIMETER: '+reason); }
function audit(text) {
  if(typeof text!=='string' || !text.trim()) reject('workflow absent');
  if(!/^name: V5 release engineering\s*$/m.test(text)) reject('unexpected workflow identity');
  if(!/^on:\s*$/m.test(text) || !/^  push:\s*$/m.test(text) ||
     !/^  pull_request:\s*$/m.test(text) ||
     !/branches: \[V5-platform\]/.test(text)) reject('event scope changed');
  if(/^\s*(?:pull_request_target|workflow_run|repository_dispatch|workflow_dispatch):/m.test(text)) {
    reject('privileged or unreviewed event is not allowed');
  }
  if(!/^permissions:\s*\n  contents: read\s*$/m.test(text)) reject('read-only token policy removed');
  if(/^\s+[a-z_-]+:\s+write\s*$/m.test(text)) reject('writable GitHub permission');
  if(/\$\{\{\s*secrets\./i.test(text) ||
     /^\s*(?:VERCEL_TOKEN|GH_TOKEN|NEON_TOKEN|R2_SECRET|APPLE_SIGNING_KEY):/m.test(text)) {
    reject('production/store/provider secret included in PR workflow');
  }
  if(!/persist-credentials: false/.test(text) || !/fetch-depth: 0/.test(text)) {
    reject('checkout must disable token persistence and fetch reviewed history');
  }
  if(/^\s*environment:\s*(?:production|staging)\s*$/m.test(text)) reject('untrusted PR cannot claim a release environment');
  const actions=[...text.matchAll(/^\s*-\s*uses:\s*([^\s#]+)/gm)].map(m=>m[1]);
  if(actions.length<3) reject('expected checkout, node and evidence upload actions');
  for(const use of actions) {
    if(!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+@[0-9a-f]{40}$/.test(use)) reject('unpinned CI action');
  }
  if(/^\s*(?:vercel\s+(?:deploy|promote|rollback)|docker\s+push|gh\s+release\s+create|npm\s+publish|git\s+push)\b/m.test(text) ||
     /scripts\/v5\/migrate\.js\s+--execute/.test(text)) {
    reject('a publish/migration command appeared in source-only CI');
  }
  const artifactPaths=[...text.matchAll(/^\s+\.artifacts\/([a-z0-9._-]+)\s*$/gm)].map(m=>m[1]);
  if(artifactPaths.length!==2 || !artifactPaths.includes('v5-ci-impact.json') ||
      !artifactPaths.includes('v5-source-candidate.json')) reject('sanitized artifact allowlist drift');
  if(/^\s+(?:path|include-hidden-files):\s+(?:\*|true|\.)\s*$/m.test(text)) reject('unsafe artifact glob');
  return {readOnly:true,actionCount:actions.length,artifacts:artifactPaths.sort()};
}
function run(root=process.cwd()){
  return audit(fs.readFileSync(path.join(root,'.github/workflows/v5-release-engineering.yml'),'utf8'));
}
if(require.main===module){
  try{const result=run();process.stdout.write('V5_CI_PERIMETER_OK read-only pinned-actions='+result.actionCount+'\n');}
  catch(e){process.stderr.write(e.message+'\n');process.exitCode=2;}
}
module.exports={audit,run};
