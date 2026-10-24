'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {unchanged,proofValid}=require('../deploy/v5/v5-change-check.js');
const token={format:'mega-v5-db-change/v1',database:'fixture',epoch:'a'.repeat(32),
  covered:true,excludedSchemas:[],revisions:Array(64).fill('0'),sequences:[['ops','seq','1',false]]};
const watermark={format:'mega-v5-backup-watermark/v2',target:'a'.repeat(64),backupId:'v5-p15-fixture',token};
test('only the exact covered source/epoch/revisions/sequence state can authorize a skip',()=>{
  const same=current=>unchanged(watermark,{token:current},watermark.target);
  assert.equal(same(structuredClone(token)),true);
  for(const change of [{covered:false},{epoch:'b'.repeat(32)},
    {revisions:['1',...Array(63).fill('0')]},{sequences:[['ops','seq','1',true]]},
    {sequences:[['ops','seq','2',false]]}])assert.equal(same({...token,...change}),false);
  assert.ok(!unchanged(null,{token},watermark.target));
  assert.equal(unchanged(watermark,{token},'another-source'),false);
});
test('freshness rejects missing/stale/future/moved/mismatched unchanged proofs',()=>{
  const now=Date.parse('2026-10-24T16:00:00Z');
  const marker={format:'mega-v5-backup-unchanged/v2',backupId:watermark.backupId,
    target:watermark.target,checkedAt:'2026-10-24T15:59:00Z',token,previous:token};
  const valid=m=>proofValid(m,watermark.backupId,now,900);
  assert.equal(valid(marker),true);
  assert.equal(valid({...marker,backupId:'v5-p15-other'}),false);
  assert.equal(valid({...marker,checkedAt:'2026-10-24T15:40:00Z'}),false);
  assert.equal(valid({...marker,checkedAt:'2026-10-24T16:01:00Z'}),false);
  assert.equal(valid({...marker,previous:{...token,covered:false}}),false);
  assert.equal(valid({...marker,previous:{...token,revisions:['1',...Array(63).fill('0')]}}),false);
  assert.equal(valid(null),false);
});
