'use strict';
/* tests/v5-p07-policy.test.js - V5 P07 task V5-07-01 queue policy verification.
 *
 * Verifies that the frozen pure matchmaking policy in `packages/domain/matchmaking.js`
 * is 100% identical in rules, constants, search windows, compatibility, scoring,
 * placement pool rules, cross-region wait, friend/recent opponent exclusion,
 * tournament cohort selection and seeding, and charge timing to the legacy baseline.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../packages/domain/matchmaking.js');
const legacy = require('../server/matchmaking.js');
const D = require('../src/domain.js');
const { Authority } = require('../src/authority.js');

function account(id, rating, {
  games = 30,
  casualRating = rating,
  verified = true,
  friends = [],
  blocked = [],
  history = [],
  coins = 1000,
  crowns = 1000,
  suspended = false,
  hold = false,
  activeMatch = null,
} = {}) {
  return {
    id,
    rating,
    games,
    casualRating,
    casualGames: 0,
    verified,
    friends,
    blocked,
    history,
    coins,
    crowns,
    suspended,
    hold,
    activeMatch,
  };
}

function ticket(actor, joinedAt = 0, region = 'iad', latencyMs = 40, mode = 'ranked') {
  return { actor, mode, joinedAt, region, latencyMs };
}

test('V5-07-01 policy: packages/domain/matchmaking exports match server/matchmaking exactly', () => {
  assert.deepEqual(P.CONFIG, legacy.CONFIG, 'CONFIG constants match');
  assert.equal(typeof P.expected, 'function');
  assert.equal(typeof P.quality, 'function');
  assert.equal(typeof P.casualSkill, 'function');
  assert.equal(typeof P.skill, 'function');
  assert.equal(typeof P.searchWindow, 'function');
  assert.equal(typeof P.sec, 'function');
  assert.equal(typeof P.normalizedRegion, 'function');
  assert.equal(typeof P.compatibility, 'function');
  assert.equal(typeof P.tournamentWindow, 'function');
  assert.equal(typeof P.selectTournamentRoom, 'function');
  assert.equal(typeof P.tournamentSeed, 'function');
});

test('V5-07-01 policy: ranked search window expands monotonically with wait time across tiers', () => {
  const provisional = account('prov', 1500, { games: D.POLICY.placements - 1 });
  assert.equal(P.searchWindow('ranked', 0, provisional), 100);
  assert.equal(P.searchWindow('ranked', 9.9, provisional), 100);
  assert.equal(P.searchWindow('ranked', 10, provisional), 125);
  assert.equal(P.searchWindow('ranked', 24.9, provisional), 125);
  assert.equal(P.searchWindow('ranked', 25, provisional), 150);
  assert.equal(P.searchWindow('ranked', 44.9, provisional), 150);
  assert.equal(P.searchWindow('ranked', 45, provisional), 200);
  assert.equal(P.searchWindow('ranked', 100, provisional), 200);

  const standard = account('std', 1500, { games: 30 });
  assert.equal(P.searchWindow('ranked', 0, standard), 50);
  assert.equal(P.searchWindow('ranked', 9.9, standard), 50);
  assert.equal(P.searchWindow('ranked', 10, standard), 100);
  assert.equal(P.searchWindow('ranked', 24.9, standard), 100);
  assert.equal(P.searchWindow('ranked', 25, standard), 150);
  assert.equal(P.searchWindow('ranked', 44.9, standard), 150);
  assert.equal(P.searchWindow('ranked', 45, standard), 200);
  assert.equal(P.searchWindow('ranked', 74.9, standard), 200);
  assert.equal(P.searchWindow('ranked', 75, standard), P.CONFIG.ranked.hardMax);
  assert.equal(P.searchWindow('ranked', 300, standard), 200);

  const elite = account('elite', 2250, { games: 100 });
  assert.equal(P.searchWindow('ranked', 75, elite), P.CONFIG.ranked.eliteMax);
  assert.equal(P.searchWindow('ranked', 300, elite), 250);
});

test('V5-07-01 policy: casual search window expands faster up to hardMax 350', () => {
  const a = account('cas', 1500);
  assert.equal(P.searchWindow('casual', 0, a), 100);
  assert.equal(P.searchWindow('casual', 5.9, a), 100);
  assert.equal(P.searchWindow('casual', 6, a), 175);
  assert.equal(P.searchWindow('casual', 14.9, a), 175);
  assert.equal(P.searchWindow('casual', 15, a), 250);
  assert.equal(P.searchWindow('casual', 29.9, a), 250);
  assert.equal(P.searchWindow('casual', 30, a), P.CONFIG.casual.hardMax);
  assert.equal(P.searchWindow('casual', 100, a), 350);
});

test('V5-07-01 policy: compatibility rejects ineligibility and blocks', () => {
  const now = 100000;
  const a = account('a', 1500);
  const b = account('b', 1500);
  const ta = ticket('a', now);
  const tb = ticket('b', now);

  assert.equal(P.compatibility({ ...a, activeMatch: 'm1' }, b, ta, tb, 'ranked', now).reason, 'INELIGIBLE');
  assert.equal(P.compatibility(a, { ...b, activeMatch: 'm2' }, ta, tb, 'ranked', now).reason, 'INELIGIBLE');
  assert.equal(P.compatibility({ ...a, suspended: true }, b, ta, tb, 'ranked', now).reason, 'INELIGIBLE');
  assert.equal(P.compatibility(a, { ...b, hold: true }, ta, tb, 'ranked', now).reason, 'INELIGIBLE');
  assert.equal(P.compatibility({ ...a, verified: false }, b, ta, tb, 'ranked', now).reason, 'INELIGIBLE');

  assert.equal(P.compatibility({ ...a, blocked: ['b'] }, b, ta, tb, 'ranked', now).reason, 'BLOCKED');
  assert.equal(P.compatibility(a, { ...b, blocked: ['a'] }, ta, tb, 'ranked', now).reason, 'BLOCKED');
});

test('V5-07-01 policy: friend block applies to ranked queue but is allowed in casual queue', () => {
  const now = 100000;
  const a = account('a', 1500, { friends: ['b'] });
  const b = account('b', 1500);
  const taR = ticket('a', now, 'iad', 30, 'ranked');
  const tbR = ticket('b', now, 'iad', 30, 'ranked');
  assert.equal(P.compatibility(a, b, taR, tbR, 'ranked', now).reason, 'FRIEND_QUEUE_BLOCK');

  const taC = ticket('a', now, 'iad', 30, 'casual');
  const tbC = ticket('b', now, 'iad', 30, 'casual');
  const cCas = P.compatibility(a, b, taC, tbC, 'casual', now);
  assert.equal(cCas.ok, true, 'friends CAN match in casual queue');
});

test('V5-07-01 policy: placement pool separation and cross-region wait rules', () => {
  const now = 100000;
  const prov = account('prov', 1500, { games: 3 });
  const placed = account('placed', 1520, { games: 40 });

  const earlyTicket = ticket('prov', now - 10000);
  const otherEarly = ticket('placed', now - 10000);
  assert.equal(P.compatibility(prov, placed, earlyTicket, otherEarly, 'ranked', now).reason, 'PLACEMENT_POOL');

  const lateTicket = ticket('prov', now - 35000);
  const otherLate = ticket('placed', now - 35000);
  assert.equal(P.compatibility(prov, placed, lateTicket, otherLate, 'ranked', now).ok, true, 'placement pool wait opens after 30s for small gap');

  const wideGapTicket = ticket('placed', now - 35000);
  const widePlaced = account('placed', 1650, { games: 40 });
  assert.equal(P.compatibility(prov, widePlaced, lateTicket, wideGapTicket, 'ranked', now).reason, 'PLACEMENT_POOL', 'gap > 100 still blocked even after 30s');

  const aIAD = account('a', 1500);
  const bSIN = account('b', 1500);
  const tIAD = ticket('a', now - 10000, 'iad');
  const tSIN = ticket('b', now - 10000, 'sin');
  assert.equal(P.compatibility(aIAD, bSIN, tIAD, tSIN, 'ranked', now).reason, 'REGION_WAIT');

  const tIADLate = ticket('a', now - 40000, 'iad');
  const tSINLate = ticket('b', now - 40000, 'sin');
  assert.equal(P.compatibility(aIAD, bSIN, tIADLate, tSINLate, 'ranked', now).ok, true, 'cross-region opens after 35s ranked');

  const tGlobal = ticket('a', now - 5000, 'global');
  assert.equal(P.compatibility(aIAD, bSIN, tGlobal, tSIN, 'ranked', now).ok, true, 'global region matches immediately');

  const tLag = ticket('a', now, 'iad', 360);
  assert.equal(P.compatibility(aIAD, bSIN, tLag, ticket('b', now, 'iad', 30), 'ranked', now).reason, 'LATENCY_LIMIT');
});

test('V5-07-01 policy: recent opponent avoidance enforced with configured windows', () => {
  const now = 100000;
  const a = account('a', 1500, { history: [{ opponent: 'b', queue: true, rated: true, at: now - 5000 }] });
  const b = account('b', 1500);
  const ta = ticket('a', now - 10000);
  const tb = ticket('b', now - 10000);
  assert.equal(P.compatibility(a, b, ta, tb, 'ranked', now).reason, 'RECENT_OPPONENT');

  const taOld = ticket('a', now - 65000);
  const tbOld = ticket('b', now - 65000);
  assert.equal(P.compatibility(a, b, taOld, tbOld, 'ranked', now).ok, true, 'recent opponent avoidance expires after 60s in ranked');
});

test('V5-07-01 policy: tournament cohort selection hard cap 200 and deterministic seeding', () => {
  const map = new Map([
    ['a', account('a', 1500)],
    ['b', account('b', 1600)],
    ['c', account('c', 1801)],
  ]);
  const economy = { accounts: map };
  const rooms = [
    { id: 'r1', table: 'low', status: 'LOBBY', created: 0, expires: 999999, players: [{ id: 'b' }] },
    { id: 'r2', table: 'low', status: 'LOBBY', created: 0, expires: 999999, players: [{ id: 'c' }] },
  ];
  const chosen = P.selectTournamentRoom(rooms, economy, 'a', 'low', 70000);
  assert.equal(chosen.id, 'r1', 'cohort cap 200 excludes r2 (rating diff 301 > 200)');

  const seedMap = new Map([
    ['p1', account('p1', 1200, { games: 50 })],
    ['p2', account('p2', 1500, { games: 10 })],
    ['p3', account('p3', 1500, { games: 20 })],
    ['p4', account('p4', 1200, { games: 50 })],
  ]);
  const seeds = P.tournamentSeed(['p1', 'p2', 'p3', 'p4'], { accounts: seedMap });
  assert.deepEqual(seeds, ['p3', 'p2', 'p1', 'p4'], 'seeds sort rating DESC, games DESC, id ASC');
});

test('V5-07-01 policy: charge timing is preserved: offerQueue does not charge; second accept commits equal fees', () => {
  const clock = 1700000000000;
  const auth = new Authority({ now: () => clock });
  auth.addAccount('alice', { verified: true });
  auth.addAccount('bob', { verified: true });

  const initialAlice = auth.account('alice');
  const initialBob = auth.account('bob');
  assert.equal(initialAlice.coins, 150);
  assert.equal(initialBob.coins, 150);
  assert.equal(initialAlice.reservedCoins, 0);
  assert.equal(initialBob.reservedCoins, 0);

  const quote = D.quote({ mode: 'queue', from: 'gold', to: 'gold', rated: true });
  assert.equal(quote.currency, 'coins');
  assert.equal(quote.contributions[0], quote.contributions[1], 'queue match uses equal contributions');

  const matchId = 'match-q-charge';
  const offered = auth.offerQueue(matchId, 'alice', 'bob', 'ranked', 30);
  assert.equal(offered.status, 'OFFERED');
  assert.equal(offered.escrow, 0, 'offerQueue charges NO escrow');
  assert.equal(auth.account('alice').coins, 150, 'alice balance untouched on offer');
  assert.equal(auth.account('bob').coins, 150, 'bob balance untouched on offer');
  assert.equal(auth.account('alice').reservedCoins, 0, 'alice reserved 0 on offer');
  assert.equal(auth.account('bob').reservedCoins, 0, 'bob reserved 0 on offer');

  const acc1 = auth.accept(matchId, 'alice', offered.termsHash);
  assert.equal(acc1.status, 'OFFERED', 'first acceptance leaves status OFFERED');
  assert.equal(auth.account('alice').coins, 150, 'alice balance untouched on first acceptance');
  assert.equal(auth.account('alice').reservedCoins, 0, 'alice reserved coins 0 on first acceptance');

  const fee = offered.quote.contributions[0];
  const acc2 = auth.accept(matchId, 'bob', offered.termsHash);
  assert.equal(acc2.status, 'PLAYING', 'second acceptance transitions to PLAYING');
  assert.equal(acc2.escrow, fee * 2, 'escrow holds exact sum of contributions');
  assert.equal(auth.account('alice').coins, 150 - fee, 'alice charged exact fee on second acceptance');
  assert.equal(auth.account('bob').coins, 150 - fee, 'bob charged exact fee on second acceptance');
  assert.equal(auth.account('alice').reservedCoins, fee, 'alice reservedCoins encumbered');
  assert.equal(auth.account('bob').reservedCoins, fee, 'bob reservedCoins encumbered');

  const receipt = auth.voidByOperator(matchId, 'test void');
  assert.equal(receipt.refunded, fee * 2, 'void refunds the exact escrow');
  assert.equal(auth.view(matchId).status, 'VOID');
  assert.equal(auth.account('alice').coins, 150, 'alice fully refunded on void');
  assert.equal(auth.account('bob').coins, 150, 'bob fully refunded on void');
  assert.equal(auth.account('alice').reservedCoins, 0, 'alice reservation cleared');
  assert.equal(auth.account('bob').reservedCoins, 0, 'bob reservation cleared');
});
