'use strict';
/* P06 key-identifier regression (V5-06-02 namespacing, real Redis).
 *
 * WHAT THIS FILE PROVES. The v1 key builder joined raw parts with the structural ':' separator, so
 * two DIFFERENT (family, part...) tuples could render one key - `key('hint','a:b','c')` and
 * `key('hint','a','b:c')` both produced `…:hint:a:b:c` - and a part spelled with punctuation the old
 * ASCII allowlist refused (`presenceTouch("legacy actor/'[]", …)`) was denied outright even though it
 * is a preservable durable text identity. Every assertion below is made through the REAL consumer
 * methods on a REAL Redis (never a mock and never a key-string round-trip):
 *  1. preserved punctuation / ':' / Unicode text identity ids are admitted by per-session presence
 *     touch, read and drop, and never read or drop ANOTHER actor's state;
 *  2. two semantically different hint tuples stay isolated, including a literal '%3A' id versus an
 *     ':' id (the escape is never confused with the punctuation it spells);
 *  3. TTLs stay positive-finite and the namespace wipe is bounded to the EXACT environment and
 *     keyVersion (a sibling version and another environment survive);
 *  4. empty / non-string / over-bound / control-bearing parts are still refused with INVALID_KEY_PART
 *     and the environment / keyVersion grammar stays strict.
 *
 * Redis-only (no PostgreSQL): it skips when REDIS_URL is absent, exactly like the other P06 suites.
 * Every service owns a private keyVersion namespace and is wiped then closed in the teardown, so no
 * key outlives the run and the process drains naturally (no forceexit).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createEphemeraService } = require('../packages/services/ephemera.js');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:50710';
const HAVE_REDIS = process.env.REDIS_URL !== undefined || process.env.V5_REDIS_REQUIRED === '1';
const GATE = HAVE_REDIS ? false : 'no REDIS_URL';
/* The owned loopback convenience URL is plaintext; a managed endpoint is `rediss://`. Opt into
 * plaintext exactly as the application must - never weaken the service's own TLS contract. */
const baseOptions = (extra = {}) => ({
  url: REDIS_URL,
  environment: 'test',
  allowPlaintext: !REDIS_URL.startsWith('rediss://'),
  socket: { connectTimeout: 3000 },
  ...extra,
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Every adapter this file opens is wiped (its own namespace) and closed in the teardown. */
const open = [];
const serviceFor = async (extra = {}) => {
  const service = await createEphemeraService(baseOptions(extra));
  open.push(service);
  return service;
};
test.after(async () => {
  for (const service of open) {
    try { await service.wipeNamespace(); } catch { /* nothing to clean */ }
    try { await service.close(); } catch { /* best effort */ }
  }
});

test('P06 keys: preserved text identity ids are admitted and stay isolated', { skip: GATE }, async () => {
  const service = await serviceFor({ keyVersion: 'kidident' });
  assert.equal(await service.healthy(), true, 'the owned Redis must answer PING');

  /* The exact id from the reported failure, a ':'-bearing durable actor id (the identity grammar
   * admits ':' after the first character) and a Unicode id. */
  const odd = "legacy actor/'[]";
  const colon = 'u_1:x:y';
  const unicode = 'игрок-Ω-🎮';

  /* The reported call: per-session presence for a punctuation text id must be admitted. */
  assert.deepEqual(await service.presenceTouch(odd, 'svc-session', true, 60000), { stored: true, available: true }, 'a punctuation text id must heartbeat');
  assert.deepEqual(await service.presenceTouch(colon, 'sess-colon', true, 60000), { stored: true, available: true });
  assert.deepEqual(await service.presenceTouch(unicode, 'sess-unicode', true, 60000), { stored: true, available: true });

  /* Each actor reads back its OWN raw member value: the encoded keys never collapse onto each other. */
  assert.deepEqual((await service.presenceRead(odd)).sessions.map((s) => s.ref), ['svc-session']);
  assert.deepEqual((await service.presenceRead(colon)).sessions.map((s) => s.ref), ['sess-colon'], 'the colon actor is isolated');
  assert.deepEqual((await service.presenceRead(unicode)).sessions.map((s) => s.ref), ['sess-unicode'], 'the Unicode actor is isolated');

  /* A single-session drop removes only that member, then the actor drop removes the rest. */
  await service.presenceTouch(odd, 'svc-second', false, 60000);
  assert.deepEqual(await service.presenceDrop(odd, 'svc-session'), { dropped: true, available: true });
  assert.deepEqual((await service.presenceRead(odd)).sessions.map((s) => s.ref), ['svc-second'], 'only the named session member is dropped');
  assert.deepEqual(await service.presenceDropActor(odd), { dropped: true, available: true });
  assert.deepEqual((await service.presenceRead(odd)).sessions, [], 'the dropped actor is gone');
  assert.deepEqual((await service.presenceRead(colon)).sessions.map((s) => s.ref), ['sess-colon'], 'the sibling actor is untouched');
  assert.deepEqual((await service.presenceRead(unicode)).sessions.map((s) => s.ref), ['sess-unicode'], 'the Unicode actor is untouched');
});

test('P06 keys: distinct hint tuples never collide (literal %xx vs encoded punctuation)', { skip: GATE }, async () => {
  const service = await serviceFor({ keyVersion: 'kidhint' });
  assert.equal(await service.healthy(), true, 'the owned Redis must answer PING');

  /* (kind='a:b', id='c') and (kind='a', id='b:c') rendered the SAME key under v1. */
  assert.deepEqual(await service.setHint('a:b', 'c', 60000), { stored: true, available: true });
  assert.deepEqual(await service.checkHint('a:b', 'c'), { present: true, available: true });
  assert.deepEqual(await service.checkHint('a', 'b:c'), { present: false, available: true }, 'a different tuple must not inherit the write');
  assert.deepEqual(await service.setHint('a', 'b:c', 60000), { stored: true, available: true });
  assert.deepEqual(await service.checkHint('a:b', 'c'), { present: true, available: true }, 'both tuples now hold their own fact');
  assert.deepEqual(await service.checkHint('a', 'b:c'), { present: true, available: true });

  /* A literal percent-escape id must NOT read as the punctuation it spells: 'id%3A' vs 'id:'. */
  assert.deepEqual(await service.setHint('kind', 'id%3A', 60000), { stored: true, available: true });
  assert.deepEqual(await service.checkHint('kind', 'id:'), { present: false, available: true }, 'literal %3A must not collide with an encoded colon');
  assert.deepEqual(await service.setHint('kind', 'id:', 60000), { stored: true, available: true });
  assert.deepEqual(await service.checkHint('kind', 'id%3A'), { present: true, available: true });
  assert.deepEqual(await service.checkHint('kind', 'id:'), { present: true, available: true });

  /* A path-like id must not collide with a ':'-bearing one either. */
  assert.deepEqual(await service.setHint('p', 'a/b', 60000), { stored: true, available: true });
  assert.deepEqual(await service.checkHint('p', 'a:b'), { present: false, available: true });
});

test('P06 keys: TTLs stay finite and the wipe is bounded by exact environment and keyVersion', { skip: GATE }, async () => {
  const target = await serviceFor({ keyVersion: 'kidsc1' });
  const siblingVersion = await serviceFor({ keyVersion: 'kidsc2' });
  const otherEnv = await serviceFor({ keyVersion: 'kidsc1', environment: 'stg' });
  assert.equal(await target.healthy(), true, 'the owned Redis must answer PING');

  await target.cacheSet('cache', 'k', 'target', 60000);
  await target.setHint('revoked', 's', 60000);
  await siblingVersion.cacheSet('cache', 'k', 'sibling', 60000);
  await otherEnv.cacheSet('cache', 'k', 'otherenv', 60000);

  const audit = await target.auditUnboundedKeys();
  assert.equal(audit.available, true);
  assert.deepEqual(audit.unbounded, [], 'every written key must carry a positive finite TTL');

  await target.cacheSet('cache', 'short', 'x', 60);
  await sleep(150);
  assert.equal((await target.cacheGet('cache', 'short')).value, null, 'a 60 ms entry must expire');

  const wiped = await target.wipeNamespace();
  assert.equal(wiped.available, true, 'the wipe reports its bounded result');
  assert.ok(wiped.deleted >= 1, 'the wipe deleted this namespace keys');
  assert.equal((await target.cacheGet('cache', 'k')).value, null, 'the wiped namespace is empty');
  assert.deepEqual(await target.checkHint('revoked', 's'), { present: false, available: true });
  assert.equal((await siblingVersion.cacheGet('cache', 'k')).value, 'sibling', 'a different keyVersion is untouched');
  assert.equal((await otherEnv.cacheGet('cache', 'k')).value, 'otherenv', 'a different environment is untouched');
});

test('P06 keys: environment/keyVersion grammar stays strict and invalid parts are refused', { skip: GATE }, async () => {
  await assert.rejects(() => createEphemeraService(baseOptions({ environment: 'production' })), (e) => e.message === 'ENVIRONMENT_REQUIRED');
  await assert.rejects(() => createEphemeraService(baseOptions({ keyVersion: 'V2' })), (e) => e.message === 'INVALID_KEY_VERSION');
  await assert.rejects(() => createEphemeraService(baseOptions({ keyVersion: '' })), (e) => e.message === 'INVALID_KEY_VERSION');
  await assert.rejects(() => createEphemeraService(baseOptions({ keyVersion: 'x'.repeat(9) })), (e) => e.message === 'INVALID_KEY_VERSION');

  const service = await serviceFor({ keyVersion: 'kidbound' });
  assert.equal(await service.healthy(), true, 'the owned Redis must answer PING');

  await assert.rejects(() => service.presenceTouch(42, 's', true, 60000), (e) => e.message === 'INVALID_KEY_PART', 'a non-string actor is refused');
  await assert.rejects(() => service.presenceTouch('', 's', true, 60000), (e) => e.message === 'INVALID_KEY_PART', 'an empty actor is refused');
  await assert.rejects(() => service.presenceTouch('a'.repeat(161), 's', true, 60000), (e) => e.message === 'INVALID_KEY_PART', 'an over-bound actor is refused');
  await assert.rejects(() => service.presenceTouch('𝒜'.repeat(81), 's', true, 60000), (e) => e.message === 'INVALID_KEY_PART', 'an over-bound Unicode actor is refused');
  await assert.rejects(() => service.presenceTouch('bad\u0000actor', 's', true, 60000), (e) => e.message === 'INVALID_KEY_PART', 'a control-bearing actor is refused');
  await assert.rejects(() => service.presenceTouch('lone\uD800surrogate', 's', true, 60000), (e) => e.message === 'INVALID_KEY_PART', 'a lone surrogate is refused');
  await assert.rejects(() => service.presenceTouch('actor', 7, true, 60000), (e) => e.message === 'INVALID_KEY_PART', 'a non-string session ref is refused');
  await assert.rejects(() => service.cacheSet('cache', '', 'v', 1000), (e) => e.message === 'INVALID_KEY_PART', 'an empty cache id is refused');
  await assert.rejects(() => service.cacheSet('cache', null, 'v', 1000), (e) => e.message === 'INVALID_KEY_PART', 'a null cache id is refused');
});
