'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../../src/game.js');
const C = require('../../src/bot/contracts.js');
const B = require('../../src/bot/board.js');
const S = require('../../src/bot/search.js');
const T = require('./tactics.cjs');

test('all curated tactical fixtures are reachably legal and non-terminal', () => {
  assert.ok(Object.keys(T.CURATED).length >= 10, 'must have at least 10 curated categories');
  for (const [id, fixture] of Object.entries(T.CURATED)) {
    let s = G.create(fixture.first);
    for (const m of fixture.moves) {
      assert.ok(G.legal(s).some(x => C.sameMove(x, m)), `${id} illegal move ${JSON.stringify(m)}`);
      s = G.apply(s, m);
    }
    assert.equal(s.winner, null, `${id} must be an active in-progress state`);
    assert.ok(G.legal(s).length > 0, `${id} must have legal moves`);
  }
});

test('curated fork creates two or more simultaneous winning threats in mini-board', () => {
  const fixture = T.CURATED['curated-fork'];
  let s = G.create(fixture.first);
  for (const m of fixture.moves) s = G.apply(s, m);

  const options = T.goals(s);
  const forkMove = options.find(x => x.createsFork);
  assert.ok(forkMove, 'curated fork fixture must have at least one move creating a local fork');

  // Verify mathematical correctness: move creates >= 2 threats in mini board
  const next = G.apply(s, forkMove.move);
  const t = B.fromCanonical(next);
  const ownMarks = s.turn === 'X' ? t.x[forkMove.move.b] : t.o[forkMove.move.b];
  const oppMarks = s.turn === 'X' ? t.o[forkMove.move.b] : t.x[forkMove.move.b];
  const threats = B.threats(ownMarks, oppMarks);
  assert.ok(B.POP[threats] >= 2, `fork move must create >= 2 threats, got ${B.POP[threats]}`);
});

test('curated sacrifice-to-win concedes mini but guarantees global Mega win across all replies', () => {
  const fixture = T.CURATED['sacrifice-to-win'];
  let s = G.create(fixture.first);
  for (const m of fixture.moves) s = G.apply(s, m);

  const options = T.goals(s);
  const sacMove = options.find(x => x.sacrificeToWin);
  assert.ok(sacMove, 'sacrifice fixture must have a sacrificeToWin move');

  // Verify mathematical correctness of sacrifice-to-win
  assert.equal(sacMove.givesMini, true, 'must concede mini-board to opponent');
  assert.equal(sacMove.losesNext, false, 'must not allow opponent to win Mega game on reply');

  const next = G.apply(s, sacMove.move);
  const replies = G.legal(next);
  assert.ok(replies.length > 0);

  // Every reply leads to state where current player can immediately win the Mega game
  const forcedWin = replies.every(reply => {
    const s2 = G.apply(next, reply);
    const counters = G.legal(s2);
    return counters.some(c => G.apply(s2, c).winner === s.turn);
  });
  assert.equal(forcedWin, true, 'every opponent reply must allow an immediate Mega win next ply');
});

test('mandatory global defense blocks immediate opponent Mega win without asserting invented unique move', () => {
  const fixture = T.CURATED['mandatory-global-defense'];
  let s = G.create(fixture.first);
  for (const m of fixture.moves) s = G.apply(s, m);

  const options = T.goals(s);
  const safeMoves = options.filter(x => !x.losesNext);
  const losingMoves = options.filter(x => x.losesNext);

  assert.ok(safeMoves.length > 0, 'must have at least one defending move');
  assert.ok(losingMoves.length > 0, 'must have losing moves to be a mandatory defense test');

  // verifyCritical permits ANY safe move, does not assert an invented unique move
  for (const safe of safeMoves) {
    assert.equal(T.verifyCritical(s, safe.move), true);
  }
  for (const losing of losingMoves) {
    assert.equal(T.verifyCritical(s, losing.move), false);
  }
});

test('immediate Mega win is taken and non-winning moves are rejected', () => {
  const fixture = T.CURATED['mega-win'];
  let s = G.create(fixture.first);
  for (const m of fixture.moves) s = G.apply(s, m);

  const options = T.goals(s);
  const winningMoves = options.filter(x => x.megaWin);
  const nonWinning = options.filter(x => !x.megaWin);

  assert.ok(winningMoves.length > 0, 'must have a winning move');
  assert.ok(nonWinning.length > 0, 'must have non-winning moves');

  for (const win of winningMoves) {
    assert.equal(T.verifyCritical(s, win.move), true);
    assert.equal(G.apply(s, win.move).winner, s.turn);
  }
  for (const nonWin of nonWinning) {
    assert.equal(T.verifyCritical(s, nonWin.move), false);
  }
});

test('search choose and mcts never miss exact one-ply global win or mandatory defense in corpus', () => {
  const corpus = T.corpus();
  for (const item of corpus) {
    let s = G.create(item.first);
    for (const m of item.moves) s = G.apply(s, m);

    // Alpha-beta search
    const rChoose = S.choose(s, { difficulty: 'Expert', seed: 42, budgetMs: 25, nodeBudget: 1000 });
    assert.ok(C.assertMove(s, rChoose.move));
    assert.equal(T.verifyCritical(s, rChoose.move), true, `S.choose missed critical tactic on ${item.id}`);

    // MCTS baseline
    const rMcts = S.mcts(s, { difficulty: 'Expert', seed: 42, budgetMs: 25, nodeBudget: 1000, simulations: 32 });
    assert.ok(C.assertMove(s, rMcts.move));
    assert.equal(T.verifyCritical(s, rMcts.move), true, `S.mcts missed critical tactic on ${item.id}`);
  }
});
