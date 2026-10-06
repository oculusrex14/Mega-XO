'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DurableStore}=require('../server/economy-store');
const {CommunityStore}=require('../server/community-store');
const {migrate}=require('../server/production/migrations');
const {config}=require('../server/production/config');

function add(c,store){
 const a=store.read(),id='u_'+crypto.randomUUID();a.addAccount(id,{verified:true,createdAt:Date.now()});c.ensureProfile(id,a);c.write(a);return id;
}
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-privacy-')),store=new DurableStore(path.join(dir,'db.sqlite'));let now=Date.parse('2026-10-06T15:00:00Z');const c=new CommunityStore({store,origin:'https://game.test',now:()=>now});migrate(store.db);
 const actor=add(c,store),friend=add(c,store),other=add(c,store),profile=c.profileRow(actor);
 const salt='SECRET-SALT-VALUE',passwordHash='SECRET-PASSWORD-HASH';
 store.db.prepare('INSERT INTO email_credentials(email,actor,salt,password_hash,created,verified_at) VALUES(?,?,?,?,?,?)').run('owner@example.com',actor,salt,passwordHash,now,now);
 store.db.prepare('INSERT INTO identities VALUES(?,?,?,?)').run('email','owner@example.com',actor,now);
 store.db.prepare('INSERT INTO identities VALUES(?,?,?,?)').run('google','google-subject-123',actor,now);
 const a=store.read();a.account(actor).friends.push(friend);a.account(friend).friends.push(actor);a.account(actor).blocked.push(other);a.account(actor).coins=777;a.account(actor).crowns=12;a.receipts.set('google:tx-private',{actor,productId:'crowns_100',crowns:100,refunded:false,at:now});c.write(a);
 store.db.prepare('INSERT INTO profile_saves VALUES(?,?,?,?)').run(actor,1,JSON.stringify({version:3.2,economyVersion:3.2,settings:{theme:'vector'},records:[],processed:[],playSeconds:0,wallet:{coins:0,crowns:0,ledger:[],owned:[]},daily:{},weekly:{},legacy:{},profile:{},offlineMatch:null}),now);
 const session=c._issue(actor,now);
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {store,c,actor,friend,other,profile,session,advance:ms=>now+=ms,salt,passwordHash};
}
test('personal export includes owned account data while excluding authentication and operator secrets',t=>{
 const f=fixture(t);
 const submitted=f.c.report(f.actor,f.other,'cheating','Repeated impossible move sequence in several games');
 f.c.report(f.friend,f.actor,'username','Review requested for this profile name');
 f.store.db.prepare('INSERT INTO v41_operator_audit VALUES(?,?,?,?,?,?,?,?,?)').run('op_secret',Date.now(),'operator.one','lookup',f.actor,'Private operator reason','{}','GENESIS','audit-secret-hash');
 const data=f.c.exportData(f.session.token),text=JSON.stringify(data);
 assert.equal(data.schemaVersion,1);assert.equal(data.account.playerId,f.actor);assert.equal(data.account.email.address,'owner@example.com');
 assert.equal(data.account.wallet.coins,777);assert.equal(data.account.wallet.crowns,12);
 assert(data.account.identities.some(x=>x.provider==='google'&&x.subject==='google-subject-123'));
 assert.equal(data.account.reportsSubmitted.length,1);assert.equal(data.account.reportsSubmitted[0].id,submitted.id);
 assert.equal(data.account.purchaseReceipts[0].transactionId,'google:tx-private');
 assert.equal(data.account.practiceSave.revision,1);
 for(const forbidden of [f.salt,f.passwordHash,f.session.token,'audit-secret-hash','Private operator reason'])assert.equal(text.includes(forbidden),false,'leaked '+forbidden);
 assert.equal(text.includes('Review requested for this profile name'),false);
 assert.equal(text.includes('csrf'),false);assert.equal(text.includes('code_hash'),false);assert.equal(text.includes('password_hash'),false);
});
test('personal export requires recent reauthentication and is rate limited',t=>{
 const f=fixture(t);
 f.c.exportData(f.session.token);f.c.exportData(f.session.token);f.c.exportData(f.session.token);
 assert.throws(()=>f.c.exportData(f.session.token),/RATE_LIMITED/);
 const fresh=f.c._issue(f.actor,Date.parse('2026-10-06T15:00:00Z'));f.advance(16*60000);
 assert.throws(()=>f.c.exportData(fresh.token),/REAUTH_REQUIRED/);
});
test('account deletion remains fail closed until an approved privacy policy exists',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-config-privacy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const base={MEGA_ENV:'staging',MEGA_ORIGIN:'https://staging.play.antimatterinnovations.com',MEGA_DB:path.join(dir,'db.sqlite'),MEGA_OTP_SECRET:'a'.repeat(64),MEGA_PROXY_SECRET:'b'.repeat(64),MEGA_PAID_ENTRY_ENABLED:'false',MEGA_PURCHASES_ENABLED:'false',MEGA_AD_MODE:'off'};
 assert.throws(()=>config({...base,MEGA_ACCOUNT_DELETION_ENABLED:'true'}),/ACCOUNT_DELETION_POLICY_NOT_APPROVED/);
 const ok=config({...base,MEGA_ACCOUNT_DELETION_ENABLED:'false'});assert.equal(ok.stage,'staging');
 const enabled=config({...base,MEGA_ACCOUNT_DELETION_ENABLED:'true',MEGA_PRIVACY_POLICY_VERSION:'privacy-2026-10'});assert.equal(enabled.privacy.deletionEnabled,true);assert.equal(enabled.privacy.policyVersion,'privacy-2026-10');
});
test('privacy deletion migrations and authenticated routes are present while policy enablement stays explicit',()=>{
 const migrations=require('../server/production/migrations').migrations;
 assert.equal(migrations.some(m=>m.name==='v41-privacy-requests'),true);assert.equal(migrations.some(m=>m.name==='v41-account-deletion-receipts'),true);
 const http=fs.readFileSync(path.join(__dirname,'..','server','community-http.js'),'utf8'),publicPage=fs.readFileSync(path.join(__dirname,'..','public','delete-account.html'),'utf8');
 assert.equal(http.includes("path==='/api/account/delete'"),true);assert.equal(http.includes("path==='/api/account/deletion'"),true);
 assert.match(publicPage,/Delete your Mega XO account/);assert.match(publicPage,/Permanently delete account|Delete account/);
});
