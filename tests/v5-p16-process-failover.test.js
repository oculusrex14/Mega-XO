'use strict';
/*
 * P16 executed-service acceptance precursor: two INDEPENDENT Core OS processes,
 * one owned PostgreSQL16 database, one disposable Redis endpoint, real P06 Core
 * factories, and an actual SIGKILL. This proves durable move/revision/escrow
 * recovery after an ACKNOWLEDGED commit, NOT socket routing, failover during
 * a still-running transaction, or the post-commit/pre-publish kill window.
 *
 * CI supplies owned loopback PG and Redis; the test cannot contact providers,
 * a production database or a public endpoint. Never weaken these preconditions.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const lab = require('./v5-pg-lab.js');
const { startPresenceChild } = require('./helpers/v5-presence-service-process.js');

const REDIS_URL = process.env.REDIS_URL || '';
const ENABLED = process.env.V5_PG_REQUIRED === '1' && process.env.V5_PG_DISPOSABLE === '1' &&
  /^(redis|rediss):\/\/(127\.0\.0\.1|localhost)(:[0-9]+)?\/?$/.test(REDIS_URL);

const redis = (keyVersion) => ({
  url: REDIS_URL, environment: 'test', allowPlaintext: REDIS_URL.startsWith('redis://'),
  keyVersion, socket: { connectTimeout: 3000 },
});

lab.installCleanup(test);

test('P16 actual Core A SIGKILL after committed move: Core B reconstructs revision, paid occupancy, same deadline and dedupe', {
  skip: ENABLED ? false : 'requires explicitly owned loopback PG16+Redis',
  timeout: 120000,
}, async (t) => {
  if (!(await lab.boot(t))) return;
  const database = await lab.createDatabase('p16killresume');
  await lab.seedActors(database, lab.seedFor(['svc_alice', 'svc_bob', 'svc_carol']));
  const url = lab.dbUrl(database);
  let a, b, c;
  try {
    a = await startPresenceChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: redis('p16kill') });
    b = await startPresenceChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: redis('p16kill') });
    assert.notEqual(a.pid, b.pid);
    assert.notEqual(a.pid, process.pid);
    assert.ok(a.hasEphemera && b.hasEphemera);

    // Approved direct paid match; second acceptance makes the pot and the
    // durable occupancy. There is NO new policy or purchased-Crown restriction.
    const matchId = 'p16-paid-active';
    const offer = await a.call('coreRun', [
      { actor: 'svc_alice', scope: 'player' },
      'p16-offer', { type: 'offer', id: matchId, opponent: 'svc_bob', terms: { kind: 'leaderboard', amount: 40 } },
    ]);
    await a.call('coreRun', [
      { actor: 'svc_alice', scope: 'player' },
      'p16-accept-a', { type: 'accept', id: matchId, termsHash: offer.termsHash },
    ]);
    assert.equal(Number(await lab.scalar(database, "SELECT reserved_crowns FROM economy.wallets WHERE actor_id='svc_alice'")), 0);
    const playing = await a.call('coreRun', [
      { actor: 'svc_bob', scope: 'player' },
      'p16-accept-b', { type: 'accept', id: matchId, termsHash: offer.termsHash },
    ]);
    assert.equal(playing.status, 'PLAYING');

    const watch = await b.call('watchMatch', ['svc_alice', matchId]);
    assert.equal(watch.snapshot.status, 'PLAYING');
    assert.equal(watch.snapshot.revision, 0);
    assert.ok(watch.available);
    assert.ok(watch.snapshot.deadline, 'a committed timed game has an absolute deadline');
    const x = watch.snapshot.symbols.X;
    const o = watch.snapshot.symbols.O;

    // A ACKNOWLEDGES a committed move, then the OS really terminates A.
    const moveCmd = { type: 'move', id: matchId, revision: 0, move: { b: 0, c: 0 } };
    const moved = await a.call('coreRun', [
      { actor: x, scope: 'player' }, 'p16-ack-move', moveCmd,
    ]);
    assert.equal(moved.revision, 1);
    const hint = await b.nextMatchUpdate(watch.watchId);
    assert.equal(hint.snapshot.revision, 1, 'B independently reread the committed revision on Redis hint');
    const beforeKill = await b.call('readMatch', [x, matchId]);
    assert.equal(beforeKill.revision, 1);
    assert.ok(beforeKill.deadline);

    a.kill();
    const killed = await a.waitExit();
    assert.equal(killed.signal, 'SIGKILL', 'the test must kill a real Core process, not call graceful shutdown');
    assert.equal(a.exited, true);

    // B is the surviving process: no in-memory state from A remains.
    const recovered = await b.call('readMatch', [x, matchId]);
    assert.equal(recovered.status, 'PLAYING');
    assert.equal(recovered.revision, 1, 'the acknowledged move is never lost');
    assert.equal(recovered.deadline, beforeKill.deadline, 'the persisted turn deadline does not reset at failover');
    assert.deepEqual(recovered.symbols, beforeKill.symbols);
    assert.equal(Number(recovered.escrow), 40);
    assert.equal(Number(await lab.scalar(database,
      "SELECT count(*)::int FROM core.actor_occupancy WHERE actor_id IN ('svc_alice','svc_bob')")), 2);

    // A client replay on B with exactly the same actor/key/payload returns
    // the durable result, rather than applying another legal move or charge.
    const replay = await b.call('coreRun', [{ actor: x, scope: 'player' }, 'p16-ack-move', moveCmd]);
    assert.equal(replay.revision, 1);
    assert.equal(Number(await lab.scalar(database, "SELECT revision FROM match.matches WHERE match_id='p16-paid-active'")), 1);
    assert.equal(Number(await lab.scalar(database,
      "SELECT reserved_crowns FROM economy.wallets WHERE actor_id='svc_alice'")), 40);
    assert.equal(Number(await lab.scalar(database,
      "SELECT reserved_crowns FROM economy.wallets WHERE actor_id='svc_bob'")), 0);
    assert.equal(Number(await lab.scalar(database,
      "SELECT count(*)::int FROM ops.outbox WHERE outbox_id LIKE '%p16-ack-move%'")), 1,
      'one acknowledged committed move produces exactly one outbox identity');

    const conflict = await b.call('coreRun', [
      { actor: x, scope: 'player' }, 'p16-ack-move',
      { type: 'move', id: matchId, revision: 0, move: { b: 1, c: 1 } },
    ]).then(() => null, (e) => e.message);
    assert.match(String(conflict), /CONFLICT/, 'a reused operation key cannot change the command');

    const followed = await b.call('coreRun', [
      { actor: o, scope: 'player' }, 'p16-resumed-move',
      { type: 'move', id: matchId, revision: 1, move: { b: 0, c: 1 } },
    ]);
    assert.equal(followed.revision, 2, 'the surviving Core commits the next legal move');

    // Redis-loss rehearsal after the crash: a THIRD freshly booted Core with
    // no adapter still resumes solely from PostgreSQL, including deadlines.
    const wiped = await b.call('wipeNamespace');
    assert.equal(wiped.available, true);
    c = await startPresenceChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: null });
    const third = await c.call('readMatch', [x, matchId]);
    const fromB = await b.call('readMatch', [x, matchId]);
    assert.equal(third.revision, 2);
    assert.equal(third.deadline, fromB.deadline);
    assert.equal(Number(third.escrow), 40);
    assert.equal(Number(await lab.scalar(database,
      "SELECT count(*)::int FROM core.actor_occupancy WHERE actor_id IN ('svc_alice','svc_bob')")), 2);
    assert.equal(Number(await lab.scalar(database,
      "SELECT count(*)::int FROM ops.outbox WHERE outbox_id LIKE '%p16-ack-move%'")), 1);

    await b.call('watchUnsubscribe', [watch.watchId]);
    assert.deepEqual(await c.shutdown(), { code: 0, signal: null });
    assert.deepEqual(await b.shutdown(), { code: 0, signal: null });
  } finally {
    for (const proc of [a, b, c]) if (proc && !proc.exited) {
      proc.kill();
      await proc.waitExit().catch(() => {});
    }
    await lab.closeDatabasePools(database);
  }
});
