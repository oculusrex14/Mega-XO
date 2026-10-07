/* native/v1 host bridge contract.
 *
 * DTO + bounds for the two existing host bridges the approved client already calls:
 *
 *   window.MegaNativeIdentity.getCredential({provider, nonce}) -> {idToken}
 *     src/community.js:92 -> POST /api/account/native/challenge then /finish
 *   window.MegaNativeNotifications.{notify,requestPermission}
 *     src/community.js:162-163
 *
 * Bounds are taken from the existing server checks, not invented: provider/intent/kind
 * are the exact allowlists in server/identity-provider.js and server/community-store.js,
 * and the ID-token ceiling is the one `IdentityProviders.verify` already enforces.
 *
 * The mounted /api/account/native/* routes deliberately keep their current checks and
 * error precedence (for example, an unknown provider still answers
 * PROVIDER_NOT_CONFIGURED from the capability gate, not a contract error), so these
 * validators are the shared library definition for the native host adapter and the
 * future Core - they do not re-route or re-error the shipped browser surface.
 */
'use strict';
const { fail } = require('./errors.js');

const BRIDGE_VERSION = 'native/v1';
const PROVIDERS = Object.freeze(['google', 'apple']);
const INTENTS = Object.freeze(['login', 'link', 'reauth']);
const KINDS = Object.freeze(['web', 'native']);
const MAX_NONCE_LENGTH = 512;
const MAX_ID_TOKEN_LENGTH = 16384;
const MAX_STATE_LENGTH = 512;
const MAX_TITLE_LENGTH = 256;
const MAX_BODY_LENGTH = 1024;
const MAX_TAG_LENGTH = 64;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const isProvider = value => typeof value === 'string' && PROVIDERS.includes(value);
const isIntent = value => typeof value === 'string' && INTENTS.includes(value);
const isKind = value => typeof value === 'string' && KINDS.includes(value);

const isNonce = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_NONCE_LENGTH && BASE64URL.test(value);

/* A JWS-compact token. Signature/claims verification stays with IdentityProviders.verify;
 * this only rejects shapes that could never verify, before any network/provider work. */
function isIdTokenShape(value) {
 if (typeof value !== 'string' || !value || value.length > MAX_ID_TOKEN_LENGTH) return false;
 const parts = value.split('.');
 return parts.length === 3 && parts.every(part => part.length > 0 && BASE64URL.test(part));
}

/* POST /api/account/native/challenge body: {provider, intent?, kind?} */
function validateChallengeRequest(body) {
 if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_AUTH_REQUEST');
 if (!isProvider(body.provider)) fail('INVALID_AUTH_REQUEST', 'provider');
 if (body.intent !== undefined && !isIntent(body.intent)) fail('INVALID_AUTH_REQUEST', 'intent');
 return { provider: body.provider, intent: body.intent || 'login' };
}
/* Response handed to the host: {state, nonce, expires}. Neither value may be logged. */
function validateChallengeResponse(value) {
 if (!value || typeof value !== 'object') fail('INVALID_AUTH_REQUEST');
 if (!isNonce(value.state) || value.state.length > MAX_STATE_LENGTH) fail('INVALID_AUTH_STATE');
 if (!isNonce(value.nonce)) fail('INVALID_AUTH_STATE', 'nonce');
 if (!Number.isSafeInteger(value.expires) || value.expires <= 0) fail('INVALID_AUTH_STATE', 'expires');
 return { state: value.state, nonce: value.nonce, expires: value.expires };
}
/* Host bridge return value. A missing/blank token must fail closed, never fall back to a
 * user id or email: the server only ever accepts an SDK ID token for this nonce. */
function validateCredential(value, { provider, nonce } = {}) {
 if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ID_TOKEN');
 if (provider !== undefined && !isProvider(provider)) fail('INVALID_ID_TOKEN', 'provider');
 if (nonce !== undefined && !isNonce(nonce)) fail('INVALID_ID_TOKEN', 'nonce');
 if (!isIdTokenShape(value.idToken)) fail('INVALID_ID_TOKEN');
 return { idToken: value.idToken };
}
/* POST /api/account/native/finish body: {provider, state, idToken} */
function validateFinishRequest(body) {
 if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_AUTH_REQUEST');
 if (!isProvider(body.provider)) fail('INVALID_AUTH_REQUEST', 'provider');
 if (!isNonce(body.state) || body.state.length > MAX_STATE_LENGTH) fail('INVALID_AUTH_STATE');
 if (!isIdTokenShape(body.idToken)) fail('INVALID_ID_TOKEN');
 return { provider: body.provider, state: body.state, idToken: body.idToken };
}
/* window.MegaNativeNotifications.notify({title, body, tag}) */
function validateNotificationRequest(value) {
 if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_NOTIFICATION');
 const title = typeof value.title === 'string' ? value.title : '';
 const body = typeof value.body === 'string' ? value.body : '';
 const tag = typeof value.tag === 'string' ? value.tag : '';
 if (!title || title.length > MAX_TITLE_LENGTH) fail('INVALID_NOTIFICATION', 'title');
 if (body.length > MAX_BODY_LENGTH) fail('INVALID_NOTIFICATION', 'body');
 if (tag.length > MAX_TAG_LENGTH) fail('INVALID_NOTIFICATION', 'tag');
 return { title, body, tag };
}

module.exports = {
 BRIDGE_VERSION, PROVIDERS, INTENTS, KINDS,
 MAX_NONCE_LENGTH, MAX_ID_TOKEN_LENGTH, MAX_TITLE_LENGTH, MAX_BODY_LENGTH, MAX_TAG_LENGTH,
 isProvider, isIntent, isKind, isNonce, isIdTokenShape,
 validateChallengeRequest, validateChallengeResponse, validateCredential, validateFinishRequest, validateNotificationRequest
};
