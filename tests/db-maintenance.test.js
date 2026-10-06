'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {main}=require('../scripts/db-maintenance');

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-db-maint-')),file=path.join(dir,'db.sqlite'),db=new DatabaseSync(file);
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 db.exec('PRAGMA journal_mode=WAL');
 db.exec('CREATE TABLE v4_controls(id INTEGER PRIMARY KEY,maintenance INTEGER NOT NULL)');
 db.exec('INSERT INTO v4_controls VALUES(1,0)');
 db.exec('CREATE TABLE state(id INTEGER PRIMARY KEY,json TEXT NOT NULL)');
 db.prepare('INSERT INTO state VALUES(1,?)').run(JSON.stringify({matches:[]}));
 db.exec('CREATE TABLE commands(id TEXT PRIMARY KEY)');
 db.close();return file;
}

test('database integrity check is read-only and reports storage',async t=>{
 const file=fixture(t),out=await main(['check'],{MEGA_DB:file});
 assert.equal(out.ok,true);assert.equal(out.quickCheck,'ok');assert(out.storage.dbBytes>0);
});

test('checkpoint and optimize require maintenance plus explicit confirmation',async t=>{
 const file=fixture(t);
 await assert.rejects(main(['checkpoint','--confirm-maintenance'],{MEGA_DB:file}),/MAINTENANCE_REQUIRED/);
 const db=new DatabaseSync(file);db.exec('UPDATE v4_controls SET maintenance=1 WHERE id=1');db.close();
 await assert.rejects(main(['checkpoint'],{MEGA_DB:file}),/CONFIRM_MAINTENANCE_REQUIRED/);
 const checkpoint=await main(['checkpoint','--confirm-maintenance'],{MEGA_DB:file});assert.equal(checkpoint.ok,true);
 const optimize=await main(['optimize','--confirm-maintenance'],{MEGA_DB:file});assert.equal(optimize.ok,true);
});
