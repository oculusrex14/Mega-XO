'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const G=require('../src/game.js'),D=require('../src/domain.js'),T=require('../src/tournament.js'),MM=require('../server/matchmaking.js');
const {Authority}=require('../src/authority.js');

test('INVARIANT: chosen cell routes the next player to the matching Mini Board',()=>{
 let s=G.create('X');s=G.apply(s,{b:4,c:2});assert.equal(s.required,2);assert(G.legal(s).every(m=>m.b===2));
});
test('INVARIANT: resolved destination creates a Free Route, never a dead turn',()=>{
 let s=G.create('X');s=G.apply(s,{b:4,c:2});s={...s,mini:s.mini.slice()};s.mini[2]='O';const legal=G.legal(s);assert(legal.length>0);assert(legal.some(m=>m.b!==2));assert(legal.every(m=>m.b!==2));
});
test('INVARIANT: three claimed Mini Boards in line wins the Mega Board',()=>{
 let s=G.create('X');s.mini=['X','X',null,null,null,null,null,null,null];s.board[2]=['X','X',null,null,null,null,null,null,null];s.required=2;s=G.apply(s,{b:2,c:2});assert.equal(s.mini[2],'X');assert.equal(s.winner,'X');assert.deepEqual(s.line,[0,1,2]);
});
test('INVARIANT: Elo outcome never accepts or depends on stake/wealth',()=>{
 const base=D.elo(1500,1800,1),small=D.quote({mode:'direct',from:'gold',to:'grandmaster'}),large=D.quote({mode:'direct',from:'gold',to:'grandmaster',amount:100000});assert.equal(small.rated,true);assert.equal(large.rated,true);assert.notEqual(small.pool,large.pool);assert.deepEqual(D.elo(1500,1800,1),base);
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
test('INVARIANT: elite seats require recent matchmade activity and recent rated play',()=>{
 const now=Date.parse('2026-11-15T00:00:00Z'),p={verified:true,games:100,rating:2700,uniqueOpponents:20,recent14Games:5,recent14QueueGames:3,recent14Opponents:3,lastRatedAt:now-D.DAY,createdAt:now-100*D.DAY,season:{id:D.season(now).id,games:8,queueGames:5,opponents:['a','b','c'],lastRatedAt:now-D.DAY}};assert.equal(D.eligible(p,now),true);assert.equal(D.eligible({...p,recent14QueueGames:2},now),false);assert.equal(D.eligible({...p,lastRatedAt:now-8*D.DAY,season:{...p.season,lastRatedAt:now-8*D.DAY}},now),false);
});
test('INVARIANT: online competitive results cannot be injected through offline completion',()=>{assert.throws(()=>D.complete(D.fresh(),{id:'fake',mode:'ranked',result:'win',reason:'line',moves:40,activeSeconds:120}),/SERVER_RESULT_REQUIRED/);});
test('INVARIANT: player-facing direct API cannot choose a matchmade opponent',()=>{
 const a=new Authority();a.addAccount('a',{verified:true,games:20});a.addAccount('b',{verified:true,games:20});assert.throws(()=>a.offer('x','a','b',{mode:'queue'}),/MATCHMAKER_REQUIRED/);
});
test('INVARIANT: tournament records are aggregates, not replay payloads',()=>{const x=D.tournamentStats({entered:2,wins:1,finishSum:3,bestFinish:1});assert.deepEqual(Object.keys(x).sort(),['averageFinish','bestFinish','entered','premiumWins','runnerUp','top3','top5','winRate','wins'].sort());});
