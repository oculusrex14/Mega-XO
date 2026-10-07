'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const G=require('../src/game.js'),D=require('../src/domain.js'),T=require('../src/tournament.js'),MM=require('../server/matchmaking.js');
const {Authority}=require('../src/authority.js');
const {assess}=require('../server/competition-compliance.js');
const {config}=require('../server/production/config.js');

test('INVARIANT: chosen cell routes the next player to the matching Mini Board',()=>{
 let s=G.create('X');s=G.apply(s,{b:4,c:2});assert.equal(s.required,2);assert(G.legal(s).every(m=>m.b===2));
});
test('INVARIANT: resolved destination creates a Free Route, never a dead turn',()=>{
 let s=G.create('X');s=G.apply(s,{b:4,c:2});s={...s,mini:s.mini.slice()};s.mini[2]='O';const legal=G.legal(s);assert(legal.length>0);assert(legal.some(m=>m.b!==2));assert(legal.every(m=>m.b!==2));
});
test('INVARIANT: three claimed Mini Boards in line wins the Mega Board',()=>{
 let s=G.create('X');s.mini=['X','X',null,null,null,null,null,null,null];s.board[2]=['X','X',null,null,null,null,null,null,null];s.required=2;s=G.apply(s,{b:2,c:2});assert.equal(s.mini[2],'X');assert.equal(s.winner,'X');assert.deepEqual(s.line,[0,1,2]);
});
test('INVARIANT: settled rated-match Elo is identical at different direct stake sizes',()=>{
 const now=Date.parse('2026-11-02T12:00:00Z'),minimum=D.quote({mode:'direct',from:'gold',to:'diamond'}).minimum;
 const settle=amount=>{const a=new Authority({paidEntryEnabled:true,eligibility:()=>true,now:()=>now,random:()=>0});a.addAccount('challenger',{verified:true,games:50,rating:1500,crowns:10000,createdAt:now-100*D.DAY});a.addAccount('target',{verified:true,games:50,rating:1800,crowns:10000,createdAt:now-100*D.DAY});const offer=a.offer('match','challenger','target',{kind:'leaderboard',amount});a.accept('match','target',offer.termsHash);const receipt=a.resign('match','target');return {pool:offer.quote.pool,rating:receipt.rating,a:a.account('challenger').rating,b:a.account('target').rating};};
 const small=settle(minimum),large=settle(minimum*20);assert.notEqual(small.pool,large.pool);assert.deepEqual(large.rating,small.rating);assert.equal(large.a,small.a);assert.equal(large.b,small.b);
});
test('INVARIANT: matchmade Ranked always uses equal Coin entries and retires half the pot',()=>{
 for(const A of D.TIERS)for(const B of D.TIERS){const q=D.quote({mode:'ranked',from:A.id,to:B.id});assert.equal(q.currency,'coins');assert.equal(q.contributions[0],q.contributions[1]);assert.equal(q.pool,q.contributions[0]*2);assert.equal(q.burn,q.pool/2);assert.equal(q.payout,q.pool/2);}
});
test('INVARIANT: ranked direct challenge is challenger-funded with 50/50 payout-retirement',()=>{
 for(const A of D.TIERS)for(const B of D.TIERS.slice(A.index)){const q=D.quote({mode:'direct',kind:'leaderboard',from:A.id,to:B.id});assert.deepEqual(q.contributions,[q.pool,0]);assert.equal(q.burn,q.pool/2);assert.equal(q.payout,q.pool/2);assert.equal(q.bonus,0);}
});
test('INVARIANT: 10:1 Coin/Crown exchange preserves total wealth exactly',()=>{
 const d=D.fresh(),before=D.wealth(d.wallet);D.convert(d,'coins',100,'invariant-c2c');assert.equal(d.wallet.crowns,10);assert.equal(D.wealth(d.wallet),before);D.convert(d,'crowns',10,'invariant-c2coin');assert.equal(D.wealth(d.wallet),before);
});
test('INVARIANT: every public tournament conserves pool, retires 10%, and fifth breaks even',()=>{
 for(const id of Object.keys(T.TABLES)){const q=T.prize(id);assert.equal(q.pool,q.entry*10);assert.equal(q.burn,q.pool*.1);assert.equal(q.payouts.reduce((n,x)=>n+x,0)+q.burn,q.pool);assert.equal(q.payouts[4],q.entry);}
});
test('INVARIANT: public tournament matchmaking has a permanent 200-Elo cohort cap',()=>{assert.equal(MM.CONFIG.tournament.hardMax,200);});
test('INVARIANT: quarterly season requalification is 5 rated / 3 queue / 3 opponents',()=>{
 const now=Date.parse('2026-11-15T00:00:00Z'),base={verified:true,games:50,rating:1800,season:{id:D.season(now).id,games:5,queueGames:3,opponents:['a','b','c'],lastRatedAt:now}};assert.equal(D.seasonQualified(base,now),true);assert.equal(D.seasonQualified({...base,season:{...base.season,queueGames:2}},now),false);
});
test('INVARIANT: direct challenges can contribute activity but cannot replace matchmade season games',()=>{
 const now=Date.parse('2026-11-15T00:00:00Z'),p={verified:true,games:50,rating:1800,season:{id:D.season(now).id,games:20,queueGames:0,opponents:['a','b','c','d','e'],lastRatedAt:now}};assert.equal(D.seasonQualified(p,now),false);p.season.queueGames=3;assert.equal(D.seasonQualified(p,now),true);
});
test('INVARIANT: weekly league publication releases an inactive elite seat without deleting Elo',()=>{
 let now=Date.parse('2026-11-02T12:00:00Z');const a=new Authority({now:()=>now}),season=D.season(now);
 const base=(id,rating=2000)=>({id,verified:true,suspended:false,hold:false,games:50,rating,peak:rating,reachedAt:now-D.DAY,createdAt:now-100*D.DAY,tier:D.basicTier(rating).id,history:[],seasonHistory:[],season:{id:season.id,startedAt:season.start,games:5,queueGames:3,opponents:['s1','s2','s3'],wins:3,losses:2,draws:0,peakRating:rating,lastRatedAt:now-D.DAY,qualifiedAt:now-D.DAY}});
 for(let i=0;i<D.POLICY.elitePopulation-1;i++)a.accounts.set('f'+i,base('f'+i));
 const elite=base('elite',2700);elite.games=100;elite.history=[...Array.from({length:5},(_,i)=>({rated:true,activityQualified:true,queue:i<3,opponent:'recent'+i,at:now-D.DAY})),...Array.from({length:5},(_,i)=>({rated:true,activityQualified:true,queue:false,opponent:'older'+i,at:now-30*D.DAY}))];a.accounts.set('elite',elite);
 a.publishLeagues();assert.equal(a.account('elite').tier,'grandmaster');const preserved=a.account('elite').rating;
 now+=7*D.DAY;a.publishLeagues();assert.equal(a.account('elite').tier,'emerald');assert.equal(a.account('elite').rating,preserved);assert.equal(D.skillLeaderboardEligible(a.account('elite'),now),true);
});
test('INVARIANT: online competitive results cannot be injected through offline completion',()=>{assert.throws(()=>D.complete(D.fresh(),{id:'fake',mode:'ranked',result:'win',reason:'line',moves:40,activeSeconds:120}),/SERVER_RESULT_REQUIRED/);});
test('INVARIANT: player-facing direct API cannot choose a matchmade opponent',()=>{
 const a=new Authority();a.addAccount('a',{verified:true,games:20});a.addAccount('b',{verified:true,games:20});assert.throws(()=>a.offer('x','a','b',{mode:'queue'}),/MATCHMAKER_REQUIRED/);
});
test('INVARIANT: tournament records are aggregates, not replay payloads',()=>{const x=D.tournamentStats({entered:2,wins:1,finishSum:3,bestFinish:1});assert.deepEqual(Object.keys(x).sort(),['averageFinish','bestFinish','entered','premiumWins','runnerUp','top3','top5','winRate','wins'].sort());});


test('INVARIANT: current pooled competition mechanics cannot pass the P1-7 compliance baseline',()=>{
 const policy={enabled:true,version:'invariant-policy',approvalId:'invariant-approval',effectiveAt:'2026-10-01T00:00:00Z',expiresAt:'2026-12-31T23:59:59Z',allowPurchasedCurrency:false,allowPooledStake:false,allowCashOut:false,allowRealWorldPrize:false,prizeFunding:'organizer',jurisdictions:[{country:'GB',platforms:['web'],minAge:18,legalReviewId:'invariant-gb-review'}]};
 const context={policy,platform:'web',location:{trusted:true,country:'GB',proxyRisk:false},age:{verified:true,age:21,verifiedAt:'2026-10-01T00:00:00Z'},spend:{entryToday:0,lossToday:0},now:Date.parse('2026-11-01T00:00:00Z')};
 for(const entry of [D.quote({mode:'ranked',from:'gold',to:'gold'}),D.quote({mode:'direct',kind:'friend',from:'gold',to:'gold',amount:20}),...Object.keys(T.TABLES).map(T.prize)])assert.equal(assess({...context,entry}).code,'POOLED_STAKE_PROHIBITED');
});

test('INVARIANT: production refuses the paid-entry feature flag until EXT-26 approval',()=>{
 const base={MEGA_ENV:'production',MEGA_ORIGIN:'https://play.antimatterinnovations.com',MEGA_DB:'/data/mega.sqlite',MEGA_OTP_SECRET:'1'.repeat(64),MEGA_PROXY_SECRET:'2'.repeat(64)};
 assert.throws(()=>config({...base,MEGA_PAID_ENTRY_ENABLED:'true'}),/PAID_FEATURES_NOT_RELEASED/);
});
