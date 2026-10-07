/* packages/db - real synchronous SQLite unit of work and repositories.
 *
 *   const {createSqliteUnitOfWork} = require('packages/db');
 *   const uow = createSqliteUnitOfWork(db, {now});
 *   const result = uow.run(tx => {
 *     const wallet = tx.repositories.wallets.for(actor);        // requires the live scope
 *     tx.repositories.domain().authority.convert(actor, 'coins', 10, key);
 *     tx.repositories.commitDomain();                            // same connection/commit
 *     tx.repositories.outcomes.save(scope, id, actor, fp, json); // same transaction
 *     return result;
 *   });
 *
 * `run` is synchronous for the legacy node:sqlite adapter. Repository methods
 * borrow the active unit of work; a nested run on the same connection reuses it
 * and never commits independently, and a repository call outside any scope fails
 * with TRANSACTION_REQUIRED instead of silently writing outside a transaction.
 */
'use strict';
const context = require('./context');
const {DomainGraph, repositoriesFor} = require('./repositories');

context.setRepositoriesFactory(repositoriesFor);

/* Existing store classes use db.tx(fn) as their transaction seam (CommunityStore.tx,
 * MailOutbox/EmailAuth via the community store). Binding that one seam to the
 * shared unit of work makes every existing transaction body - including nested
 * ones - participate in the one real scope instead of a second connection-level
 * transaction. No other connection method is added or renamed. */
function bindTransactionSeam(db, unitOfWork) {
 if (db.tx && db.tx.unitOfWork === unitOfWork) return unitOfWork;
 Object.defineProperty(db, 'tx', {
  configurable: true,
  writable: true,
  value: (fn) => unitOfWork.run(fn),
 });
 db.tx.unitOfWork = unitOfWork;
 return unitOfWork;
}

function createSqliteUnitOfWork(db, options = {}) {
 if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') throw Error('SQLITE_CONNECTION_REQUIRED');
 const resolved = context.contextOptions(db, options);
 const unitOfWork = {
  run(fn) { return context.runInScope(db, resolved, fn); },
  repositories() { return context.getRepositories(db, resolved); },
  close() { context.releaseContext(db); },
 };
 bindTransactionSeam(db, unitOfWork);
 return unitOfWork;
}

module.exports = {
 createSqliteUnitOfWork,
 bindTransactionSeam,
 DomainGraph,
 repositoriesFor,
 ContextError: context.ContextError,
 contextFor: context.contextFor,
 contextOptions: context.contextOptions,
 currentScope: context.currentScope,
 getContext: context.getContext,
 getRepositories: context.getRepositories,
 releaseContext: context.releaseContext,
 requireScope: context.requireScope,
 runInScope: context.runInScope,
 setRepositoriesFactory: context.setRepositoriesFactory,
};
