'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {assertTarget,readTarget}=require('../scripts/v5/p15/direct-target.js');
const stage=require('../docs/v5/environments/staging.json');
const production=require('../docs/v5/environments/production.json');
const SHA='a'.repeat(40);
function passfile(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mx-p15-prod-pass-'));
 t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
 const file=path.join(dir,'pgpass');
 fs.writeFileSync(file,production.host+':5432:'+production.database+':backup_reader:secret\n',
  {mode:0o600});
 return file;
}
const productionSource=()=>({format:'mega-v5-p15-direct-pg-target/v1',
 kind:'nonserving-production-source',environment:'production',sourceSha:SHA,
 sourceId:'p15-production-source-owned',projectId:production.projectId,
 host:production.host,port:5432,database:production.database,
 user:'backup_reader',sslMode:'verify-full',pgMajor:16});
const nonproductionRestore=()=>({format:'mega-v5-p15-direct-pg-target/v1',
 kind:'nonproduction-restore',environment:'test',sourceSha:SHA,
 sourceId:'p15-nonproduction-restore-owned',projectId:'disposable-restore-pg16',
 host:'127.0.0.1',port:5432,database:'v5_p15_restore_fixture01',
 user:'postgres',sslMode:'disable',pgMajor:16});
const prodEnv=(file)=>({P15_PGPASSFILE:file,
 P15_OWNER_APPROVE_PRODUCTION_BACKUP:'1',P15_OWNER_CONFIRMS_PRODUCTION:'1',
 PATH:'/usr/bin:/bin',HOME:'/'});
const restoreEnv=()=>({V5_P15_DISPOSABLE:'1',V5_P15_QUARANTINE:'1',PATH:'/usr/bin:/bin'});
const disposableSource=()=>({format:'mega-v5-p15-direct-pg-target/v1',
 kind:'disposable-source',environment:'test',sourceSha:SHA,
 sourceId:'p15-source-local-test',projectId:'disposable-source-pg16',
 host:'127.0.0.1',port:5432,database:'v5_test_p15_source_fixture01',
 user:'postgres',sslMode:'disable',pgMajor:16});
const disposableRestore=()=>({...disposableSource(),kind:'disposable-restore',
 sourceId:'p15-recovery-local-test',projectId:'disposable-restore-pg16',
 port:5433,database:'v5_p15_restore_fixture01'});
const stagingSource=()=>({...disposableSource(),kind:'nonserving-staging-source',
 environment:'staging',projectId:stage.projectId,host:stage.host,port:5432,
 database:stage.database,user:'backup_reader',sslMode:'verify-full'});

test('production source is refused without both explicit owner gates',t=>{
 const file=passfile(t);
 const base=prodEnv(file);
 assert.throws(()=>assertTarget(productionSource(),'backup',{
  ...base,P15_OWNER_APPROVE_PRODUCTION_BACKUP:undefined,
  P15_OWNER_CONFIRMS_PRODUCTION:undefined}),/P15_TARGET_REFUSED/);
 assert.throws(()=>assertTarget(productionSource(),'backup',{
  ...base,P15_OWNER_APPROVE_PRODUCTION_BACKUP:undefined}),/P15_TARGET_REFUSED/);
 assert.throws(()=>assertTarget(productionSource(),'backup',{
  ...base,P15_OWNER_CONFIRMS_PRODUCTION:undefined}),/P15_TARGET_REFUSED/);
 assert.throws(()=>assertTarget(productionSource(),'backup',{
  ...base,P15_OWNER_APPROVE_PRODUCTION_BACKUP:'0'}),/P15_TARGET_REFUSED/);
});

test('production source requires an exact checked-in production binding',t=>{
 const file=passfile(t);
 const env=prodEnv(file);
 for(const mutate of [
  x=>{x.host='ep-other-endpoint.c-14.us-east-1.aws.neon.tech';},
  x=>{x.host=production.host.replace('.c-14','-pooler.c-14');},
  x=>{x.database='mega_xo_v5_staging';},
  x=>{x.user='core_runtime';},
  x=>{x.user='postgres';},
  x=>{x.port=5433;},
  x=>{x.sslMode='disable';},
  x=>{x.sslMode='require';},
  x=>{x.projectId='lively-shadow-52629967';},
  x=>{x.environment='staging';}
 ]){
  const target=productionSource();mutate(target);
  assert.throws(()=>assertTarget(target,'backup',env),/P15_TARGET_REFUSED/,
   'production binding must be exact');
 }
});

test('production source accepted with both gates and exact match, and frozen',t=>{
 const file=passfile(t);
 const checked=assertTarget(productionSource(),'backup',prodEnv(file));
 assert.equal(checked.kind,'nonserving-production-source');
 assert.equal(checked.host,production.host);
 assert.equal(checked.database,production.database);
 assert.equal(checked.user,'backup_reader');
 assert.equal(checked.sslMode,'verify-full');
 assert.ok(Object.isFrozen(checked));
 assert.throws(()=>{checked.host='evil';},TypeError);
});

test('ambient credential or endpoint overrides still refuse the production kind',t=>{
 const file=passfile(t);
 for(const override of [
  {PGPASSWORD:'inline-secret'},
  {DATABASE_URL:'postgres://production'},
  {NEON_DATABASE_URL:'postgres://neon-production'},
  {MEGA_PRODUCTION_DATABASE_URL:'postgres://mega-production'},
  {PGHOSTADDR:'127.0.0.1'},{PGSERVICE:'prod'},{PGOPTIONS:'-c x=y'}
 ]){
  assert.throws(()=>assertTarget(productionSource(),'backup',
   {...prodEnv(file),...override}),/P15_TARGET_REFUSED/);
 }
});

test('production source requires an absolute mode-0600 regular P15_PGPASSFILE',t=>{
 const file=passfile(t);
 assert.throws(()=>assertTarget(productionSource(),'backup',
  {...prodEnv(file),P15_PGPASSFILE:undefined}),/P15_TARGET_REFUSED/);
 assert.throws(()=>assertTarget(productionSource(),'backup',
  {...prodEnv(file),P15_PGPASSFILE:'relative/pgpass'}),/P15_TARGET_REFUSED/);
 const world=path.join(path.dirname(file),'world');
 fs.writeFileSync(world,'secret\n',{mode:0o644});
 assert.throws(()=>assertTarget(productionSource(),'backup',
  {...prodEnv(file),P15_PGPASSFILE:world}),/P15_TARGET_REFUSED/);
 assert.throws(()=>assertTarget(productionSource(),'backup',
  {...prodEnv(file),P15_PGPASSFILE:path.join(path.dirname(file),'absent')}));
});

test('nonproduction restore accepts an exact loopback target and refuses drift',()=>{
 const checked=assertTarget(nonproductionRestore(),'restore',restoreEnv());
 assert.equal(checked.kind,'nonproduction-restore');
 assert.equal(checked.host,'127.0.0.1');
 assert.ok(Object.isFrozen(checked));
 for(const mutate of [
  x=>{x.host='localhost';},
  x=>{x.host='10.0.0.7';},
  x=>{x.database='postgres';},
  x=>{x.database='v5_p15_restore_ab';},
  x=>{x.database='v5_test_p15_source_fixture01';},
  x=>{x.user='backup_reader';},
  x=>{x.port=5433;},
  x=>{x.projectId='disposable-source-pg16';},
  x=>{x.environment='production';}
 ]){
  const target=nonproductionRestore();mutate(target);
  assert.throws(()=>assertTarget(target,'restore',restoreEnv()),/P15_TARGET_REFUSED/);
 }
 assert.throws(()=>assertTarget(nonproductionRestore(),'restore',{
  ...restoreEnv(),V5_P15_DISPOSABLE:undefined}),/P15_TARGET_REFUSED/);
 assert.throws(()=>assertTarget(nonproductionRestore(),'restore',{
  ...restoreEnv(),V5_P15_QUARANTINE:undefined}),/P15_TARGET_REFUSED/);
 assert.throws(()=>assertTarget(nonproductionRestore(),'backup',restoreEnv()),
  /P15_TARGET_REFUSED/);
});

test('backup CLI demands the distinct production confirmation flag',async t=>{
 const {run}=require('../scripts/v5/p15/backup-cli.js');
 const file=passfile(t);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mx-p15-prod-cli-'));
 t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
 const targetFile=path.join(dir,'target.json');
 fs.writeFileSync(targetFile,JSON.stringify(productionSource()),{mode:0o600});
 const env=prodEnv(file);
 const argv=(confirm)=>['--source',targetFile,'--recipient',path.join(dir,'r.pem'),
  '--out',dir,confirm];
 await assert.rejects(()=>run(argv('--confirm-owned-backup'),env),
  /production requires distinct owner confirmation/);
 await assert.rejects(()=>run(argv('--confirm-nonserving-staging-backup'),env),
  /production requires distinct owner confirmation/);
 // The production flag must pass the usage gate and then fail only on the
 // target contract itself (here: an operation mismatch), never on usage.
 const wrongKind=path.join(dir,'restore-target.json');
 fs.writeFileSync(wrongKind,JSON.stringify(nonproductionRestore()),{mode:0o600});
 await assert.rejects(()=>run(['--source',wrongKind,'--recipient',path.join(dir,'r.pem'),
  '--out',dir,'--confirm-nonserving-production-backup'],env),/P15_TARGET_REFUSED/);
 await assert.rejects(()=>run(argv('--confirm-anything-else'),env),/P15_BACKUP_REFUSED: usage/);
});

test('pre-existing target kinds keep their exact accept/refuse behaviour',t=>{
 const file=passfile(t);
 assert.equal(assertTarget(disposableSource(),'backup',
  {V5_P15_DISPOSABLE:'1',V5_PG_DISPOSABLE:'1',PATH:'/usr/bin:/bin'}).kind,
  'disposable-source');
 assert.throws(()=>assertTarget(disposableSource(),'backup',
  {V5_P15_DISPOSABLE:'1',PATH:'/usr/bin:/bin'}),/P15_TARGET_REFUSED/);
 assert.equal(assertTarget(disposableRestore(),'restore',restoreEnv()).kind,
  'disposable-restore');
 assert.throws(()=>assertTarget({...disposableRestore(),port:5432},'restore',
  restoreEnv()),/P15_TARGET_REFUSED/);
 const stagingEnv={P15_PGPASSFILE:file,
  P15_OWNER_APPROVE_NONPRODUCTION_BACKUP:'1',
  P15_OWNER_CONFIRMS_NONPRODUCTION:'1',PATH:'/usr/bin:/bin'};
 assert.equal(assertTarget(stagingSource(),'backup',stagingEnv).kind,
  'nonserving-staging-source');
 assert.throws(()=>assertTarget(stagingSource(),'backup',{
  ...stagingEnv,P15_OWNER_CONFIRMS_NONPRODUCTION:undefined}),
  /P15_TARGET_REFUSED/);
 assert.throws(()=>assertTarget({...stagingSource(),kind:'production'},'backup',
  stagingEnv),/P15_TARGET_REFUSED/);
 // readTarget accepts exactly the same production target from a private file.
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mx-p15-prod-target-'));
 t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
 const targetFile=path.join(dir,'target.json');
 fs.writeFileSync(targetFile,JSON.stringify(productionSource()),{mode:0o600});
 assert.equal(readTarget(targetFile,'backup',prodEnv(file)).kind,
  'nonserving-production-source');
});
