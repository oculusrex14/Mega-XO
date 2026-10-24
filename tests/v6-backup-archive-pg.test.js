'use strict';
/* The no-change proof must carry the sequence values the ARCHIVE restores, not a
 * pre-dump sample: setval(20) -> dump(20) -> setval(10) is a real skip hazard that
 * only archive-bound identities close. Real pg_dump/pg_restore, real sealed bytes. */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Client}=require('pg');
const lab=require('./v5-pg-lab.js');
const {backup}=require('../scripts/v5/p15/backup-cli.js');
const {unchanged}=require('../deploy/v5/v5-change-check.js');
lab.installCleanup(test);

const SHA='b'.repeat(40);
const recipient=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
const pub=recipient.publicKey.export({type:'spki',format:'pem'});
const clientBin= ['/opt/homebrew/opt/postgresql@16/bin','/usr/local/opt/postgresql@16/bin','/usr/lib/postgresql/16/bin']
 .map(dir=>({dump:path.join(dir,'pg_dump'),restore:path.join(dir,'pg_restore')}))
 .find(pair=>fs.existsSync(pair.dump)&&fs.existsSync(pair.restore));

function disposableTarget(url,database){
 const u=new URL(url);
 return {format:'mega-v5-p15-direct-pg-target/v1',kind:'disposable-source',environment:'test',
  sourceSha:SHA,sourceId:'p15-source-owned-test',projectId:'disposable-source-pg16',
  host:u.hostname,port:Number(u.port||5432),database,user:decodeURIComponent(u.username||'postgres'),
  sslMode:'disable',pgMajor:16};
}

test('the watermark carries archive-restored sequence values through a setval ABA race',async t=>{
 if(!await lab.boot(t))return;
 assert.ok(clientBin,'PostgreSQL 16 client tools (pg_dump/pg_restore) required');
 const database=await lab.createDatabase('p15_source');
 const admin=new Client({connectionString:lab.dbUrl(database)});
 await admin.connect();
 try{
  await admin.query('CREATE SCHEMA pgx');
  await admin.query('CREATE SEQUENCE pgx.\\"Weird Name\\"');
  await admin.query('SELECT setval(\'pgx."Weird Name"\',40,true)');
  const probe=async()=> (await admin.query('SELECT ops.backup_change_probe(false) AS token')).rows[0].token;
  const preDump=await probe();
  assert.equal(preDump.covered,true);
  // ABA: advance the sequence AFTER the probe, dump, then return it.
  await admin.query("SELECT setval('monetization.reward_events_event_id_seq',20,true)");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v6-archive-'));
  t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
  const run=async expected=>backup({source:disposableTarget(lab.dbUrl(database),database),
   recipientPublicPem:pub,outputDirectory:dir,
   env:{V5_P15_DISPOSABLE:'1',V5_PG_DISPOSABLE:'1',P15_SOURCE_SHA:SHA,PATH:process.env.PATH,
    ...(expected?{P15_SEQUENCE_IDENTITIES:JSON.stringify(expected)}:{})},
   command:clientBin.dump,versionCheck:()=>16});
  const result=await run(preDump.sequences);
  const captured=Object.fromEntries(result.sequenceCapture.sequences.map(row=>[row[0]+'.'+row[1],[row[2],row[3]]]));
  assert.deepEqual(captured['monetization.reward_events_event_id_seq'],['20','true'],'the dump recorded 20, not the stale pre-probe 9');
  assert.deepEqual(captured['pgx."Weird Name"'],['40','true'],'quoted cross-schema identities survive');
  assert.equal(result.sequenceCapture.hasLargeObjects,false);
  const watermark={format:'mega-v5-backup-watermark/v2',target:'fixture',backupId:'v5-p15-fixture',
   token:{...preDump,sequences:result.sequenceCapture.sequences},
   ciphertextSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64)};
  await admin.query("SELECT setval('monetization.reward_events_event_id_seq',9,true)");
  assert.equal(unchanged(watermark,{token:await probe()},'fixture'),false,
   'the old pre-dump sample would have skipped here; archive binding refuses');
  await admin.query("SELECT setval('monetization.reward_events_event_id_seq',20,true)");
  assert.equal(unchanged(watermark,{token:await probe()},'fixture'),true,'an exact match to the archived state skips');
  // Large objects are never eligible for an unchanged baseline.
  await admin.query('SELECT lo_create(42)');
  const withLob=await run(preDump.sequences);
  assert.equal(withLob.sequenceCapture.hasLargeObjects,true);
  assert.equal(withLob.sequenceCapture.sequences,result.sequenceCapture.sequences);
 }finally{await admin.end();}
});
test('an identity mismatch with the archive fails the backup closed',async t=>{
 if(!await lab.boot(t))return;
 assert.ok(clientBin,'PostgreSQL 16 client tools required');
 const database=await lab.createDatabase('p15_source_2');
 const admin=new Client({connectionString:lab.dbUrl(database)});
 await admin.connect();
 try{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v6-archive-bad-'));
  t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
  await assert.rejects(()=>backup({source:disposableTarget(lab.dbUrl(database),database),
   recipientPublicPem:pub,outputDirectory:dir,
   env:{V5_P15_DISPOSABLE:'1',V5_PG_DISPOSABLE:'1',P15_SOURCE_SHA:SHA,PATH:process.env.PATH,
    P15_SEQUENCE_IDENTITIES:JSON.stringify([['ops','missing_sequence','1',false]])},
   command:clientBin.dump,versionCheck:()=>16}),/P15_(SEQUENCE_CAPTURE_FAILED|BACKUP_REFUSED)/);
  assert.deepEqual(fs.readdirSync(dir),[],'no archive or manifest survives an identity mismatch');
 }finally{await admin.end();}
});
