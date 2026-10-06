'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DurableStore}=require('../server/economy-store');
const {CommunityStore}=require('../server/community-store');
const {migrate}=require('../server/production/migrations');
const {OperatorService,operatorKey}=require('../server/production/operator-service');

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-operator-')),file=path.join(dir,'db.sqlite'),store=new DurableStore(file),c=new CommunityStore({store,origin:'https://game.test'});migrate(store.db);
 const authority=store.read(),actor='u_'+crypto.randomUUID();authority.addAccount(actor,{verified:true,createdAt:Date.now()});c.ensureProfile(actor,authority);authority.account(actor).coins=321;authority.account(actor).crowns=45;c.write(authority);
 const p=c.profileRow(actor),salt=crypto.randomBytes(16).toString('base64url');
 store.db.prepare('INSERT INTO email_credentials(email,actor,salt,password_hash,created,verified_at) VALUES(?,?,?,?,?,?)').run('player@example.com',actor,salt,'legacy-placeholder',Date.now(),Date.now());
 store.db.prepare('INSERT INTO identities VALUES(?,?,?,?)').run('email','player@example.com',actor,Date.now());
 const issued=c._issue(actor,Date.now()),service={store,community:c},ops=new OperatorService(service,{secret:'b'.repeat(64)});
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {store,c,actor,p,issued,ops};
}
test('operator lookup masks email and never exposes session/token material',t=>{
 const f=fixture(t),value=f.ops.command({action:'lookup',query:f.p.tag});
 assert.equal(value.actor,f.actor);assert.equal(value.email,'p***@example.com');assert.equal(value.wallet.coins,321);assert.equal(value.wallet.crowns,45);
 assert.equal(JSON.stringify(value).includes(f.issued.token),false);assert.equal(JSON.stringify(value).includes('player@example.com'),false);
 assert.equal(f.ops.resolve(f.p.username),f.actor);assert.equal(f.ops.resolve('player@example.com'),f.actor);
});
test('operator suspension revokes sessions and creates immutable audit record without touching wallet',t=>{
 const f=fixture(t),before=f.c.read().account(f.actor),coins=before.coins,crowns=before.crowns;
 const result=f.ops.command({action:'suspend',query:f.p.tag,operator:'security.bot',reason:'Confirmed account security incident'});
 assert.equal(result.value,true);assert.equal(result.revoked,1);assert.equal(f.c.session(f.issued.token),null);
 const after=f.c.read().account(f.actor);assert.equal(after.suspended,true);assert.equal(after.coins,coins);assert.equal(after.crowns,crowns);
 const history=f.ops.command({action:'audit',query:f.p.tag,limit:10});assert.equal(history.audit.valid,true);assert.equal(history.rows[0].action,'suspended_on');assert.equal(history.rows[0].reason,'Confirmed account security incident');
 assert.throws(()=>f.store.db.prepare('UPDATE v41_operator_audit SET reason=?').run('tamper'),/AUDIT_IMMUTABLE/);
 assert.throws(()=>f.store.db.prepare('DELETE FROM v41_operator_audit').run(),/AUDIT_IMMUTABLE/);
});
test('operator hold and recovery actions are explicit, audited and do not include currency mutation commands',t=>{
 const f=fixture(t);
 f.ops.command({action:'hold-on',query:f.actor,operator:'ops.agent',reason:'Temporary fraud investigation hold'});
 assert.equal(f.c.read().account(f.actor).hold,true);
 f.ops.command({action:'hold-off',query:f.actor,operator:'ops.agent',reason:'Investigation completed without finding abuse'});
 assert.equal(f.c.read().account(f.actor).hold,false);
 f.ops.command({action:'unsuspend',query:f.actor,operator:'ops.agent',reason:'Account suspension reviewed and cleared'});
 assert.equal(f.ops.verifyAudit().count,3);
 assert.throws(()=>f.ops.command({action:'grant-currency',query:f.actor,operator:'ops.agent',reason:'This command must never exist'}),/INVALID_OPERATOR_ACTION/);
});
test('operator key is deterministic but never equal to the proxy secret itself',()=>{
 const secret='c'.repeat(64),key=operatorKey(secret);assert.match(key,/^[A-Za-z0-9_-]{43}$/);assert.notEqual(key,secret);assert.equal(key,operatorKey(secret));assert.notEqual(key,operatorKey('d'.repeat(64)));
});

test('incident lockdown revokes sessions, invalidates pending auth and remains in maintenance until explicitly cleared',t=>{
 const f=fixture(t),now=Date.now();
 f.store.db.prepare('INSERT INTO signin_attempts(state,session,provider,kind,intent,target,nonce,verifier,expires,used) VALUES(?,?,?,?,?,?,?,?,?,0)').run('incident-state','session-hash','google','web','login',null,'nonce','verifier',now+60000);
 f.store.db.prepare('INSERT INTO email_challenges(id,session,email,purpose,actor,code_hash,created,expires,attempts,consumed) VALUES(?,?,?,?,?,?,?,?,0,0)').run('incident-otp','session-hash','incident@example.com','reset',f.actor,'hash',now,now+60000);
 f.store.db.prepare('INSERT INTO v4_outbox(id,payload,kind,state,created,expires,next_at,lease_until,attempts) VALUES(?,?,?,?,?,?,?,?,0)').run('incident-mail','encrypted','otp','queued',now,now+60000,now,0);
 const locked=f.ops.command({action:'incident-lockdown',operator:'security.lead',reason:'Credential exposure drill requires global containment'});
 assert.equal(locked.lockedDown,true);assert.equal(locked.maintenance,true);assert.equal(f.c.session(f.issued.token),null);
 assert.equal(f.store.db.prepare("SELECT used FROM signin_attempts WHERE state='incident-state'").get().used,1);
 const otp=f.store.db.prepare("SELECT consumed,password_hash,password_salt FROM email_challenges WHERE id='incident-otp'").get();assert.equal(otp.consumed,1);assert.equal(otp.password_hash,null);assert.equal(otp.password_salt,null);
 const mail=f.store.db.prepare("SELECT state,payload FROM v4_outbox WHERE id='incident-mail'").get();assert.equal(mail.state,'cancelled');assert.equal(mail.payload,null);
 const cleared=f.ops.command({action:'incident-clear',operator:'security.lead',reason:'Containment drill completed and credentials validated'});
 assert.equal(cleared.cleared,true);assert.equal(cleared.maintenance,true);
 assert.equal(f.store.db.prepare('SELECT maintenance FROM v4_controls WHERE id=1').get().maintenance,1);
 assert.equal(f.ops.verifyAudit().count,2);
});
test('incident lockdown is visible in status and cannot be cleared twice',t=>{
 const f=fixture(t);
 assert.equal(f.ops.command({action:'incident-status'}).lockdown,false);
 f.ops.command({action:'incident-lockdown',operator:'ops.lead',reason:'Simulated session compromise containment drill'});
 const status=f.ops.command({action:'incident-status'});assert.equal(status.lockdown,true);assert.equal(status.sessions,0);assert.equal(status.audit.valid,true);
 f.ops.command({action:'incident-clear',operator:'ops.lead',reason:'Simulated incident validation completed safely'});
 assert.throws(()=>f.ops.command({action:'incident-clear',operator:'ops.lead',reason:'Second clear should never be accepted'}),/INCIDENT_NOT_ACTIVE/);
});
test('secret rotation helper refuses direct Restic password replacement and requires lockdown for trust-root rotation',()=>{
 const source=fs.readFileSync(path.join(__dirname,'..','deploy','rotate-secret.sh'),'utf8');
 assert.ok(source.includes("restic_password) echo 'Do not rotate Restic encryption"));
 assert.ok(source.includes('rotation requires an active audited incident lockdown first'));
 assert.ok(source.includes("proxy_secret || \"$name\" = otp_secret"));
 assert.ok(source.includes('R2 credentials must be rotated together'));
 assert.ok(source.includes('Rotation failed; previous secret restored.'));
 const r2=fs.readFileSync(path.join(__dirname,'..','deploy','rotate-r2-credentials.sh'),'utf8');
 assert.ok(r2.includes('R2 credential pair rotated and repository access verified.'));
 assert.ok(r2.includes('previous credential pair restored.'));
});


test('operator support lookup returns only sanitized request metadata',t=>{
 const f=fixture(t),id='MX-A1B2C3D4E5F60708';
 f.store.db.prepare('INSERT INTO v41_support_events(id,at,method,route,status,code) VALUES(?,?,?,?,?,?)').run(id,123456,'POST','/api/v1/move',409,'STALE_REVISION');
 const value=f.ops.command({action:'support',query:id});
 assert.deepEqual(value,{id,at:123456,method:'POST',route:'/api/v1/move',status:409,code:'STALE_REVISION'});
 assert.equal('actor' in value,false);assert.equal('ip' in value,false);assert.throws(()=>f.ops.command({action:'support',query:'MX-not-valid'}),/INVALID_SUPPORT_ID/);
});
