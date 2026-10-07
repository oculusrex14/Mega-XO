/* Shared unit-of-work context over one synchronous node:sqlite connection.
 *
 * Exactly one transaction scope can be open per connection: node:sqlite rejects a
 * nested BEGIN ("cannot start a transaction within a transaction") and an
 * independent COMMIT inside a monetary operation would split one business effect
 * into two durable units. Repository calls and the existing store transaction
 * wrappers on the same connection therefore BORROW the active scope; only the
 * outermost scope commits or rolls back.
 *
 * The context (connection + clock + repository set) is created once per
 * connection and released when the owning store closes, so a context captured by
 * repository methods cannot write to a closed connection. The domain-graph
 * cache is dropped when a scope ends, so every unit of work hydrates the
 * serialized state exactly like the legacy read() did.
 */
'use strict';
class ContextError extends Error {
 constructor(code) { super(code); this.name = 'ContextError'; this.code = code; }
}
const CONTEXTS = new WeakMap();
const SCOPES = new WeakMap();
let repositoriesFactory = null;
function setRepositoriesFactory(factory) {
 if (typeof factory !== 'function') throw new ContextError('REPOSITORY_FACTORY_REQUIRED');
 repositoriesFactory = factory;
}
function contextFor(db, options = {}) {
 const existing = CONTEXTS.get(db);
 if (existing) return existing;
 if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') throw new ContextError('SQLITE_CONNECTION_REQUIRED');
 const context = {
  connection: db,
  clock: typeof options.now === 'function' ? options.now : Date.now,
  begin: typeof options.begin === 'string' ? options.begin : 'BEGIN IMMEDIATE',
  options,
  repositories: null,
  graph: null,
  ended: false,
 };
 CONTEXTS.set(db, context);
 return context;
}
function getContext(db) { return CONTEXTS.get(db) || null; }
function contextOptions(db, options) {
 if (options) return options;
 const context = CONTEXTS.get(db);
 return context ? context.options : {};
}
function repositoriesOf(context) {
 if (!repositoriesFactory) throw new ContextError('REPOSITORY_FACTORY_REQUIRED');
 if (!context.repositories) context.repositories = repositoriesFactory(context);
 return context.repositories;
}
/* Lazy accessor for legacy read paths that run outside a transaction. */
function getRepositories(db, options) { return repositoriesOf(contextFor(db, contextOptions(db, options))); }
function currentScope(db) {
 const scope = SCOPES.get(db);
 return scope && !scope.ended ? scope : null;
}
function requireScope(db) {
 const scope = currentScope(db);
 if (!scope) throw new ContextError('TRANSACTION_REQUIRED');
 return scope;
}
function releaseContext(db) {
 const context = CONTEXTS.get(db);
 if (!context) return;
 if (currentScope(db)) { try { db.exec('ROLLBACK'); } catch {} }
 CONTEXTS.delete(db);
 SCOPES.delete(db);
 context.ended = true;
 context.repositories = null;
}
function finishScope(context) {
 const scope = SCOPES.get(context.connection);
 if (scope) scope.ended = true;
 context.graph = null;
 SCOPES.delete(context.connection);
}
class TransactionScope {
 constructor(context, origin) {
  this.context = context;
  /* Which seam opened the outermost scope; used to detect a store trying to
   * persist an economy graph owned by a different store's open unit of work. */
  this.origin = origin || 'unit-of-work';
  this.depth = 0;
  this.ended = false;
  /* The transaction handle exposed to callbacks: repositories plus the one
   * connection and clock of this unit of work. */
  this.tx = Object.freeze({
   get repositories() { return repositoriesOf(context); },
   get connection() { return context.connection; },
   get clock() { return context.clock; },
  });
 }
 get repositories() { return repositoriesOf(this.context); }
 get connection() { return this.context.connection; }
 get clock() { return this.context.clock; }
 commit() {
  const scope = this;
  if (scope.ended) return;
  scope.depth--;
  if (scope.depth > 0) return;
  const context = scope.context;
  if (context.ended) { finishScope(context); return; }
  try {
   context.connection.exec('COMMIT');
  } catch (error) {
   try { context.connection.exec('ROLLBACK'); } catch {}
   finishScope(context);
   throw error;
  }
  finishScope(context);
 }
 rollback() {
  const scope = this;
  if (scope.ended) return;
  const context = scope.context;
  scope.ended = true;
  if (context.ended) return;
  context.connection.exec('ROLLBACK');
  finishScope(context);
 }
}
function openScope(db, options = {}) {
 const active = currentScope(db);
 if (active) { active.depth++; return active; }
 const context = contextFor(db, options);
 context.connection.exec(context.begin);
 const scope = new TransactionScope(context, options.origin);
 scope.depth = 1;
 SCOPES.set(db, scope);
 return scope;
}
function runInScope(db, options, fn) {
 if (typeof fn !== 'function') throw new ContextError('CALLBACK_REQUIRED');
 const scope = openScope(db, options);
 try {
  const value = fn(scope.tx);
  if (value && typeof value.then === 'function') throw new ContextError('ASYNC_CALLBACK_UNSUPPORTED');
  scope.commit();
  return value;
 } catch (error) {
  scope.rollback();
  throw error;
 }
}
module.exports = {
 ContextError,
 TransactionScope,
 contextFor,
 contextOptions,
 currentScope,
 finishScope,
 getContext,
 getRepositories,
 openScope,
 releaseContext,
 repositoriesOf,
 requireScope,
 runInScope,
 setRepositoriesFactory,
};
