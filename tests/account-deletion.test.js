'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DurableStore}=require('../server/economy-store');
const {CommunityStore}=require('../server/community-store');
const {migrate}=require('../server/production/migrations');

function add(c,store,now){
 const a=store.read(),id='u_'+crypto.randomUUID();a.addAccount(id,{verified:true,createdAt:now-86400000});c.ensureProfile(id,a);c.write(a);return id;
}
function fixture(t,{enabled=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-delete-')),store=new DurableStore(path.join(dir,'db.sqlite'));let now=Date.parse('2026-10-06T16:00:00Z');
 const c=new CommunityStore({store,origin:'https://game.test',now:()=>now,deletionPolicy:{enabled,policyVersion:enabled?'privacy-2026-10':''}});migrate(store.db);
 const actor=add(c,store,now),friend=add(c,store,now),other=add(c,store,now),profile=c.profileRow(actor);
 const salt='delete-salt',password='delete-password-hash';
 store.db.prepare('INSERT INTO email_credentials(email,actor,salt,password_hash,created,verified_at) VALUES(?,?,?,?,?,?)').run('delete@example.com',actor,salt,password,now,now);
 store.db.prepare('INSERT INTO identities VALUES(?,?,?,?)').run('email','delete@example.com',actor,now);
 store.db.prepare('INSERT INTO identities VALUES(?,?,?,?)').run('google','google-delete-subject',actor,now);
 store.db.prepare('INSERT INTO profile_saves VALUES(?,?,?,?)').run(actor,1,JSON.stringify({version:3.2,economyVersion:3.2,settings:{theme:'vector'},records:[],processed:[],playSeconds:0,wallet:{coins:0,crowns:0,ledger:[],owned:[]},daily:{},weekly:{},legacy:{},profile:{},offlineMatch:null}),now);
 const a=store.read();
 a.account(actor).friends=[friend];a.account(friend).friends=[actor];a.account(other).friendRequests=[actor];a.account(friend).blocked=[actor];
 a.account(friend).history=[{id:'historic',at:now-1000,opponent:actor,mode:'casual',queue:true,rated:false,qualified:true,result:'loss',reason:'line',activeSeconds:90}];
 a.account(friend).season.opponents=[actor];a.receipts.set('google:historic-token-hash',{actor,productId:'crowns_100',crowns:100,refunded:false,at:now-2000});
 a.journal.push({id:'private-ledger',actor,currency:'coins',amount:1,reason:'Test',source:'test',at:now});
 a.matches.set('historic',{id:'historic',players:[actor,friend],accepted:[actor,friend],status:'FINISHED',symbols:{X:actor,O:friend},receipt:{winner:actor,payout:0,burn:0},commands:new Map()});
 c.write(a);
 c.report(actor,other,'cheating','Submitted report should be erased with reporter');
 c.report(friend,actor,'username','Reporter free text about deleted profile must not survive');
 const session=c._issue(actor,now);
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {store,c,actor,friend,other,profile,session,now:()=>now,advance:ms=>now+=ms};
}
test('deletion is policy gated, needs recent auth and exact player-tag confirmation',t=>{
 const disabled=fixture(t,{enabled:false});assert.equal(disabled.c.deletionStatus(disabled.session.token).available,false);
 assert.throws(()=>disabled.c.deleteAccount(disabled.session.token,disabled.profile.tag),/ACCOUNT_DELETION_UNAVAILABLE/);
});
test('deletion rejects stale auth, wrong confirmation and active competitive work',t=>{
 const f=fixture(t);
 assert.throws(()=>f.c.deleteAccount(f.session.token,'WRONG-TAG'),/DELETE_CONFIRMATION_REQUIRED/);
 const stale=f.c._issue(f.actor,f.now());f.advance(16*60000);assert.throws(()=>f.c.deleteAccount(stale.token,f.profile.tag),/REAUTH_REQUIRED/);
 const fresh=f.c._issue(f.actor,f.now()),a=f.store.read();a.account(f.actor).activeMatch='live-match';f.c.write(a);
 assert.throws(()=>f.c.deleteAccount(fresh.token,f.profile.tag),/ACCOUNT_BUSY/);
});
test('permanent deletion revokes identity and scrubs profile/social/cloud data while retaining only pseudonymous integrity records',t=>{
 const f=fixture(t),tag=f.profile.tag,deleted=f.c.deleteAccount(f.session.token,tag);
 assert.equal(deleted.deleted,true);assert.equal(deleted.policyVersion,'privacy-2026-10');assert.match(deleted.receiptId,/^del_/);
 assert.equal(f.c.session(f.session.token),null);
 assert.equal(f.store.db.prepare('SELECT * FROM profiles WHERE actor=?').get(f.actor),undefined);
 assert.equal(f.store.db.prepare('SELECT * FROM identities WHERE actor=?').get(f.actor),undefined);
 assert.equal(f.store.db.prepare('SELECT * FROM email_credentials WHERE actor=?').get(f.actor),undefined);
 assert.equal(f.store.db.prepare('SELECT * FROM profile_saves WHERE actor=?').get(f.actor),undefined);
 const a=f.store.read();assert.equal(a.accounts.has(f.actor),false);
 assert.equal(a.account(f.friend).friends.includes(f.actor),false);assert.equal(a.account(f.friend).blocked.includes(f.actor),false);assert.equal(a.account(f.other).friendRequests.includes(f.actor),false);
 const opponent=a.account(f.friend).history[0].opponent;assert.match(opponent,/^deleted_[a-f0-9]+$/);assert.notEqual(opponent,f.actor);
 assert.equal(a.account(f.friend).season.opponents.includes(f.actor),false);
 const match=a.matches.get('historic');assert.equal(match.players.includes(f.actor),false);assert.equal(match.symbols.X,opponent);assert.equal(match.receipt.winner,opponent);
 const receipt=a.receipts.get('google:historic-token-hash');assert.equal(receipt.actor,opponent);assert.equal(receipt.refunded,false);
 assert.equal(a.journal.some(x=>x.actor===f.actor),false);
 assert.equal(f.store.db.prepare('SELECT 1 FROM v41_reports WHERE reporter=?').get(f.actor),undefined);
 const against=f.store.db.prepare('SELECT target,detail FROM v41_reports WHERE target=?').get(opponent);assert.equal(against.target,opponent);assert.equal(against.detail,'');
 const proof=f.store.db.prepare('SELECT * FROM v41_deletion_receipts WHERE id=?').get(deleted.receiptId);assert(proof);assert.equal(JSON.stringify(proof).includes('delete@example.com'),false);assert.equal(JSON.stringify(proof).includes(tag),false);assert.equal(JSON.stringify(proof).includes(f.actor),false);
 const request=f.store.db.prepare('SELECT actor,state FROM v41_privacy_requests WHERE id=?').get(deleted.receiptId);assert.equal(request.actor,opponent);assert.equal(request.state,'completed');
});
test('a deleted Google identity can create a new profile but can never restore the former player tag',t=>{
 const f=fixture(t),oldTag=f.profile.tag;f.c.deleteAccount(f.session.token,oldTag);
 const guest=f.c.bootstrap(),started=f.c.start(guest.token,'google','login','native'),attempt=f.c.consume(guest.token,started.state,'google','native');
 const next=f.c.finishVerified(guest.token,attempt,{provider:'google',subject:'google-delete-subject'});
 assert.equal(next.created,true);assert.notEqual(next.actor,f.actor);assert.notEqual(next.profile.tag,oldTag);
 assert.equal(f.store.read().accounts.has(f.actor),false);
});
