'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {THEMES,SCREENS,hash,sourceFrozen,verifyCaptures,compareCaptures}=require('../scripts/v5/p18/visual-baseline.js');
const root=path.resolve(__dirname,'..');
function temp(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-p18-visual-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return dir;
}
function png(width=390,height=844,tag=0){
 // Minimal deterministic IHDR fixture; verifies bytes/provenance only,
 // intentionally does NOT claim the synthetic fixture displays actual pixels.
 const raw=Buffer.alloc(45,0);
 Buffer.from('89504e470d0a1a0a','hex').copy(raw,0);
 raw.writeUInt32BE(13,8);raw.write('IHDR',12,'ascii');
 raw.writeUInt32BE(width,16);raw.writeUInt32BE(height,20);
 raw[28]=tag;
 raw.writeUInt32BE(0,33);raw.write('IEND',37,'ascii');
 return raw;
}
function captures(dir,tag=0){
 const rows=[];
 for(const theme of THEMES)for(const screen of SCREENS){
  const file=theme+'/'+screen+'.png';
  fs.mkdirSync(path.join(dir,theme),{recursive:true});
  const data=png(390,844,tag);
  fs.writeFileSync(path.join(dir,file),data);
  rows.push({theme,screen,viewport:'390x844',width:390,height:844,
    bytes:data.length,sha256:hash(data),file});
 }
 return {format:'mega-v5-p18-private-captures/v1',sourceSha:'e'.repeat(40),
   platform:'browser',captures:rows};
}
test('P00 frozen approved client source has exactly 21 hash/byte tracked files',()=>{
 const checked=sourceFrozen(root);
 assert.equal(checked.approvedFiles,21);
 assert.equal(checked.visualScreenshotParityVerified,false);
 assert.equal(checked.g18Accepted,false);
 assert.match(checked.baselineSha,/^[a-f0-9]{40}$/);
});
test('private screenshot manifests are actually checked against their PNG bytes',t=>{
 const dir=temp(t),manifest=captures(dir);
 assert.equal(verifyCaptures(dir,manifest).size,16);
 const found=compareCaptures(dir,manifest,dir,manifest);
 assert.equal(found.byteIdenticalScenarios,16);
 assert.equal(found.visualBehavioralParityProven,false);
 assert.equal(found.g18Accepted,false);
 const diff=captures(dir,1);
 const compared=compareCaptures(dir,diff,dir,manifest);
 assert.equal(compared.changedScenariosRequireVisualReview.length,0);
 // Compare against two independently persisted capture roots.
 const other=temp(t),candidate=captures(other,2);
 const result=compareCaptures(dir,diff,other,candidate);
 assert.equal(result.changedScenariosRequireVisualReview.length,16);
});
test('manifests cannot drop a theme, duplicate a case or lie about SHA/dimensions',t=>{
 const dir=temp(t);
 const p=captures(dir);
 for(const change of [
  r=>r.captures.pop(),
  r=>{r.captures[0].theme='other';},
  r=>{r.captures[0].sha256='a'.repeat(64);},
  r=>{r.captures[0].file='../secrets.png';},
  r=>{r.captures[0].width=391;},
  r=>{r.captures[0].screen=r.captures[1].screen;r.captures[0].theme=r.captures[1].theme;},
  r=>{r.captures[0].token='PRIVATE';}
 ]){
  const bad=JSON.parse(JSON.stringify(p));change(bad);
  assert.throws(()=>verifyCaptures(dir,bad),/P18_VISUAL_REFUSED/);
 }
});
test('approved source freeze reports changes as requiring review, never silently normalized',t=>{
 const dir=temp(t);
 const src=path.join(root,'docs/v5/evidence/phase00-source-baseline.json');
 const baseline=JSON.parse(fs.readFileSync(src,'utf8'));
 fs.mkdirSync(path.join(dir,'docs/v5/evidence'),{recursive:true});
 fs.writeFileSync(path.join(dir,'docs/v5/evidence/phase00-source-baseline.json'),JSON.stringify(baseline));
 for(const row of baseline.source_manifest.files){
  const target=path.join(dir,row.path);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.copyFileSync(path.join(root,row.path),target);
 }
 let result=sourceFrozen(dir);
 assert.equal(result.sourceBytesIdenticalToP00,true);
 fs.appendFileSync(path.join(dir,'src','game.js'),'\n// regression');
 result=sourceFrozen(dir);
 assert.equal(result.sourceBytesIdenticalToP00,false);
 assert.deepEqual(result.reviewRequiredFiles,['src/game.js']);
 assert.equal(result.g18Accepted,false);
});
