'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {AbuseGuard}=require('../server/production/abuse-guard');
const {DurableStore}=require('../server/economy-store');
const {CommunityStore}=require('../server/community-store');
const {migrate}=require('../server/production/migrations');
const {Passwords}=require('../server/production/passwords');
const {MailOutbox}=require('../server/production/mail-outbox');
const {EmailAuth}=require('../server/production/email-auth');
const {MonetizationStore}=require('../server/monetization-store');
const {Authority}=require('../src/authority');
const MM=require('../server/matchmaking');
const ABUSE=require('../server/competitive-abuse');
const D=require('../src/domain');

function authFixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-p1-abuse-auth-'));let now=Date.parse('2026-10-07T10:00:00Z');
 const store=new DurableStore(path.join(dir,'db.sqlite'),{now:()=>now}),community=new CommunityStore({store,origin:'https://game.test',now:()=>now});migrate(store.db);
 const secret='a'.repeat(64),passwords=new Passwords({concurrency:1}),transport={enabled:()=>true,sendOtp:async()=>{},sendPasswordChanged:async()=>{},sendSecurityNotice:async()=>{}};
 const outbox=new MailOutbox(community,{secret,transport,now:()=>now}),auth=new EmailAuth(community,{secret,passwords,outbox,now:()=>now});
 const code=id=>outbox.open(store.db.prepare('SELECT payload FROM v4_outbox WHERE id=?').get(id).payload).code;
 const create=async(address='known@example.com')=>{const g=community.bootstrap(),p=await auth.continue(g.token,address,'correct-horse-42');return auth.verify(g.token,p.challengeId,code(p.challengeId));};
 t.after(()=>{outbox.close();passwords.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {store,community,auth,outbox,code,create,advance:ms=>now+=ms,now:()=>now};
}
function moneyFixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-p1-abuse-money-'));let now=Date.parse('2026-10-07T10:00:00Z');
 const store=new DurableStore(path.join(dir,'db.sqlite'),{now:()=>now});migrate(store.db);const a=store.read();
 a.addAccount('alice',{verified:true,games:30,coins:1000,crowns:0});a.addAccount('bob',{verified:true,games:30,coins:1000,crowns:0});store.write(a);
 const receipts=new Map([['real',{valid:true,accountId:'alice',store:'apple',transactionId:'tx-p1-9',productId:'crowns_100'}]]);
 const service=new MonetizationStore(store,{now:()=>now,purchasesEnabled:true,eligible:()=>true,verifyPurchase:async evidence=>receipts.get(evidence)||{valid:false},adMode:'rewarded',adUnit:'rewarded-unit',rewardItem:'cosmetic_reward',verifyAd:async event=>event});
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {store,service,now:()=>now,advance:ms=>now+=ms};
}
function account(id,rating,{friends=[],history=[],games=30}={}){return {id,rating,games,casualRating:rating,verified:true,friends,blocked:[],history,coins:1000,crowns:1000,suspended:false,hold:false,activeMatch:null};}
function ticket(actor,joinedAt=0){return {actor,mode:'ranked',joinedAt,region:'global',latencyMs:40};}

test('P1-9 credential stuffing: sensitive login attempts are persistently IP throttled',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-p1-abuse-ip-')),db=new DatabaseSync(path.join(dir,'db.sqlite'));db.exec('CREATE TABLE v4_limits(id TEXT PRIMARY KEY,hits INTEGER NOT NULL,expires INTEGER NOT NULL)');
 let now=1000000;const ip='198.51.100.51',guard=new AbuseGuard(db,{secret:'s'.repeat(64),now:()=>now});
 for(let i=0;i<12;i++)assert.equal(guard.sensitive(ip,'/api/account/email','POST',{action:'continue'}),true);
 assert.equal(guard.sensitive(ip,'/api/account/email','POST',{action:'continue'}),false);
 const recovered=new AbuseGuard(db,{secret:'s'.repeat(64),now:()=>now});assert.equal(recovered.sensitive(ip,'/api/account/email','POST',{action:'continue'}),false);
 assert.equal(db.prepare('SELECT id FROM v4_limits').all().some(x=>x.id.includes(ip)),false);
 db.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('P1-9 OTP abuse: codes are session-bound, attempt-limited and superseded on resend',async t=>{
 const f=authFixture(t),a=f.community.bootstrap(),b=f.community.bootstrap(),p=await f.auth.continue(a.token,'otp@example.com','correct-horse-42'),good=f.code(p.challengeId),bad=good==='000000'?'111111':'000000';
 assert.throws(()=>f.auth.verify(b.token,p.challengeId,good),/INVALID_OTP/);
 for(let i=0;i<5;i++)assert.throws(()=>f.auth.verify(a.token,p.challengeId,bad),/INVALID_OTP/);
 assert.throws(()=>f.auth.verify(a.token,p.challengeId,good),/OTP_LOCKED/);
 f.advance(61000);const fresh=await f.auth.continue(a.token,'otp@example.com','correct-horse-42');
 assert.throws(()=>f.auth.verify(a.token,p.challengeId,good),/INVALID_OTP/);
 assert(f.auth.verify(a.token,fresh.challengeId,f.code(fresh.challengeId)).actor);
});

test('P1-9 account enumeration: forgot-password response does not reveal account existence',async t=>{
 const f=authFixture(t);await f.create('known@example.com');const known=f.auth.forgot(f.community.bootstrap().token,'known@example.com');
 f.advance(61000);const missing=f.auth.forgot(f.community.bootstrap().token,'missing@example.com');
 assert.deepEqual(Object.keys(known).sort(),Object.keys(missing).sort());assert.equal(known.message,missing.message);assert.equal(known.email.replace(/^.\*\*\*/,'***'),missing.email.replace(/^.\*\*\*/,'***'));
 assert(f.store.db.prepare('SELECT 1 FROM v4_outbox WHERE id=?').get(known.challengeId));assert.equal(f.store.db.prepare('SELECT 1 FROM v4_outbox WHERE id=?').get(missing.challengeId),undefined);
});

test('P1-9 purchase replay: one verified store transaction grants Crowns exactly once',async t=>{
 const f=moneyFixture(t);const first=await f.service.purchase('alice','purchase-1','real'),afterFirst=f.store.read().account('alice').crowns;
 const replay=await f.service.purchase('alice','purchase-2','real');assert.equal(first.duplicate,false);assert.equal(replay.duplicate,true);assert.equal(f.store.read().account('alice').crowns,afterFirst);
 await assert.rejects(()=>f.service.purchase('bob','purchase-steal','real'),/INVALID_RECEIPT/);
});

test('P1-9 ad-reward replay: duplicate signed reward is idempotent and cannot grant twice',async t=>{
 const f=moneyFixture(t),q=f.service.ticket('alice','ticket-1','credits'),event={actor:'alice',ticket:q.ticket,transactionId:'ad-tx-1',rewardItem:'cosmetic_reward',amount:1,timestamp:f.now(),adUnit:'rewarded-unit'};
 const one=await f.service.callback(event),credits=one.credits,two=await f.service.callback(event);assert.equal(two.credits,credits);assert.equal(f.service.status('alice').credits,credits);
 const q2=(()=>{f.advance(D.DAY);return f.service.ticket('alice','ticket-2','credits');})();await assert.rejects(()=>f.service.callback({...event,ticket:q2.ticket}),/IDEMPOTENCY_CONFLICT|AD_TRANSACTION_USED/);
});

test('P1-9 challenge collusion: rapid rated win-trading is bounded and short direct results are flagged',()=>{
 let now=Date.parse('2026-10-07T10:00:00Z');const a=new Authority({paidEntryEnabled:true,eligibility:()=>true,now:()=>now,random:()=>0});
 a.addAccount('a',{verified:true,games:30,rating:1500,crowns:100});a.addAccount('b',{verified:true,games:30,rating:1500,crowns:100});a.account('a').friends=['b'];a.account('b').friends=['a'];
 const q=a.offer('d1','a','b',{kind:'friend',amount:2});a.accept('d1','b',q.termsHash);a.resign('d1','b');
 assert(a.view('d1').riskFlags.includes('SHORT_DIRECT_RESULT_REVIEW'));assert.throws(()=>a.offer('d2','a','b',{kind:'friend',amount:2}),/RATED_PAIR_LIMIT/);
});

test('P1-9 tournament collusion: public matchmaking separates friends and suspicious forfeits are review-only',()=>{
 const A=account('a',1500,{friends:['b']}),B=account('b',1510,{friends:['a']}),C=account('c',1520),economy={accounts:new Map([['a',A],['b',B],['c',C]])};
 const friendRoom={id:'friend',table:'low',status:'LOBBY',created:0,expires:999999,players:[{id:'b'}]};
 assert.equal(MM.selectTournamentRoom([friendRoom],economy,'a','low',70000),null);
 assert.equal(MM.selectTournamentRoom([{...friendRoom,id:'open',players:[{id:'c'}]}],economy,'a','low',70000).id,'open');
 const signals=ABUSE.tournamentSignals({fixtures:[
  {players:['a','b'],winner:'a',reason:'resign'},{players:['a','c'],winner:'a',reason:'no-show'},{players:['a','d'],winner:'a',reason:'timeout'},{players:['e','f'],winner:'e',reason:'resign'},{players:['g','h'],winner:'g',reason:'resign'}
 ]});
 assert(signals.flags.includes('CONCENTRATED_FORFEITS_REVIEW'));assert(signals.flags.includes('HIGH_FORFEIT_RATE'));
});

test('P1-9 leaderboard boosting: friends/recent opponents cannot farm ranked queue and short results do not satisfy activity qualification',()=>{
 const now=Date.parse('2026-10-07T10:00:00Z'),A=account('a',1500,{friends:['b']}),B=account('b',1510,{friends:['a']});
 assert.equal(MM.compatibility(A,B,ticket('a',now-10000),ticket('b',now-10000),'ranked',now).reason,'FRIEND_QUEUE_BLOCK');
 A.friends=[];B.friends=[];A.history=[{id:'recent',opponent:'b',queue:true,rated:true,at:now-1000}];assert.equal(MM.compatibility(A,B,ticket('a',now-10000),ticket('b',now-10000),'ranked',now).reason,'RECENT_OPPONENT');
 let clock=now;const authority=new Authority({paidEntryEnabled:true,eligibility:()=>true,now:()=>clock,random:()=>0});authority.addAccount('x',{verified:true,games:30,rating:1500,crowns:100});authority.addAccount('y',{verified:true,games:30,rating:1500,crowns:100});authority.account('x').friends=['y'];authority.account('y').friends=['x'];
 const q=authority.offer('short','x','y',{kind:'friend',amount:2});authority.accept('short','y',q.termsHash);authority.resign('short','y');
 assert.equal(authority.account('x').history.at(-1).activityQualified,false);assert.equal(authority.seasonStatus(authority.account('x')).games,0);assert.equal(D.skillLeaderboardEligible(authority.account('x'),clock),false);
});

test('P1-9 bot/solver abuse: clients cannot forge results and extreme automated cadence is surfaced for review',()=>{
 const fast=[...Array(10)].map((_,i)=>({actor:'botlike',ms:i<3?50:180}));assert.deepEqual(ABUSE.automationActors(fast),['botlike']);
 const a=new Authority({paidEntryEnabled:true,eligibility:()=>true,random:()=>0});a.addAccount('a',{verified:true,games:30,rating:1500,crowns:100});a.addAccount('b',{verified:true,games:30,rating:1500,crowns:100});a.account('a').friends=['b'];a.account('b').friends=['a'];
 const q=a.offer('m','a','b',{kind:'friend',amount:2});a.accept('m','b',q.termsHash);const m=a.matches.get('m'),wrong=m.symbols.X==='a'?'b':'a';
 assert.throws(()=>a.move('m',wrong,0,'wrong-turn',{b:0,c:0}),/NOT_YOUR_TURN/);assert.equal(a.view('m').receipt,undefined);
 assert.equal(typeof a.result,'undefined');
});
