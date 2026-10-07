/* Concrete repository set for the shared unit of work.
 *
 * Every method runs on the unit of work's single connection and requires its live
 * transaction scope; none of them opens, commits or rolls back a transaction of
 * its own. Domain rules stay in the domain objects (Authority/domain modules) and
 * the store services; repositories only read/write the existing relational and
 * serialized layout, so the same shapes can back a future asynchronous adapter
 * without moving rules into SQL.
 *
 * The serialized `state` row is hydrated at most once per unit of work and cached
 * on the context, so a multi-repository monetary operation shares one domain graph
 * instead of re-parsing per call.
 */
'use strict';
const {Authority} = require('../../src/authority.js');
const {currentScope,requireScope} = require('./context');

class DomainGraph {
 constructor(context, authority) {
  this.context = context;
  this.authority = authority;
 }
 get accounts() { return this.authority.accounts; }
 get matches() { return this.authority.matches; }
 get receipts() { return this.authority.receipts; }
 account(id, required = true) {
  const account = this.authority.accounts.get(id);
  if (!account) {
   if (required) throw Error('ACCOUNT_REQUIRED');
   return null;
  }
  return account;
 }
 export() { return this.authority.export(); }
}

function hydrate(context, options) {
 /* Shared within one live unit of work only; outside a scope (legacy read path)
  * every call hydrates fresh, matching the legacy read() semantics. */
 const cacheable = !!currentScope(context.connection);
 if (cacheable && context.graph) return context.graph;
 const row = context.connection.prepare('SELECT json FROM state WHERE id=1').get();
 if (!row) throw Error('ACCOUNT_SERVICE_REQUIRED');
 const graph = new DomainGraph(context, new Authority({...(options || context.options), state: JSON.parse(row.json)}));
 if (cacheable) context.graph = graph;
 return graph;
}

function repositoriesFor(context) {
 const db = context.connection;
 /* Reads use the connection (safe outside a transaction, exactly like the legacy
  * store reads). Mutations require the live transaction scope so no repository can
  * write outside the one unit of work or after the context is released. */
 const conn = () => context.connection;
 const write = () => requireScope(db).connection;
 const stateJson = (graph) => JSON.stringify(graph.export());

 const accounts = {
  has(actor) { conn(); return hydrate(context).accounts.has(actor); },
 };

 const profiles = {
  for(actor) { conn(); return db.prepare('SELECT actor,tag,username,display_name,avatar,stats_visibility,presence_visibility,created,username_changed,version FROM profiles WHERE actor=?').get(actor) || null; },
 };

 const sessions = {
  live(tokenHash, now) { conn(); return db.prepare('SELECT token,actor,csrf,created,expires,auth_at FROM account_sessions WHERE token=? AND expires>?').get(tokenHash, now) || null; },
  presence(actor, since, before) { conn(); return db.prepare('SELECT p.seen,p.foreground FROM session_presence p JOIN account_sessions s ON s.token=p.session WHERE p.actor=? AND p.seen>? AND s.expires>?').all(actor, since, before); },
  revoke(actor, tokenHash) { write(); return db.prepare('DELETE FROM account_sessions WHERE actor=? AND token=?').run(actor, tokenHash).changes; },
  /* Single-use bearer rotation deletes by token: an anonymous session has a NULL actor. */
  rotate(tokenHash) { write(); return db.prepare('DELETE FROM account_sessions WHERE token=?').run(tokenHash).changes; },
  revokeOthers(actor, tokenHash) { write(); return db.prepare('DELETE FROM account_sessions WHERE actor=? AND token<>? RETURNING token').all(actor, tokenHash).map(row => row.token); },
  revokeAll(actor) { write(); return db.prepare('DELETE FROM account_sessions WHERE actor=?').run(actor).changes; },
  clearPresence(tokenHash) { write(); return db.prepare('DELETE FROM session_presence WHERE session=?').run(tokenHash).changes; },
  clearOtherPresence(actor, tokenHash) { write(); return db.prepare('DELETE FROM session_presence WHERE actor=? AND session<>?').run(actor, tokenHash).changes; },
  clearActorPresence(actor) { write(); return db.prepare('DELETE FROM session_presence WHERE actor=?').run(actor).changes; },
 };

 const saves = {
  for(actor) { conn(); return db.prepare('SELECT revision,payload,updated FROM profile_saves WHERE actor=?').get(actor) || null; },
  revisionOf(actor) { conn(); return db.prepare('SELECT revision FROM profile_saves WHERE actor=?').get(actor)?.revision || 0; },
 };

 const wallets = {
  for(actor) { conn(); const account = hydrate(context).account(actor); return {actor, coins: account.coins, crowns: account.crowns, purchasedCoins: account.purchasedCoins, purchasedCrowns: account.purchasedCrowns, reservedCoins: account.reservedCoins, reservedCrowns: account.reservedCrowns, purchaseInfluenced: !!account.purchaseInfluenced}; },
 };

 const ledger = {
  recent(actor, limit = 40) { conn(); const graph = hydrate(context); const entries = (graph.authority.journal || []).filter(entry => entry.actor === actor); return limit === null ? entries : entries.slice(-limit); },
  burned() { conn(); const burned = hydrate(context).authority.burned; return {coins: burned.coins, crowns: burned.crowns}; },
 };

 const matches = {
  for(id) { conn(); return hydrate(context).matches.get(id) || null; },
  view(id) { conn(); const graph = hydrate(context); const match = graph.matches.get(id); if (!match) throw Error('UNKNOWN_MATCH'); return graph.authority.view(id); },
  forActor(actor, statuses = null) { conn(); return [...hydrate(context).matches.values()].filter(match => match.players.includes(actor) && (!statuses || statuses.includes(match.status))); },
 };

 const tournaments = {
  /* Party rooms are the durable tournament serialization (party_rooms.json). */
  room(id) { conn(); const row = db.prepare('SELECT json FROM party_rooms WHERE id=? OR code=?').get(id, id); return row ? JSON.parse(row.json) : null; },
  activeRooms() { conn(); return db.prepare("SELECT json FROM party_rooms WHERE json_extract(json,'$.status') IN ('LOBBY','RUNNING','PAUSED','REVIEW')").all().map(row => JSON.parse(row.json)); },
  codeExists(code) { conn(); return !!db.prepare('SELECT id FROM party_rooms WHERE code=?').get(code); },
  save(room) { write(); db.prepare('INSERT INTO party_rooms VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(room.id, room.code, JSON.stringify(room)); return room.id; },
 };

 const purchases = {
  receipt(store, transactionId) { conn(); return hydrate(context).receipts.get(`${store}:${transactionId}`) || null; },
  revoked(store, transactionId) { conn(); return !!db.prepare('SELECT 1 FROM v41_store_revocations WHERE store=? AND transaction_id=?').get(store, transactionId); },
 };

 /* Durable operation outcomes. A scope describes its own table SQL so each store
  * keeps its existing key/column layout (commands.id, party_commands.id,
  * v35_commands actor+key) instead of one invented shared convention. */
 const outcomes = {
  find(scope, ...keys) { conn(); return db.prepare(scope.find).get(...keys) || null; },
  save(scope, ...values) { write(); db.prepare(scope.insert).run(...values); return values; },
 };

 /* Durable worker-visible job queue already present in the schema. The selector
  * and expiry predicate are the exact legacy mail-outbox claim statements, so the
  * outbox worker and the repository cannot drift apart. (Purchase finalization
  * lives in the Google billing module and is not duplicated here.) */
 const OUTBOX_DUE = "SELECT * FROM v4_outbox WHERE expires>? AND attempts<3 AND ((state='queued' AND next_at<=?) OR (state='sending' AND lease_until<=?)) ORDER BY created LIMIT ?";
 const OUTBOX_EXPIRE = "UPDATE v4_outbox SET state='expired',payload=NULL WHERE expires<=? AND state IN ('queued','sending')";
 const jobs = {
  queues() { return ['v4_outbox']; },
  due(table, now, limit = 1) {
   conn();
   if (table !== 'v4_outbox') throw Error('UNKNOWN_JOB_QUEUE');
   return db.prepare(OUTBOX_DUE).all(now, now, now, limit);
  },
  expireDue(table, now) {
   write();
   if (table !== 'v4_outbox') throw Error('UNKNOWN_JOB_QUEUE');
   return db.prepare(OUTBOX_EXPIRE).run(now).changes;
  },
 };

 const community = {
  /* Durable rate/limit counter: autocommit outside a unit of work (legacy rate
   * behavior) and part of the unit when one is open. Callers map hits>limit to
   * RATE_LIMITED; counters are abuse budgets, not economic state. */
  count(id) { conn(); return db.prepare('INSERT INTO community_limits VALUES(?,1) ON CONFLICT(id) DO UPDATE SET hits=hits+1 RETURNING hits').get(id).hits; },
 };

 /* Raw serialized economy record, exactly as the legacy room/monetization readers
  * saw it: no Authority construction, so no normalization is persisted back into
  * the row when a caller rewrites it. Outside a unit of work this autocommits,
  * preserving the legacy `writeEconomy` seam; inside one it is transactional. */
 const state = {
  read() { conn(); const row = context.connection.prepare('SELECT json FROM state WHERE id=1').get(); if (!row) throw Error('ACCOUNT_SERVICE_REQUIRED'); return JSON.parse(row.json); },
  write(value) {
   conn().prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(value));
   context.graph = null;
   return value;
  },
 };

 return Object.freeze({
  accounts, profiles, sessions, saves, wallets, ledger, matches, tournaments,
  purchases, outcomes, jobs, community, state,
  domain: () => { conn(); return hydrate(context); },
  /* Persist the shared domain graph through the unit of work's connection. The
   * whole serialized state row is rewritten exactly like the legacy stores did,
   * so domain normalization/season rolling stay in-memory until this commit. */
  commitDomain() {
   write(); const graph = hydrate(context);
   write().prepare('UPDATE state SET json=? WHERE id=1').run(stateJson(graph));
   return true;
  },
 });
}

module.exports = {DomainGraph, repositoriesFor};
