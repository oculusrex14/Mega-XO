/* Exact legacy invocation guard.
 *
 * This reproduces server/economy-store.js:19-20 verbatim, including guard order,
 * membership set, key length ceiling and error codes. It deliberately does NOT
 * tighten command shape: unknown command types and extra fields must keep reaching
 * the existing dispatcher so `UNKNOWN_COMMAND` and legacy ignored-field behaviour
 * are unchanged. `principal` is supplied by the authentication layer, never parsed
 * from request JSON.
 *
 * Returns normally on success (no boolean return) and throws otherwise.
 */
'use strict';
const { fail } = require('./errors.js');

const SCOPES = Object.freeze(['player', 'operator', 'matchmaker', 'store']);
const MAX_KEY_LENGTH = 160;

function validateInvocation(principal, key, command) {
 if (!principal || typeof principal.actor !== 'string' || !principal.actor || !SCOPES.includes(principal.scope)) fail('AUTH_REQUIRED');
 if (typeof key !== 'string' || !key || key.length > MAX_KEY_LENGTH || !command || typeof command.type !== 'string') fail('INVALID_COMMAND');
}

module.exports = { validateInvocation, SCOPES, MAX_KEY_LENGTH };
