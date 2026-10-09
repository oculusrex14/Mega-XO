'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {assertTarget,buildPgEnv,fingerprint,privateDirectory}=require('../scripts/v5/p15/direct-target.js');
const sha='a'.repeat(40);
const source=()=>({format:'mega-v5-p15-direct-pg-target/v1',
 kind:'disposable-source',environment:'test',sourceSha:sha,
 sourceId:'p15-source-local-test',projectId:'disposable-source-pg16',
 host:'127.0.0.1',port:5432,database:'v5_test_p15_source_fixture01',
 user:'postgres',sslMode:'disable',pgMajor:16});
const restore=()=>({...source(),kind:'disposable-restore',
 sourceId:'p15-recovery-local-test',projectId:'disposable-restore-pg16',
 port:5433,database:'v5_p15_restore_fixture01'});
const env=()=>({V5_P15_DISPOSABLE:'1',V5_PG_DISPOSABLE:'1',
 V5_P15_QUARANTINE:'1',PATH:'/usr/bin:/bin'});
test('P15 source and target are separate local PG16 clusters with narrow roles',()=>{
 const a=assertTarget(source(),'backup',env());
 const b=assertTarget(restore(),'restore',env());
 assert.notEqual(fingerprint(a),fingerprint(b));
 assert.equal(buildPgEnv(b,env()).PGPORT,'5433');
 assert.equal(buildPgEnv(a,env()).PGSSLMODE,'disable');
 assert.deepEqual(Object.keys(buildPgEnv(a,env())).filter(x=>x.includes('PASSWORD')),[]);
});
test('backup and restore refuse arbitrary roles, pooled endpoint, production, shared host or missing quarantine',()=>{
 for(const attack of [
  x=>{x.kind='production';},x=>{x.port=5445;},
  x=>{x.database='mega_xo_production';},
  x=>{x.host='localhost';},x=>{x.host='my-project-pooler.neon.tech';},
  x=>{x.user='core_runtime';},x=>{x.pgMajor=17;},
  x=>{x.extra='PGPASSWORD=bad';},x=>{x.projectId='v4-backup';}
 ]){
  const obj=source();attack(obj);
  assert.throws(()=>assertTarget(obj,'backup',env()),/P15_TARGET_REFUSED/);
 }
 assert.throws(()=>assertTarget(restore(),'backup',env()),/P15_TARGET_REFUSED/);
 assert.throws(()=>assertTarget(source(),'restore',env()),/P15_TARGET_REFUSED/);
 assert.throws(()=>assertTarget(restore(),'restore',{...env(),V5_P15_QUARANTINE:'0'}),/P15_TARGET_REFUSED/);
 assert.throws(()=>assertTarget(source(),'backup',{...env(),DATABASE_URL:'postgres://prod'}),/P15_TARGET_REFUSED/);
 assert.throws(()=>assertTarget(source(),'backup',{...env(),PGPASSWORD:'secret'}),/P15_TARGET_REFUSED/);
});
test('output directory must preexist as private real directory (no symlink)',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mx-p15-mode-'));
 t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
 assert.equal(privateDirectory(dir),dir);
 fs.chmodSync(dir,0o755);
 assert.throws(()=>privateDirectory(dir),/P15_TARGET_REFUSED/);
 fs.chmodSync(dir,0o700);
 const link=dir+'-sym';
 fs.symlinkSync(dir,link);
 t.after(()=>fs.rmSync(link,{force:true}));
 assert.throws(()=>privateDirectory(link),/P15_TARGET_REFUSED/);
});
test('real staging backup remains unavailable until owner verifies isolation and credential file',()=>{
 const stage=require('../docs/v5/environments/staging.json');
 const config={...source(),kind:'nonserving-staging-source',
   environment:'staging',projectId:stage.projectId,host:stage.host,
   port:5432,database:stage.database,user:'backup_reader',sslMode:'verify-full'};
 assert.throws(()=>assertTarget(config,'backup',env()),/P15_TARGET_REFUSED/);
 assert.throws(()=>assertTarget(config,'backup',{
   ...env(),P15_OWNER_APPROVE_NONPRODUCTION_BACKUP:'1',
   P15_OWNER_CONFIRMS_NONPRODUCTION:'1'}),/P15_TARGET_REFUSED/);
});
