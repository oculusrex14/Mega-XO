'use strict';

/**
 * P15 immutable PostgreSQL direct-target contract. No URL credentials,
 * connection-pool endpoints, production DBs, shell evaluation or free-form
 * target selection. Real stage requires explicit owner gating, while CI may
 * operate on two distinct job-owned PostgreSQL16 instances only.
 */
const fs=require('node:fs');
const crypto=require('node:crypto');
const path=require('node:path');
const stage=require('../../../docs/v5/environments/staging.json');
const SHA40=/^[a-f0-9]{40}$/;
function refuse(why){throw Error('P15_TARGET_REFUSED: '+why);}
function checkFile(file,{secret=false}={}){
 if(typeof file!=='string'||!path.isAbsolute(file))refuse('absolute protected file path required');
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||
   (secret && (stat.mode&0o077)!==0))refuse('file not regular or credential permissions unsafe');
 return file;
}
function privateDirectory(dir){
 if(typeof dir!=='string'||!path.isAbsolute(dir)||dir==='/'||
    dir.includes('\0'))refuse('bounded absolute output directory required');
 const st=fs.lstatSync(dir);
 if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0) {
  refuse('backup directory must already exist, real and mode 0700');
 }
 return dir;
}
function assertTarget(value,operation,env=process.env){
 if(!value||typeof value!=='object'||Array.isArray(value)||
   Object.keys(value).sort().join(',')!==[
     'format','kind','environment','sourceSha','sourceId',
     'projectId','host','port','database','user','sslMode','pgMajor'
   ].sort().join(',')||value.format!=='mega-v5-p15-direct-pg-target/v1'||
   !['backup','restore'].includes(operation)||!SHA40.test(value.sourceSha)||
   typeof value.sourceId!=='string'||!/^[a-zA-Z][a-zA-Z0-9_-]{6,95}$/.test(value.sourceId)||
   value.pgMajor!==16||value.port!==5432 && value.port!==5433||
   typeof value.host!=='string'||!value.host||
   value.host.includes('pooler')||value.host.includes('@')||value.host.includes('/')||
   typeof value.database!=='string'||typeof value.user!=='string') {
  refuse('untrusted target identity or non-direct PostgreSQL endpoint');
 }
 const allowed={
  'disposable-source':operation==='backup'&&value.environment==='test'&&
   env.V5_P15_DISPOSABLE==='1'&&env.V5_PG_DISPOSABLE==='1'&&
   value.host==='127.0.0.1'&&value.port===5432&&
   /^v5_test_p15_source_[a-z0-9_]{6,48}$/.test(value.database)&&
   value.projectId==='disposable-source-pg16'&&value.user==='postgres'&&
   value.sslMode==='disable',
  'disposable-restore':operation==='restore'&&value.environment==='test'&&
   env.V5_P15_DISPOSABLE==='1'&&env.V5_P15_QUARANTINE==='1'&&
   value.host==='127.0.0.1'&&value.port===5433&&
   /^v5_p15_restore_[a-z0-9_]{6,48}$/.test(value.database)&&
   value.projectId==='disposable-restore-pg16'&&value.user==='postgres'&&
   value.sslMode==='disable',
  'nonserving-staging-source':operation==='backup'&&
   value.environment==='staging'&&
   env.P15_OWNER_APPROVE_NONPRODUCTION_BACKUP==='1'&&
   env.P15_OWNER_CONFIRMS_NONPRODUCTION==='1'&&
   value.projectId===stage.projectId&&value.host===stage.host&&
   value.database===stage.database&&value.port===5432&&
   value.user==='backup_reader'&&value.sslMode==='verify-full'
 };
 if(allowed[value.kind]!==true)refuse('production/unknown environment or unapproved backup/restore target');
 if(env.PGPASSWORD||env.PGHOSTADDR||env.PGSERVICE||env.PGOPTIONS||env.DATABASE_URL||
    env.NEON_DATABASE_URL||env.MEGA_PRODUCTION_DATABASE_URL) {
   refuse('ambient credential or endpoint override prohibited');
 }
 if(value.kind==='nonserving-staging-source') {
  if(!stage.nonserving||stage.outbound.email!=='disabled'||
    stage.outbound.storeNotifications!=='disabled'||stage.outbound.adRewards!=='disabled'){
   refuse('nonserving staging configuration is no longer isolated');
  }
  checkFile(env.P15_PGPASSFILE,{secret:true});
 }
 return Object.freeze({...value});
}
function buildPgEnv(target,env=process.env){
 const pg={PATH:env.PATH||'/usr/bin:/bin',HOME:env.HOME||'/',
  LANG:'C',LC_ALL:'C',
  PGHOST:target.host,PGPORT:String(target.port),PGDATABASE:target.database,
  PGUSER:target.user,PGSSLMODE:target.sslMode,PGCONNECT_TIMEOUT:'10',
  PGAPPNAME:'mega-v5-p15-backup-restore'};
 if(target.environment==='staging')pg.PGPASSFILE=env.P15_PGPASSFILE;
 return pg;
}
function fingerprint(target){
 const fields={kind:target.kind,environment:target.environment,
  projectId:target.projectId,host:target.host,port:target.port,
  database:target.database,user:target.user,sourceSha:target.sourceSha};
 return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
function readTarget(filename,operation,env=process.env){
 checkFile(filename);
 const stat=fs.statSync(filename);
 if(stat.size>4096)refuse('target JSON is too large');
 let parsed;try{parsed=JSON.parse(fs.readFileSync(filename,'utf8'));}catch{refuse('target JSON invalid');}
 return assertTarget(parsed,operation,env);
}
module.exports={assertTarget,buildPgEnv,fingerprint,privateDirectory,checkFile,readTarget};
