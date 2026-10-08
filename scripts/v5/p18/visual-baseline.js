#!/usr/bin/env node
'use strict';

/**
 * P18-04 approved-client source freeze and private screenshot provenance.
 * The P00 screenshots live in restricted owner evidence, NOT this repository.
 * A byte-identical PNG is evidence of matching bytes, not device UX parity.
 * Changed pixels always require real visual review; this tool cannot sign G18.
 */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const THEMES=Object.freeze(['vector','midnight','paperclub','afterhours']);
const SCREENS=Object.freeze(['home','settings','wallet','game']);
const SHA64=/^[a-f0-9]{64}$/;
function refuse(message){throw new Error('P18_VISUAL_REFUSED: '+message);}
function hash(bytes){return crypto.createHash('sha256').update(bytes).digest('hex');}
function sourceFrozen(root) {
  const proof=JSON.parse(fs.readFileSync(path.join(root,'docs/v5/evidence/phase00-source-baseline.json'),'utf8'));
  if(proof.schema_version!==1 || proof.source_manifest?.schema_version!==1 ||
     !Array.isArray(proof.source_manifest.files) || proof.source_manifest.files.length!==21) {
    refuse('expected P00 source manifest is missing or incomplete');
  }
  const seen=new Set(),changed=[];
  for(const entry of proof.source_manifest.files) {
    if(!entry || typeof entry.path!=='string' || !/^(?:src\/|public\/|index\.html$)/.test(entry.path) ||
       entry.path.includes('..') || entry.path.includes('\\') ||
       !SHA64.test(entry.sha256) || !Number.isSafeInteger(entry.bytes)) refuse('bad P00 baseline row');
    if(seen.has(entry.path)) refuse('duplicate P00 approved source file');
    seen.add(entry.path);
    const file=path.join(root,entry.path),stat=fs.lstatSync(file);
    if(!stat.isFile() || stat.isSymbolicLink()) refuse('untrusted approved source symlink');
    const bytes=fs.readFileSync(file);
    if(bytes.length!==entry.bytes||hash(bytes)!==entry.sha256) {
      changed.push(entry.path);
    }
  }
  return {
    format:'mega-v5-p18-source-freeze-check/v1',
    baselineSha:proof.source_manifest.base_sha,
    approvedFiles:seen.size,
    sourceBytesIdenticalToP00:changed.length===0,
    reviewRequiredFiles:changed,
    visualScreenshotParityVerified:false,
    g18Accepted:false
  };
}
function withinRoot(root,rel) {
  if(typeof rel!=='string' || rel.length>300 || rel.startsWith('/') ||
     rel.includes('\\') || rel.split('/').some(x=>!x || x==='.' || x==='..') ||
     !/^[a-zA-Z0-9._/-]+\.png$/.test(rel)) refuse('unsafe screenshot file reference');
  let parent=path.resolve(root);
  const full=path.resolve(parent,rel);
  if(!full.startsWith(parent+path.sep)) refuse('screenshot escapes capture root');
  // Do not allow symlinks anywhere along the capture tree.
  for(const segment of rel.split('/').slice(0,-1)) {
    parent=path.join(parent,segment);
    if(fs.lstatSync(parent).isSymbolicLink()) refuse('capture directory symlink forbidden');
  }
  const stat=fs.lstatSync(full);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size>20_000_000 || stat.size<33) {
    refuse('invalid or unbounded screenshot');
  }
  return full;
}
function verifyPng(root,file,sha,bytes,width,height) {
  if(!SHA64.test(sha)||!Number.isSafeInteger(bytes)||bytes<33 ||
     !Number.isSafeInteger(width)||width<1||width>8192 ||
     !Number.isSafeInteger(height)||height<1||height>8192) refuse('invalid screenshot metadata');
  const raw=fs.readFileSync(withinRoot(root,file));
  if(raw.length!==bytes||hash(raw)!==sha) refuse('screenshot bytes do not match manifest');
  const signature=Buffer.from('89504e470d0a1a0a','hex');
  if(!raw.subarray(0,8).equals(signature)||
     raw.readUInt32BE(8)!==13 || raw.subarray(12,16).toString('ascii')!=='IHDR' ||
     raw.readUInt32BE(16)!==width||raw.readUInt32BE(20)!==height) {
    refuse('PNG signature or IHDR dimensions invalid');
  }
}
function verifyCaptures(root,manifest) {
  if(!manifest || typeof manifest!=='object' || Array.isArray(manifest) ||
     manifest.format!=='mega-v5-p18-private-captures/v1' ||
     !/^[a-f0-9]{40}$/.test(manifest.sourceSha) ||
     !['browser','android','ios'].includes(manifest.platform) ||
     !Array.isArray(manifest.captures)) refuse('invalid capture manifest header');
  const entries=new Map();
  for(const row of manifest.captures) {
    if(!row || typeof row!=='object'||Array.isArray(row)||
       Object.keys(row).sort().join(',')!==['bytes','file','height','screen','sha256','theme','viewport','width'].sort().join(',')) {
      refuse('screenshot row schema incorrect');
    }
    if(!THEMES.includes(row.theme)||!SCREENS.includes(row.screen)||
       typeof row.viewport!=='string'||!/^\d{3,4}x\d{3,4}$/.test(row.viewport)) {
      refuse('unexpected theme, screen or viewport');
    }
    const key=row.theme+'|'+row.screen+'|'+row.viewport;
    if(entries.has(key)) refuse('duplicate visual scenario');
    verifyPng(root,row.file,row.sha256,row.bytes,row.width,row.height);
    const [w,h]=row.viewport.split('x').map(Number);
    if(row.width!==w||row.height!==h) refuse('viewport and PNG pixel dimensions differ');
    entries.set(key,row.sha256);
  }
  const all=Array.from(entries.keys());
  const viewports=Array.from(new Set(manifest.captures.map(x=>x.viewport)));
  if(viewports.length<1 || all.length!==THEMES.length*SCREENS.length*viewports.length) {
    refuse('all four themes and core screens required at every reported viewport');
  }
  for(const v of viewports) for(const theme of THEMES) for(const screen of SCREENS) {
    if(!entries.has(theme+'|'+screen+'|'+v)) refuse('visual matrix incomplete');
  }
  return entries;
}
function compareCaptures(baselineRoot,baseline,candidateRoot,candidate) {
  const left=verifyCaptures(baselineRoot,baseline);
  const right=verifyCaptures(candidateRoot,candidate);
  if(left.size!==right.size || [...left.keys()].some(k=>!right.has(k))) {
    refuse('candidate screenshots do not cover exact P00 scenario matrix');
  }
  const differences=[...left.keys()].filter(k=>left.get(k)!==right.get(k)).sort();
  return {
    format:'mega-v5-p18-screenshot-provenance-comparison/v1',
    scenariosCompared:left.size,
    byteIdenticalScenarios:left.size-differences.length,
    changedScenariosRequireVisualReview:differences,
    visualBehavioralParityProven:false,
    genuineDeviceEvidenceIndependentlyReviewed:false,
    g18Accepted:false,
    note:'PNG hashes and dimensions verified against private files; pixel/gesture accessibility parity must still be reviewed'
  };
}
if(require.main===module){
  try{
    if(process.argv.length!==3 || process.argv[2]!=='--source-freeze') refuse('usage: visual-baseline.js --source-freeze');
    const report=sourceFrozen(process.cwd());
    process.stdout.write(JSON.stringify(report,null,2)+'\n');
    if(!report.sourceBytesIdenticalToP00)process.exitCode=2;
  }catch(e){process.stderr.write(e.message+'\n');process.exitCode=2;}
}
module.exports={THEMES,SCREENS,hash,sourceFrozen,verifyPng,verifyCaptures,compareCaptures};
