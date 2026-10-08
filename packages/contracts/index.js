/* @mega-xo/contracts - versioned shared validators and DTO contracts.
 *
 * Independent of HTTP and SQLite: no `node:http`, no `node:sqlite`, no server or `src`
 * imports, so the same validators can run inside the Vercel facade, the Game Core, the
 * worker, a native host adapter and a plain unit test.
 *
 * Consumers:
 *   server/economy-store.js  -> validateInvocation (DurableStore.run, before BEGIN)
 *   server/http.js           -> http-guards (body/key/origin/principal/response)
 *   server/community-http.js -> http-guards (same, plus cookie/session origin rules)
 *   server/party-http.js     -> http-guards (LAN bearer + if-present origin rules)
 *   server/monetization-http.js -> http-guards (provider callbacks + keyed commands)
 *   future Core / realtime transport -> realtime (envelope/snapshot/delta/ack bounds)
 */
'use strict';

const { ContractError, fail, isContractError } = require('./errors.js');
const { validateInvocation, SCOPES, MAX_KEY_LENGTH } = require('./invocation.js');
const guards = require('./http-guards.js');
const commands = require('./commands.js');
const routes = require('./routes.js');
const nativeBridge = require('./native-bridge.js');
const realtime = require('./realtime.js');
const access = require('./access-dto.js');

module.exports = {
 // failure primitive
 ContractError, fail, isContractError,
 // invocation guard shared with the transactional store
 validateInvocation, SCOPES, MAX_KEY_LENGTH,
 // request/body/key/principal guards for the mounted legacy routers
 guards,
 // request body -> domain command projection (never trusts actor/balance/outcome)
 commands,
 // versioned legacy HTTP/native bridge route manifest
 routes,
 // native/v1 host bridge DTO contracts
 nativeBridge,
 // separately versioned realtime/v1 envelope contract
 realtime,
 // P05 native-credential + realtime-ticket DTO contracts
 access
};
