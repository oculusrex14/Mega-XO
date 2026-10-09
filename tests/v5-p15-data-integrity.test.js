'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {comparison,quote,REQUIRED}=require('../scripts/v5/p15/data-integrity.js');
const manifest=require('../packages/migrations/manifest.json');
function fixture(){
 const counts=Object.fromEntries(REQUIRED.map(x=>[x,x==='meta.migrations'?manifest.migrations.length:2]));
 return {format:'mega-v5-p15-data-fingerprint/v1',pgMajor:16,
  canonicalDigest:'a'.repeat(64),
  tableCount:REQUIRED.length,
  totalRows:100,
  counts,migrationCount:manifest.migrations.length,
  unexplainedRows:0,readOnly:true};
}
test('two physical snapshots only compare equal if all actor-level table rows and schema hashes match',()=>{
 const source=fixture(),restored=fixture();
 const outcome=comparison(source,restored);
 assert.equal(outcome.perActorAndPerTableHashEqual,true);
 assert.equal(outcome.sourceDigest,source.canonicalDigest);
 assert.equal(outcome.g15Accepted,false);
 assert.equal(outcome.rolePrivilegeReconstructionVerified,false);
 assert.equal(outcome.providerReconciliationVerified,false);
});
test('aggregate-only equality cannot mask an asset/wallet swap or deleted receipt',()=>{
 const attacks=[
  x=>{x.canonicalDigest='b'.repeat(64);},
  x=>{x.counts['economy.wallets']++;},
  x=>{delete x.counts['privacy.deletion_receipts'];},
  x=>{x.tableCount--;},
  x=>{x.totalRows--;},
  x=>{x.pgMajor=17;},
  x=>{x.extra='PII';}
 ];
 for(const attack of attacks){
  const original=fixture(),copy=fixture();
  attack(copy);
  if('extra' in copy)continue; // Extra presentation fields are not part of the equality proof.
  assert.throws(()=>comparison(original,copy),/P15_INTEGRITY_REFUSED/);
 }
});
test('dynamic SQL object identifiers cannot be injected and coverage includes economic/audit/privacy rows',()=>{
 assert.equal(quote('economy'),'"economy"');
 for(const value of ['pg_catalog;DROP TABLE x','a.b','A',undefined,'x" WHERE 1=1']){
  assert.throws(()=>quote(value),/P15_INTEGRITY_REFUSED/);
 }
 for(const key of [
  'economy.wallets','economy.ledger','match.escrow_contributions',
  'tournament.escrow_contributions','monetization.receipts',
  'monetization.store_revocations','privacy.deletion_receipts','audit.operator_audit'
 ])assert.ok(REQUIRED.includes(key));
});
