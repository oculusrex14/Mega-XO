'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const G=require('../../src/game.js'),R=require('./runner.cjs'),T=require('./tactics.cjs');
test('paired runner reverses sides, starters and replays legal whole games',()=>{const x=R.league(R.legacy('Easy'),R.legacy('Beginner'),{pairs:3}),y=R.league(R.legacy('Easy'),R.legacy('Beginner'),{pairs:3});assert.deepEqual(x.games.map(g=>g.moves),y.games.map(g=>g.moves));assert.equal(x.summary.games,6);assert.equal(x.games[1].swap,true);assert.equal(x.games[2].first,'O');for(const g of x.games){let s=G.create(g.first);for(const m of g.moves)s=G.apply(s,m);assert.equal(s.winner,g.winner);}});
test('terminal states have no critical moves and illegal suggestions fail',()=>{const state=G.create();assert.equal(T.verifyCritical(state,{b:99,c:0}),false);assert.deepEqual(T.goals({...state,winner:'DRAW'}),[]);});
