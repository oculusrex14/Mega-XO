'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DurableStore}=require('../server/economy-store');
const {CommunityStore}=require('../server/community-store');

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-email-auth-'));let now=Date.parse('2026-10-06T06:00:00Z');
 const store=new DurableStore(path.join(dir,'db.sqlite'),{now:()=>now}),community=new CommunityStore({store,origin:'https://mega.example',now:()=>now});
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {store,community,advance:ms=>now+=ms};
}
function googleLogin(c,subject='google-user'){
 const boot=c.bootstrap(),start=c.start(boot.token,'google','login','native'),attempt=c.consume(boot.token,start.state,'google','native');
 return c.finishVerified(boot.token,attempt,{provider:'google',subject});
}

test('email signup normalizes address, hashes password and creates a linked profile',t=>{
 const {store,community}=fixture(t),boot=community.bootstrap(),created=community.emailSignup(boot.token,'  Alice@example.COM ','correct-horse-42');
 assert.equal(created.created,true);assert.equal(created.profile.email,'alice@example.com');assert.deepEqual(created.profile.providers,['email']);
 assert.equal(community.session(boot.token),null);assert.equal(community.session(created.token).actor,created.actor);
 const row=store.db.prepare('SELECT * FROM email_credentials WHERE actor=?').get(created.actor);
 assert.equal(row.email,'alice@example.com');assert.notEqual(row.password_hash,'correct-horse-42');assert.notEqual(row.salt,'correct-horse-42');
 assert.equal(store.read().account(created.actor).verified,true);
});

test('email signup rejects malformed addresses, weak passwords and duplicate normalized emails',t=>{
 const {community}=fixture(t);
 assert.throws(()=>community.emailSignup(community.bootstrap().token,'not-an-email','correct-horse-42'),/INVALID_EMAIL/);
 assert.throws(()=>community.emailSignup(community.bootstrap().token,'user@example.com','short1'),/PASSWORD_WEAK/);
 community.emailSignup(community.bootstrap().token,'user@example.com','correct-horse-42');
 assert.throws(()=>community.emailSignup(community.bootstrap().token,'USER@EXAMPLE.COM','another-password-7'),/EMAIL_IN_USE/);
});

test('email signin restores the same profile and wrong credentials fail generically',t=>{
 const {community}=fixture(t),created=community.emailSignup(community.bootstrap().token,'alice@example.com','correct-horse-42');
 community.edit(created.actor,{username:'alice',displayName:'Alice'});
 const recovered=community.emailSignin(community.bootstrap().token,'ALICE@example.com','correct-horse-42');
 assert.equal(recovered.actor,created.actor);assert.equal(recovered.profile.username,'alice');assert.equal(recovered.profile.tag,created.profile.tag);
 assert.throws(()=>community.emailSignin(community.bootstrap().token,'alice@example.com','wrong-password-9'),/INVALID_CREDENTIALS/);
 assert.throws(()=>community.emailSignin(community.bootstrap().token,'missing@example.com','wrong-password-9'),/INVALID_CREDENTIALS/);
});

test('single email continue creates a missing profile and signs into an existing one',t=>{
 const {store,community}=fixture(t);
 const first=community.emailContinue(community.bootstrap().token,' Player@Example.com ','correct-horse-42');
 assert.equal(first.created,true);assert.equal(first.profile.email,'player@example.com');const count=store.read().accounts.size;
 community.edit(first.actor,{username:'player_one',displayName:'Player One'});
 const second=community.emailContinue(community.bootstrap().token,'PLAYER@example.com','correct-horse-42');
 assert.equal(second.created,false);assert.equal(second.actor,first.actor);assert.equal(second.profile.username,'player_one');assert.equal(store.read().accounts.size,count);
 assert.throws(()=>community.emailContinue(community.bootstrap().token,'player@example.com','wrong-password-9'),/INVALID_CREDENTIALS/);
 assert.equal(store.read().accounts.size,count);
});

test('email can be linked to an existing provider account and counts as a recovery method',t=>{
 const {community}=fixture(t),google=googleLogin(community);
 const linked=community.emailLink(google.token,'linked@example.com','another-password-7');
 assert.deepEqual(linked.providers,['email','google']);assert.equal(linked.email,'linked@example.com');
 const recovered=community.emailSignin(community.bootstrap().token,'linked@example.com','another-password-7');
 assert.equal(recovered.actor,google.actor);
 community.unlink(recovered.token,'email');assert.deepEqual(community.identities(google.actor).map(x=>x.provider),['google']);
 assert.equal(community.emailAddress(google.actor),null);
});

test('email reauthentication refreshes sensitive-link permission without exposing password data',t=>{
 const {community,advance}=fixture(t),created=community.emailSignup(community.bootstrap().token,'reauth@example.com','another-password-7');
 advance(16*60000);assert.throws(()=>community.emailLink(created.token,'second@example.com','another-password-8'),/REAUTH_REQUIRED/);
 assert.throws(()=>community.emailReauth(created.token,'reauth@example.com','wrong-password-9'),/INVALID_CREDENTIALS/);
 const p=community.emailReauth(created.token,'reauth@example.com','another-password-7');assert.equal(p.id,created.actor);
 const start=community.start(created.token,'google','link','native');assert.equal(start.target,created.actor);
});
