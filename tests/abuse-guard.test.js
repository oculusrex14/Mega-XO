'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {AbuseGuard}=require('../server/production/abuse-guard');

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-abuse-')),file=path.join(dir,'db.sqlite'),db=new DatabaseSync(file);let now=Date.parse('2026-10-06T12:00:00Z');
 db.exec('CREATE TABLE v4_limits(id TEXT PRIMARY KEY,hits INTEGER NOT NULL,expires INTEGER NOT NULL)');
 t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {db,guard:new AbuseGuard(db,{secret:'a'.repeat(64),now:()=>now,maxMemory:20}),advance:ms=>now+=ms};
}
test('abuse guard stores only keyed pseudonyms, not raw IP addresses',t=>{
 const f=fixture(t),ip='198.51.100.42';
 assert.equal(f.guard.persistent(ip,'email-forgot',1,3600),true);
 const row=f.db.prepare('SELECT id FROM v4_limits').get();
 assert.match(row.id,/^abuse:email-forgot:[a-f0-9]{32}:/);
 assert.equal(row.id.includes(ip),false);
});
test('sensitive auth limits persist across guard instances and reset by window',t=>{
 const f=fixture(t),ip='203.0.113.8';
 for(let i=0;i<12;i++)assert.equal(f.guard.sensitive(ip,'/api/account/email','POST',{action:'continue'}),true);
 assert.equal(f.guard.sensitive(ip,'/api/account/email','POST',{action:'continue'}),false);
 const recovered=new AbuseGuard(f.db,{secret:'a'.repeat(64),now:()=>Date.parse('2026-10-06T12:00:30Z')});
 assert.equal(recovered.sensitive(ip,'/api/account/email','POST',{action:'continue'}),false);
 f.advance(5*60000+1);
 const next=new AbuseGuard(f.db,{secret:'a'.repeat(64),now:()=>Date.parse('2026-10-06T12:05:01Z')});
 assert.equal(next.sensitive(ip,'/api/account/email','POST',{action:'continue'}),true);
});
test('coarse memory limits protect guest session creation without database writes',t=>{
 const f=fixture(t),ip='192.0.2.2';
 for(let i=0;i<60;i++)assert.equal(f.guard.coarse(ip,'/api/account/session','GET'),true);
 assert.equal(f.guard.coarse(ip,'/api/account/session','GET'),false);
 assert.equal(f.db.prepare('SELECT count(*) n FROM v4_limits').get().n,0);
});
test('email-change and password-recovery have stricter independent IP windows',t=>{
 const f=fixture(t),ip='192.0.2.3';
 for(let i=0;i<8;i++)assert(f.guard.sensitive(ip,'/api/account/email','POST',{action:'change'}));
 assert.equal(f.guard.sensitive(ip,'/api/account/email','POST',{action:'change'}),false);
 for(let i=0;i<12;i++)assert(f.guard.sensitive(ip,'/api/account/email','POST',{action:'forgot'}));
 assert.equal(f.guard.sensitive(ip,'/api/account/email','POST',{action:'forgot'}),false);
});
