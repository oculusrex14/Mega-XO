/* tests/v5-p05-tickets.test.js - V5 P05 durable one-use realtime tickets (design B5, Part F).
 *
 * WHAT THIS PROVES (A14/A15): the API issuer mints a 32-byte bearer, stores ONLY its sha256 hex in
 * identity.realtime_tickets, and Core redeems it through the narrow SECURITY DEFINER function
 * inside ONE core_runtime transaction. The durable row's `redeemed_at IS NULL` predicate is the only
 * authority, so two racing redemptions, a second redemption after a simulated process restart, and a
 * redemption after total cache loss all resolve to exactly one winner. No Redis is consulted
 * anywhere - single-use is proven by simply redeeming twice.
 *
 * Covered: issue -> redeem returns the exact issued fields; the raw ticket is never stored; unknown
 * -> TICKET_INVALID; two concurrent redemptions -> one winner + one TICKET_REDEEMED; restart
 * single-use; the caller's environment/audience/session/generation comparison contract on the
 * RETURNED values (the envelope guard is Core's, not this service's); expired -> TICKET_EXPIRED;
 * outstanding/live/per-IP admission limits -> TICKET_LIMIT; and core_runtime's role isolation
 * (no direct INSERT/UPDATE/DELETE, EXECUTE of the function).
 *
 * Harness: the frozen tests/v5-pg-lab.js disposable PG16 lab (real checksummed migration chain,
 * real guarded role pools, synthetic actors only). No mocks, no SQLite, no provider claims.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const lab = require('./v5-pg-lab.js');
const { createTicketIssuer, redeemRealtimeTicket } = require('../packages/services/tickets.js');

lab.installCleanup(test);

const CLOCK = lab.CLOCK;
const sha256hex = (value) => crypto.createHash('sha256').update(value).digest('hex');
const throwsCode = (promise, code) => assert.rejects(promise, (e) => e.message === code, `expected ${code}`);
/* The Core envelope guard's comparison contract (design B5.3/B5.4): the actor used for
 * authorization is ALWAYS the redeemed row's actor_id, and environment/audience/sessionId/
 * generation are compared against the envelope. This module does NOT call it - it returns the
 * stored fields - so the test pins the contract on those returned values. */
const envelopeGuard = (grant, envelope) => {
 if (grant.environment !== envelope.environment) throw Error('FORBIDDEN');
 if (grant.audience !== envelope.audience) throw Error('FORBIDDEN');
 if (grant.sessionId !== envelope.sessionId) throw Error('FORBIDDEN');
 if (grant.generation !== envelope.generation) throw Error('FORBIDDEN');
 return grant;
};

/* A request bound to svc_alice's synthetic session. */
const binding = (extra = {}) => ({
 actor: 'svc_alice', sessionId: 'a'.repeat(24), generation: 1,
 connectionClass: 'game', matchScope: null, ipHash: null, ...extra,
});

test('P05 tickets: issue -> redeem returns the exact issued fields and stores only the hash', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('tickets_exact');
 await lab.seedActors(db);
 const issuer = await createTicketIssuer(lab.poolsFor(db).api, { now: () => CLOCK, environment: 'stg', audience: 'mega-core' });

 const { ticket, expiresAt } = await issuer.issue(binding({ matchScope: 'match-7', connectionClass: 'game' }));
 assert.equal(typeof ticket, 'string');
 assert.equal(Buffer.from(ticket, 'base64url').length, 32, 'the ticket is 32 random bytes base64url');
 assert.equal(expiresAt, CLOCK + 10000, 'TTL is 10s from now()');

 /* Stored ONLY as sha256 hex; the raw base64url bearer is never a row. */
 const stored = await lab.scalar(db, 'SELECT ticket_hash FROM identity.realtime_tickets WHERE ticket_hash = $1', [sha256hex(ticket)]);
 assert.equal(stored, sha256hex(ticket));
 assert.equal(await lab.scalar(db, 'SELECT count(*)::int FROM identity.realtime_tickets WHERE ticket_hash = $1', [ticket]), 0, 'the raw ticket never appears in the table');
 assert.equal(await lab.scalar(db, 'SELECT count(*)::int FROM identity.realtime_tickets WHERE expires_at - issued_at <> interval \'10 seconds\''), 0, 'the stored lifetime is exactly 10s');

 const grant = await redeemRealtimeTicket(lab.poolsFor(db).core, { ticket, connectionId: 'conn-1', node: 'core-1', now: () => CLOCK });
 assert.deepEqual(grant, {
  actorId: 'svc_alice', sessionId: 'a'.repeat(24), generation: 1,
  environment: 'stg', audience: 'mega-core', matchScope: 'match-7',
 }, 'redemption returns the stored fields exactly');
 assert.equal(envelopeGuard(grant, { environment: 'stg', audience: 'mega-core', sessionId: 'a'.repeat(24), generation: 1 }).actorId, 'svc_alice');

 /* listOpen: unredeemed+unexpired only, and never the raw ticket. */
 const openAfter = await issuer.listOpen('svc_alice');
 assert.equal(openAfter.length, 0, 'a redeemed ticket is no longer open');
 const second = await issuer.issue(binding({ matchScope: null }));
 const open = await issuer.listOpen('svc_alice');
 assert.equal(open.length, 1);
 assert.equal(open[0].ticketHash, sha256hex(second.ticket));
 assert.equal(open[0].ticketHash === second.ticket, false, 'listOpen returns the digest, not bearer material');

 await throwsCode(redeemRealtimeTicket(lab.poolsFor(db).core, { ticket: 'z'.repeat(43), connectionId: 'c', node: 'n', now: () => CLOCK }), 'TICKET_INVALID');
 issuer.close();
});

test('P05 tickets: two concurrent redemptions yield one winner and one TICKET_REDEEMED', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('tickets_race');
 await lab.seedActors(db);
 const core = lab.poolsFor(db).core;
 const issuer = await createTicketIssuer(lab.poolsFor(db).api, { now: () => CLOCK, environment: 'stg' });
 const { ticket } = await issuer.issue(binding());

 const results = await Promise.allSettled([
  redeemRealtimeTicket(core, { ticket, connectionId: 'conn-a', node: 'node-a', now: () => CLOCK }),
  redeemRealtimeTicket(core, { ticket, connectionId: 'conn-b', node: 'node-b', now: () => CLOCK }),
 ]);
 const wins = results.filter((r) => r.status === 'fulfilled');
 const losses = results.filter((r) => r.status === 'rejected');
 assert.equal(wins.length, 1, 'exactly one node wins');
 assert.equal(losses.length, 1);
 assert.equal(losses[0].reason.message, 'TICKET_REDEEMED');
 assert.equal(wins[0].value.actorId, 'svc_alice');
 assert.equal(await lab.scalar(db, 'SELECT count(*)::int FROM identity.realtime_tickets WHERE ticket_hash = $1 AND redeemed_at IS NOT NULL', [sha256hex(ticket)]), 1);
 issuer.close();
});

test('P05 tickets: redemption survives a simulated process restart and stays single-use', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('tickets_restart');
 await lab.seedActors(db);
 const api = lab.poolsFor(db).api;
 const core = lab.poolsFor(db).core;

 /* Process 1: issue then die without redeeming (the issuer is closed, as if the instance exited). */
 const first = await createTicketIssuer(api, { now: () => CLOCK, environment: 'stg' });
 const { ticket } = await first.issue(binding({ matchScope: 'match-restart' }));
 first.close();

 /* Process 2: brand-new issuer/core objects over the same database. The durable row is the only
  * authority, so no in-process state is required to redeem or to defeat a replay. */
 const second = await createTicketIssuer(api, { now: () => CLOCK, environment: 'stg' });
 const grant = await redeemRealtimeTicket(core, { ticket, connectionId: 'conn-p2', node: 'node-p2', now: () => CLOCK });
 assert.equal(grant.matchScope, 'match-restart');

 await throwsCode(redeemRealtimeTicket(core, { ticket, connectionId: 'conn-p2b', node: 'node-p2', now: () => CLOCK }), 'TICKET_REDEEMED');
 /* A total cache loss changes nothing: the second redemption is refused straight from PostgreSQL. */
 assert.equal(await lab.scalar(db, 'SELECT count(*)::int FROM identity.realtime_tickets WHERE ticket_hash = $1 AND redeemed_at IS NOT NULL', [sha256hex(ticket)]), 1);
 second.close();
});

test('P05 tickets: the return-value comparison contract pins environment/audience/session/generation', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('tickets_contract');
 await lab.seedActors(db);
 const api = lab.poolsFor(db).api;
 const core = lab.poolsFor(db).core;
 const stg = await createTicketIssuer(api, { now: () => CLOCK, environment: 'stg', audience: 'mega-core' });
 const prd = await createTicketIssuer(api, { now: () => CLOCK, environment: 'prd', audience: 'mega-android' });

 const a = await stg.issue(binding({ sessionId: 'a'.repeat(24), generation: 2 }));
 const grantA = await redeemRealtimeTicket(core, { ticket: a.ticket, connectionId: 'c-a', node: 'n', now: () => CLOCK });
 /* The CORRECT envelope passes... */
 assert.equal(envelopeGuard(grantA, { environment: 'stg', audience: 'mega-core', sessionId: 'a'.repeat(24), generation: 2 }).generation, 2);
 /* ...and every single-axis mismatch is refused by the caller guard, not silently accepted. */
 assert.throws(() => envelopeGuard(grantA, { environment: 'prd', audience: 'mega-core', sessionId: 'a'.repeat(24), generation: 2 }), /FORBIDDEN/);
 assert.throws(() => envelopeGuard(grantA, { environment: 'stg', audience: 'mega-android', sessionId: 'a'.repeat(24), generation: 2 }), /FORBIDDEN/);
 assert.throws(() => envelopeGuard(grantA, { environment: 'stg', audience: 'mega-core', sessionId: 'b'.repeat(24), generation: 2 }), /FORBIDDEN/);
 assert.throws(() => envelopeGuard(grantA, { environment: 'stg', audience: 'mega-core', sessionId: 'a'.repeat(24), generation: 3 }), /FORBIDDEN/);

 /* A ticket issued for session B returns B, so it can never be passed off as session A. */
 const b = await stg.issue(binding({ sessionId: 'b'.repeat(24), generation: 5 }));
 const grantB = await redeemRealtimeTicket(core, { ticket: b.ticket, connectionId: 'c-b', node: 'n', now: () => CLOCK });
 assert.equal(grantB.sessionId, 'b'.repeat(24));
 assert.throws(() => envelopeGuard(grantB, { environment: 'stg', audience: 'mega-core', sessionId: 'a'.repeat(24), generation: 5 }), /FORBIDDEN/);
 assert.equal(grantA.sessionId !== grantB.sessionId, true);

 /* The stored environment/audience are those of the ISSUING instance, not the redeeming caller. */
 const p = await prd.issue(binding({ sessionId: 'c'.repeat(24), generation: 1 }));
 const grantP = await redeemRealtimeTicket(core, { ticket: p.ticket, connectionId: 'c-p', node: 'n', now: () => CLOCK });
 assert.equal(grantP.environment, 'prd');
 assert.equal(grantP.audience, 'mega-android');
 assert.throws(() => envelopeGuard(grantP, { environment: 'stg', audience: 'mega-core', sessionId: 'c'.repeat(24), generation: 1 }), /FORBIDDEN/);

 stg.close();
 prd.close();
});

test('P05 tickets: expired tickets answer TICKET_EXPIRED and unknown ones TICKET_INVALID', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('tickets_expiry');
 await lab.seedActors(db);
 const core = lab.poolsFor(db).core;
 const issuer = await createTicketIssuer(lab.poolsFor(db).api, { now: () => CLOCK, environment: 'stg' });
 const { ticket } = await issuer.issue(binding());

 await throwsCode(redeemRealtimeTicket(core, { ticket, connectionId: 'late', node: 'n', now: CLOCK + 10000 }), 'TICKET_EXPIRED');
 await throwsCode(redeemRealtimeTicket(core, { ticket, connectionId: 'late', node: 'n', now: () => CLOCK + 10001 }), 'TICKET_EXPIRED');
 /* Still inside the window, the same ticket redeems. */
 const grant = await redeemRealtimeTicket(core, { ticket, connectionId: 'in-time', node: 'n', now: () => CLOCK + 9999 });
 assert.equal(grant.actorId, 'svc_alice');
 /* Expired stays spent for a later attempt too (redeemed_at wins over expiry). */
 await throwsCode(redeemRealtimeTicket(core, { ticket, connectionId: 'late-2', node: 'n', now: () => CLOCK + 60000 }), 'TICKET_REDEEMED');
 /* A well-formed but unknown 32-byte bearer is TICKET_INVALID. */
 await throwsCode(redeemRealtimeTicket(core, { ticket: crypto.randomBytes(32).toString('base64url'), connectionId: 'x', node: 'n', now: () => CLOCK }), 'TICKET_INVALID');
 await throwsCode(redeemRealtimeTicket(core, { ticket: 'not-a-ticket', connectionId: 'x', node: 'n', now: () => CLOCK }), 'TICKET_INVALID');
 /* An expired-and-unredeemed ticket is TICKET_EXPIRED, never INVALID/REDEEMED. */
 const stale = await issuer.issue(binding({ ipHash: 'f'.repeat(64) }));
 await throwsCode(redeemRealtimeTicket(core, { ticket: stale.ticket, connectionId: 'x', node: 'n', now: () => CLOCK + 20000 }), 'TICKET_EXPIRED');
 issuer.close();
});

test('P05 tickets: outstanding (3) and live (4) admission limits fail closed', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('tickets_limits');
 await lab.seedActors(db);
 const core = lab.poolsFor(db).core;
 const at = CLOCK;
 const issuer = await createTicketIssuer(lab.poolsFor(db).api, { now: () => at, environment: 'stg' });

 /* Outstanding: three unredeemed tickets for one actor, the fourth is refused. */
 for (let i = 0; i < 3; i += 1) await issuer.issue(binding());
 assert.equal((await issuer.listOpen('svc_alice')).length, 3);
 await throwsCode(issuer.issue(binding()), 'TICKET_LIMIT');
 /* A DIFFERENT actor is unaffected (the cap is per actor). */
 const bob = await issuer.issue(binding({ actor: 'svc_bob' }));
 assert.equal(typeof bob.ticket, 'string');
 /* The block is a real cap, not a lock: consuming one outstanding ticket frees a slot. The probe
  * uses the FROZEN clock, like the service, so it sees the same 10s window. */
 const atIso = new Date(at).toISOString();
 const rows = await lab.adminClient(db);
 const hashes = (await rows.query('SELECT ticket_hash FROM identity.realtime_tickets WHERE actor_id = $1 AND redeemed_at IS NULL AND expires_at > $2::timestamptz', ['svc_alice', atIso])).rows.map((r) => r.ticket_hash);
 await rows.end();
 assert.equal(hashes.length, 3);
 await lab.installSql(db, [`UPDATE identity.realtime_tickets SET redeemed_at = '${atIso}'::timestamptz, redeemed_by = 'sweep' WHERE ticket_hash = '${hashes[0]}'`]);
 assert.equal((await issuer.listOpen('svc_alice')).length, 2);
 assert.equal(typeof (await issuer.issue(binding())).ticket, 'string', 'one slot freed, one issuance allowed');

 /* Live: redeem four concurrent connections for a fresh actor, the fifth admission is refused even
  * though nothing is outstanding (the live cap is on redeemed-and-unexpired rows). */
 const carolLive = async () => {
  for (let i = 0; i < 4; i += 1) {
   const issued = await issuer.issue(binding({ actor: 'svc_carol' }));
   await redeemRealtimeTicket(core, { ticket: issued.ticket, connectionId: `carol-${i}`, node: 'node-live', now: () => at });
  }
 };
 await carolLive();
 assert.equal((await issuer.listOpen('svc_carol')).length, 0, 'all four are redeemed, none outstanding');
 assert.equal(await lab.scalar(db, "SELECT count(*)::int FROM identity.realtime_tickets WHERE actor_id = 'svc_carol' AND redeemed_at IS NOT NULL AND expires_at > $1", [new Date(at).toISOString()]), 4);
 await throwsCode(issuer.issue(binding({ actor: 'svc_carol' })), 'TICKET_LIMIT', 'the fifth live connection is refused');
 issuer.close();
});

test('P05 tickets: the per-IP issuance budget is a rolling 60s window and fails closed', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('tickets_ip');
 await lab.seedActors(db);
 let at = CLOCK;
 const ip = 'ab'.repeat(32);
 /* A caller may only TIGHTEN the frozen budget; 5 per ipHash per window makes the breach cheap. */
 const issuer = await createTicketIssuer(lab.poolsFor(db).api, { now: () => at, environment: 'stg', limits: { ipIssueMax: 5 } });

 await issuer.issue(binding({ actor: 'svc_alice', ipHash: ip }));
 await issuer.issue(binding({ actor: 'svc_alice', ipHash: ip }));
 await issuer.issue(binding({ actor: 'svc_alice', ipHash: ip }));
 await issuer.issue(binding({ actor: 'svc_bob', ipHash: ip }));
 await issuer.issue(binding({ actor: 'svc_bob', ipHash: ip }));
 /* The sixth issuance breaches the IP budget while BOTH actor caps are still satisfied. */
 assert.equal((await issuer.listOpen('svc_bob')).length, 2, 'bob is under his own outstanding cap');
 await throwsCode(issuer.issue(binding({ actor: 'svc_bob', ipHash: ip })), 'TICKET_LIMIT');
 /* A different IP is unaffected. */
 assert.equal(typeof (await issuer.issue(binding({ actor: 'svc_carol', ipHash: 'cd'.repeat(32) }))).ticket, 'string');
 /* An issuance with NO IP hash does not consume an IP budget (and is not counted against one). */
 assert.equal(typeof (await issuer.issue(binding({ actor: 'svc_carol', ipHash: null }))).ticket, 'string');
 /* Past the 60s window the old issuances fall out of the rolling budget. */
 at = CLOCK + 61000;
 assert.equal(typeof (await issuer.issue(binding({ actor: 'svc_bob', ipHash: ip }))).ticket, 'string');
 assert.equal(await lab.scalar(db, "SELECT count(*)::int FROM identity.realtime_tickets WHERE issued_ip_hash = $1", [ip]), 6);
 issuer.close();
});

test('P05 tickets: the global outstanding cap fails closed across actors', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('tickets_global');
 await lab.seedActors(db);
 /* A caller may only TIGHTEN the frozen 10000 global cap; 2 makes the breach cheap and proves the
  * limit is global (three DIFFERENT actors, each far under its own per-actor cap). */
 const issuer = await createTicketIssuer(lab.poolsFor(db).api, { now: () => CLOCK, environment: 'stg', limits: { globalOutstanding: 2 } });
 const alice = await issuer.issue(binding({ actor: 'svc_alice' }));
 await issuer.issue(binding({ actor: 'svc_bob' }));
 assert.equal((await issuer.listOpen('svc_carol')).length, 0);
 await throwsCode(issuer.issue(binding({ actor: 'svc_carol' })), 'TICKET_LIMIT', 'the global cap refuses a third actor');
 /* A redeemed ticket no longer counts as outstanding, so the slot frees up. */
 await redeemRealtimeTicket(lab.poolsFor(db).core, { ticket: alice.ticket, connectionId: 'g-1', node: 'n', now: () => CLOCK });
 assert.equal(typeof (await issuer.issue(binding({ actor: 'svc_carol' }))).ticket, 'string');
 /* The frozen default is the design's 10000 and cannot be loosened by a caller. */
 await assert.rejects(createTicketIssuer(lab.poolsFor(db).api, { now: () => CLOCK, environment: 'stg', limits: { globalOutstanding: 10001 } }), (e) => e.message === 'TICKET_LIMIT_INVALID');
 issuer.close();
});

test('P05 tickets: core_runtime can execute the redeem function but cannot mutate the table directly', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('tickets_roles');
 await lab.seedActors(db);
 const core = lab.poolsFor(db).core;
 const issuer = await createTicketIssuer(lab.poolsFor(db).api, { now: () => CLOCK, environment: 'stg' });
 const { ticket } = await issuer.issue(binding({ matchScope: 'match-role' }));

 const denied = (e) => e && (e.code === '42501' || /permission denied/i.test(String(e.message)));
 const insert = 'INSERT INTO identity.realtime_tickets (ticket_hash, actor_id, session_id, generation, environment, audience, connection_class, issued_at, expires_at)'
  + " VALUES ('" + '9'.repeat(64) + "', 'svc_bob', 'x', 1, 'stg', 'mega-core', 'game', now(), now() + interval '10 seconds')";
 await assert.rejects(core.withTransaction((tx) => tx.query(insert)), denied, 'core_runtime has no INSERT on the ticket table');
 await assert.rejects(core.withTransaction((tx) => tx.query('UPDATE identity.realtime_tickets SET redeemed_at = now() WHERE ticket_hash = $1', [sha256hex(ticket)])), denied, 'core_runtime has no UPDATE');
 await assert.rejects(core.withTransaction((tx) => tx.query('DELETE FROM identity.realtime_tickets WHERE ticket_hash = $1', [sha256hex(ticket)])), denied, 'core_runtime has no DELETE');

 /* The narrow seam it DOES hold: EXECUTE on the SECURITY DEFINER function redeems exactly once. */
 const grant = await redeemRealtimeTicket(core, { ticket, connectionId: 'conn-role', node: 'core-node', now: () => CLOCK });
 assert.equal(grant.actorId, 'svc_alice');
 assert.equal(grant.matchScope, 'match-role');
 await throwsCode(redeemRealtimeTicket(core, { ticket, connectionId: 'conn-role', node: 'core-node', now: () => CLOCK }), 'TICKET_REDEEMED');
 issuer.close();
});
