/* packages/db/pg/uow.js - V5 P04 PostgreSQL unit of work.
 *
 * The asynchronous mirror of `createSqliteUnitOfWork` (packages/db/index.js) over the
 * guarded pool in `packages/db/pg/pool.js`:
 *
 *   const pool = createPgPool(fromEnvironment(process.env));
 *   const uow  = createPgUnitOfWork(pool, {now});
 *   const out  = await uow.run(async (tx) => {
 *     await tx.repositories.wallets.lock([actor, other], {aggregate: {kind: 'match', id}});
 *     await tx.repositories.wallets.reserve({actor, currency: 'coins', amount: 100, entryId, reason, at});
 *     return tx.repositories.wallets.for(actor);
 *   });
 *
 * Contract (identical where the storage model allows it to the SQLite adapter):
 *  - ONE transaction scope per client. `run`/`runAsync` borrow the pool's
 *    `withTransaction`, which opens exactly one `withIdempotentTransaction`
 *    (pool.js:578-664). A nested `run` on the same client borrows the live scope,
 *    increments its depth and NEVER commits independently.
 *  - A repository call with no live scope raises the shared
 *    `ContextError('TRANSACTION_REQUIRED')`. Unlike the synchronous SQLite adapter -
 *    whose reads ride the always-open connection - PG read members are scope-bound
 *    too: the guarded pool only guarantees the pinned search_path, role identity and
 *    timers inside the borrowed transaction, so an out-of-scope read would run on a
 *    session this layer cannot vouch for.
 *  - `run` and `runAsync` are the same asynchronous entry point. PostgreSQL I/O
 *    cannot be synchronous, so the result is always a Promise and a caller cannot
 *    mistake it for a committed value. `runAsync` is the explicit alias.
 *  - `close()` releases this unit of work's own state only. The pool is owned by the
 *    caller - it carries a cluster-wide connection-budget claim (pool.js:claimBudget)
 *    that must outlive one request - so the unit of work never calls `pool.end()`.
 *
 * The transaction facade handed to the callback exposes exactly what the SQLite
 * `scope.tx` exposes - `client`, `clock`, `query` - plus the scope-bound
 * `repositories` accessor and the live `scope`. The frozen `tx` object owned by
 * pool.js is never mutated, and the repository set is built once per transaction.
 */
'use strict';
const { ContextError } = require('../context');
const { withIdempotentTransaction } = require('./pool');
const { pgRepositoriesFor } = require('./repositories');

/* Transaction options forwarded to the transaction primitive. Deliberately closed: an
 * unknown option silently ignored would be a silent correctness hole (a typo in
 * `expectRole` would drop the in-BEGIN role re-assertion). `expectSession` is pinned by
 * the pool in pool mode and cannot be overridden from here. */
const TRANSACTION_OPTIONS = Object.freeze(['key', 'expectRole']);

function createPgUnitOfWork(pool, options = {}) {
 if (!pool || typeof pool.withTransaction !== 'function') throw new ContextError('PG_POOL_REQUIRED');
 if (options.now !== undefined && typeof options.now !== 'function') throw new ContextError('CLOCK_REQUIRED');
 const clock = typeof options.now === 'function' ? options.now : Date.now;
 const boundClient = options.client || null;
 /* The guarded pool knows which runtime identity it logs in as; taking the role from it means a
  * caller cannot forget to declare it and silently lose the role-aware repository behaviour
  * (schema capability filtering and the split eligibility grants). */
 const role = typeof options.role === 'string' && options.role
  ? options.role
  : (typeof pool.describe === 'function' && pool.describe() ? pool.describe().role : null);
 const transactionOptions = {};
 for (const key of TRANSACTION_OPTIONS) {
  if (options[key] !== undefined) transactionOptions[key] = options[key];
 }
 /* One repository set per live transaction: a second pgRepositoriesFor(context) for the
  * same scope would re-derive the same frozen member set and lose the per-scope
  * aggregate read cache. */
 const repositorySets = new WeakMap();
 let closed = false;

 function facade(tx) {
  let entry = repositorySets.get(tx);
  if (!entry) {
   const context = Object.freeze({
    client: tx.client,
    transaction: tx,
    scope: tx.scope,
    role,
    clock: typeof tx.clock === 'function' ? tx.clock : clock,
    options,
   });
   entry = Object.freeze({ context, repositories: pgRepositoriesFor(context) });
   repositorySets.set(tx, entry);
  }
  const context = entry.context;
  return Object.freeze({
   get client() { return tx.client; },
   get clock() { return context.clock; },
   get scope() { return tx.scope; },
   get repositories() { return entry.repositories; },
   query(text, params) { return tx.query(text, params); },
  });
 }

 function runAsync(fn) {
  if (closed) return Promise.reject(new ContextError('UNIT_OF_WORK_CLOSED'));
  if (typeof fn !== 'function') return Promise.reject(new ContextError('CALLBACK_REQUIRED'));
  /* Await the callback even when it is synchronous: an unawaited rejection inside a
   * thenable would otherwise escape the transaction body and be reported as a COMMIT. */
  const body = (tx) => Promise.resolve().then(() => fn(facade(tx)));
  const resolved = { ...transactionOptions, now: clock };
  if (boundClient) return withIdempotentTransaction(boundClient, body, { ...resolved, connected: true });
  return pool.withTransaction(body, resolved);
 }

 return Object.freeze({
  /* Both names are the same asynchronous entry point; see the header. */
  run: runAsync,
  runAsync,
  /* Bound to the supplied client's live scope when a client was supplied, otherwise a
   * detached set whose every method raises ContextError('TRANSACTION_REQUIRED'). */
  repositories() {
   if (closed) throw new ContextError('UNIT_OF_WORK_CLOSED');
   return pgRepositoriesFor(Object.freeze({ client: boundClient, role, clock, options }));
  },
  clock() { return clock(); },
  close() { closed = true; },
 });
}

module.exports = { createPgUnitOfWork, TRANSACTION_OPTIONS };
