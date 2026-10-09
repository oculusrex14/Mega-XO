#!/usr/bin/env node
'use strict';

/*
 * P24 evidence-only CLI.
 * --templates <sha> prints UNKNOWN-baseline and NULL-threshold policy drafts.
 * --review <sha> reads ONLY local .artifacts/p24-review.json and the checked-out
 * owner ledger. Never accesses providers, any URL, environment secrets or
 * mutable deploy configurations; it does not write files or apply scaling.
 */
const fs=require('node:fs');
const path=require('node:path');
const {SHA,baselineTemplate,exact}=require('./capacity-baseline');
const {template}=require('./scale-policy');
const {reviewScale}=require('./scaling-review');
function refuse(why){throw Error('P24_CLI_REFUSED:'+why);}
function safeLocal(root,relative,maxBytes){
 const parts=relative.split('/');
 if(parts.some(x=>!x||x==='.'||x==='..'))refuse('PATH');
 let at=root;
 for(let i=0;i<parts.length;i++){
  at=path.join(at,parts[i]);
  const st=fs.lstatSync(at);
  if(st.isSymbolicLink())refuse('SYMLINK');
  if(i<parts.length-1&&!st.isDirectory())refuse('NOT_DIRECTORY');
  if(i===parts.length-1&&(!st.isFile()||st.size>maxBytes))refuse('UNSAFE_FILE');
 }
 return JSON.parse(fs.readFileSync(at,'utf8'));
}
function runCli(argv,inputs={}){
 if(!Array.isArray(argv)||argv.length!==2 ||
    !['--templates','--review'].includes(argv[0])||
    !SHA.test(argv[1]))refuse('REQUIRES_MODE_AND_EXACT_SHA');
 const [mode,sourceSha]=argv;
 if(mode==='--templates')return Object.freeze({
  format:'mega-v5-p24-input-templates/v1',
  capacityBaseline:baselineTemplate(sourceSha),
  scalePolicy:template(sourceSha),
  note:'UNKNOWN_VALUES_ARE_NOT_ZERO_AND_NOT_CAPACITY',
  productionMutationAuthorized:false,g24Accepted:false,
 });
 const root=inputs.root===undefined?process.cwd():inputs.root;
 if(typeof root!=='string'||root.length===0)refuse('ROOT');
 const read=inputs.read||safeLocal;
 const packet=read(root,'.artifacts/p24-review.json',262144);
 exact(packet,['format','nowUtc','baseline','policy','intervals'],'REVIEW_INPUT');
 if(packet.format!=='mega-v5-p24-review-input/v1')refuse('REVIEW_INPUT_FORMAT');
 const ledger=read(root,'docs/v5/progress.json',262144);
 const report=reviewScale({
  ledger,sourceSha,nowUtc:packet.nowUtc,baseline:packet.baseline,
  policy:packet.policy,intervals:packet.intervals,
 });
 if(report.productionMutationAuthorized!==false||report.g24Accepted!==false)
  refuse('PRODUCTION_AUTHORIZATION_MUST_STAY_FALSE');
 return report;
}
if(require.main===module){
 try{process.stdout.write(JSON.stringify(runCli(process.argv.slice(2)),null,2)+'\n');}
 catch(error){process.stderr.write(error.message+'\n');process.exitCode=2;}
}
module.exports={runCli,safeLocal};
