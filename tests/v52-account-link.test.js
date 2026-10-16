'use strict';
/* V5.2 owner-decided account-link choice flow: a provider-verified email that matches exactly one
   existing profile persists a single-use, expiry-bounded, session-bound decision; 'link' and any
   deletion scheduling require ownership proof of the matched profile; 'new' without proof never
   touches the old profile; ambiguous matches refuse 'link' entirely. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DurableStore}=require('../server/economy-store');
const {CommunityStore}=require('../server/community-store');
const D=require('../src/domain');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-link-'));let now=Date.parse('2026-10-16T12:00Z');const store=new DurableStore(path.join(dir,'db.sqlite'),{now:()=>now}),c=new CommunityStore({store,origin:'https://mega.example',now:()=>now});t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {store,c,advance:ms=>now+=ms,now:()=>now};}
function attempt(c,token,provider='google',subject='new-sub',intent='login'){
 const started=c.start(token,provider,intent,'native');
 return {raw:started.state,consumed:c.consume(token,started.state,provider,'native')};
}
function emailProfile(c,email='morgan@example.com',password='password123'){
 const boot=c.bootstrap(),cont=c.emailContinue(boot.token,email,password);
 assert.equal(cont.verificationRequired,true);
 const out=c.emailVerify(boot.token,cont.challengeId,cont.delivery.code);
 assert.ok(out.actor);
 return {actor:out.actor,token:out.token};
}
test('verified-email match asks; link needs proof and succeeds with it',t=>{
 const {c}=fixture(t),old=emailProfile(c),anon=c.bootstrap();
 const a=attempt(c,anon.token),result=c.finishVerified(anon.token,a.consumed,{provider:'google',subject:'gs',email:'Morgan@Example.com'});
 assert.equal(result.choiceRequired,true);assert.equal(result.maskedEmail,'m***@example.com');
 assert.throws(()=>c.decide(anon.token,a.raw,'link'),/PROOF_REQUIRED/);
 assert.throws(()=>c.decide(anon.token,a.raw,'link',{email:'morgan@example.com',password:'wrong'}),/PROOF_REQUIRED/);
 const verified=c.decisionVerify(anon.token,a.raw,{email:'morgan@example.com',password:'password123'});
 assert.equal(verified.verified,true);assert.equal(verified.existing.tag,old.actor&&c.profileRow(old.actor).tag);
 const linked=c.decide(anon.token,a.raw,'link',{email:'morgan@example.com',password:'password123'});
 assert.equal(linked.actor,old.actor);
 assert.deepEqual(c.identities(old.actor).map(i=>i.provider),['email','google']);
 /* The link replaced the session, so the old bearer is dead; the decision row itself is terminal. */
 assert.throws(()=>c.decide(anon.token,a.raw,'link',{email:'morgan@example.com',password:'password123'}),/AUTH_REQUIRED/);
 assert.equal(c.db.prepare('SELECT decision_state FROM signin_attempts WHERE decision_subject=?').get('gs').decision_state,'complete');
 assert.throws(()=>c.decide(c.bootstrap().token,a.raw,'link',{email:'morgan@example.com',password:'password123'}),/INVALID_AUTH_STATE/);
});
test('new profile without proof leaves the old profile untouched',t=>{
 const {c}=fixture(t),old=emailProfile(c),anon=c.bootstrap();
 let a=attempt(c,anon.token,'google','fresh-1');
 const noProof=c.finishVerified(anon.token,a.consumed,{provider:'google',subject:'fresh-1',email:'morgan@example.com'});
 assert.equal(noProof.choiceRequired,true);
 const created=c.decide(anon.token,a.raw,'new',null);
 assert.equal(created.created,true);assert.notEqual(created.actor,old.actor);
 assert.equal(c.db.prepare('SELECT COUNT(*) n FROM scheduled_deletions').get().n,0);
 assert.equal(c.profileRow(old.actor).actor,old.actor);
 /* The new profile registered the same verified email, so a THIRD claimant now sees ambiguity. */
 const freshToken=c.bootstrap();a=attempt(c,freshToken.token,'apple','fresh-2');
 const ask=c.finishVerified(freshToken.token,a.consumed,{provider:'apple',subject:'fresh-2',email:'morgan@example.com'});
 assert.equal(ask.choiceRequired,true);assert.equal(ask.ambiguous,true);
 assert.throws(()=>c.decide(freshToken.token,a.raw,'link',{email:'morgan@example.com',password:'password123'}),/DECISION_UNAVAILABLE/);
});
test('new profile with proof schedules the old profile for deletion in 30 days',t=>{
 const {c}=fixture(t),old=emailProfile(c),anon=c.bootstrap();
 const a=attempt(c,anon.token,'apple','sched-1');
 const ask=c.finishVerified(anon.token,a.consumed,{provider:'apple',subject:'sched-1',email:'morgan@example.com'});
 assert.equal(ask.choiceRequired,true);
 const verified=c.decisionVerify(anon.token,a.raw,{email:'morgan@example.com',password:'password123'});
 assert.equal(verified.existing.tag,c.profileRow(old.actor).tag);
 const second=c.decide(anon.token,a.raw,'new',{email:'morgan@example.com',password:'password123'});
 assert.equal(second.created,true);assert.notEqual(second.actor,old.actor);
 const row=c.db.prepare('SELECT actor,due FROM scheduled_deletions').get();
 assert.equal(row.actor,old.actor);
 assert.ok(Math.abs(row.due-(c.now()+30*86400000))<5000);
});
test('expiry and session binding fail closed; no prompt when the identity already exists',t=>{
 const {c,advance}=fixture(t),old=emailProfile(c);
 let anon=c.bootstrap(),a=attempt(c,anon.token);
 let ask=c.finishVerified(anon.token,a.consumed,{provider:'google',subject:'gx',email:'morgan@example.com'});
 assert.equal(ask.choiceRequired,true);
 advance(6*60000);
 assert.throws(()=>c.decide(anon.token,a.raw,'link',{email:'morgan@example.com',password:'password123'}),/INVALID_AUTH_STATE/);
 anon=c.bootstrap();a=attempt(c,anon.token);
 ask=c.finishVerified(anon.token,a.consumed,{provider:'google',subject:'gx',email:'morgan@example.com'});
 assert.equal(ask.choiceRequired,true);
 const other=c.bootstrap();
 assert.throws(()=>c.decide(other.token,a.raw,'link',{email:'morgan@example.com',password:'password123'}),/INVALID_AUTH_STATE/);
 /* A repeat sign-in on another session prompts again (the decision is per-attempt); once the
   * identity EXISTS the sign-in is direct with no prompt. */
 const third=c.bootstrap(),thirdAttempt=attempt(c,third.token,'google','gx');
 const ask3=c.finishVerified(third.token,thirdAttempt.consumed,{provider:'google',subject:'gx',email:'morgan@example.com'});
 assert.equal(ask3.choiceRequired,true);
 const linked=c.decide(third.token,thirdAttempt.raw,'link',{email:'morgan@example.com',password:'password123'});
 assert.equal(linked.actor,old.actor);
 const againSession=c.bootstrap(),againAttempt=attempt(c,againSession.token,'google','gx');
 const again=c.finishVerified(againSession.token,againAttempt.consumed,{provider:'google',subject:'gx',email:'morgan@example.com'});
 assert.equal(again.actor,old.actor);assert.equal(again.choiceRequired,undefined);
});
test('ambiguous matches refuse link; new-profile creation still works without deleting anything',t=>{
 const {c}=fixture(t);
 emailProfile(c,'morgan@example.com','password123');
 const second=c.bootstrap(),secondAttempt=attempt(c,second.token,'apple','apple-sub');
 const ask2=c.finishVerified(second.token,secondAttempt.consumed,{provider:'apple',subject:'apple-sub',email:'morgan@example.com'});
 assert.equal(ask2.choiceRequired,true);
 const created=c.decide(second.token,secondAttempt.raw,'new',null);
 assert.equal(created.created,true);
 const anon=c.bootstrap(),a=attempt(c,anon.token,'google','third-sub');
 const ambiguous=c.finishVerified(anon.token,a.consumed,{provider:'google',subject:'third-sub',email:'morgan@example.com'});
 assert.equal(ambiguous.choiceRequired,true);assert.equal(ambiguous.ambiguous,true);
 assert.throws(()=>c.decisionVerify(anon.token,a.raw,{email:'morgan@example.com',password:'password123'}),/DECISION_UNAVAILABLE/);
 assert.throws(()=>c.decide(anon.token,a.raw,'link',{email:'morgan@example.com',password:'password123'}),/DECISION_UNAVAILABLE/);
 const fresh=c.decide(anon.token,a.raw,'new',null);
 assert.equal(fresh.created,true);
 assert.equal(c.db.prepare('SELECT COUNT(*) n FROM scheduled_deletions').get().n,0);
});
test('the scheduled sweep wipes with the coordinated path and postpones busy actors',t=>{
 const {c,advance}=fixture(t),old=emailProfile(c),tag=c.profileRow(old.actor).tag;
 const anon=c.bootstrap(),a=attempt(c,anon.token);
 c.finishVerified(anon.token,a.consumed,{provider:'google',subject:'sched-1',email:'morgan@example.com'});
 c.decide(anon.token,a.raw,'new',{email:'morgan@example.com',password:'password123'});
 advance(31*86400000);
 const authority=c.read();authority.account(old.actor).activeMatch='match:busy';c.write(authority);
 c.cleanup();
 assert.equal(c.db.prepare('SELECT due FROM scheduled_deletions').get().due,c.now()+3600000);
 const authority2=c.read();authority2.account(old.actor).activeMatch=null;c.write(authority2);
 advance(2*3600000+1000);
 c.cleanup();
 assert.equal(c.db.prepare('SELECT COUNT(*) n FROM scheduled_deletions').get().n,0);
 assert.throws(()=>c.profile(old.actor,old.actor),/UNKNOWN_ACCOUNT|PROFILE_NOT_FOUND/);
 assert.equal(c.db.prepare('SELECT COUNT(*) n FROM profiles WHERE tag=?').get(tag).n,0);
});
