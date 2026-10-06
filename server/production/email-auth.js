'use strict';
const crypto=require('node:crypto');
const {validate,equal}=require('./passwords');
const {hit}=require('./mail-outbox');
const TTL=600000,COOLDOWN=60000;
function email(value) {
 if(typeof value!=='string')throw Error('INVALID_EMAIL');
 const normalized=value.trim().toLowerCase(),parts=normalized.split('@');
 if(normalized.length>254||parts.length!==2||!parts[0]||parts[0].length>64||parts[0].startsWith('.')||parts[0].endsWith('.')||parts[0].includes('..')||! /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0])||! /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(parts[1]))throw Error('INVALID_EMAIL');
 return normalized;
}
const stamp=row=>row?crypto.createHash('sha256').update(row.actor+'|'+row.password_hash).digest('hex'):null;
const mask=value=>value[0]+'***@'+value.split('@')[1];
class EmailAuth {
 constructor(community,{passwords,outbox,secret,now=Date.now}) {Object.assign(this,{c:community,db:community.db,passwords,outbox,secret,now});}
 rate(session,address) {
  hit(this.db,this.secret,'auth-session',session.hash,12,300,this.now());
  hit(this.db,this.secret,'auth-address',address,30,3600,this.now());
 }
 requireCurrent(token,hash) {const session=this.c.requireSession(token);if(session.hash!==hash)throw Error('AUTH_REQUIRED');return session;}
 credential(address){return this.db.prepare('SELECT * FROM email_credentials WHERE email=?').get(address);}
 hashCode(id,address,purpose,code){return crypto.createHmac('sha256',this.secret).update([id,address,purpose,code].join('|')).digest('base64url');}
 challenge(session,address,purpose,{actor=null,credential=null,password=null,dummy=false}={}) {
  // Limits are committed outside the grant transaction; errors cannot erase abuse counters.
  hit(this.db,this.secret,'otp-session',session.hash,8,3600,this.now());
  hit(this.db,this.secret,'otp-address',address,6,3600,this.now());
  const recent=this.db.prepare('SELECT created FROM email_challenges WHERE email=? AND purpose=? ORDER BY created DESC LIMIT 1').get(address,purpose);
  if(recent&&this.now()-recent.created<COOLDOWN)throw Error('OTP_COOLDOWN');
  return this.c.tx(()=>{
   const id=crypto.randomBytes(24).toString('base64url'),code=String(crypto.randomInt(1000000)).padStart(6,'0'),now=this.now();
   this.db.prepare("UPDATE v4_outbox SET state='cancelled',payload=NULL WHERE state='queued' AND id IN (SELECT id FROM email_challenges WHERE session=? AND email=? AND purpose=?)").run(session.hash,address,purpose);
   this.db.prepare('UPDATE email_challenges SET consumed=1 WHERE session=? AND email=? AND purpose=?').run(session.hash,address,purpose);
   this.db.prepare('INSERT INTO email_challenges(id,session,email,purpose,actor,code_hash,password_salt,password_hash,created,expires) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,session.hash,address,purpose,actor,this.hashCode(id,address,purpose,code),password?.salt||null,password?.password_hash||null,now,now+TTL);
   this.db.prepare('INSERT INTO v4_email_versions VALUES(?,?)').run(id,stamp(credential));
   if(!dummy)this.outbox.enqueue(id,{to:address,code,purpose},now+TTL);
   return {linked:false,verificationRequired:true,challengeId:id,email:mask(address),expiresAt:now+TTL,resendAt:now+COOLDOWN};
  });
 }
 async continue(token,address,password) {
  const session=this.c.requireSession(token);if(session.actor)throw Error('ALREADY_LINKED');address=email(address);validate(password);this.rate(session,address);
  const row=this.credential(address);
  if(row) {
   if(!await this.passwords.verify(password,row.salt,row.password_hash))throw Error('INVALID_CREDENTIALS');
   this.requireCurrent(token,session.hash);
   if(stamp(this.credential(address))!==stamp(row))throw Error('INVALID_CREDENTIALS');
   this.c.requireAccount(row.actor);
   if(!row.verified_at)return this.challenge(session,address,'verify-existing',{actor:row.actor,credential:row});
   // Upgrade legacy work factor only after successful verification, outside a DB lock.
   const upgraded=row.password_hash.startsWith('scrypt-v1$')?null:await this.passwords.hash(password);
   return this.c.tx(()=>{
    this.requireCurrent(token,session.hash);
    if(stamp(this.credential(address))!==stamp(row))throw Error('INVALID_CREDENTIALS');
    if(upgraded)this.db.prepare('UPDATE email_credentials SET salt=?,password_hash=? WHERE email=?').run(upgraded.salt,upgraded.password_hash,address);
    return this.c._replaceSession(session,row.actor,false);
   });
  }
  if(!this.outbox.enabled())throw Error('EMAIL_DELIVERY_NOT_CONFIGURED');
  const hashed=await this.passwords.hash(password);this.requireCurrent(token,session.hash);
  if(this.credential(address))throw Error('INVALID_CREDENTIALS');
  return this.challenge(session,address,'signup',{password:hashed});
 }
 async link(token,address,password) {
  const session=this.c.requireLinked(token);if(this.now()-session.authAt>900000)throw Error('REAUTH_REQUIRED');
  address=email(address);validate(password);this.rate(session,address);
  if(this.db.prepare('SELECT actor FROM email_credentials WHERE email=? OR actor=?').get(address,session.actor))throw Error('EMAIL_IN_USE');
  if(!this.outbox.enabled())throw Error('EMAIL_DELIVERY_NOT_CONFIGURED');
  const hashed=await this.passwords.hash(password);this.requireCurrent(token,session.hash);
  return this.challenge(session,address,'link',{actor:session.actor,password:hashed});
 }
 verify(token,id,code) {
  const session=this.c.requireSession(token);
  hit(this.db,this.secret,'otp-verify',session.hash,20,300,this.now());
  if(typeof id!=='string'||id.length>64||typeof code!=='string'||!/^\d{6}$/.test(code))throw Error('INVALID_OTP');
  const result=this.c.tx(()=>{
   const row=this.db.prepare('SELECT e.*,v.credential_hash FROM email_challenges e JOIN v4_email_versions v ON v.challenge=e.id WHERE e.id=? AND e.session=?').get(id,session.hash);
   if(!row||row.consumed||row.verified_at)return {error:'INVALID_OTP'};
   if(row.expires<=this.now()){this.db.prepare('UPDATE email_challenges SET consumed=1 WHERE id=?').run(id);return {error:'OTP_EXPIRED'};}
   if(row.attempts>=5)return {error:'OTP_LOCKED'};
   if(!equal(this.hashCode(row.id,row.email,row.purpose,code),row.code_hash)) {
    this.db.prepare('UPDATE email_challenges SET attempts=attempts+1 WHERE id=?').run(id);return {error:'INVALID_OTP'};
   }
   const credential=this.credential(row.email);
   if(['reset','verify-existing'].includes(row.purpose)&&(!row.actor||!credential||stamp(credential)!==row.credential_hash))return {error:'INVALID_OTP'};
   if(row.purpose==='reset'){this.db.prepare('UPDATE email_challenges SET verified_at=? WHERE id=?').run(this.now(),id);return {resetReady:true,challengeId:id};}
   if(row.purpose==='verify-existing') {
    this.c.requireAccount(row.actor);this.db.prepare('UPDATE email_credentials SET verified_at=? WHERE email=?').run(this.now(),row.email);
    this.db.prepare('UPDATE email_challenges SET verified_at=?,consumed=1 WHERE id=?').run(this.now(),id);
    return this.c._replaceSession(session,row.actor,false);
   }
   if(row.purpose==='change-email'){
    if(session.actor!==row.actor||this.now()-session.authAt>900000)return {error:'REAUTH_REQUIRED'};
    const current=this.db.prepare('SELECT * FROM email_credentials WHERE actor=? AND verified_at IS NOT NULL').get(row.actor);
    if(!current||stamp(current)!==row.credential_hash||credential)return {error:'INVALID_OTP'};
    const oldEmail=current.email;
    this.db.prepare('UPDATE email_credentials SET email=?,verified_at=? WHERE actor=?').run(row.email,this.now(),row.actor);
    this.db.prepare("UPDATE identities SET subject=? WHERE actor=? AND provider='email'").run(row.email,row.actor);
    this.db.prepare('UPDATE email_challenges SET consumed=1 WHERE actor=?').run(row.actor);
    this.db.prepare("UPDATE v4_outbox SET state='cancelled',payload=NULL WHERE state='queued' AND id IN (SELECT id FROM email_challenges WHERE actor=?)").run(row.actor);
    this.db.prepare('DELETE FROM session_presence WHERE actor=? AND session<>?').run(row.actor,session.hash);
    this.db.prepare('DELETE FROM account_sessions WHERE actor=? AND token<>?').run(row.actor,session.hash);
    return {linked:true,emailChanged:true,oldEmail,newEmail:row.email,profile:this.c.profile(row.actor,row.actor)};
   }
   if(!['signup','link'].includes(row.purpose)||credential)return {error:'INVALID_OTP'};
   if(row.purpose==='link'&&(session.actor!==row.actor||this.now()-session.authAt>900000))return {error:'REAUTH_REQUIRED'};
   if(row.purpose==='signup'&&session.actor)return {error:'ALREADY_LINKED'};
   const authority=this.c.read(),actor=row.actor||'u_'+crypto.randomUUID();
   if(row.purpose==='signup'){authority.addAccount(actor,{verified:true,createdAt:this.now()});this.c.ensureProfile(actor,authority);this.c.write(authority);}
   else this.c.requireAccount(actor);
   this.db.prepare('INSERT INTO email_credentials(email,actor,salt,password_hash,created,verified_at) VALUES(?,?,?,?,?,?)').run(row.email,actor,row.password_salt,row.password_hash,this.now(),this.now());
   this.db.prepare('INSERT INTO identities VALUES(?,?,?,?)').run('email',row.email,actor,this.now());
   this.db.prepare('UPDATE email_challenges SET consumed=1,verified_at=?,password_hash=NULL,password_salt=NULL WHERE id=?').run(this.now(),id);
   return row.purpose==='link'?{linked:true,profile:this.c.profile(actor,actor)}:this.c._replaceSession(session,actor,true);
  });
  if(result.error)throw Error(result.error);
  if(result.emailChanged){
   for(const to of [result.oldEmail,result.newEmail])try{this.c.tx(()=>this.outbox.enqueue('security-email-'+crypto.randomUUID(),{to,event:'email_changed',detail:'The email address used to sign in to your Mega XO profile was changed.'},this.now()+86400000,'security'));}catch{}
   delete result.oldEmail;delete result.newEmail;
  }
  return result;
 }
 async change(token,address) {
  const session=this.c.requireLinked(token);if(this.now()-session.authAt>900000)throw Error('REAUTH_REQUIRED');
  address=email(address);this.rate(session,address);const current=this.db.prepare('SELECT * FROM email_credentials WHERE actor=? AND verified_at IS NOT NULL').get(session.actor);
  if(!current)throw Error('EMAIL_NOT_LINKED');if(current.email===address)throw Error('EMAIL_UNCHANGED');
  const used=this.credential(address);if(used)throw Error(used.actor===session.actor?'EMAIL_UNCHANGED':'EMAIL_IN_USE');
  if(!this.outbox.enabled())throw Error('EMAIL_DELIVERY_NOT_CONFIGURED');
  this.requireCurrent(token,session.hash);
  return this.challenge(session,address,'change-email',{actor:session.actor,credential:current});
 }
 forgot(token,address) {
  const session=this.c.requireSession(token);address=email(address);this.rate(session,address);
  if(!this.outbox.enabled())throw Error('EMAIL_DELIVERY_NOT_CONFIGURED');
  this.outbox.assertCapacity(); // Same global availability result for known and unknown addresses.
  const row=this.credential(address);
  const result=this.challenge(session,address,'reset',{actor:row?.actor||null,credential:row,dummy:!row});
  // Delivery happens in the background outbox for BOTH response paths: no network
  // latency or provider error is exposed as an account-existence side channel.
  return {...result,message:'If this email has a Mega XO account, a reset code has been requested.'};
 }
 async reset(token,id,password) {
  const session=this.c.requireSession(token);validate(password);
  hit(this.db,this.secret,'reset-complete',session.hash,6,300,this.now());
  const hashed=await this.passwords.hash(password);
  const result=this.c.tx(()=>{
   this.requireCurrent(token,session.hash);
   const row=this.db.prepare("SELECT e.*,v.credential_hash FROM email_challenges e JOIN v4_email_versions v ON v.challenge=e.id WHERE e.id=? AND e.session=? AND e.purpose='reset'").get(id,session.hash);
   if(!row||row.consumed||!row.verified_at||row.expires<=this.now()||!row.actor||stamp(this.credential(row.email))!==row.credential_hash)throw Error('RESET_NOT_AUTHORIZED');
   this.c.requireAccount(row.actor);
   this.db.prepare('UPDATE email_credentials SET salt=?,password_hash=?,verified_at=? WHERE actor=?').run(hashed.salt,hashed.password_hash,this.now(),row.actor);
   this.db.prepare('UPDATE email_challenges SET consumed=1,password_hash=NULL,password_salt=NULL WHERE email=?').run(row.email);
   this.db.prepare('DELETE FROM session_presence WHERE actor=?').run(row.actor);this.db.prepare('DELETE FROM account_sessions WHERE actor=?').run(row.actor);
   return {...this.c._replaceSession(session,row.actor,false),changed:row.email};
  });
  try {this.c.tx(()=>this.outbox.enqueue('changed-'+id,{to:result.changed},this.now()+86400000,'changed'));}catch {this.outbox.log({event:'password_notice_not_queued'});}
  delete result.changed;return {...result,passwordChanged:true};
 }
 async reauth(token,address,password) {
  const session=this.c.requireLinked(token);address=email(address);this.rate(session,address);const row=this.credential(address);
  if(!row||row.actor!==session.actor||!row.verified_at||!await this.passwords.verify(password,row.salt,row.password_hash))throw Error('INVALID_CREDENTIALS');
  this.requireCurrent(token,session.hash);if(stamp(this.credential(address))!==stamp(row))throw Error('INVALID_CREDENTIALS');
  this.db.prepare('UPDATE account_sessions SET auth_at=? WHERE token=?').run(this.now(),session.hash);return this.c.profile(row.actor,row.actor);
 }
 async dispatch(token,body) {
  switch(body.action) {
   case 'continue':return this.continue(token,body.email,body.password);
   case 'link':return this.link(token,body.email,body.password);
   case 'verify':return this.verify(token,body.challengeId,body.code);
   case 'change':return this.change(token,body.email);
   case 'forgot':return this.forgot(token,body.email);
   case 'reset':return this.reset(token,body.challengeId,body.password);
   case 'reauth':return this.reauth(token,body.email,body.password);
   default:throw Error('INVALID_AUTH_REQUEST');
  }
 }
}
module.exports={EmailAuth,email};
