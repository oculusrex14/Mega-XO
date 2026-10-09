#!/usr/bin/env node
'use strict';

// P17 contract-only forward/rollback compatibility policy. This tool NEVER
// performs a deploy, migration, Vercel promote or PostgreSQL rollback. Its
// positive result is not a release authorization: live targets, CI conclusions,
// image digests, prior compatible builds and owner approval are separate gates.
const fs = require('node:fs');
const path = require('node:path');
const RELEASE_FORMAT='mega-v5-release-range/v1';
const RUNTIME_FORMAT='mega-v5-runtime-compat-snapshot/v1';
const SHA40=/^[0-9a-f]{40}$/;
const RX_VERSION=/^5\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(dev|beta|rc)\.([0-9a-z]+))?$/;

function refuse(why){throw new Error('V5_COMPATIBILITY_REFUSED: '+why);}
function plain(value,fields,name) {
  if (!value || typeof value!=='object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0')!==[...fields].sort().join('\0')) {
    refuse(name+' has unexpected or missing fields');
  }
}
function parseVersion(version){
  if(typeof version!=='string') refuse('missing semantic release version');
  const m=version.match(RX_VERSION);
  if(!m) refuse('unsupported V5 release SemVer');
  const variant=m[3]||'stable',order={dev:0,beta:1,rc:2,stable:3};
  const label=m[4]||'';
  if (label && /^\d+$/.test(label) && label.length>1 && label[0]==='0') refuse('leading-zero prerelease');
  return [5,Number(m[1]),Number(m[2]),order[variant],/^\d+$/.test(label)?Number(label):label];
}
function compareVersions(a,b) {
  const left=parseVersion(a),right=parseVersion(b);
  for(let i=0;i<4;i++){
    if(left[i]!==right[i]) return left[i]<right[i]?-1:1;
  }
  if (left[3]===3) return 0;
  // Numeric identifiers order numerically; nonnumeric identifiers sort
  // lexically, with numeric identifiers ordered before nonnumeric.
  const l=left[4],r=right[4];
  if(l===r)return 0;
  if(typeof l===typeof r)return l<r?-1:1;
  return typeof l==='number'?-1:1;
}
function releaseRange(value) {
  plain(value,['format','version','sourceSha','authority','schemaMin','schemaMax','realtimeProtocol'],'release range');
  if(value.format!==RELEASE_FORMAT || value.authority!=='postgresql') refuse('release must use V5 PostgreSQL');
  parseVersion(value.version);
  if(typeof value.sourceSha!=='string' || !SHA40.test(value.sourceSha)) refuse('invalid immutable commit ID');
  if(!Number.isSafeInteger(value.schemaMin) || !Number.isSafeInteger(value.schemaMax) ||
      value.schemaMin<1 || value.schemaMax<value.schemaMin || value.schemaMax>100000) {
    refuse('schema compatibility range invalid');
  }
  if(value.realtimeProtocol!=='realtime/v1') refuse('realtime wire contract unsupported');
  return value;
}
function runtimeSnapshot(value) {
  plain(value,['format','environment','store','schemaVersion','realtimeProtocol',
    'oldV4WriterFenced','firstPostImportApplicationWrite','authorityEpoch',
    'evidenceReference'],'runtime observation');
  if(value.format!==RUNTIME_FORMAT || !['staging','production'].includes(value.environment)) refuse('invalid environment');
  if(!['postgresql','sqlite-v4'].includes(value.store)) refuse('unknown source of authority');
  if(!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion<1 ||
      value.schemaVersion>100000) refuse('invalid deployed schema');
  if(value.realtimeProtocol!=='realtime/v1') refuse('unexpected deployed protocol');
  if(typeof value.oldV4WriterFenced!=='boolean' ||
    typeof value.firstPostImportApplicationWrite!=='boolean') refuse('missing authority observations');
  if(!Number.isSafeInteger(value.authorityEpoch) || value.authorityEpoch<0) refuse('invalid authority epoch');
  if(typeof value.evidenceReference!=='string' ||
     !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{7,150}$/.test(value.evidenceReference) ||
     value.evidenceReference.includes('..') || value.evidenceReference.includes('//')) {
    refuse('operator evidence reference missing/unsafe');
  }
  if(value.firstPostImportApplicationWrite && value.store!=='postgresql') {
    refuse('application writes after import forbid SQLite authority rollback');
  }
  return value;
}
function inRange(release,liveSchema) {
  return release.schemaMin<=liveSchema && liveSchema<=release.schemaMax;
}
function plan({current=null,target,runtime,mode}){
  const next=releaseRange(target),state=runtimeSnapshot(runtime);
  if(!['forward','rollback'].includes(mode)) refuse('direction must be explicit');
  if(state.store!=='postgresql') {
    refuse('P17 refuses pre-cutover SQLite promotion; use the separate P22 freeze/transfer protocol');
  }
  if(!state.oldV4WriterFenced || state.authorityEpoch<1) {
    refuse('sole PostgreSQL authority and V4 writer fence not proven');
  }
  if(!inRange(next,state.schemaVersion)) refuse('target cannot read/write actual PostgreSQL schema');
  if(next.realtimeProtocol!==state.realtimeProtocol) refuse('target realtime wire mismatch');
  if(current!==null){
    const prior=releaseRange(current);
    if(!inRange(prior,state.schemaVersion)) {
      refuse('current release cannot read the deployed schema; rollback floor unknown');
    }
    if(prior.realtimeProtocol!==state.realtimeProtocol) refuse('current wire mismatch');
    const diff=compareVersions(next.version,prior.version);
    if(!diff && next.sourceSha!==prior.sourceSha) {
      refuse('immutable release version reused with different source');
    }
    if(mode==='forward' && diff<=0) refuse('forward release must advance SemVer');
    if(mode==='rollback' && diff>=0) refuse('rollback must select an older compatible PostgreSQL release');
  }else {
    if(mode==='rollback') refuse('rollback requires the exact previous PostgreSQL release');
    if(state.environment==='production') refuse('initial production authority transfer belongs to P22, not P17');
  }
  return {
    format:'mega-v5-contract-compatibility-result/v1',
    result:'COMPATIBLE_CONTRACTS_ONLY',
    authorizesDeployment:false,
    stateEvidenceReference:state.evidenceReference,
    schemaVersion:state.schemaVersion,
    sourceSha:next.sourceSha,
    version:next.version,
    mode,
    mandatoryNextGates:[
      'exact-source immutable artifacts and CI conclusions',
      'approved staging run and P16/P17 acceptance',
      'owner-reviewed environment and signed credentials',
      'production writer fence and P22 authority rules when applicable'
    ]
  };
}
function localInput(root,p) {
  if(typeof p!=='string' || !/^\.artifacts\/[a-z0-9][a-z0-9._-]*\.json$/.test(p)) {
    refuse('input must be an explicitly named .artifacts JSON document');
  }
  const dest=path.join(root,p);
  const stat=fs.lstatSync(dest);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size>131072) refuse('input not a bounded regular JSON file');
  return JSON.parse(fs.readFileSync(dest,'utf8'));
}
function cli(args,root=process.cwd()){
  // An explicit no-write dry-run. No HTTP, secrets, environments or migration.
  const flags={};
  for(let i=0;i<args.length;i+=2) {
    if(i+1>=args.length || !['--runtime','--target','--current','--mode'].includes(args[i]) ||
      Object.hasOwn(flags,args[i])) refuse('usage: --runtime PATH --target PATH [--current PATH] --mode forward|rollback');
    flags[args[i]]=args[i+1];
  }
  if(!flags['--runtime'] || !flags['--target'] || !flags['--mode']) refuse('missing required compatibility inputs');
  return plan({
    runtime:localInput(root,flags['--runtime']),
    target:localInput(root,flags['--target']),
    current:flags['--current']?localInput(root,flags['--current']):null,
    mode:flags['--mode']
  });
}
if(require.main===module) {
  try { process.stdout.write(JSON.stringify(cli(process.argv.slice(2)),null,2)+'\n'); }
  catch(error){ process.stderr.write(error.message+'\n');process.exitCode=2; }
}
module.exports={RELEASE_FORMAT,RUNTIME_FORMAT,parseVersion,compareVersions,releaseRange,runtimeSnapshot,plan,cli};
