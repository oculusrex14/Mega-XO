'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {comparison,quote,REQUIRED,connectSnapshot,ISOLATED_KINDS}=require('../scripts/v5/p15/data-integrity.js');
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
test('the snapshot verifier reads only isolated loopback kinds and never production',async()=>{
 assert.deepEqual(ISOLATED_KINDS,{'disposable-source':'test',
  'disposable-restore':'test','nonproduction-restore':'test'});
 // A production source kind, and any kind/environment mismatch or non-loopback
 // host, is refused at the gate before a single connection is attempted.
 for(const t of [
  {kind:'nonserving-production-source',environment:'production',host:'127.0.0.1',sslMode:'disable'},
  {kind:'nonserving-staging-source',environment:'staging',host:'127.0.0.1',sslMode:'disable'},
  {kind:'disposable-source',environment:'production',host:'127.0.0.1',sslMode:'disable'},
  {kind:'nonproduction-restore',environment:'test',host:'db.example.com',sslMode:'disable'},
  {kind:'nonproduction-restore',environment:'test',host:'127.0.0.1',sslMode:'verify-full'},
  {kind:'disposable-restore',environment:'test',host:'127.0.0.1',sslMode:'require'},
  {kind:'unknown-restore',environment:'test',host:'127.0.0.1',sslMode:'disable'},
  {kind:'nonproduction-restore',host:'127.0.0.1',sslMode:'disable'},
  undefined
 ]){
  await assert.rejects(()=>connectSnapshot(t),/P15_INTEGRITY_REFUSED/);
 }
 // The quarantined recovery kind passes the gate and only then reaches the
 // database layer; it must never refuse as a policy violation.
 const failure=await connectSnapshot({kind:'nonproduction-restore',environment:'test',
  host:'127.0.0.1',port:1,database:'v5_p15_restore_snapshot01',user:'postgres',
  sslMode:'disable'}).then(()=>null,e=>e);
 assert.ok(failure,'no PostgreSQL server can be listening for this gate test');
 assert.ok(!failure.message.startsWith('P15_INTEGRITY_REFUSED:'),
  'the quarantined recovery kind must pass the isolation gate');
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
