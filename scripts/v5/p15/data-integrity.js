'use strict';

/**
 * P15 isolated restore data integrity audit. Read-only repeatable-read cursor
 * over EVERY restored application table (not merely global wallet totals).
 * Canonical per-row text is hashed in memory and never logged or uploaded.
 * Scope is actual PostgreSQL16 data, including migration history, actor
 * assets, escrow, receipts/revocations, privacy tombstones and audit chain.
 * Role grants/off-host keys/provider egress/PITR are DISTINCT external gates.
 */
const crypto=require('node:crypto');
const manifest=require('../../../packages/migrations/manifest.json');
const SCHEMAS=new Set(['meta','identity','profile','social','economy','core','match',
 'tournament','monetization','cosmetics','season','privacy','support','audit','runtime','ops','v5_migration']);
const REQUIRED=[
 'meta.migrations','identity.actors','identity.eligibility','identity.profiles',
 'economy.wallets','economy.ratings','economy.ledger','economy.command_outcomes',
 'match.matches','match.escrow_contributions','tournament.rooms',
 'tournament.escrow_contributions','monetization.receipts',
 'monetization.store_revocations','monetization.store_notifications',
 'privacy.requests','privacy.deletion_receipts','audit.operator_audit',
 'ops.outbox'
];
const SHA=/^[a-f0-9]{64}$/;
function refuse(msg){throw Error('P15_INTEGRITY_REFUSED: '+msg);}
function comparison(source,target){
 if(!source||!target||source.format!=='mega-v5-p15-data-fingerprint/v1'||
    target.format!=='mega-v5-p15-data-fingerprint/v1'||
    source.pgMajor!==16||target.pgMajor!==16||
    typeof source.canonicalDigest!=='string'||!SHA.test(source.canonicalDigest)||
    typeof target.canonicalDigest!=='string'||!SHA.test(target.canonicalDigest)||
    !Number.isSafeInteger(source.tableCount)||source.tableCount<REQUIRED.length||
    !Number.isSafeInteger(target.tableCount)||target.tableCount<REQUIRED.length||
    !Number.isSafeInteger(source.totalRows)||source.totalRows<manifest.migrations.length||
    !Number.isSafeInteger(target.totalRows)||target.totalRows<manifest.migrations.length||
    !source.counts||!target.counts||
    typeof source.counts!=='object'||typeof target.counts!=='object'||
    !REQUIRED.every(t=>Number.isSafeInteger(source.counts[t])&&source.counts[t]>=0&&
      Number.isSafeInteger(target.counts[t])&&target.counts[t]>=0)) {
  refuse('full source/restore table accounting missing');
 }
 const names1=Object.keys(source.counts).sort(),names2=Object.keys(target.counts).sort();
 if(JSON.stringify(names1)!==JSON.stringify(names2)||
   JSON.stringify(source.counts)!==JSON.stringify(target.counts)||
   source.tableCount!==target.tableCount||
   source.totalRows!==target.totalRows||
   source.canonicalDigest!==target.canonicalDigest){
  refuse('source/target durable per-table contents differ');
 }
 return {
  format:'mega-v5-p15-restore-comparison/v1',
  sourceDigest:source.canonicalDigest,targetDigest:target.canonicalDigest,
  tablesCompared:source.tableCount,rowsCompared:source.totalRows,
  perActorAndPerTableHashEqual:true,
  sourceAndRestoreArePhysicallyDistinct:null,
  rolePrivilegeReconstructionVerified:false,
  outboundQuarantineExternallyObserved:false,
  providerReconciliationVerified:false,
  g15Accepted:false
 };
}
function quote(id){
 if(typeof id!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(id))refuse('unexpected SQL catalog identifier');
 return '"'+id+'"';
}
async function snapshot(client,{maxRows=1000000}={}){
 if(!client||typeof client.query!=='function'||
  !Number.isSafeInteger(maxRows)||maxRows<REQUIRED.length||maxRows>10000000) {
   refuse('bounded read-only PG client required');
 }
 const result={
  format:'mega-v5-p15-data-fingerprint/v1',pgMajor:16,
  canonicalDigest:null,tableCount:0,totalRows:0,counts:{},
  migrationCount:0,unexplainedRows:0,readOnly:true
 };
 const hash=crypto.createHash('sha256');
 let begun=false;
 try{
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  begun=true;
  const server=await client.query("SELECT current_setting('server_version_num') AS version");
  if(Math.floor(Number(server.rows[0]?.version)/10000)!==16)refuse('expected PostgreSQL16 source or restore');
  const relations=await client.query(
   "SELECT n.nspname AS schema, c.relname AS name FROM pg_catalog.pg_class c "+
   "JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "+
   "WHERE c.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema') "+
   "AND n.nspname NOT LIKE 'pg_toast%' ORDER BY n.nspname,c.relname");
  if(relations.rows.length<REQUIRED.length||relations.rows.length>256)refuse('incomplete or unbounded restored table inventory');
  const names=relations.rows.map(r=>r.schema+'.'+r.name);
  if(names.some(name=>!SCHEMAS.has(name.split('.')[0]))||
   !REQUIRED.every(name=>names.includes(name)))refuse('unexpected or absent V5 application schema');
  for(const entry of relations.rows){
   const id=entry.schema+'.'+entry.name;
   hash.update(id+'\n');
   const table=quote(entry.schema)+'.'+quote(entry.name);
   const cursor='p15_verify_rows';
   await client.query('DECLARE '+cursor+' NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS row FROM '+table+' t ORDER BY row_to_json(t)::text');
   let count=0;
   try{
    while(true){
     const page=(await client.query('FETCH FORWARD 256 FROM '+cursor)).rows;
     if(!page.length)break;
     for(const row of page){
      if(typeof row.row!=='string')refuse('row JSON cursor returned unexpected data');
      hash.update(row.row+'\n');
      count++;
      result.totalRows++;
      if(result.totalRows>maxRows)refuse('data history exceeds verified read budget');
     }
    }
   }finally{await client.query('CLOSE '+cursor);}
   result.counts[id]=count;
   result.tableCount++;
  }
  const migrations=await client.query('SELECT id,name,checksum FROM meta.migrations WHERE id>0 ORDER BY id');
  if(migrations.rows.length!==manifest.migrations.length)refuse('not all checksummed migrations survived');
  for(let i=0;i<migrations.rows.length;i++){
   const a=migrations.rows[i],b=manifest.migrations[i];
   if(a.id!==b.id||a.name!==b.name||a.checksum!==b.sha256)refuse('restored migration history differs from source pack');
  }
  result.migrationCount=migrations.rows.length;
  const bad=await client.query(
   'SELECT count(*)::int AS n FROM economy.wallets w '+
   'LEFT JOIN identity.actors a ON a.actor_id=w.actor_id '+
   'WHERE a.actor_id IS NULL OR w.coins<0 OR w.crowns<0 OR '+
   'w.reserved_coins<0 OR w.reserved_crowns<0 OR '+
   'w.purchased_coins>w.coins OR w.purchased_crowns>w.crowns');
  if(bad.rows[0].n!==0)refuse('orphan/invalid actor economic state');
  const audit=await client.query(
   "SELECT count(*)::int AS n FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid "+
   "WHERE c.oid='audit.operator_audit'::regclass AND "+
   "t.tgname IN ('operator_audit_no_update','operator_audit_no_delete') AND NOT t.tgisinternal");
  if(audit.rows[0].n!==2)refuse('append-only audit safeguards absent after restoration');
  result.canonicalDigest=hash.digest('hex');
  await client.query('COMMIT');
  return result;
 }catch(e){
  if(begun)try{await client.query('ROLLBACK');}catch{}
  if(e.message&&e.message.startsWith('P15_INTEGRITY_REFUSED:'))throw e;
  refuse('restricted data integrity inspection failed');
 }
}
async function connectSnapshot(target){
 if(!target||target.environment!=='test'||!['disposable-source','disposable-restore'].includes(target.kind)) {
  refuse('only isolated disposable source/restore may be read by PR verifier');
 }
 const {Client}=require('pg');
 const client=new Client({host:target.host,port:target.port,database:target.database,
  user:target.user,ssl:false,connectionTimeoutMillis:5000});
 await client.connect();
 try{return await snapshot(client);}finally{await client.end();}
}
module.exports={REQUIRED,SCHEMAS,quote,snapshot,comparison,connectSnapshot};
