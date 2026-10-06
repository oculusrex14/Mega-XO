'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DurableStore}=require('../server/economy-store');
const {CommunityStore}=require('../server/community-store');

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-email-auth-'));let now=Date.parse('2026-10-06T06:00:00Z');
 const store=new DurableStore(path.join(dir,'db.sqlite'),{now:()=>now}),community=new CommunityStore({store,origin:'https://mega.example',now:()=>now,otpSecret:'test-otp-secret'});
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {store,community,advance:ms=>now+=ms};
}
function googleLogin(c,subject='google-user'){
 const boot=c.bootstrap(),start=c.start(boot.token,'google','login','native'),attempt=c.consume(boot.token,start.state,'google','native');
 return c.finishVerified(boot.token,attempt,{provider:'google',subject});
}
function createEmail(c,email='alice@example.com',password='correct-horse-42'){
 const boot=c.bootstrap(),pending=c.emailContinue(boot.token,email,password);
 assert.equal(pending.verificationRequired,true);
 const verified=c.emailVerify(boot.token,pending.challengeId,pending.delivery.code);
 return {pending,verified};
}

test('new email account stays pending until the emailed OTP is verified',t=>{
 const {store,community}=fixture(t),boot=community.bootstrap(),pending=community.emailContinue(boot.token,' Alice@Example.COM ','correct-horse-42');
 assert.equal(pending.verificationRequired,true);assert.equal(pending.email,'a***@example.com');assert.equal(store.read().accounts.size,0);
 const challenge=store.db.prepare('SELECT * FROM email_challenges WHERE id=?').get(pending.challengeId);assert.notEqual(challenge.code_hash,pending.delivery.code);assert.equal(challenge.password_hash.includes('correct-horse-42'),false);
 assert.throws(()=>community.emailVerify(boot.token,pending.challengeId,'000000'),/INVALID_OTP/);assert.equal(store.read().accounts.size,0);
 const created=community.emailVerify(boot.token,pending.challengeId,pending.delivery.code);
 assert.equal(created.created,true);assert.equal(created.profile.email,'alice@example.com');assert.equal(created.profile.emailVerified,true);assert.deepEqual(created.profile.providers,['email']);
 const row=store.db.prepare('SELECT * FROM email_credentials WHERE actor=?').get(created.actor);assert.ok(row.verified_at);assert.notEqual(row.password_hash,'correct-horse-42');assert.equal(store.read().account(created.actor).verified,true);
});

test('single Continue with email signs into the verified account without creating a duplicate',t=>{
 const {store,community}=fixture(t),created=createEmail(community).verified;community.edit(created.actor,{username:'alice',displayName:'Alice'});const count=store.read().accounts.size;
 const recovered=community.emailContinue(community.bootstrap().token,'ALICE@example.com','correct-horse-42');
 assert.equal(recovered.verificationRequired,undefined);assert.equal(recovered.actor,created.actor);assert.equal(recovered.profile.username,'alice');assert.equal(recovered.profile.tag,created.profile.tag);assert.equal(store.read().accounts.size,count);
 assert.throws(()=>community.emailContinue(community.bootstrap().token,'alice@example.com','wrong-password-9'),/INVALID_CREDENTIALS/);assert.equal(store.read().accounts.size,count);
});

test('OTP challenges expire, throttle resends and lock after repeated bad codes',t=>{
 const {community,advance}=fixture(t),boot=community.bootstrap(),first=community.emailContinue(boot.token,'user@example.com','correct-horse-42');
 assert.throws(()=>community.emailContinue(boot.token,'user@example.com','correct-horse-42'),/OTP_COOLDOWN/);
 advance(60001);const second=community.emailContinue(boot.token,'user@example.com','correct-horse-42');for(let i=0;i<5;i++)assert.throws(()=>community.emailVerify(boot.token,second.challengeId,'999999'),/INVALID_OTP/);
 assert.throws(()=>community.emailVerify(boot.token,second.challengeId,second.delivery.code),/OTP_LOCKED/);
 advance(60001);const third=community.emailContinue(boot.token,'user@example.com','correct-horse-42');advance(10*60000+1);assert.throws(()=>community.emailVerify(boot.token,third.challengeId,third.delivery.code),/OTP_EXPIRED/);
});

test('legacy unverified email credential must prove mailbox ownership before signin',t=>{
 const {store,community}=fixture(t),created=createEmail(community).verified;store.db.prepare('UPDATE email_credentials SET verified_at=NULL WHERE actor=?').run(created.actor);
 const boot=community.bootstrap(),pending=community.emailContinue(boot.token,'alice@example.com','correct-horse-42');assert.equal(pending.verificationRequired,true);assert.equal(store.read().accounts.size,1);
 const restored=community.emailVerify(boot.token,pending.challengeId,pending.delivery.code);assert.equal(restored.actor,created.actor);assert.equal(restored.profile.emailVerified,true);
});

test('linking email to an existing provider profile requires OTP ownership proof',t=>{
 const {community}=fixture(t),google=googleLogin(community),pending=community.emailLinkStart(google.token,'linked@example.com','another-password-7');
 assert.equal(pending.verificationRequired,true);assert.equal(community.emailAddress(google.actor),null);
 const linked=community.emailVerify(google.token,pending.challengeId,pending.delivery.code);assert.equal(linked.linked,true);assert.deepEqual(linked.profile.providers,['email','google']);assert.equal(linked.profile.emailVerified,true);
 const recovered=community.emailContinue(community.bootstrap().token,'linked@example.com','another-password-7');assert.equal(recovered.actor,google.actor);
 community.unlink(recovered.token,'email');assert.deepEqual(community.identities(google.actor).map(x=>x.provider),['google']);assert.equal(community.emailAddress(google.actor),null);
});

test('forgot-password OTP resets the password, verifies email and revokes older sessions',t=>{
 const {community}=fixture(t),created=createEmail(community).verified,other=community.emailContinue(community.bootstrap().token,'alice@example.com','correct-horse-42');
 const guest=community.bootstrap(),pending=community.emailResetStart(guest.token,'alice@example.com');assert.equal(pending.verificationRequired,true);
 const ready=community.emailVerify(guest.token,pending.challengeId,pending.delivery.code);assert.equal(ready.resetReady,true);
 const reset=community.emailResetComplete(guest.token,pending.challengeId,'new-secure-password-9');assert.equal(reset.actor,created.actor);assert.equal(reset.passwordChangedEmail,'alice@example.com');assert.equal(community.session(other.token),null);
 assert.throws(()=>community.emailContinue(community.bootstrap().token,'alice@example.com','correct-horse-42'),/INVALID_CREDENTIALS/);
 assert.equal(community.emailContinue(community.bootstrap().token,'alice@example.com','new-secure-password-9').actor,created.actor);
});

test('forgot-password request does not reveal whether an account exists',t=>{
 const {community}=fixture(t);createEmail(community,'known@example.com','correct-horse-42');
 const knownSession=community.bootstrap(),missingSession=community.bootstrap(),known=community.emailResetStart(knownSession.token,'known@example.com'),missing=community.emailResetStart(missingSession.token,'missing@example.com');
 assert.equal(known.verificationRequired,true);assert.equal(missing.verificationRequired,true);assert.ok(known.delivery);assert.equal(missing.delivery,undefined);
 assert.throws(()=>community.emailVerify(missingSession.token,missing.challengeId,'000000'),/INVALID_OTP/);
});

test('email reauthentication requires a verified linked email',t=>{
 const {store,community,advance}=fixture(t),created=createEmail(community,'reauth@example.com','another-password-7').verified;advance(16*60000);
 assert.throws(()=>community.emailReauth(created.token,'reauth@example.com','wrong-password-9'),/INVALID_CREDENTIALS/);
 const p=community.emailReauth(created.token,'reauth@example.com','another-password-7');assert.equal(p.id,created.actor);
 store.db.prepare('UPDATE email_credentials SET verified_at=NULL WHERE actor=?').run(created.actor);assert.throws(()=>community.emailReauth(created.token,'reauth@example.com','another-password-7'),/INVALID_CREDENTIALS/);
});
