'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DurableStore}=require('../server/economy-store');
const {CommunityStore}=require('../server/community-store');
const {migrate}=require('../server/production/migrations');
const {Passwords}=require('../server/production/passwords');
const {MailOutbox}=require('../server/production/mail-outbox');
const {EmailAuth}=require('../server/production/email-auth');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-v4-auth-'));let now=Date.parse('2026-10-06T09:00:00Z');
 const store=new DurableStore(path.join(dir,'db'),{now:()=>now}),c=new CommunityStore({store,origin:'https://game.test',now:()=>now});migrate(store.db);
 const secret='a'.repeat(64),sent=[],passwords=new Passwords({concurrency:1});
 const transport={enabled:()=>true,sendOtp:async m=>{sent.push({...m,kind:'otp'});},sendPasswordChanged:async m=>{sent.push({...m,kind:'changed'});},sendSecurityNotice:async m=>{sent.push({...m,kind:'security'});}};
 const outbox=new MailOutbox(c,{secret,transport,now:()=>now}),auth=new EmailAuth(c,{secret,passwords,outbox,now:()=>now});
 t.after(()=>{outbox.close();passwords.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const pendingCode=id=>outbox.open(store.db.prepare('SELECT payload FROM v4_outbox WHERE id=?').get(id).payload).code;
 async function create(address='player@example.com') {const guest=c.bootstrap(),p=await auth.continue(guest.token,address,'correct-horse-42');const a=auth.verify(guest.token,p.challengeId,pendingCode(p.challengeId));return a;}
 return {store,c,passwords,outbox,auth,transport,sent,secret,pendingCode,create,advance:ms=>now+=ms,now:()=>now};
}
test('production scrypt is asynchronous, bounded and accepts legacy hashes',async()=>{
 const p=new Passwords({concurrency:1,maxQueue:1}),salt=crypto.randomBytes(16).toString('base64url');
 const old=crypto.scryptSync('correct-horse-42',Buffer.from(salt,'base64url'),32,{N:16384,r:8,p:1}).toString('base64url');
 assert(await p.verify('correct-horse-42',salt,old));
 let ticked=false;const promise=p.hash('correct-horse-42');setImmediate(()=>{ticked=true;});const hashed=await promise;
 assert(ticked,'hashing must yield to game requests');assert(hashed.password_hash.startsWith('scrypt-v1$'));
 assert(await p.verify('correct-horse-42',hashed.salt,hashed.password_hash));assert.equal(await p.verify('wrong-password-42',hashed.salt,hashed.password_hash),false);
 let unlock;const first=p.run(()=>new Promise(r=>unlock=r)),second=p.run(async()=>2);
 await assert.rejects(p.run(async()=>3),/AUTH_BUSY/);unlock(1);assert.equal(await first,1);assert.equal(await second,2);p.close();
});
test('production OTP failures persist and are bound to one browser session',async t=>{
 const f=fixture(t),a=f.c.bootstrap(),b=f.c.bootstrap(),p=await f.auth.continue(a.token,'test@example.com','correct-horse-42');
 const code=f.pendingCode(p.challengeId),wrong=code==='000000'?'111111':'000000';
 assert.throws(()=>f.auth.verify(b.token,p.challengeId,code),/INVALID_OTP/);
 for(let i=0;i<5;i++)assert.throws(()=>f.auth.verify(a.token,p.challengeId,wrong),/INVALID_OTP/);
 assert.equal(f.store.db.prepare('SELECT attempts FROM email_challenges WHERE id=?').get(p.challengeId).attempts,5);
 assert.throws(()=>f.auth.verify(a.token,p.challengeId,code),/OTP_LOCKED/);assert.equal(f.store.read().accounts.size,0);
});
test('two verified reset challenges cannot replay after a password change',async t=>{
 const f=fixture(t),account=await f.create(),a=f.c.bootstrap(),b=f.c.bootstrap();
 const first=f.auth.forgot(a.token,'player@example.com');f.auth.verify(a.token,first.challengeId,f.pendingCode(first.challengeId));
 f.advance(61000);const second=f.auth.forgot(b.token,'player@example.com');f.auth.verify(b.token,second.challengeId,f.pendingCode(second.challengeId));
 const reset=await f.auth.reset(a.token,first.challengeId,'new-password-safe-42');assert.equal(reset.actor,account.actor);assert.equal(f.c.session(account.token),null);
 await assert.rejects(f.auth.reset(b.token,second.challengeId,'attacker-new-pass-42'),/RESET_NOT_AUTHORIZED/);
 const recovered=await f.auth.continue(f.c.bootstrap().token,'player@example.com','new-password-safe-42');assert.equal(recovered.actor,account.actor);
});
test('forgot-password hides account existence even when the shared mail budget is full',async t=>{
 const f=fixture(t);await f.create();const a=f.c.bootstrap(),b=f.c.bootstrap();
 const known=f.auth.forgot(a.token,'player@example.com'),unknown=f.auth.forgot(b.token,'unknown@example.com');
 assert.deepEqual(Object.keys(known).sort(),Object.keys(unknown).sort());assert.equal(known.message,unknown.message);
 assert(!f.store.db.prepare('SELECT id FROM v4_outbox WHERE id=?').get(unknown.challengeId));
 f.outbox.daily=1;
 assert.throws(()=>f.auth.forgot(f.c.bootstrap().token,'player@example.com'),/EMAIL_BUDGET_EXCEEDED/);
 assert.throws(()=>f.auth.forgot(f.c.bootstrap().token,'other@example.com'),/EMAIL_BUDGET_EXCEEDED/);
});
test('encrypted outbox retries after restart with a stable provider idempotency key',async t=>{
 const f=fixture(t),guest=f.c.bootstrap(),p=await f.auth.continue(guest.token,'retry@example.com','correct-horse-42'),keys=[];
 f.transport.sendOtp=async message=>{keys.push(message.idempotencyKey);throw Error('provider detail must stay private');};
 await f.outbox.tick();assert.equal(f.store.db.prepare('SELECT attempts FROM v4_outbox WHERE id=?').get(p.challengeId).attempts,1);
 f.advance(16000);const recovered=new MailOutbox(f.c,{secret:f.secret,now:f.now,transport:{enabled:()=>true,sendOtp:async m=>keys.push(m.idempotencyKey)}});
 await recovered.tick();const row=f.store.db.prepare('SELECT * FROM v4_outbox WHERE id=?').get(p.challengeId);
 assert.equal(row.state,'sent');assert.equal(row.payload,null);assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);recovered.close();
});
test('resending cancels queued superseded mail and never permits an old code',async t=>{
 const f=fixture(t),g=f.c.bootstrap(),old=await f.auth.continue(g.token,'resend@example.com','correct-horse-42'),code=f.pendingCode(old.challengeId);
 f.advance(61000);const fresh=await f.auth.continue(g.token,'resend@example.com','correct-horse-42');
 assert.equal(f.store.db.prepare('SELECT state FROM v4_outbox WHERE id=?').get(old.challengeId).state,'cancelled');
 assert.throws(()=>f.auth.verify(g.token,old.challengeId,code),/INVALID_OTP/);
 const account=f.auth.verify(g.token,fresh.challengeId,f.pendingCode(fresh.challengeId));assert(account.actor);
});

test('verified email change preserves actor, rejects collisions and revokes other sessions',async t=>{
 const f=fixture(t),account=await f.create('old@example.com');
 await f.auth.reauth(account.token,'old@example.com','correct-horse-42');
 const second=await f.auth.continue(f.c.bootstrap().token,'old@example.com','correct-horse-42');
 assert.equal(second.actor,account.actor);
 const pending=await f.auth.change(account.token,'new@example.com');
 const changed=f.auth.verify(account.token,pending.challengeId,f.pendingCode(pending.challengeId));
 assert.equal(changed.emailChanged,true);assert.equal(changed.profile.id,account.actor);assert.equal(changed.profile.email,'new@example.com');
 assert.equal(f.c.session(second.token),null);
 await assert.rejects(f.auth.continue(f.c.bootstrap().token,'old@example.com','correct-horse-42'),/INVALID_CREDENTIALS|EMAIL/);
 const restored=await f.auth.continue(f.c.bootstrap().token,'new@example.com','correct-horse-42');assert.equal(restored.actor,account.actor);
 await f.outbox.tick();await f.outbox.tick();
 assert.equal(f.sent.filter(x=>x.kind==='security').length,2);
});
test('email change requires recent reauthentication and cannot take another profile email',async t=>{
 const f=fixture(t),a=await f.create('one@example.com');
 f.advance(61000);const b=await f.create('two@example.com');
 assert.throws(()=>f.auth.change(a.token,'fresh@example.com'),/REAUTH_REQUIRED/);
 await f.auth.reauth(a.token,'one@example.com','correct-horse-42');
 assert.throws(()=>f.auth.change(a.token,'two@example.com'),/EMAIL_IN_USE/);
 const pending=await f.auth.change(a.token,'fresh@example.com');f.advance(16*60000);
 assert.throws(()=>f.auth.verify(a.token,pending.challengeId,f.pendingCode(pending.challengeId)),/REAUTH_REQUIRED/);
 assert.equal(f.c.emailAddress(a.actor),'one@example.com');assert.equal(f.c.emailAddress(b.actor),'two@example.com');
});
test('session list exposes opaque ids and can revoke one or every other session',async t=>{
 const f=fixture(t),a=await f.create('sessions@example.com'),b=await f.auth.continue(f.c.bootstrap().token,'sessions@example.com','correct-horse-42'),c=await f.auth.continue(f.c.bootstrap().token,'sessions@example.com','correct-horse-42');
 let rows=f.c.sessions(a.token);assert.equal(rows.length,3);assert.equal(rows.filter(x=>x.current).length,1);assert(rows.every(x=>/^[a-f0-9]{24}$/.test(x.id)));
 const target=rows.find(x=>!x.current);f.c.revokeSession(a.token,target.id);assert.equal(f.c.session(b.token)===null||f.c.session(c.token)===null,true);
 rows=f.c.sessions(a.token);assert.equal(rows.length,2);assert.throws(()=>f.c.revokeSession(a.token,rows.find(x=>x.current).id),/CURRENT_SESSION/);
 const all=f.c.revokeOtherSessions(a.token);assert.equal(all.revoked,1);assert.equal(f.c.sessions(a.token).length,1);assert(f.c.session(a.token));
});
