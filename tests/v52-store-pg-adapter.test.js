'use strict';

/* Offline unit proof for the store-purchase PG adapter (LR15): the revocation check routes to the
 * CORE pool (0021), every store_finalize statement routes to the WORKER pool (0022 - core_runtime
 * is deliberately denied the finalize sweep), the legacy DELETE maps to the TERMINAL abandoned
 * state, created/updated alias the 0015 columns, and any unrecognized statement refuses. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgStoreDb } = require('../packages/services/store-pg-adapter.js');

function fakePools() {
  const coreQueries = [];
  const workerQueries = [];
  const row = { ping: 1 };
  return {
    corePool: { query: async (text, params) => { coreQueries.push({ text, params }); return { rows: [row], rowCount: 1 }; } },
    workerPool: { query: async (text, params) => { workerQueries.push({ text, params }); return { rows: [row], rowCount: 1 }; } },
    coreQueries,
    workerQueries,
  };
}

test('construction requires both pools', () => {
  assert.throws(() => createPgStoreDb({ workerPool: { query: async () => {} } }), /STORE_PG_CORE_POOL_REQUIRED/);
  assert.throws(() => createPgStoreDb({ corePool: { query: async () => {} } }), /STORE_PG_WORKER_POOL_REQUIRED/);
});

test('the revocation check routes to the CORE pool', async () => {
  const { corePool, workerPool, workerQueries, coreQueries } = fakePools();
  const db = createPgStoreDb({ corePool, workerPool });
  await db.prepare('SELECT 1 FROM v41_store_revocations WHERE store=? AND transaction_id=?').get('google', 'tx-1');
  assert.equal(coreQueries.length, 1);
  assert.match(coreQueries[0].text, /monetization\.store_revocations/);
  assert.deepEqual(coreQueries[0].params, ['google', 'tx-1']);
  await db.prepare("SELECT 1 FROM v41_store_revocations WHERE store='apple' AND transaction_id=?").get('tx-2');
  assert.equal(coreQueries.length, 2);
  assert.equal(workerQueries.length, 0);
});

test('every store_finalize statement routes to the WORKER pool', async () => {
  const { corePool, workerPool, workerQueries, coreQueries } = fakePools();
  const db = createPgStoreDb({ corePool, workerPool });
  await db.prepare("INSERT INTO v41_store_finalize(store,transaction_id,product_id,purchase_token,kind,state,attempts,next_at,created,updated) VALUES('google',?,?,?,?, 'pending',0,?,?,?) ON CONFLICT(store,transaction_id) DO UPDATE SET product_id=excluded.product_id").run('tx-1', 'crowns_100', 'token-1', 'consume', 1750000000000, 1750000000000, 1750000000000);
  assert.equal(coreQueries.length, 0);
  assert.equal(workerQueries.length, 1);
  assert.match(workerQueries[0].text, /INSERT INTO monetization\.store_finalize/);
  assert.deepEqual(workerQueries[0].params, ['tx-1', 'crowns_100', 'token-1', 'consume', 1750000000000, 1750000000000, 1750000000000]);
  await db.prepare("SELECT * FROM v41_store_finalize WHERE store='google' AND transaction_id=?").get('tx-1');
  assert.equal(coreQueries.length, 0);
  assert.equal(workerQueries.length, 2);
  /* created/updated alias the 0015 column names so the provider field expectations hold. */
  assert.match(workerQueries[1].text, /created_at AS created/);
  assert.match(workerQueries[1].text, /updated_at AS updated/);
});

test('the legacy DELETE maps to the TERMINAL abandoned state, never a DELETE', async () => {
  const { corePool, workerPool, workerQueries, coreQueries } = fakePools();
  const db = createPgStoreDb({ corePool, workerPool });
  await db.prepare("DELETE FROM v41_store_finalize WHERE store='google' AND transaction_id=?").run('tx-1');
  assert.equal(coreQueries.length, 0);
  assert.equal(workerQueries.length, 1);
  assert.match(workerQueries[0].text, /state = 'abandoned'/);
  assert.doesNotMatch(workerQueries[0].text, /DELETE FROM/);
  assert.deepEqual(workerQueries[0].params, ['tx-1']);
});

test('the due sweep routes to the WORKER pool with the pending filter', async () => {
  const { corePool, workerPool, workerQueries, coreQueries } = fakePools();
  const db = createPgStoreDb({ corePool, workerPool });
  const rows = await db.prepare("SELECT * FROM v41_store_finalize WHERE store='google' AND state='pending' AND next_at<=? ORDER BY created LIMIT 10").all(1750000000000);
  assert.deepEqual(rows, [{ ping: 1 }]);
  assert.equal(coreQueries.length, 0);
  assert.match(workerQueries[0].text, /state = 'pending'/);
  assert.deepEqual(workerQueries[0].params, [1750000000000]);
});

test('an unrecognized statement refuses on both lanes', () => {
  const { corePool, workerPool } = fakePools();
  const db = createPgStoreDb({ corePool, workerPool });
  assert.throws(() => db.prepare('SELECT * FROM monetization.reward_tickets'), /UNSUPPORTED_STORE_STATEMENT/);
  assert.throws(() => db.prepare('DROP TABLE players'), /UNSUPPORTED_STORE_STATEMENT/);
});
