/* Legacy command projection.
 *
 * The mounted routers turn a request body into a domain command. Both currently contain
 * the same field expressions (`server/http.js` standalone and `server/community-http.js`
 * mounted), and the inventory's hard rule is that the projection NEVER takes an actor id,
 * balance, rating change or outcome from client JSON. Defining the projection once makes
 * that rule explicit and testable instead of duplicated.
 *
 * Only request->command projection lives here. Route-specific pre-checks (friendship,
 * queue-busy, target resolution, rate budgets) stay in the routers, in their current
 * order; nothing in this module reads state or performs I/O.
 */
'use strict';

/* http.js:45 / community-http.js:108 - direct-challenge terms. Rated direct matches are
 * fixed at the approved 30s clock, unranked at 60s; `rated` is compared strictly to true
 * so `"false"`/`1` from a client cannot enable a rated match. */
function directOfferTerms(body) {
 const terms = body?.terms;
 return {
  mode: 'direct',
  kind: terms?.kind,
  rated: terms?.rated === true,
  amount: terms?.amount,
  turnSeconds: terms?.rated === true ? 30 : 60
 };
}

/* http.js:43 / community-http.js:110 - preferences only ever carry these two allowlisted
 * keys. A client cannot select an arbitrary account field through this command. */
function preferenceChanges(body) {
 return { wealthPublic: body?.changes?.wealthPublic, region: body?.changes?.region };
}

/* Field projections used by both routers. Each returns a fresh object with exactly the
 * legacy keys; extra client fields are dropped, never forwarded. */
function purchase(body) { return { type: 'purchase', evidence: body?.evidence }; }
function convert(body) { return { type: 'convert', from: body?.from, amount: body?.amount }; }
function quest(body) { return { type: 'quest', quest: body?.quest }; }
function friend(body) { return { type: 'friend', target: body?.target }; }
function acceptFriend(body) { return { type: 'acceptFriend', from: body?.from }; }
function preferences(body) { return { type: 'preferences', changes: preferenceChanges(body) }; }
function cosmetic(body) { return { type: 'cosmetic', name: body?.name }; }
function offer(body, opponent) { return { type: 'offer', id: body?.id, opponent, terms: directOfferTerms(body) }; }
function accept(body) { return { type: 'accept', id: body?.id, termsHash: body?.termsHash }; }
function decline(body) { return { type: 'decline', id: body?.id }; }
function cancel(body) { return { type: 'cancel', id: body?.id }; }
function move(body) { return { type: 'move', id: body?.id, revision: body?.revision, move: body?.move }; }
function resign(body) { return { type: 'resign', id: body?.id }; }

const COMMANDS = Object.freeze({ purchase, convert, quest, friend, acceptFriend, preferences, cosmetic, offer, accept, decline, cancel, move, resign });

/* Reconstructs a player command for a known logical name. Unknown names are not a
 * command - the caller answers NOT_FOUND exactly as before. */
function projectCommand(name, body, extra) {
 const builder = COMMANDS[name];
 return builder ? builder(body, extra) : null;
}

module.exports = {
 directOfferTerms, preferenceChanges, COMMANDS, projectCommand,
 purchase, convert, quest, friend, acceptFriend, preferences, cosmetic, offer, accept, decline, cancel, move, resign
};
