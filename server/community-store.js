/* V3.3.3 identity, profiles, social graph and recovery. Shares the economy DB;
 * account wallets/Elo remain authoritative and are never restored from a client save. */
'use strict';
const crypto=require('node:crypto');
const {sha,equal}=require('./identity-provider.js'),D=require('../src/domain.js');
const {contextFor,currentScope,getContext,repositoriesOf,runInScope}=require('../packages/db/context');
const {SOCIAL_OPERATIONS}=require('../packages/db/scopes');
const DAY=86400000,MAX_SAVE_BYTES=262144,AVATARS=['cross','ring','board','rook','crown','star'];
const NAME=/^[a-z][a-z0-9_]{2,19}$/;
const EMAIL=/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const normalizeEmail=value=>{if(typeof value!=='string')fail('INVALID_EMAIL');const email=value.trim().toLowerCase();if(email.length<6||email.length>254||!EMAIL.test(email))fail('INVALID_EMAIL');return email;};
const validatePassword=value=>{if(typeof value!=='string'||value.length<10||value.length>128||!/[A-Za-z]/.test(value)||!/[0-9]/.test(value))fail('PASSWORD_WEAK');return value;};
const passwordHash=(password,salt)=>crypto.scryptSync(password,Buffer.from(salt,'base64url'),32,{N:16384,r:8,p:1,maxmem:64*1024*1024}).toString('base64url');
const OTP_TTL=10*60000,OTP_COOLDOWN=60000,OTP_ATTEMPTS=5,REPORT_CATEGORIES=new Set(['cheating','username','harassment','unsportsmanlike','other']);
const otpCode=()=>String(crypto.randomInt(0,1000000)).padStart(6,'0');
const maskEmail=email=>{const [local,domain]=email.split('@');return local.slice(0,1)+'***@'+domain;};
const RESERVED=new Set(['admin','administrator','moderator','support','system','megaxo','mega_xo','official','deleted','anonymous']);
const fail=code=>{throw Error(code);};
const safeText=(value,max)=>typeof value==='string'&&value.trim().length>0&&[...value.trim()].length<=max&&!/[\u0000-\u001f\u007f<>]/.test(value);
const json=x=>JSON.stringify(x);
const safeKey=k=>typeof k==='string'&&/^[A-Za-z0-9:_-]{1,160}$/.test(k);
function sanitizePractice(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==3.2)fail('INVALID_SAVE');
 const text=json(value);if(Buffer.byteLength(text)>MAX_SAVE_BYTES)fail('SAVE_TOO_LARGE');
 const clean=JSON.parse(text,(k,v)=>{if(['__proto__','constructor','prototype'].includes(k))fail('INVALID_SAVE');return v;});
 const allowed=['version','economyVersion','settings','records','processed','playSeconds','wallet','daily','weekly','legacy','profile','offlineMatch'];
 for(const k of Object.keys(clean))if(!allowed.includes(k))delete clean[k];
 if(!Array.isArray(clean.records)||clean.records.length>2000||!clean.settings||!clean.wallet)fail('INVALID_SAVE');
 clean.records=clean.records.filter(r=>r?.mode==='bot'&&['win','loss','draw'].includes(r.result)&&typeof r.id==='string'&&r.id.length<160&&Number.isFinite(r.activeSeconds)&&r.activeSeconds>=0&&r.activeSeconds<=86400);
 const themes=['vector','midnight','paperclub','afterhours'];if(!themes.includes(clean.settings.theme))fail('INVALID_SAVE');
 for(const key of ['coins','crowns'])if(!Number.isSafeInteger(clean.wallet[key])||clean.wallet[key]<0)fail('INVALID_SAVE');
 if(!Array.isArray(clean.wallet.ledger)||!Array.isArray(clean.wallet.owned)||!Array.isArray(clean.processed))fail('INVALID_SAVE');
 if(clean.offlineMatch&&(!Array.isArray(clean.offlineMatch.moves)||clean.offlineMatch.moves.length>81))fail('INVALID_SAVE');
 // The archive is untrusted practice data. It is never read by economy settlement.
 return clean;
}
class CommunityStore {
 constructor({store,origin,now=Date.now,otpSecret=process.env.MEGA_OTP_SECRET,securityNotify=()=>{},deletionPolicy={}}={}){
  if(!store?.db||!origin)fail('IDENTITY_STORE_REQUIRED');this.store=store;this.db=store.db;this.origin=new URL(origin).origin;this.now=now;this.otpSecret=Buffer.from(otpSecret||crypto.randomBytes(32).toString('base64url'));this.securityNotify=securityNotify;this.deletionPolicy={enabled:deletionPolicy.enabled===true,policyVersion:typeof deletionPolicy.policyVersion==='string'?deletionPolicy.policyVersion:''};
  this.db.exec(`CREATE TABLE IF NOT EXISTS profiles(actor TEXT PRIMARY KEY,tag TEXT NOT NULL UNIQUE,username TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,avatar TEXT NOT NULL DEFAULT 'board',stats_visibility TEXT NOT NULL DEFAULT 'friends',presence_visibility TEXT NOT NULL DEFAULT 'friends',created INTEGER NOT NULL,username_changed INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS identities(provider TEXT NOT NULL,subject TEXT NOT NULL,actor TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(provider,subject),UNIQUE(actor,provider));
CREATE TABLE IF NOT EXISTS email_credentials(email TEXT PRIMARY KEY COLLATE NOCASE,actor TEXT NOT NULL UNIQUE,salt TEXT NOT NULL,password_hash TEXT NOT NULL,created INTEGER NOT NULL,verified_at INTEGER);
CREATE TABLE IF NOT EXISTS account_sessions(token TEXT PRIMARY KEY,actor TEXT,csrf TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,auth_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS signin_attempts(state TEXT PRIMARY KEY,session TEXT NOT NULL,provider TEXT NOT NULL,kind TEXT NOT NULL,intent TEXT NOT NULL,target TEXT,nonce TEXT NOT NULL,verifier TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS profile_saves(actor TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL,updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS session_presence(session TEXT PRIMARY KEY,actor TEXT NOT NULL,seen INTEGER NOT NULL,foreground INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS social_operations(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS community_limits(id TEXT PRIMARY KEY,hits INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS email_challenges(id TEXT PRIMARY KEY,session TEXT NOT NULL,email TEXT NOT NULL COLLATE NOCASE,purpose TEXT NOT NULL,actor TEXT,code_hash TEXT NOT NULL,password_salt TEXT,password_hash TEXT,created INTEGER NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,verified_at INTEGER,consumed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS v41_reports(id TEXT PRIMARY KEY,reporter TEXT NOT NULL,target TEXT NOT NULL,category TEXT NOT NULL CHECK(category IN ('cheating','username','harassment','unsportsmanlike','other')),detail TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','reviewed')),reviewed_at INTEGER,reviewed_by TEXT,outcome TEXT CHECK(outcome IS NULL OR outcome IN ('no_action','action_taken','duplicate')));
CREATE TABLE IF NOT EXISTS v41_privacy_requests(id TEXT PRIMARY KEY,actor TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,requested_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,completed_at INTEGER,policy_version TEXT NOT NULL,note TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS v41_deletion_receipts(id TEXT PRIMARY KEY,actor_hash TEXT NOT NULL UNIQUE,tombstone TEXT NOT NULL UNIQUE,completed_at INTEGER NOT NULL,policy_version TEXT NOT NULL,retained TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS v41_reports_target_state ON v41_reports(target,state,created);
CREATE INDEX IF NOT EXISTS v41_reports_reporter_created ON v41_reports(reporter,created);
CREATE INDEX IF NOT EXISTS session_actor ON account_sessions(actor);
CREATE INDEX IF NOT EXISTS presence_actor ON session_presence(actor);
CREATE INDEX IF NOT EXISTS identities_actor ON identities(actor);
CREATE INDEX IF NOT EXISTS email_credentials_actor ON email_credentials(actor);
CREATE INDEX IF NOT EXISTS email_challenges_session ON email_challenges(session);
CREATE INDEX IF NOT EXISTS email_challenges_email ON email_challenges(email);`);
  const credentialColumns=this.db.prepare('PRAGMA table_info(email_credentials)').all();if(!credentialColumns.some(c=>c.name==='verified_at'))this.db.exec('ALTER TABLE email_credentials ADD COLUMN verified_at INTEGER');
 }
 /* Existing account/social transaction seam: the store's OWN connection scope.
  * Nested calls borrow it, so signup/social/deletion effects (identity, graph,
  * outcomes) commit as one unit and never independently. */
 tx(fn){return runInScope(this.db,{now:this.now,origin:'community',begin:'BEGIN IMMEDIATE'},fn);}
 /* Current live scope repositories when one is open, else the connection-bound set. */
 repositories(){const scope=currentScope(this.db);if(scope)return repositoriesOf(scope.context);const context=getContext(this.db);return repositoriesOf(context||contextFor(this.db,{now:this.now,begin:'BEGIN IMMEDIATE'}));}
 rate(actor,bucket,limit,seconds=60){const hits=this.repositories().community.count(bucket+':'+actor+':'+Math.floor(this.now()/1000/seconds));if(hits>limit)fail('RATE_LIMITED');}
 read(){return this.store.read();}
 /* Never persist the economic graph while it is owned by another store's open
  * unit of work; that scope commits it. Outside a scope this writes atomically. */
 write(a){const scope=currentScope(this.db);if(scope&&scope.origin!=='community')throw Error('NESTED_ECONOMY_WRITE');this.db.prepare('UPDATE state SET json=? WHERE id=1').run(json(a.export()));const context=getContext(this.db);if(context)context.graph=null;}
 requireAccount(actor){const a=this.read().account(actor);if(a.suspended||a.hold||!a.verified)fail('ACCOUNT_UNAVAILABLE');return a;}
 profileRow(actor){return this.repositories().profiles.for(actor);}
 ensureProfile(actor,a){let row=this.profileRow(actor);if(row)return row;const account=a.account(actor);let tag=account.friendCode;
  if(!tag||this.db.prepare('SELECT actor FROM profiles WHERE tag=?').get(tag))do{tag='MEGA-'+crypto.randomBytes(6).toString('hex').toUpperCase();}while(this.db.prepare('SELECT actor FROM profiles WHERE tag=?').get(tag));
  let username;do{username='player_'+crypto.randomBytes(5).toString('hex');}while(this.db.prepare('SELECT actor FROM profiles WHERE username=?').get(username));
  this.db.prepare('INSERT INTO profiles(actor,tag,username,display_name,created) VALUES(?,?,?,?,?)').run(actor,tag,username,username,this.now());account.friendCode=tag;account.name=username;return this.profileRow(actor);
 }
 _issue(actor=null,authAt=0){const token=crypto.randomBytes(32).toString('base64url'),csrf=crypto.randomBytes(24).toString('base64url'),created=this.now(),expires=created+(actor?14*DAY:DAY);this.db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?,?,?)').run(sha(token),actor,csrf,created,expires,authAt);return {token,csrf,actor,expires,authAt};}
 bootstrap(token){const s=this.session(token);if(s)return {...s,token:null};return this.tx(()=>this._issue());}
 session(token){if(typeof token!=='string'||token.length>128)return null;const s=this.repositories().sessions.live(sha(token),this.now());if(!s)return null;
  if(s.actor){try{this.requireAccount(s.actor);}catch{return null;}}return {hash:s.token,actor:s.actor,csrf:s.csrf,expires:s.expires,authAt:s.auth_at};}
 requireSession(token){return this.session(token)||fail('AUTH_REQUIRED');}
 requireLinked(token){const s=this.requireSession(token);if(!s.actor)fail('LINK_ACCOUNT_REQUIRED');return s;}
 csrf(token,provided){const s=this.requireSession(token);if(!equal(s.csrf,provided))fail('CSRF_FAILED');return s;}
 identities(actor){return this.db.prepare('SELECT provider,created FROM identities WHERE actor=? ORDER BY provider').all(actor);}
 emailAddress(actor){return this.db.prepare('SELECT email FROM email_credentials WHERE actor=?').get(actor)?.email||null;}
 emailVerified(actor){return !!this.db.prepare('SELECT verified_at FROM email_credentials WHERE actor=?').get(actor)?.verified_at;}
 _security(actor,event,details={}){try{this.securityNotify(actor,event,details);}catch{}}
 _sessionId(hash){return crypto.createHash('sha256').update(hash).digest('hex').slice(0,24);}
 sessions(token){const current=this.requireLinked(token),rows=this.db.prepare('SELECT token,created,expires,auth_at FROM account_sessions WHERE actor=? AND expires>? ORDER BY created DESC').all(current.actor,this.now());return rows.map(r=>({id:this._sessionId(r.token),current:r.token===current.hash,created:r.created,expires:r.expires,recentlyVerified:this.now()-r.auth_at<=15*60000}));}
 revokeSession(token,id){const current=this.requireLinked(token);if(typeof id!=='string'||!/^[a-f0-9]{24}$/.test(id))fail('INVALID_SESSION');const row=this.db.prepare('SELECT token FROM account_sessions WHERE actor=? AND expires>?').all(current.actor,this.now()).find(r=>this._sessionId(r.token)===id);if(!row)fail('SESSION_NOT_FOUND');if(row.token===current.hash)fail('CURRENT_SESSION');return this.tx(()=>{const repositories=this.repositories();repositories.sessions.clearPresence(row.token);repositories.sessions.revoke(current.actor,row.token);this._security(current.actor,'session_revoked');return {revoked:true};});}
 revokeOtherSessions(token){const current=this.requireLinked(token);return this.tx(()=>{const repositories=this.repositories();repositories.sessions.clearOtherPresence(current.actor,current.hash);const count=repositories.sessions.revokeOthers(current.actor,current.hash).length;this._security(current.actor,'other_sessions_revoked',{count});return {revoked:count};});}
 _password(password,salt,expected){try{return equal(passwordHash(validatePassword(password),salt),expected);}catch{return false;}}
 _replaceSession(session,actor,created=false){const repositories=this.repositories();repositories.sessions.clearPresence(session.hash);repositories.sessions.rotate(session.hash);const issued=this._issue(actor,this.now()),others=this.db.prepare('SELECT token FROM account_sessions WHERE actor=? ORDER BY created DESC').all(actor).slice(5);for(const x of others){repositories.sessions.revoke(actor,x.token);repositories.sessions.clearPresence(x.token);}return {...issued,created,profile:this.profile(actor,actor)};}
 _otpHash(id,email,purpose,code){return crypto.createHmac('sha256',this.otpSecret).update([id,email,purpose,code].join('|')).digest('base64url');}
 _challenge(session,{email,purpose,actor=null,password=null}){
  this.rate(session.hash,'email-otp-session',8,3600);this.rate(sha(email),'email-otp-address',6,3600);
  const recent=this.db.prepare('SELECT created FROM email_challenges WHERE session=? AND email=? AND purpose=? AND created>? ORDER BY created DESC LIMIT 1').get(session.hash,email,purpose,this.now()-OTP_COOLDOWN);if(recent)fail('OTP_COOLDOWN');
  const id=crypto.randomBytes(18).toString('base64url'),code=otpCode(),created=this.now(),expires=created+OTP_TTL;let salt=null,hash=null;
  if(password!==null){password=validatePassword(password);salt=crypto.randomBytes(16).toString('base64url');hash=passwordHash(password,salt);}
  this.db.prepare('UPDATE email_challenges SET consumed=1 WHERE session=? AND email=? AND purpose=? AND consumed=0').run(session.hash,email,purpose);
  this.db.prepare('INSERT INTO email_challenges(id,session,email,purpose,actor,code_hash,password_salt,password_hash,created,expires) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,session.hash,email,purpose,actor,this._otpHash(id,email,purpose,code),salt,hash,created,expires);
  return {verificationRequired:true,challengeId:id,email:maskEmail(email),expiresAt:expires,resendAt:created+OTP_COOLDOWN,delivery:{to:email,code,purpose,idempotencyKey:'mega-xo/'+purpose+'/'+id}};
 }
 emailContinue(token,email,password){
  const session=this.requireSession(token);if(session.actor)fail('ALREADY_LINKED');email=normalizeEmail(email);password=validatePassword(password);this.rate(session.hash,'email-continue',10,300);
  const row=this.db.prepare('SELECT * FROM email_credentials WHERE email=?').get(email);
  if(row){if(!this._password(password,row.salt,row.password_hash))fail('INVALID_CREDENTIALS');this.requireAccount(row.actor);if(row.verified_at)return this.tx(()=>this._replaceSession(session,row.actor,false));return this.tx(()=>this._challenge(session,{email,purpose:'verify-existing',actor:row.actor}));}
  return this.tx(()=>this._challenge(session,{email,purpose:'signup',password}));
 }
 emailLinkStart(token,email,password){
  const session=this.requireLinked(token);if(this.now()-session.authAt>15*60000)fail('REAUTH_REQUIRED');email=normalizeEmail(email);password=validatePassword(password);this.rate(session.hash,'email-link',5,300);
  const found=this.db.prepare('SELECT actor FROM email_credentials WHERE email=?').get(email);if(found&&found.actor!==session.actor)fail('EMAIL_IN_USE');if(found)fail('EMAIL_ALREADY_LINKED');
  return this.tx(()=>this._challenge(session,{email,purpose:'link',actor:session.actor,password}));
 }
 emailVerify(token,id,code){
  const session=this.requireSession(token);if(typeof id!=='string'||id.length>64||typeof code!=='string'||!/^[0-9]{6}$/.test(code))fail('INVALID_OTP');this.rate(session.hash,'email-otp-verify',12,300);
  let row=this.db.prepare('SELECT * FROM email_challenges WHERE id=? AND session=?').get(id,session.hash);if(!row||row.consumed)fail('INVALID_OTP');
  if(row.expires<=this.now()){this.db.prepare('UPDATE email_challenges SET consumed=1 WHERE id=?').run(id);fail('OTP_EXPIRED');}
  if(row.verified_at)fail('OTP_USED');if(row.attempts>=OTP_ATTEMPTS)fail('OTP_LOCKED');
  if(!equal(this._otpHash(row.id,row.email,row.purpose,code),row.code_hash)){this.db.prepare('UPDATE email_challenges SET attempts=attempts+1 WHERE id=?').run(id);fail('INVALID_OTP');}
  return this.tx(()=>{row=this.db.prepare('SELECT * FROM email_challenges WHERE id=? AND session=?').get(id,session.hash);if(!row||row.consumed||row.expires<=this.now()||row.verified_at)fail('INVALID_OTP');
   if(row.purpose==='reset'){if(!row.actor)fail('INVALID_OTP');this.db.prepare('UPDATE email_challenges SET verified_at=? WHERE id=?').run(this.now(),id);return {resetReady:true,challengeId:id};}
   if(row.purpose==='signup'){if(this.db.prepare('SELECT actor FROM email_credentials WHERE email=?').get(row.email))fail('EMAIL_IN_USE');const authority=this.read(),actor='u_'+crypto.randomUUID();authority.addAccount(actor,{verified:true,createdAt:this.now()});this.ensureProfile(actor,authority);this.db.prepare('INSERT INTO email_credentials(email,actor,salt,password_hash,created,verified_at) VALUES(?,?,?,?,?,?)').run(row.email,actor,row.password_salt,row.password_hash,this.now(),this.now());this.db.prepare('INSERT INTO identities VALUES(?,?,?,?)').run('email',row.email,actor,this.now());this.write(authority);this.db.prepare('UPDATE email_challenges SET verified_at=?,consumed=1,actor=? WHERE id=?').run(this.now(),actor,id);return this._replaceSession(session,actor,true);}
   if(row.purpose==='verify-existing'){const credential=this.db.prepare('SELECT actor FROM email_credentials WHERE email=?').get(row.email);if(!credential||credential.actor!==row.actor)fail('INVALID_OTP');this.db.prepare('UPDATE email_credentials SET verified_at=? WHERE email=?').run(this.now(),row.email);this.db.prepare('UPDATE email_challenges SET verified_at=?,consumed=1 WHERE id=?').run(this.now(),id);return this._replaceSession(session,row.actor,false);}
   if(row.purpose==='link'){if(!session.actor||session.actor!==row.actor)fail('ACCOUNT_CHANGED');if(this.db.prepare('SELECT actor FROM email_credentials WHERE email=?').get(row.email))fail('EMAIL_IN_USE');this.db.prepare('INSERT INTO email_credentials(email,actor,salt,password_hash,created,verified_at) VALUES(?,?,?,?,?,?)').run(row.email,row.actor,row.password_salt,row.password_hash,this.now(),this.now());this.db.prepare('INSERT INTO identities VALUES(?,?,?,?)').run('email',row.email,row.actor,this.now());this.db.prepare('UPDATE email_challenges SET verified_at=?,consumed=1 WHERE id=?').run(this.now(),id);return {linked:true,profile:this.profile(row.actor,row.actor)};}
   if(row.purpose==='change-email'){if(!session.actor||session.actor!==row.actor||this.now()-session.authAt>15*60000)fail('REAUTH_REQUIRED');const current=this.db.prepare('SELECT * FROM email_credentials WHERE actor=? AND verified_at IS NOT NULL').get(row.actor);if(!current)fail('EMAIL_NOT_LINKED');if(this.db.prepare('SELECT actor FROM email_credentials WHERE email=?').get(row.email))fail('EMAIL_IN_USE');const oldEmail=current.email;this.db.prepare('UPDATE email_credentials SET email=?,verified_at=? WHERE actor=?').run(row.email,this.now(),row.actor);this.db.prepare("UPDATE identities SET subject=? WHERE actor=? AND provider='email'").run(row.email,row.actor);this.db.prepare('UPDATE email_challenges SET verified_at=?,consumed=1 WHERE id=?').run(this.now(),id);this.db.prepare('UPDATE email_challenges SET consumed=1 WHERE actor=? AND id<>?').run(row.actor,id);this.db.prepare('DELETE FROM session_presence WHERE actor=? AND session<>?').run(row.actor,session.hash);this.db.prepare('DELETE FROM account_sessions WHERE actor=? AND token<>?').run(row.actor,session.hash);this._security(row.actor,'email_changed',{oldEmail,newEmail:row.email});return {linked:true,emailChanged:true,oldEmail,newEmail:row.email,profile:this.profile(row.actor,row.actor)};}
   fail('INVALID_OTP');
  });
 }
 emailChangeStart(token,newEmail){
  const session=this.requireLinked(token);if(this.now()-session.authAt>15*60000)fail('REAUTH_REQUIRED');newEmail=normalizeEmail(newEmail);this.rate(session.hash,'email-change',4,3600);
  const current=this.db.prepare('SELECT * FROM email_credentials WHERE actor=? AND verified_at IS NOT NULL').get(session.actor);if(!current)fail('EMAIL_NOT_LINKED');if(current.email===newEmail)fail('EMAIL_UNCHANGED');
  const used=this.db.prepare('SELECT actor FROM email_credentials WHERE email=?').get(newEmail);if(used)fail(used.actor===session.actor?'EMAIL_UNCHANGED':'EMAIL_IN_USE');
  return this.tx(()=>this._challenge(session,{email:newEmail,purpose:'change-email',actor:session.actor}));
 }
 emailResetStart(token,email){
  const session=this.requireSession(token);email=normalizeEmail(email);this.rate(session.hash,'email-reset',5,3600);const credential=this.db.prepare('SELECT actor FROM email_credentials WHERE email=?').get(email);
  return this.tx(()=>{const challenge=this._challenge(session,{email,purpose:'reset',actor:credential?.actor||null});if(!credential)delete challenge.delivery;return challenge;});
 }
 emailResetComplete(token,id,password){
  const session=this.requireSession(token);password=validatePassword(password);this.rate(session.hash,'email-reset-complete',6,300);
  return this.tx(()=>{const row=this.db.prepare("SELECT * FROM email_challenges WHERE id=? AND session=? AND purpose='reset'").get(id,session.hash);if(!row||row.consumed||!row.verified_at||row.expires<=this.now()||!row.actor)fail('RESET_NOT_AUTHORIZED');const credential=this.db.prepare('SELECT email FROM email_credentials WHERE actor=?').get(row.actor);if(!credential||credential.email!==row.email)fail('RESET_NOT_AUTHORIZED');const salt=crypto.randomBytes(16).toString('base64url');this.db.prepare('UPDATE email_credentials SET salt=?,password_hash=?,verified_at=? WHERE actor=?').run(salt,passwordHash(password,salt),this.now(),row.actor);this.db.prepare('UPDATE email_challenges SET consumed=1 WHERE id=?').run(id);this.db.prepare('DELETE FROM session_presence WHERE actor=?').run(row.actor);this.db.prepare('DELETE FROM account_sessions WHERE actor=?').run(row.actor);return {...this._replaceSession(session,row.actor,false),passwordChangedEmail:row.email};});
 }
 emailReauth(token,email,password){
  const session=this.requireLinked(token);email=normalizeEmail(email);this.rate(session.hash,'email-reauth',8,300);const row=this.db.prepare('SELECT * FROM email_credentials WHERE email=? AND actor=? AND verified_at IS NOT NULL').get(email,session.actor);if(!row||!this._password(password,row.salt,row.password_hash))fail('INVALID_CREDENTIALS');this.db.prepare('UPDATE account_sessions SET auth_at=? WHERE token=?').run(this.now(),session.hash);return this.profile(session.actor,session.actor);
 }
 start(token,provider,intent='login',kind='web'){
  const session=this.requireSession(token);if(!['google','apple'].includes(provider)||!['login','link','reauth'].includes(intent)||!['web','native'].includes(kind))fail('INVALID_AUTH_REQUEST');
  if(intent==='reauth'&&!session.actor)fail('LINK_ACCOUNT_REQUIRED');
  if(intent==='link'&&session.actor&&this.now()-session.authAt>15*60000)fail('REAUTH_REQUIRED');this.rate(session.hash,'signin',15,300);
  const attempt={state:crypto.randomBytes(32).toString('base64url'),nonce:crypto.randomBytes(32).toString('base64url'),verifier:crypto.randomBytes(32).toString('base64url'),provider,kind,intent,target:['link','reauth'].includes(intent)?session.actor:null,expires:this.now()+5*60000};
  this.db.prepare('INSERT INTO signin_attempts VALUES(?,?,?,?,?,?,?,?,?,0)').run(sha(attempt.state),session.hash,provider,kind,intent,attempt.target,attempt.nonce,attempt.verifier,attempt.expires);
  return attempt;
 }
 consume(token,state,provider,kind){const s=this.requireSession(token);if(typeof state!=='string')fail('INVALID_AUTH_STATE');return this.tx(()=>{const row=this.db.prepare('SELECT * FROM signin_attempts WHERE state=?').get(sha(state));if(!row||row.used||row.expires<=this.now()||row.session!==s.hash||row.provider!==provider||row.kind!==kind)fail('INVALID_AUTH_STATE');this.db.prepare('UPDATE signin_attempts SET used=1 WHERE state=?').run(sha(state));return row;});}
 // Called ONLY with claims already verified by IdentityProviders, not public JSON.
 finishVerified(token,attempt,{provider,subject}){
  const session=this.requireSession(token);if(provider!==attempt.provider||typeof subject!=='string'||!subject||subject.length>255)fail('INVALID_IDENTITY');
  return this.tx(()=>{const authority=this.read();const found=this.db.prepare('SELECT actor FROM identities WHERE provider=? AND subject=?').get(provider,subject);let actor=attempt.target,created=false;
   if(actor&&actor!==session.actor)fail('ACCOUNT_CHANGED');
   if(attempt.intent==='reauth'&&(!actor||!found||found.actor!==actor))fail('REAUTH_ACCOUNT_MISMATCH');
   if(actor&&found&&found.actor!==actor)fail('ACCOUNT_LINKED_ELSEWHERE');
   if(!actor&&found)actor=found.actor;
   if(!actor){actor='u_'+crypto.randomUUID();authority.addAccount(actor,{verified:true,createdAt:this.now()});created=true;}
   const a=authority.account(actor);if(a.suspended||a.hold)fail('ACCOUNT_UNAVAILABLE');
   const prior=this.db.prepare('SELECT subject FROM identities WHERE actor=? AND provider=?').get(actor,provider);if(prior&&prior.subject!==subject)fail('PROVIDER_ALREADY_LINKED');
   this.ensureProfile(actor,authority);const inserted=this.db.prepare('INSERT OR IGNORE INTO identities VALUES(?,?,?,?)').run(provider,subject,actor,this.now()).changes>0;this.write(authority);
   if(inserted&&!created)this._security(actor,'provider_linked',{provider});
   return this._replaceSession(session,actor,created);
  });
 }
 logout(token,all=false){const s=this.requireSession(token);return this.tx(()=>{const repositories=this.repositories();if(all&&s.actor){repositories.sessions.clearActorPresence(s.actor);repositories.sessions.revokeAll(s.actor);}else{repositories.sessions.clearPresence(s.hash);repositories.sessions.rotate(s.hash);}return {signedOut:true};});}
 unlink(token,provider){const s=this.requireLinked(token);if(this.now()-s.authAt>15*60000)fail('REAUTH_REQUIRED');return this.tx(()=>{const list=this.identities(s.actor);if(list.length<=1)fail('LAST_LOGIN_METHOD');if(!list.some(i=>i.provider===provider))fail('PROVIDER_NOT_LINKED');this.db.prepare('DELETE FROM identities WHERE actor=? AND provider=?').run(s.actor,provider);if(provider==='email')this.db.prepare('DELETE FROM email_credentials WHERE actor=?').run(s.actor);this._security(s.actor,'provider_unlinked',{provider});return {providers:this.identities(s.actor)};});}
 edit(actor,changes){this.requireAccount(actor);this.rate(actor,'edit',15,300);return this.tx(()=>{const a=this.read(),p=this.ensureProfile(actor,a),username=typeof changes.username==='string'?changes.username.toLowerCase().trim():p.username,name=changes.displayName===undefined?p.display_name:(typeof changes.displayName==='string'?changes.displayName.trim():fail('INVALID_DISPLAY_NAME')),avatar=changes.avatar??p.avatar;
  if(!NAME.test(username)||RESERVED.has(username))fail('INVALID_USERNAME');if(!safeText(name,28))fail('INVALID_DISPLAY_NAME');if(!AVATARS.includes(avatar))fail('INVALID_AVATAR');
  if(username!==p.username&&p.username_changed&&this.now()-p.username_changed<7*DAY)fail('USERNAME_COOLDOWN');const other=this.db.prepare('SELECT actor FROM profiles WHERE username=?').get(username);if(other&&other.actor!==actor)fail('USERNAME_TAKEN');
  const sv=changes.statsVisibility??p.stats_visibility,pv=changes.presenceVisibility??p.presence_visibility;if(!['public','friends','private'].includes(sv)||!['friends','hidden'].includes(pv))fail('INVALID_PRIVACY');
  this.db.prepare('UPDATE profiles SET username=?,display_name=?,avatar=?,stats_visibility=?,presence_visibility=?,username_changed=?,version=version+1 WHERE actor=?').run(username,name,avatar,sv,pv,username!==p.username?this.now():p.username_changed,actor);a.account(actor).name=name;this.write(a);return this.profile(actor,actor);
 });}
 relation(actor,target,a=this.read()){const A=a.account(actor),B=a.account(target);if(A.blocked.includes(target)||B.blocked.includes(actor))return 'blocked';if(A.friends.includes(target)&&B.friends.includes(actor))return 'friend';if(A.friendRequests.includes(target))return 'incoming';if(B.friendRequests.includes(actor))return 'outgoing';return actor===target?'self':'none';}
 stats(a){const out={};for(const mode of ['ranked','casual','friend']){const rows=(a.history||[]).filter(r=>r.mode===mode&&['win','loss','draw'].includes(r.result)),wins=rows.filter(r=>r.result==='win').length,losses=rows.filter(r=>r.result==='loss').length,seconds=rows.reduce((s,r)=>s+(Number.isFinite(r.activeSeconds)?Math.max(0,r.activeSeconds):0),0);out[mode]={games:rows.length,wins,losses,draws:rows.length-wins-losses,winRate:rows.length?wins/rows.length:null,averageSeconds:rows.length?seconds/rows.length:null,hours:seconds/3600};}out.tournament=D.tournamentStats(a.tournamentRecord);return out;}
 presence(actor,viewer){const authority=this.read(),p=this.profileRow(actor);if(!p||actor!==viewer&&(p.presence_visibility==='hidden'||this.relation(actor,viewer,authority)!=='friend'))return {state:'hidden',online:false};
  const rows=this.repositories().sessions.presence(actor,this.now()-45000,this.now());if(!rows.length)return {state:'offline',online:false};if(!rows.some(r=>r.foreground))return {state:'away',online:false};
  const a=authority.account(actor);let state=a.activeMatch?'in-match':this.isQueued?.(actor)?'queued':'online';const table=this.db.prepare("SELECT name FROM sqlite_master WHERE name='party_rooms'").get();if(state==='online'&&table){const rooms=this.db.prepare("SELECT json FROM party_rooms WHERE json_extract(json,'$.status') IN ('LOBBY','RUNNING','PAUSED')").all();if(rooms.some(r=>JSON.parse(r.json).players.some(p=>p.id===actor)))state='in-lobby';}
  return {state,online:true};
 }
 heartbeat(token,foreground){const s=this.requireLinked(token);if(typeof foreground!=='boolean')fail('INVALID_PRESENCE');this.rate(s.hash,'presence',12,60);this.db.prepare('INSERT INTO session_presence VALUES(?,?,?,?) ON CONFLICT(session) DO UPDATE SET seen=excluded.seen,foreground=excluded.foreground').run(s.hash,s.actor,this.now(),foreground?1:0);return this.presence(s.actor,s.actor);}
 profile(viewer,actor){const a=this.read(),account=a.account(actor),p=this.profileRow(actor);if(!p||account.suspended||account.hold||this.relation(viewer,actor,a)==='blocked')fail('PROFILE_NOT_FOUND');const relation=this.relation(viewer,actor,a),show=viewer===actor||p.stats_visibility==='public'||p.stats_visibility==='friends'&&relation==='friend';
  const season=a.seasonStatus(account);return {id:actor,tag:p.tag,friendCode:p.tag,username:p.username,name:p.display_name,displayName:p.display_name,avatar:p.avatar,rating:account.rating,games:account.games,tier:a.currentTier(account),season,relation,stats:show?this.stats(account):null,statsVisibility:p.stats_visibility,presence:this.presence(actor,viewer),...(viewer===actor?{providers:this.identities(actor).map(i=>i.provider),email:this.emailAddress(actor),emailVerified:this.emailVerified(actor),presenceVisibility:p.presence_visibility,profileVersion:p.version,activeMatch:account.activeMatch,cloudRevision:this.db.prepare('SELECT revision FROM profile_saves WHERE actor=?').get(actor)?.revision||0,cosmeticCredits:account.monetization?.credits||0}: {})};
 }
 search(actor,query){this.requireAccount(actor);this.rate(actor,'search',30);if(typeof query!=='string'||query.length>64)fail('INVALID_SEARCH');const q=query.trim().replace(/^#|^@/,'');if(q.length<3)fail('SEARCH_TOO_SHORT');let rows;
  if(q.toUpperCase().startsWith('MEGA-'))rows=this.db.prepare('SELECT actor FROM profiles WHERE tag=?').all(q.toUpperCase());else{const key=q.toLowerCase();if(!/^[a-z0-9_]+$/.test(key))return [];rows=this.db.prepare('SELECT actor FROM profiles WHERE username>=? AND username<? ORDER BY CASE WHEN username=? THEN 0 ELSE 1 END,username LIMIT 20').all(key,key+'\uffff',key);}
  return rows.filter(r=>r.actor!==actor).flatMap(r=>{try{const p=this.profile(actor,r.actor);delete p.stats;return [p];}catch{return [];}});
 }
 resolve(query,a=this.read()){if(a.accounts.has(query))return query;const p=this.db.prepare('SELECT actor FROM profiles WHERE username=? OR tag=?').get(String(query).toLowerCase().replace(/^@/,''),String(query).toUpperCase().replace(/^#/,''));return p?.actor||fail('PROFILE_NOT_FOUND');}
 friends(actor){const a=this.read(),self=a.account(actor);const list=ids=>ids.flatMap(id=>{try{return [this.profile(actor,id)];}catch{return [];}});return {friends:list(self.friends).sort((x,y)=>Number(y.presence.online)-Number(x.presence.online)||x.username.localeCompare(y.username)),incoming:list(self.friendRequests),outgoing:list([...a.accounts.values()].filter(p=>p.friendRequests.includes(actor)).map(p=>p.id)),blocked:self.blocked.map(id=>({id,username:this.profileRow(id)?.username||'Player'}))};}
 report(actor,target,category,detail=''){
  this.requireAccount(actor);if(!REPORT_CATEGORIES.has(category))fail('INVALID_REPORT_CATEGORY');if(typeof detail!=='string')fail('INVALID_REPORT_DETAIL');
  detail=detail.trim();if(detail&&(!safeText(detail,280)))fail('INVALID_REPORT_DETAIL');if(category==='other'&&detail.length<8)fail('REPORT_DETAIL_REQUIRED');
  this.rate(actor,'report',5,86400);const a=this.read(),id=this.resolve(target,a);if(id===actor)fail('CANNOT_REPORT_SELF');a.account(id);
  const existing=this.db.prepare("SELECT id FROM v41_reports WHERE reporter=? AND target=? AND category=? AND state='open' AND created>? ORDER BY created DESC LIMIT 1").get(actor,id,category,this.now()-DAY);
  if(existing)return {reported:true,duplicate:true,id:existing.id};
  const reportId='rp_'+crypto.randomUUID();this.db.prepare('INSERT INTO v41_reports(id,reporter,target,category,detail,created,state) VALUES(?,?,?,?,?,?,?)').run(reportId,actor,id,category,detail,this.now(),'open');
  return {reported:true,duplicate:false,id:reportId};
 }
 social(actor,key,command,target){if(!safeKey(key))fail('INVALID_OPERATION');this.requireAccount(actor);const fp=sha(json({command,target})),op=actor+':'+key;return this.tx(()=>{const repositories=this.repositories(),existing=repositories.outcomes.find(SOCIAL_OPERATIONS,op);if(existing){if(existing.fingerprint!==fp)fail('IDEMPOTENCY_CONFLICT');return JSON.parse(existing.result);}this.rate(actor,'social',30);const a=this.read(),id=this.resolve(target,a),A=a.account(actor),B=a.account(id);if(id===actor)fail('SELF_REQUEST');const relation=this.relation(actor,id,a);
  if(!['request','accept','decline','cancel','remove','block','unblock'].includes(command))fail('INVALID_SOCIAL_ACTION');if(relation==='blocked'&&!['block','unblock'].includes(command))fail('PROFILE_NOT_FOUND');
  if(command==='request'){if(A.friends.length>=200||B.friendRequests.length>=50)fail('FRIEND_LIMIT');a.requestFriend(actor,id);}
  if(command==='accept'){if(A.friends.length>=200||B.friends.length>=200)fail('FRIEND_LIMIT');a.acceptFriend(actor,id);A.friendRequests=A.friendRequests.filter(x=>x!==id);B.friendRequests=B.friendRequests.filter(x=>x!==actor);}
  if(command==='decline')A.friendRequests=A.friendRequests.filter(x=>x!==id);
  if(command==='cancel')B.friendRequests=B.friendRequests.filter(x=>x!==actor);
  if(['remove','block'].includes(command)){A.friends=A.friends.filter(x=>x!==id);B.friends=B.friends.filter(x=>x!==actor);A.friendRequests=A.friendRequests.filter(x=>x!==id);B.friendRequests=B.friendRequests.filter(x=>x!==actor);for(const m of a.matches.values())if(m.status==='OFFERED'&&m.players.includes(actor)&&m.players.includes(id))m.status='CANCELLED';}
  if(command==='block'&&!A.blocked.includes(id))A.blocked.push(id);if(command==='unblock')A.blocked=A.blocked.filter(x=>x!==id);
  this.write(a);const result={ok:true};repositories.outcomes.save(SOCIAL_OPERATIONS,op,fp,json(result));return result;
 });}
 exportData(token){
  const session=this.requireLinked(token);if(this.now()-session.authAt>15*60000)fail('REAUTH_REQUIRED');this.rate(session.actor,'data-export',3,86400);
  const actor=session.actor,a=this.read(),account=a.account(actor),profile=this.profileRow(actor),email=this.db.prepare('SELECT email,created,verified_at FROM email_credentials WHERE actor=?').get(actor)||null;
  const ref=id=>{const p=this.profileRow(id);return {playerId:id,tag:p?.tag||null,username:p?.username||null};};
  const outgoing=[...a.accounts.values()].filter(x=>(x.friendRequests||[]).includes(actor)).map(x=>x.id);
  const save=this.db.prepare('SELECT revision,payload,updated FROM profile_saves WHERE actor=?').get(actor);
  const identities=this.db.prepare('SELECT provider,subject,created FROM identities WHERE actor=? ORDER BY provider').all(actor);
  const reports=this.db.prepare('SELECT id,target,category,detail,created,state,reviewed_at,outcome FROM v41_reports WHERE reporter=? ORDER BY created').all(actor).map(r=>({...r,target:ref(r.target)}));
  const receipts=[...a.receipts.entries()].filter(([,r])=>r.actor===actor).map(([transactionId,r])=>({transactionId,...JSON.parse(json(r))}));
  const wallet={coins:account.coins,crowns:account.crowns,reservedCoins:account.reservedCoins,reservedCrowns:account.reservedCrowns,owned:JSON.parse(json(account.owned||[])),purchaseInfluenced:!!account.purchaseInfluenced,monetization:JSON.parse(json(account.monetization||{}))};
  return {schemaVersion:1,exportedAt:this.now(),account:{playerId:actor,createdAt:account.createdAt,region:account.region||'',wealthPublic:!!account.wealthPublic,suspended:!!account.suspended,securityHold:!!account.hold,profile:{tag:profile.tag,username:profile.username,displayName:profile.display_name,avatar:profile.avatar,statsVisibility:profile.stats_visibility,presenceVisibility:profile.presence_visibility,created:profile.created,usernameChanged:profile.username_changed},email:email?{address:email.email,created:email.created,verifiedAt:email.verified_at}:null,identities,wallet,competitive:{rating:account.rating,peakRating:account.peak,games:account.games,tier:account.tier,casualRating:account.casualRating,casualGames:account.casualGames,season:JSON.parse(json(account.season)),seasonHistory:JSON.parse(json(account.seasonHistory||[])),tournamentRecord:JSON.parse(json(account.tournamentRecord||{})),matchHistory:JSON.parse(json(account.history||[])),daily:JSON.parse(json(account.daily||{})),activeMatch:account.activeMatch||null},social:{friends:(account.friends||[]).map(ref),incomingRequests:(account.friendRequests||[]).map(ref),outgoingRequests:outgoing.map(ref),blocked:(account.blocked||[]).map(ref)},economyJournal:a.journal.filter(e=>e.actor===actor).map(e=>JSON.parse(json(e))),purchaseReceipts:receipts,practiceSave:save?{revision:save.revision,updated:save.updated,practice:JSON.parse(save.payload)}:null,reportsSubmitted:reports}};
 }
 deletionStatus(token){
  const session=this.requireLinked(token),p=this.profileRow(session.actor);return {available:this.deletionPolicy.enabled===true,policyVersion:this.deletionPolicy.policyVersion||null,confirmation:p?.tag||null,recentlyVerified:this.now()-session.authAt<=15*60000};
 }
 deleteAccount(token,confirmation){
  const session=this.requireLinked(token);if(!this.deletionPolicy.enabled||!this.deletionPolicy.policyVersion)fail('ACCOUNT_DELETION_UNAVAILABLE');if(this.now()-session.authAt>15*60000)fail('REAUTH_REQUIRED');
  const actor=session.actor,profile=this.profileRow(actor);if(!profile||confirmation!==profile.tag)fail('DELETE_CONFIRMATION_REQUIRED');this.rate(actor,'account-delete',2,86400);
  const a=this.read(),account=a.account(actor);if(account.activeMatch||this.isQueued?.(actor)||this.isDeletionBusy?.(actor)||[...a.matches.values()].some(m=>m.players.includes(actor)&&['OFFERED','PLAYING'].includes(m.status)))fail('ACCOUNT_BUSY');
  const tombstone='deleted_'+crypto.randomUUID().replace(/-/g,''),receiptId='del_'+crypto.randomUUID(),now=this.now(),policyVersion=this.deletionPolicy.policyVersion,actorHash=crypto.createHash('sha256').update('mega-xo-deleted-account:'+actor).digest('base64url');
  return this.tx(()=>{
   const authority=this.read(),current=authority.account(actor);if(current.activeMatch||[...authority.matches.values()].some(m=>m.players.includes(actor)&&['OFFERED','PLAYING'].includes(m.status)))fail('ACCOUNT_BUSY');
   const sessions=this.db.prepare('SELECT token FROM account_sessions WHERE actor=?').all(actor).map(r=>r.token);
   this.db.prepare('INSERT INTO v41_privacy_requests(id,actor,kind,state,requested_at,updated_at,policy_version,note) VALUES(?,?,?,?,?,?,?,?)').run(receiptId,actor,'deletion','processing',now,now,policyVersion,'');
   for(const other of authority.accounts.values())if(other.id!==actor){
    other.friends=(other.friends||[]).filter(x=>x!==actor);other.friendRequests=(other.friendRequests||[]).filter(x=>x!==actor);other.blocked=(other.blocked||[]).filter(x=>x!==actor);
    for(const h of other.history||[])if(h.opponent===actor)h.opponent=tombstone;
    if(other.season?.opponents)other.season.opponents=other.season.opponents.map(x=>x===actor?tombstone:x);
    for(const season of other.seasonHistory||[])if(season.opponents)season.opponents=season.opponents.map(x=>x===actor?tombstone:x);
   }
   for(const m of authority.matches.values())if(m.players.includes(actor)){
    m.players=m.players.map(x=>x===actor?tombstone:x);m.accepted=(m.accepted||[]).map(x=>x===actor?tombstone:x);
    if(m.symbols){if(m.symbols.X===actor)m.symbols.X=tombstone;if(m.symbols.O===actor)m.symbols.O=tombstone;}
    if(m.receipt?.winner===actor)m.receipt.winner=tombstone;
   }
   for(const r of authority.receipts.values())if(r.actor===actor)r.actor=tombstone;
   for(const snapshot of authority.snapshots.values())if(snapshot&&Object.hasOwn(snapshot,actor))delete snapshot[actor];
   for(const [key,payment] of [...authority.weeklyPaid])if(payment?.account===actor)authority.weeklyPaid.delete(key);
   for(const e of authority.journal)if(e.actor===actor)e.actor=tombstone;
   authority.accounts.delete(actor);this.write(authority);
   if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='v4_outbox'").get()&&sessions.length){const q=sessions.map(()=>'?').join(',');this.db.prepare(`UPDATE v4_outbox SET state='cancelled',payload=NULL WHERE state IN ('queued','sending') AND id IN (SELECT id FROM email_challenges WHERE session IN (${q}))`).run(...sessions);}
   const email=this.db.prepare('SELECT email FROM email_credentials WHERE actor=?').get(actor)?.email||null;
   const repositories=this.repositories();repositories.sessions.clearActorPresence(actor);repositories.sessions.revokeAll(actor);this.db.prepare('DELETE FROM signin_attempts WHERE target=?').run(actor);
   for(const hash of sessions)this.db.prepare('DELETE FROM signin_attempts WHERE session=?').run(hash);
   if(email)this.db.prepare('DELETE FROM email_challenges WHERE actor=? OR email=?').run(actor,email);else this.db.prepare('DELETE FROM email_challenges WHERE actor=?').run(actor);
   if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='v4_email_versions'").get())this.db.prepare('DELETE FROM v4_email_versions WHERE challenge NOT IN (SELECT id FROM email_challenges)').run();
   this.db.prepare('DELETE FROM identities WHERE actor=?').run(actor);this.db.prepare('DELETE FROM email_credentials WHERE actor=?').run(actor);this.db.prepare('DELETE FROM profile_saves WHERE actor=?').run(actor);this.db.prepare('DELETE FROM profiles WHERE actor=?').run(actor);if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='v41_store_bindings'").get())this.db.prepare('DELETE FROM v41_store_bindings WHERE actor=?').run(actor);
   this.db.prepare("DELETE FROM social_operations WHERE id LIKE ?").run(actor+':%');this.db.prepare("DELETE FROM community_limits WHERE id LIKE ?").run('%'+actor+'%');
   this.db.prepare('DELETE FROM commands WHERE actor=?').run(actor);
   for(const table of ['v35_commands','v35_tickets','v35_casual','v35_events'])if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))this.db.prepare('DELETE FROM '+table+' WHERE actor=?').run(actor);
   this.db.prepare("DELETE FROM v41_reports WHERE reporter=?").run(actor);this.db.prepare("UPDATE v41_reports SET target=?,detail='' WHERE target=?").run(tombstone,actor);
   this.db.prepare('UPDATE v41_privacy_requests SET actor=?,state=?,updated_at=?,completed_at=?,note=? WHERE id=?').run(tombstone,'completed',now,now,'',receiptId);
   this.db.prepare('INSERT INTO v41_deletion_receipts VALUES(?,?,?,?,?,?)').run(receiptId,actorHash,tombstone,now,policyVersion,json(['purchase_replay_records','operator_security_audit','pseudonymized_moderation_outcomes']));
   return {deleted:true,receiptId,policyVersion};
  });
 }
 save(actor,expected,payload){this.requireAccount(actor);if(!Number.isSafeInteger(expected)||expected<0)fail('INVALID_REVISION');this.rate(actor,'save',20);const clean=sanitizePractice(payload);return this.tx(()=>{const current=this.repositories().saves.revisionOf(actor);if(current!==expected)fail('SAVE_CONFLICT');const revision=expected+1;this.db.prepare('INSERT INTO profile_saves VALUES(?,?,?,?) ON CONFLICT(actor) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated=excluded.updated').run(actor,revision,json(clean),this.now());return {revision,updated:this.now()};});}
 restore(actor){this.requireAccount(actor);const row=this.repositories().saves.for(actor);return row?{revision:row.revision,updated:row.updated,practice:JSON.parse(row.payload)}:{revision:0,practice:null};}
 cleanup(){const now=this.now();this.db.prepare('DELETE FROM signin_attempts WHERE expires<?').run(now-3600000);this.db.prepare('DELETE FROM email_challenges WHERE expires<? OR consumed=1 AND created<?').run(now-3600000,now-DAY);this.db.prepare('DELETE FROM account_sessions WHERE expires<?').run(now);this.db.prepare('DELETE FROM session_presence WHERE seen<?').run(now-3600000);if(this.db.prepare('SELECT COUNT(*) n FROM community_limits').get().n>10000)this.db.prepare('DELETE FROM community_limits WHERE rowid IN (SELECT rowid FROM community_limits ORDER BY rowid LIMIT 1000)').run();}
}
module.exports={CommunityStore,AVATARS,sanitizePractice};
