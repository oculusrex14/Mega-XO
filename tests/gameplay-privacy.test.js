'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs').promises,path=require('node:path'),os=require('node:os');
const P=require('../packages/learning/privacy.js'),S=require('../packages/learning/encrypted.js');
async function setup(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capture-privacy-'));await fs.chmod(dir,0o700);t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {file:path.join(dir,'journal'),key:crypto.randomBytes(32),keyId:'privacy-test'};}
function db({enabled=false,epoch=3,failAt=0}={}){const effects=[],c={query:async(s,a=[])=>{effects.push([s,a]);if(s.includes('configuration'))return {rows:[{value:{enabled,privacyEpoch:epoch}}]};if(s.includes('privacy_page'))return {rows:a[0]?[]:[{actor_id:'private_subject',reason:'account-deletion',epoch:3}]};if(s.includes('erasure_page'))return {rows:a[0]?[]:[{capture_id:'f'.repeat(64),state:'purged'}]};if(s.includes('learning.erase'))return {rows:[{n:0}]};if(s.includes('learning.suppress')&&failAt)throw Error('synthetic-database-failure');return {rows:[]};},release:()=>{effects.push(['RELEASE']);}};return {effects,connect:async()=>c};}
test('fresh encrypted journal retains suppression and missing-source erasure tombstones for isolated replay',async t=>{
 const o=await setup(t),source=db(),receipt=await P.exportPrivacyJournal(source,o);assert.equal(receipt.suppressions,1);assert.equal(receipt.erasures,1);assert.ok(!(await fs.readFile(o.file)).includes(Buffer.from('private_subject')));
 const target=db(),r=await P.replayPrivacyJournal(target,{...o,...receipt,requiredEpoch:3,isolatedRestore:true});assert.equal(r.enabled,false);assert.equal(r.entries,2);assert.ok(target.effects.some(([s])=>s.includes('learning.replay_erasure')));assert.ok(target.effects.some(([s])=>s==='COMMIT'));
});
test('stale privacy journal, missing authorization and enabled target fail closed',async t=>{
 const o=await setup(t),r=await P.exportPrivacyJournal(db(),o);
 await assert.rejects(P.replayPrivacyJournal(db(),{...o,...r,requiredEpoch:3}),/CAPTURE_RESTORE_AUTHORIZATION/);
 for(const [target,epoch,code] of [[db(),4,'STALE_JOURNAL'],[db({enabled:true}),3,'TARGET_ENABLED']]){await assert.rejects(P.replayPrivacyJournal(target,{...o,...r,requiredEpoch:epoch,isolatedRestore:true}),new RegExp('CAPTURE_RESTORE_'+code));assert.ok(!target.effects.some(([s])=>s.includes('learning.suppress')));}
});
test('malformed journal or database failure rolls back every applied effect',async t=>{
 const o=await setup(t),w=await S.createWriter(o.file,o.key,{keyId:o.keyId,kind:'privacy-journal'});await w.write({type:'watermark',format:'privacy-journal/v1',epoch:3});await w.write({type:'suppression',actorId:'private_subject',reason:'account-deletion',epoch:3});await w.write({type:'password',value:'forbidden'});const r=await w.finish();
 const target=db();await assert.rejects(P.replayPrivacyJournal(target,{...o,...r,requiredEpoch:3,isolatedRestore:true}),/CAPTURE_PRIVACY_RECORD/);assert.ok(target.effects.some(([s])=>s==='ROLLBACK'));assert.ok(!target.effects.some(([s])=>s==='COMMIT'));
});
test('database failure rolls back a verified journal, never commits a partial replay',async t=>{const o=await setup(t),receipt=await P.exportPrivacyJournal(db(),o),target=db({failAt:1});await assert.rejects(P.replayPrivacyJournal(target,{...o,...receipt,requiredEpoch:3,isolatedRestore:true}),/synthetic-database-failure/);assert.ok(target.effects.some(([s])=>s==='ROLLBACK'));assert.ok(!target.effects.some(([s])=>s==='COMMIT'));});
