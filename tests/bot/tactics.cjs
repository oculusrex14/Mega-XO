'use strict';
const G = require('../../src/game.js');
const C = require('../../src/bot/contracts.js');
const B = require('../../src/bot/board.js');

// Curated canonical fixtures: reachable, legal from G.create(), with mathematically correct goals.
const CURATED = Object.freeze({
  opening: {
    first: 'X',
    moves: []
  },
  'curated-fork': {
    first: 'X',
    moves: [
      { b: 8, c: 7 }, { b: 7, c: 2 }, { b: 2, c: 4 }, { b: 4, c: 7 },
      { b: 7, c: 5 }, { b: 5, c: 3 }, { b: 3, c: 0 }, { b: 0, c: 6 },
      { b: 6, c: 8 }, { b: 8, c: 6 }, { b: 6, c: 3 }, { b: 3, c: 8 },
      { b: 8, c: 8 }, { b: 8, c: 5 }, { b: 5, c: 6 }, { b: 6, c: 1 },
      { b: 1, c: 4 }, { b: 4, c: 2 }, { b: 2, c: 7 }, { b: 7, c: 8 }
    ]
  },
  'sacrifice-to-win': {
    first: 'O',
    moves: [
      { b: 1, c: 1 }, { b: 1, c: 4 }, { b: 4, c: 7 }, { b: 7, c: 7 },
      { b: 7, c: 4 }, { b: 4, c: 3 }, { b: 3, c: 0 }, { b: 0, c: 7 },
      { b: 7, c: 5 }, { b: 5, c: 4 }, { b: 4, c: 1 }, { b: 1, c: 3 },
      { b: 3, c: 2 }, { b: 2, c: 0 }, { b: 0, c: 1 }, { b: 1, c: 6 },
      { b: 6, c: 3 }, { b: 3, c: 6 }, { b: 6, c: 0 }, { b: 0, c: 0 },
      { b: 0, c: 6 }, { b: 6, c: 2 }, { b: 2, c: 2 }, { b: 2, c: 4 },
      { b: 4, c: 6 }, { b: 6, c: 1 }, { b: 1, c: 0 }, { b: 0, c: 8 },
      { b: 8, c: 3 }, { b: 3, c: 1 }, { b: 1, c: 5 }, { b: 5, c: 6 },
      { b: 6, c: 5 }, { b: 5, c: 1 }, { b: 1, c: 7 }, { b: 7, c: 3 },
      { b: 3, c: 7 }, { b: 7, c: 1 }, { b: 1, c: 8 }, { b: 8, c: 8 },
      { b: 8, c: 6 }, { b: 6, c: 6 }, { b: 6, c: 4 }, { b: 4, c: 0 },
      { b: 0, c: 3 }, { b: 3, c: 3 }, { b: 3, c: 8 }, { b: 8, c: 2 },
      { b: 2, c: 6 }, { b: 0, c: 2 }, { b: 2, c: 1 }, { b: 1, c: 2 },
      { b: 2, c: 3 }, { b: 3, c: 4 }, { b: 4, c: 8 }, { b: 8, c: 5 },
      { b: 5, c: 3 }, { b: 3, c: 5 }, { b: 5, c: 8 }, { b: 5, c: 5 },
      { b: 5, c: 7 }, { b: 7, c: 6 }, { b: 2, c: 5 }, { b: 5, c: 0 }
    ]
  },
  'send-danger': {
    first: 'X',
    moves: [
      { b: 2, c: 2 }, { b: 2, c: 6 }, { b: 6, c: 2 }, { b: 2, c: 4 },
      { b: 4, c: 2 }, { b: 2, c: 7 }, { b: 7, c: 5 }, { b: 5, c: 6 },
      { b: 6, c: 8 }, { b: 8, c: 3 }, { b: 3, c: 0 }, { b: 0, c: 8 },
      { b: 8, c: 6 }, { b: 6, c: 3 }, { b: 3, c: 2 }, { b: 2, c: 8 },
      { b: 8, c: 5 }, { b: 5, c: 5 }, { b: 5, c: 4 }, { b: 4, c: 7 },
      { b: 7, c: 3 }
    ]
  },
  'mini-win': {
    first: 'X',
    moves: [
      { b: 2, c: 2 }, { b: 2, c: 6 }, { b: 6, c: 2 }, { b: 2, c: 4 },
      { b: 4, c: 2 }, { b: 2, c: 7 }, { b: 7, c: 5 }, { b: 5, c: 6 },
      { b: 6, c: 8 }, { b: 8, c: 3 }, { b: 3, c: 0 }, { b: 0, c: 8 },
      { b: 8, c: 6 }, { b: 6, c: 3 }, { b: 3, c: 2 }, { b: 2, c: 8 },
      { b: 8, c: 5 }, { b: 5, c: 5 }, { b: 5, c: 4 }, { b: 4, c: 7 },
      { b: 7, c: 3 }, { b: 3, c: 6 }
    ]
  },
  'closed-route': {
    first: 'X',
    moves: [
      { b: 2, c: 2 }, { b: 2, c: 6 }, { b: 6, c: 2 }, { b: 2, c: 4 },
      { b: 4, c: 2 }, { b: 2, c: 7 }, { b: 7, c: 5 }, { b: 5, c: 6 },
      { b: 6, c: 8 }, { b: 8, c: 3 }, { b: 3, c: 0 }, { b: 0, c: 8 },
      { b: 8, c: 6 }, { b: 6, c: 3 }, { b: 3, c: 2 }, { b: 2, c: 8 },
      { b: 8, c: 5 }, { b: 5, c: 5 }, { b: 5, c: 4 }, { b: 4, c: 7 },
      { b: 7, c: 3 }, { b: 3, c: 6 }, { b: 6, c: 1 }
    ]
  },
  'free-choice': {
    first: 'X',
    moves: [
      { b: 2, c: 2 }, { b: 2, c: 6 }, { b: 6, c: 2 }, { b: 2, c: 4 },
      { b: 4, c: 2 }, { b: 2, c: 7 }, { b: 7, c: 5 }, { b: 5, c: 6 },
      { b: 6, c: 8 }, { b: 8, c: 3 }, { b: 3, c: 0 }, { b: 0, c: 8 },
      { b: 8, c: 6 }, { b: 6, c: 3 }, { b: 3, c: 2 }, { b: 2, c: 8 },
      { b: 8, c: 5 }, { b: 5, c: 5 }, { b: 5, c: 4 }, { b: 4, c: 7 },
      { b: 7, c: 3 }, { b: 3, c: 6 }, { b: 6, c: 1 }, { b: 1, c: 2 }
    ]
  },
  'mandatory-global-defense': {
    first: 'X',
    moves: [
      { b: 2, c: 2 }, { b: 2, c: 6 }, { b: 6, c: 2 }, { b: 2, c: 4 },
      { b: 4, c: 2 }, { b: 2, c: 7 }, { b: 7, c: 5 }, { b: 5, c: 6 },
      { b: 6, c: 8 }, { b: 8, c: 3 }, { b: 3, c: 0 }, { b: 0, c: 8 },
      { b: 8, c: 6 }, { b: 6, c: 3 }, { b: 3, c: 2 }, { b: 2, c: 8 },
      { b: 8, c: 5 }, { b: 5, c: 5 }, { b: 5, c: 4 }, { b: 4, c: 7 },
      { b: 7, c: 3 }, { b: 3, c: 6 }, { b: 6, c: 1 }, { b: 1, c: 2 },
      { b: 8, c: 0 }, { b: 0, c: 2 }, { b: 1, c: 0 }, { b: 0, c: 3 },
      { b: 3, c: 3 }, { b: 3, c: 8 }, { b: 8, c: 2 }, { b: 4, c: 0 },
      { b: 0, c: 7 }, { b: 7, c: 1 }, { b: 1, c: 6 }, { b: 6, c: 5 },
      { b: 5, c: 7 }, { b: 7, c: 2 }, { b: 0, c: 6 }, { b: 6, c: 4 },
      { b: 4, c: 8 }, { b: 8, c: 4 }, { b: 4, c: 3 }, { b: 3, c: 4 },
      { b: 4, c: 1 }, { b: 1, c: 1 }, { b: 1, c: 3 }, { b: 3, c: 1 },
      { b: 7, c: 7 }, { b: 7, c: 0 }, { b: 0, c: 0 }, { b: 0, c: 1 },
      { b: 5, c: 8 }, { b: 8, c: 7 }
    ]
  },
  'mega-win': {
    first: 'X',
    moves: [
      { b: 2, c: 2 }, { b: 2, c: 6 }, { b: 6, c: 2 }, { b: 2, c: 4 },
      { b: 4, c: 2 }, { b: 2, c: 7 }, { b: 7, c: 5 }, { b: 5, c: 6 },
      { b: 6, c: 8 }, { b: 8, c: 3 }, { b: 3, c: 0 }, { b: 0, c: 8 },
      { b: 8, c: 6 }, { b: 6, c: 3 }, { b: 3, c: 2 }, { b: 2, c: 8 },
      { b: 8, c: 5 }, { b: 5, c: 5 }, { b: 5, c: 4 }, { b: 4, c: 7 },
      { b: 7, c: 3 }, { b: 3, c: 6 }, { b: 6, c: 1 }, { b: 1, c: 2 },
      { b: 8, c: 0 }, { b: 0, c: 2 }, { b: 1, c: 0 }, { b: 0, c: 3 },
      { b: 3, c: 3 }, { b: 3, c: 8 }, { b: 8, c: 2 }, { b: 4, c: 0 },
      { b: 0, c: 7 }, { b: 7, c: 1 }, { b: 1, c: 6 }, { b: 6, c: 5 },
      { b: 5, c: 7 }, { b: 7, c: 2 }, { b: 0, c: 6 }, { b: 6, c: 4 },
      { b: 4, c: 8 }, { b: 8, c: 4 }, { b: 4, c: 3 }, { b: 3, c: 4 },
      { b: 4, c: 1 }, { b: 1, c: 1 }, { b: 1, c: 3 }, { b: 3, c: 1 },
      { b: 7, c: 7 }, { b: 7, c: 0 }, { b: 0, c: 0 }, { b: 0, c: 1 },
      { b: 5, c: 8 }, { b: 8, c: 7 }, { b: 5, c: 1 }
    ]
  },
  'late-forced': {
    first: 'X',
    moves: [
      { b: 2, c: 2 }, { b: 2, c: 6 }, { b: 6, c: 2 }, { b: 2, c: 4 },
      { b: 4, c: 2 }, { b: 2, c: 7 }, { b: 7, c: 5 }, { b: 5, c: 6 },
      { b: 6, c: 8 }, { b: 8, c: 3 }, { b: 3, c: 0 }, { b: 0, c: 8 },
      { b: 8, c: 6 }, { b: 6, c: 3 }, { b: 3, c: 2 }, { b: 2, c: 8 },
      { b: 8, c: 5 }, { b: 5, c: 5 }, { b: 5, c: 4 }, { b: 4, c: 7 },
      { b: 7, c: 3 }, { b: 3, c: 6 }, { b: 6, c: 1 }, { b: 1, c: 2 },
      { b: 8, c: 0 }, { b: 0, c: 2 }, { b: 1, c: 0 }, { b: 0, c: 3 },
      { b: 3, c: 3 }, { b: 3, c: 8 }, { b: 8, c: 2 }, { b: 4, c: 0 },
      { b: 0, c: 7 }, { b: 7, c: 1 }, { b: 1, c: 6 }, { b: 6, c: 5 },
      { b: 5, c: 7 }, { b: 7, c: 2 }, { b: 0, c: 6 }, { b: 6, c: 4 },
      { b: 4, c: 8 }, { b: 8, c: 4 }, { b: 4, c: 3 }, { b: 3, c: 4 },
      { b: 4, c: 1 }, { b: 1, c: 1 }, { b: 1, c: 3 }, { b: 3, c: 1 },
      { b: 7, c: 7 }, { b: 7, c: 0 }, { b: 0, c: 0 }, { b: 0, c: 1 },
      { b: 5, c: 8 }, { b: 8, c: 7 }, { b: 5, c: 1 }, { b: 0, c: 5 },
      { b: 8, c: 8 }, { b: 4, c: 4 }, { b: 4, c: 6 }, { b: 3, c: 5 },
      { b: 4, c: 5 }
    ]
  },
  'drawn-route': {
    first: 'X',
    moves: [
      { b: 0, c: 6 }, { b: 6, c: 4 }, { b: 4, c: 7 }, { b: 7, c: 7 },
      { b: 7, c: 8 }, { b: 8, c: 5 }, { b: 5, c: 5 }, { b: 5, c: 6 },
      { b: 6, c: 3 }, { b: 3, c: 5 }, { b: 5, c: 4 }, { b: 4, c: 5 },
      { b: 5, c: 3 }, { b: 3, c: 1 }, { b: 1, c: 0 }, { b: 0, c: 5 },
      { b: 2, c: 0 }, { b: 0, c: 7 }, { b: 7, c: 5 }, { b: 4, c: 2 },
      { b: 2, c: 5 }, { b: 7, c: 3 }, { b: 3, c: 7 }, { b: 7, c: 2 },
      { b: 2, c: 6 }, { b: 6, c: 7 }, { b: 7, c: 0 }, { b: 0, c: 2 },
      { b: 2, c: 3 }, { b: 3, c: 3 }, { b: 3, c: 6 }, { b: 6, c: 0 },
      { b: 0, c: 8 }, { b: 8, c: 6 }, { b: 6, c: 6 }, { b: 6, c: 5 },
      { b: 7, c: 4 }, { b: 4, c: 1 }, { b: 1, c: 1 }, { b: 1, c: 6 },
      { b: 6, c: 2 }, { b: 4, c: 0 }, { b: 0, c: 3 }, { b: 3, c: 4 },
      { b: 8, c: 1 }, { b: 1, c: 2 }, { b: 1, c: 5 }, { b: 8, c: 4 },
      { b: 6, c: 8 }, { b: 8, c: 7 }, { b: 0, c: 4 }, { b: 6, c: 1 },
      { b: 1, c: 8 }, { b: 8, c: 3 }, { b: 1, c: 3 }, { b: 1, c: 4 },
      { b: 0, c: 1 }
    ]
  }
});

// Goals allow multiple mathematically correct actions. Positions retain canonical move histories.
function goals(state) {
  if (state.winner) return [];
  const player = state.turn, other = player === 'X' ? 'O' : 'X';
  const tBefore = B.fromCanonical(state);
  const ownMarksBefore = player === 'X' ? tBefore.x : tBefore.o;
  const otherMarksBefore = player === 'X' ? tBefore.o : tBefore.x;
  const oppMacroThreats = B.threats(player === 'X' ? tBefore.mo : tBefore.mx, (player === 'X' ? tBefore.mx : tBefore.mo) | tBefore.md);

  return G.legal(state).map(move => {
    const next = G.apply(state, move), replies = G.legal(next);
    const megaWin = next.winner === player;
    const miniWin = next.mini[move.b] === player && state.mini[move.b] !== player;
    const freeRoute = next.required === null;
    const drawnDestination = next.mini[move.c] === 'DRAW';
    const closedDestination = !!next.mini[move.c];
    const losesNext = replies.some(reply => G.apply(next, reply).winner === other);
    const givesMini = replies.some(reply => G.apply(next, reply).mini[reply.b] === other && next.mini[reply.b] !== other);

    let createsFork = false;
    if (next.mini[move.b] === null) {
      const tAfter = B.fromCanonical(next);
      const ownMarksAfter = player === 'X' ? tAfter.x[move.b] : tAfter.o[move.b];
      const otherMarksAfter = player === 'X' ? tAfter.o[move.b] : tAfter.x[move.b];
      createsFork = B.POP[B.threats(ownMarksAfter, otherMarksAfter)] >= 2;
    }

    const sacrificeToWin = givesMini && !losesNext && replies.length > 0 && replies.every(reply => {
      const s2 = G.apply(next, reply);
      return G.legal(s2).some(counter => G.apply(s2, counter).winner === player);
    });

    const oppMiniThreatsBefore = B.threats(otherMarksBefore[move.b], ownMarksBefore[move.b]);
    const blocksMiniThreat = (oppMiniThreatsBefore & (1 << move.c)) !== 0;
    const blocksMegaThreat = (oppMacroThreats & (1 << move.b)) !== 0 && blocksMiniThreat && !losesNext;

    return {
      move,
      megaWin,
      miniWin,
      freeRoute,
      drawnDestination,
      closedDestination,
      losesNext,
      givesMini,
      createsFork,
      sacrificeToWin,
      blocksMegaThreat,
      blocksMiniThreat
    };
  });
}

function verifyCritical(state, move) {
  const options = goals(state), chosen = options.find(x => C.sameMove(x.move, move));
  if (!chosen) return false;
  if (options.some(x => x.megaWin)) return chosen.megaWin;
  if (options.some(x => !x.losesNext)) return !chosen.losesNext;
  return true;
}

function verifyGoal(state, move, goalName) {
  const options = goals(state), chosen = options.find(x => C.sameMove(x.move, move));
  if (!chosen) return false;
  return Boolean(chosen[goalName]);
}

function corpus({ games = 12, seed = 54, dynamic = false } = {}) {
  const cases = {};

  // Build states from curated fixtures
  for (const [id, fixture] of Object.entries(CURATED)) {
    let s = G.create(fixture.first);
    for (const m of fixture.moves) s = G.apply(s, m);
    cases[id] = s;
  }

  // Dynamic discovery if requested
  if (dynamic && games > 0) {
    const rng = C.seeded(seed);
    for (let n = 0; n < games; n++) {
      let s = G.create(n % 2 ? 'O' : 'X');
      while (!s.winner) {
        const legal = G.legal(s);
        if (s.moves.length > 20) {
          const opts = goals(s);
          const retain = (name, p) => { if (!cases[name] && p) cases[name] = s; };
          retain('dyn-mega-win', opts.some(x => x.megaWin));
          retain('dyn-mandatory-global-defense', !opts.some(x => x.megaWin) && opts.some(x => x.losesNext) && opts.some(x => !x.losesNext));
          retain('dyn-mini-win', opts.some(x => x.miniWin));
          retain('dyn-closed-route', opts.some(x => x.closedDestination));
          retain('dyn-drawn-route', opts.some(x => x.drawnDestination));
          retain('dyn-send-danger', opts.some(x => x.givesMini) && opts.some(x => !x.givesMini));
          retain('dyn-late-forced', legal.length === 1);
          retain('dyn-free-choice', s.required === null && s.mini.some(Boolean));
        }
        s = G.apply(s, legal[Math.floor(rng() * legal.length)]);
      }
    }
  }

  return Object.entries(cases).map(([id, state]) => ({
    id,
    first: state.moves[0]?.player || state.turn,
    moves: state.moves.map(({ b, c }) => ({ b, c })),
    expected: { required: state.required, mini: state.mini, winner: state.winner },
    goals: goals(state)
  }));
}

module.exports = { CURATED, goals, verifyCritical, verifyGoal, corpus };
