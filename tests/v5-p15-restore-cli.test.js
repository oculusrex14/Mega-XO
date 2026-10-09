'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {requireRestore,restoreArgs,readPrivateKey}=require('../scripts/v5/p15/restore-cli.js');
const SOURCE='a'.repeat(40);
const env=()=>({
 P15_SOURCE_SHA:SOURCE,V5_P15_DISPOSABLE:'1',
 V5_P15_QUARANTINE:'1',P15_RESTORE_JOBS_DISABLED:'1',
 P15_RESTORE_PROVIDER_CALLBACKS_DISABLED:'1'
});
const target=()=>({
 format:'mega-v5-p15-direct-pg-target/v1',kind:'disposable-restore',
 environment:'test',sourceSha:SOURCE,sourceId:'p15-owned-restore-fixture',
 projectId:'disposable-restore-pg16',host:'127.0.0.1',
 port:5433,database:'v5_p15_restore_fixture01',
 user:'postgres',sslMode:'disable',pgMajor:16
});
const manifest=()=>({sourceSha:SOURCE,sourceKind:'disposable-source',
 sourceEnvironment:'test',backupRunClass:'REAL_DIRECT_PG16_DUMP'});
test('pg_restore writes only to a separate quarantined DB in one transaction, without clean/create',()=>{
 const t=requireRestore(target(),manifest(),env());
 assert.equal(t.port,5433);
 const args=restoreArgs(t.database);
 assert.ok(args.includes('--single-transaction'));
 assert.ok(args.includes('--exit-on-error'));
 assert.ok(args.includes('--no-owner'));
 assert.ok(args.includes('--no-acl'));
 assert.ok(args.includes('--dbname='+t.database));
 for(const disallowed of ['--clean','--create','--disable-triggers']) {
  assert.ok(!args.includes(disallowed));
 }
});
test('wrong source, successful-looking mock or active provider jobs cannot activate a restore',()=>{
 for(const attack of [
  (t,m,e)=>{t.port=5432;},
  (t,m,e)=>{t.projectId='disposable-source-pg16';},
  (t,m,e)=>{t.database='mega_xo_production';},
  (t,m,e)=>{m.sourceSha='b'.repeat(40);},
  (t,m,e)=>{m.backupRunClass='UNIT_STUB_NOT_DB_PROOF';},
  (t,m,e)=>{m.sourceEnvironment='production';},
  (t,m,e)=>{e.P15_RESTORE_JOBS_DISABLED='0';},
  (t,m,e)=>{e.P15_RESTORE_PROVIDER_CALLBACKS_DISABLED='0';},
  (t,m,e)=>{e.P15_SOURCE_SHA='b'.repeat(40);}
 ]){
  const t=target(),m=manifest(),e=env();attack(t,m,e);
  assert.throws(()=>requireRestore(t,m,e),/P15_RESTORE_REFUSED|P15_TARGET_REFUSED/);
 }
 for(const name of ['production','public','v5_test_p15_source_in_same_database','v5_p15_restore_../../']){
  assert.throws(()=>restoreArgs(name),/P15_RESTORE_REFUSED/);
 }
});
test('private recovery material must stay in 0600 file, never accept a symlink or public mode',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mx-p15-keymode-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const f=path.join(dir,'identity.pem');
 fs.writeFileSync(f,'-----BEGIN PRIVATE KEY-----\n'+('x'.repeat(2000))+'\n-----END PRIVATE KEY-----\n',{mode:0o600});
 assert.ok(readPrivateKey(f).includes('PRIVATE KEY'));
 fs.chmodSync(f,0o644);
 assert.throws(()=>readPrivateKey(f),/P15_TARGET_REFUSED/);
 const alias=path.join(dir,'link.pem');
 fs.symlinkSync(f,alias);
 assert.throws(()=>readPrivateKey(alias),/P15_TARGET_REFUSED/);
});
