'use strict';

/**
 * Real two-cluster P15 archive/recovery: PostgreSQL16 source on 127.0.0.1:5432,
 * independent EMPTY PostgreSQL16 restore cluster on 127.0.0.1:5433.
 * Both GitHub service containers have synthetic data and ephemeral trust auth.
 * NEVER executes without explicit P15_REAL_DISPOSABLE=1, never touches Neon,
 * R2, V4 backups or private user data.
 */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {Client}=require('pg');

const lab=require('./v5-pg-lab.js');
const {backup}=require('../scripts/v5/p15/backup-cli.js');
const {restore}=require('../scripts/v5/p15/restore-cli.js');
const {connectSnapshot,comparison}=require('../scripts/v5/p15/data-integrity.js');
lab.installCleanup(test);

async function targetAdmin(database='postgres'){
 const c=new Client({host:'127.0.0.1',port:5433,database,user:'postgres',
  ssl:false,connectionTimeoutMillis:5000});
 await c.connect();
 return c;
}
const quote=name=>'"'+name.replace(/"/g,'""')+'"';
test('P15 separate PostgreSQL16 containers: encrypted backup, authenticated restore and all-table integrity equality',
 {timeout:300000},async t=>{
 if(process.env.P15_REAL_DISPOSABLE!=='1'){
  t.skip('real isolated twin-PG archive roundtrip runs only in P15 ephemeral CI');
  return;
 }
 assert.equal(process.env.V5_P15_DISPOSABLE,'1');
 assert.equal(process.env.V5_P15_QUARANTINE,'1');
 assert.equal(process.env.P15_RESTORE_JOBS_DISABLED,'1');
 assert.equal(process.env.P15_RESTORE_PROVIDER_CALLBACKS_DISABLED,'1');
 assert.match(process.env.P15_SOURCE_SHA,/^[a-f0-9]{40}$/);
 assert.equal(await lab.boot(t),true);
 const sourceDb=await lab.createDatabase('p15_source');
 await lab.seedActors(sourceDb,lab.seedFor(['svc_alice','svc_bob','svc_carol']));

 const core=await lab.coreFor(sourceDb);
 try{
  const converted=await core.run({actor:'svc_alice',scope:'player'},'p15-convert-fixture',
   {type:'convert',from:'coins',amount:100});
  assert.equal(converted.debit,100);
  assert.equal(converted.credit,10);
  const offered=await core.run({actor:'svc_alice',scope:'player'},'p15-offer-fixture',
   {type:'offer',id:'p15-match-offer-fixture',opponent:'svc_bob',
    terms:{kind:'leaderboard',amount:40}});
  assert.ok(offered.termsHash);
  await core.run({actor:'svc_alice',scope:'player'},'p15-accept-a',
   {type:'accept',id:'p15-match-offer-fixture',termsHash:offered.termsHash});
  await core.run({actor:'svc_bob',scope:'player'},'p15-accept-b',
   {type:'accept',id:'p15-match-offer-fixture',termsHash:offered.termsHash});
 }finally{core.close();await lab.closeDatabasePools(sourceDb);}

 const seeded=await lab.adminClient(sourceDb);
 try{
  const now=new Date(lab.CLOCK).toISOString();
  // Some P04 match operations persist the reservation in the aggregate
  // rather than emitting historical contribution rows. For backup schema
  // coverage we explicitly seed the two synthetic contribution rows if
  // absent. This tests restoration of that table, not P04 allocation logic.
  const match=(await seeded.query("SELECT escrow,accepted_count FROM match.matches WHERE match_id='p15-match-offer-fixture'")).rows[0];
  assert.ok(match && Number(match.accepted_count)===2);
  const contributionRows=(await seeded.query(
    "SELECT count(*)::int AS n FROM match.escrow_contributions WHERE match_id='p15-match-offer-fixture'")).rows[0].n;
  if(contributionRows===0){
   await seeded.query("INSERT INTO match.escrow_contributions (match_id,actor_id,amount) VALUES ('p15-match-offer-fixture','svc_alice',40),('p15-match-offer-fixture','svc_bob',40)");
  }
  // A second escrow graph fixture, intentionally synthetic and limited to
  // restore fidelity: not a claim about actual future P09 room orchestration.
  await seeded.query("INSERT INTO tournament.rooms (room_id,code,owner_id,status,created_at,escrow) VALUES ('p15-room-fixture','P15ROOMFIXTURE','svc_carol','RUNNING',$1,40)",[now]);
  await seeded.query("INSERT INTO tournament.escrow_contributions (room_id,actor_id,amount) VALUES ('p15-room-fixture','svc_carol',40)");
  await seeded.query("INSERT INTO monetization.receipts (store,transaction_id,actor_id,product_id,crowns,refunded,purchased_at) VALUES ('google','p15-purchase-01','svc_alice','crowns_100',100,false,$1)",[now]);
  await seeded.query("INSERT INTO monetization.store_revocations (store,transaction_id,product_id,occurred_at,reason) VALUES ('google','p15-revoked-01','crowns_100',$1,'synthetic_refund')",[now]);
  await seeded.query("INSERT INTO privacy.deletion_receipts (receipt_id,actor_hash,tombstone,completed_at,policy_version,retained) VALUES ('p15-delete-01',$1,'anon_p15_removed',$2,'v4.1.2','[]'::jsonb)",['b'.repeat(64),now]);
  await seeded.query("INSERT INTO privacy.requests (request_id,actor_id,kind,state,requested_at,updated_at,completed_at,policy_version) VALUES ('p15-privacy-req','anon_p15_removed','deletion','completed',$1,$1,$1,'v4.1.2')",[now]);
  await seeded.query("INSERT INTO audit.operator_audit (audit_id,\"at\",operator,action,actor_id,reason,detail,prev_hash,entry_hash) VALUES ('p15-audit-fixture',$1,'synthetic_operator','inspect','svc_alice','synthetic','fixture',$2,$3)",
   [now,'0'.repeat(64),'a'.repeat(64)]);
 }finally{await seeded.end();}

 const source={format:'mega-v5-p15-direct-pg-target/v1',kind:'disposable-source',
  environment:'test',sourceSha:process.env.P15_SOURCE_SHA,
  sourceId:'p15-source-disposable-ci',projectId:'disposable-source-pg16',
  host:'127.0.0.1',port:5432,database:sourceDb,user:'postgres',sslMode:'disable',pgMajor:16};
 const original=await connectSnapshot(source);
 assert.equal(original.migrationCount,lab.CHAIN_LENGTH);
 for(const table of ['economy.wallets','economy.ledger','match.matches',
  'match.escrow_contributions','tournament.escrow_contributions',
  'monetization.receipts','monetization.store_revocations',
  'privacy.deletion_receipts','privacy.requests','audit.operator_audit']) {
  assert.ok(original.counts[table]>0,'fixture coverage must contain real data in '+table);
 }

 // The recovery cluster is a different running postgres container. No
 // future job/service gets its port as a production/Neon identity.
 const restoreName='v5_p15_restore_'+crypto.randomBytes(5).toString('hex');
 const admin=await targetAdmin();
 let created=false;
 try {
  await admin.query('CREATE DATABASE '+quote(restoreName));
  created=true;
 }finally{await admin.end();}
 const target={...source,kind:'disposable-restore',projectId:'disposable-restore-pg16',
  sourceId:'p15-restored-disposable-ci',port:5433,database:restoreName};
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mega-v5-p15-archive-'));
 const keypair=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
 const pub=keypair.publicKey.export({format:'pem',type:'spki'});
 const privatePem=keypair.privateKey.export({format:'pem',type:'pkcs8'});
 const env={...process.env,P15_SOURCE_SHA:process.env.P15_SOURCE_SHA};
 const started=performance.now();
 let report;
 try{
  const createdBackup=await backup({source,recipientPublicPem:pub,
   outputDirectory:temp,env});
  const backedUpAt=new Date().toISOString();
  const restoreStart=performance.now();
  const restored=await restore({manifestPath:createdBackup.manifestFile,
   archivePath:createdBackup.sealedFile,privatePem,target,env});
  const restoredAt=new Date().toISOString();
  const restoredSnapshot=await connectSnapshot(target);
  const matched=comparison(original,restoredSnapshot);
  assert.equal(matched.perActorAndPerTableHashEqual,true);
  assert.equal(restored.completeDataDigest,original.canonicalDigest);
  assert.equal(restored.singleTransactionRestoreCommitted,true);
  assert.equal(restored.preRestoreGcmAuthenticationVerified,true);
  assert.equal(restored.providerPitrObserved,false);
  assert.equal(restored.encryptedR2DownloadObserved,false);
  assert.equal(restored.g15Accepted,false);
  assert.equal(createdBackup.manifest.backupRunClass,'REAL_DIRECT_PG16_DUMP');
  assert.deepEqual(fs.readdirSync(temp).sort(),
   [path.basename(createdBackup.manifestFile),path.basename(createdBackup.sealedFile)].sort(),
   'only ciphertext and sanitized manifest remain; no plaintext dump or private key on disk');

  report={
   format:'mega-v5-p15-disposable-restore-evidence/v1',
   sourceSha:process.env.P15_SOURCE_SHA,
   sourceKind:'ACTUAL_PG16_DISPOSABLE_INSTANCE',
   restoreKind:'SECOND_INDEPENDENT_PG16_DISPOSABLE_INSTANCE',
   syntheticOnly:true,quarantineAndNoProviderEffectsDeclared:true,
   backupCiphertextBytes:createdBackup.manifest.ciphertextBytes,
   backupCiphertextSha256:createdBackup.manifest.ciphertextSha256,
   sourceAndRestoredRows:matched.rowsCompared,
   sourceAndRestoredTables:matched.tablesCompared,
   sourceAndRestoredDigestEqual:true,
   migrationsVerified:original.migrationCount,
   nonemptyAssetAndTombstoneFixtures:true,
   actualEncryptedArchiveVerified:true,
   archiveRetrievedFromR2:false,
   roleAndExternalSecretsReconstructed:false,
   neonPitrObserved:false,actualRpoMeasured:false,actualRtoMeasured:false,
   localBackupDurationMs:Number((restoreStart-started).toFixed(3)),
   localRecoveryDurationMs:Number((performance.now()-restoreStart).toFixed(3)),
   productionRetentionApproved:false,
   sourceOwnerReportedBackupConflictReconciled:false,
   g15Accepted:false,
   restoredAtUtc:restoredAt,localBackupCompletedAtUtc:backedUpAt,
   recoveryTargetCleaned:false
  };
 }finally{
  // This is ONLY the name created in this test on the second disposable
  // cluster; no production/staging database cleanup automation exists.
  if(created){
   const drop=await targetAdmin();
   try{await drop.query('DROP DATABASE '+quote(restoreName)+' WITH (FORCE)');}
   finally{await drop.end();}
  }
  fs.rmSync(temp,{recursive:true,force:true});
 }
 assert.ok(report,'a failed restore cannot produce a success report');
 const confirm=await targetAdmin();
 try{
  const q=await confirm.query("SELECT count(*)::int AS n FROM pg_catalog.pg_database WHERE datname=$1",[restoreName]);
  assert.equal(q.rows[0].n,0,'independent test database was removed');
 }finally{await confirm.end();}
 report.recoveryTargetCleaned=true;
 if(process.env.P15_EVIDENCE_OUTPUT){
  assert.equal(process.env.P15_EVIDENCE_OUTPUT,'.artifacts/p15-disposable-restore.json');
  fs.mkdirSync('.artifacts',{recursive:true});
  fs.writeFileSync(process.env.P15_EVIDENCE_OUTPUT,JSON.stringify(report,null,2)+'\n',
   {mode:0o600,flag:'wx'});
 }
 assert.equal(report.g15Accepted,false);
 assert.ok(report.localBackupDurationMs>=0);
 assert.ok(report.localRecoveryDurationMs>=0);
});
