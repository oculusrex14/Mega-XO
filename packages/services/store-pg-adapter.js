'use strict';

/* LR15 (2026-10-16): PostgreSQL adapter for the V4-era store verifiers, ON the existing
 * monetization.store_* schema (0015) under the DEPLOYED ROLE SPLIT (0021/0022/0038):
 *   - the revocation check (SELECT on monetization.store_revocations) runs on the CORE pool
 *     (0021 grants core_runtime SELECT/INSERT/UPDATE there);
 *   - every store_finalize statement runs on the WORKER pool (0022 grants worker_runtime
 *     SELECT/INSERT/UPDATE on store_finalize; core_runtime is DENIED the finalize sweep -
 *     asserted by the least-privilege suite).
 * The adapter recognises EXACTLY the statements the providers issue and FAILS CLOSED on any
 * other statement. created/updated map to the 0015 created_at/updated_at columns (aliased on
 * SELECT); the legacy DELETE maps to the TERMINAL abandoned state (no worker DELETE grant).
 * Both pools are caller-owned; neither is optional. */

const fail = (code) => { throw Error(code); };
const normalize = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const toPgParams = (sql) => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };

const MAPPINGS = [
  { fragment: "SELECT 1 FROM v41_store_revocations WHERE store=", lane: "core", kind: "get", pg: "SELECT 1 FROM monetization.store_revocations WHERE store=$1 AND transaction_id=$2" },
  { fragment: "SELECT 1 FROM v41_store_revocations WHERE store='apple' AND transaction_id=?", lane: "core", kind: "get", pg: "SELECT 1 FROM monetization.store_revocations WHERE store = 'apple' AND transaction_id = $1" },
  { fragment: "INSERT INTO v41_store_finalize", lane: "worker", kind: "run", pg: "INSERT INTO monetization.store_finalize (store, transaction_id, product_id, purchase_token, kind, state, attempts, next_at, created_at, updated_at) VALUES ('google', $1, $2, $3, $4, 'pending', 0, $5, $6, $7) ON CONFLICT (store, transaction_id) DO UPDATE SET product_id = excluded.product_id, purchase_token = CASE WHEN monetization.store_finalize.state = 'done' THEN monetization.store_finalize.purchase_token ELSE excluded.purchase_token END, kind = excluded.kind, updated_at = excluded.updated_at" },
  { fragment: "UPDATE v41_store_finalize SET state='done'", lane: "worker", kind: "run", pg: "UPDATE monetization.store_finalize SET state = 'done', purchase_token = '', updated_at = $1 WHERE store = 'google' AND transaction_id = $2" },
  { fragment: "UPDATE v41_store_finalize SET attempts=", lane: "worker", kind: "run", pg: "UPDATE monetization.store_finalize SET attempts = $1, next_at = $2, updated_at = $3 WHERE store = 'google' AND transaction_id = $4" },
  { fragment: "SELECT * FROM v41_store_finalize WHERE store='google' AND transaction_id=?", lane: "worker", kind: "get", pg: "SELECT *, created_at AS created, updated_at AS updated FROM monetization.store_finalize WHERE store = 'google' AND transaction_id = $1" },
  { fragment: "SELECT * FROM v41_store_finalize WHERE store='google' AND state='pending'", lane: "worker", kind: "all", pg: "SELECT *, created_at AS created, updated_at AS updated FROM monetization.store_finalize WHERE store = 'google' AND state = 'pending' AND next_at <= $1 ORDER BY created_at LIMIT 10" },
  { fragment: "DELETE FROM v41_store_finalize", lane: "worker", kind: "run", pg: "UPDATE monetization.store_finalize SET state = 'abandoned', updated_at = now() WHERE store = 'google' AND transaction_id = $1" },
];

function createPgStoreDb(options) {
  const corePool = options && options.corePool;
  const workerPool = options && options.workerPool;
  if (!corePool || typeof corePool.query !== 'function') fail('STORE_PG_CORE_POOL_REQUIRED');
  if (!workerPool || typeof workerPool.query !== 'function') fail('STORE_PG_WORKER_POOL_REQUIRED');
  const pools = { core: corePool, worker: workerPool };
  return Object.freeze({
    prepare(sql) {
      const normalized = normalize(sql);
      const mapping = MAPPINGS.find((m) => normalized.startsWith(m.fragment));
      if (!mapping) fail('UNSUPPORTED_STORE_STATEMENT');
      const text = toPgParams(mapping.pg);
      const execute = (params) => pools[mapping.lane].query(text, params);
      const firstRow = (result) => (result && Array.isArray(result.rows) ? result.rows[0] : undefined);
      const rowsOf = (result) => (result && Array.isArray(result.rows) ? result.rows : []);
      return Object.freeze({
        async get(...params) {
          if (mapping.kind !== 'get' && mapping.kind !== 'run') fail('UNSUPPORTED_STORE_STATEMENT');
          return firstRow(await execute(params));
        },
        async all(...params) {
          if (mapping.kind !== 'all') fail('UNSUPPORTED_STORE_STATEMENT');
          return rowsOf(await execute(params));
        },
        async run(...params) {
          if (mapping.kind === 'all') fail('UNSUPPORTED_STORE_STATEMENT');
          const result = await execute(params);
          return { changes: result && Number.isSafeInteger(result.rowCount) ? result.rowCount : 0 };
        },
      });
    },
  });
}

module.exports = { createPgStoreDb, MAPPINGS };
