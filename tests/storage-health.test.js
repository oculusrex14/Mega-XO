'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {storageSnapshot}=require('../server/production/storage-health');
test('storage telemetry reports database aggregate and growth warnings without mutating state',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-storage-')),file=path.join(dir,'db.sqlite');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const db=new DatabaseSync(file);t.after(()=>db.close());db.exec("PRAGMA journal_mode=WAL; CREATE TABLE state(id INTEGER PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE commands(id TEXT PRIMARY KEY); INSERT INTO state VALUES(1,'"+'x'.repeat(4096)+"');");
 const before=db.prepare('SELECT json FROM state WHERE id=1').get().json;
 const out=storageSnapshot(db,file,{dbWarnBytes:1,walWarnBytes:1,stateWarnBytes:1});
 assert(out.dbBytes>0);assert(out.stateBytes>=4096);assert(out.pageSize>0);assert(out.pageCount>0);assert(out.warnings.includes('database_size'));assert(out.warnings.includes('aggregate_state_size'));
 assert.equal(db.prepare('SELECT json FROM state WHERE id=1').get().json,before);
});
