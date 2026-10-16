'use strict';
/* Mega Pass member benefits: the additive 8:1-effective exchange bonus (standard 10:1 conversion
   untouched, purchased-coin provenance intact), the allowance ledger, and the member pack price. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DurableStore}=require('../server/economy-store');
const {CommunityStore}=require('../server/community-store');
const {MonetizationStore}=require('../server/monetization-store');
const M=require('../src/monetization');
const stubPolar={verifyWebhook:()=>false};
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-pass-'));
 let now=Date.parse('2026-11-02T12:00Z');
 const store=new DurableStore(path.join(dir,'db.sqlite'),{now:()=>now});
 const community=new CommunityStore({store,origin:'https://mega.example',now:()=>now});
 const monetization=new MonetizationStore(store,{now:()=>now,polarProvider:stubPolar,cashfreeCatalog:{crowns_100:'99.00',crowns_525:'499.00'}});
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {store,community,monetization,advance:ms=>now+=ms,now:()=>now};
}
function member(t,m,c,months=0){
 const boot=c.bootstrap(),cont=c.emailContinue(boot.token,'pass@example.com','password123');
 const out=c.emailVerify(boot.token,cont.challengeId,cont.delivery.code);
 const actor=out.actor;
 const periodStart=m.now()+months*30*86400000;
 m.db.prepare('INSERT INTO v52_pass(actor,provider,external_id,status,period_start,period_end,canceled_at,updated_at,allowances) VALUES(?,?,?,?,?,?,?,?,?)')
  .run(actor,'polar','sub-test-1','active',periodStart,periodStart+30*86400000,null,m.now(),JSON.stringify({monthKey:M.passMonthKey(m.now()),exchangeCoinsUsed:0,exchangeCarry:0,packDiscountsUsed:0}));
 return {actor,token:out.token};
}
test('exchange bonus credits the exact 8:1-effective difference and replays safely',t=>{
 const {monetization:m,community:c}=fixture(t),{actor}=member(t,m,c);
 const status=m.status(actor);assert.equal(status.pass.active,true);
 const one=m.passExchangeBonus(actor,40,'op-1');
 assert.equal(one.bonus,1);
 assert.equal(m.store.read().account(actor).crowns,1);
 const replay=m.passExchangeBonus(actor,40,'op-1');
 assert.equal(replay.bonus,1);
 assert.equal(m.store.read().account(actor).crowns,1,'replay never double-pays');
 const small=m.passExchangeBonus(actor,10,'op-2');
 assert.equal(small.bonus,0);
 assert.equal(m.store.read().account(actor).crowns,1);
 const carry=m.passExchangeBonus(actor,30,'op-3');
 assert.equal(carry.bonus,1);
 assert.equal(m.store.read().account(actor).crowns,2);
 const row=m.db.prepare('SELECT allowances FROM v52_pass WHERE actor=?').get(actor);
 const allowances=JSON.parse(row.allowances);
 assert.equal(allowances.exchangeCoinsUsed,80);
});
test('non-members get no bonus and the allowance is monthly-bounded',t=>{
 const {monetization:m,community:c}=fixture(t),{actor}=member(t,m,c);
 const guest=c.bootstrap();
 assert.equal(m.passExchangeBonus(guest.token.slice(0,8),40,'op-x'),null);
 m.db.prepare('UPDATE v52_pass SET allowances=? WHERE actor=?').run(JSON.stringify({monthKey:M.passMonthKey(m.now()),exchangeCoinsUsed:200,exchangeCarry:0,packDiscountsUsed:0}),actor);
 assert.equal(m.passExchangeBonus(actor,40,'op-y').bonus,0);
});
test('member pack price applies 15 percent only within monthly uses',t=>{
 const {monetization:m,community:c}=fixture(t),{actor}=member(t,m,c);
 assert.equal(m.passPackPrice(actor,'crowns_525').amount,'424.15');
 assert.equal(m.passPackPrice(actor,'crowns_525').discounted,true);
 const anon='u_'+'0'.repeat(0)+c.bootstrap().token.slice(0,4);
 m.db.prepare('UPDATE v52_pass SET allowances=? WHERE actor=?').run(JSON.stringify({monthKey:M.passMonthKey(m.now()),exchangeCoinsUsed:0,exchangeCarry:0,packDiscountsUsed:2}),actor);
 assert.equal(m.passPackPrice(actor,'crowns_525').discounted,false);
 assert.equal(m.passPackPrice(actor,'crowns_525').amount,'499.00');
});
