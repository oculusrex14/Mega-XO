/* Pure account/profile/social policy: the approved V4 validators and constants, extracted
 * VERBATIM from server/community-store.js (V5 P04, spec 07 cutover).
 *
 * Why this module exists: the V5 PostgreSQL account service (packages/services/accounts.js) must
 * validate usernames, emails, practice archives and privacy exactly as the live V4.1.2 path does.
 * Re-writing those rules in the new service would create a second definition that drifts, so the
 * one definition moves here and `server/community-store.js` imports it. Nothing in this file
 * reaches storage, HTTP, SQLite or the network: every export is a pure function or a frozen
 * constant, and every failure is the bare source error code (`fail`).
 *
 * SOURCE TRUTH: every body below is byte-for-byte the corresponding declaration in
 * server/community-store.js as of V4.1.2 (lines 8-36 there), with two mechanical changes only:
 *   - `crypto` is required here instead of being required by the store, and
 *   - the practice theme allow-list is the named constant PRACTICE_THEMES instead of an inline
 *     literal (same values, same order).
 * The 150-Coin opening balance, wallet shapes and any economic rule are NOT here: they stay in
 * src/domain.js / src/authority.js and are Core-owned.
 */
'use strict';
const crypto = require('node:crypto');

const DAY = 86400000;

/* Practice archive admission bounds. The byte cap is measured on the ORIGINAL source text before
 * any JSON parsing (server/community-store.js:23-28), which is also what the 0033 payload_text
 * CHECK mirrors - so the measured representation must never change. */
const MAX_SAVE_BYTES = 262144;
const MAX_PRACTICE_RECORDS = 2000;
const MAX_OFFLINE_MOVES = 81;
const PRACTICE_VERSION = 3.2;
const PRACTICE_THEMES = Object.freeze(['vector', 'midnight', 'paperclub', 'afterhours']);
const PRACTICE_ROOTS = Object.freeze(['version', 'economyVersion', 'settings', 'records', 'processed', 'playSeconds', 'wallet', 'daily', 'weekly', 'legacy', 'profile', 'offlineMatch']);

const AVATARS = Object.freeze(['cross', 'ring', 'board', 'rook', 'crown', 'star']);
const NAME = /^[a-z][a-z0-9_]{2,19}$/;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const OTP_TTL = 10 * 60000;
const OTP_COOLDOWN = 60000;
const OTP_ATTEMPTS = 5;
const REPORT_CATEGORIES = new Set(['cheating', 'username', 'harassment', 'unsportsmanlike', 'other']);
const RESERVED = new Set(['admin', 'administrator', 'moderator', 'support', 'system', 'megaxo', 'mega_xo', 'official', 'deleted', 'anonymous']);
const PRIVACY_STATS = Object.freeze(['public', 'friends', 'private']);
const PRIVACY_PRESENCE = Object.freeze(['friends', 'hidden']);
const DISPLAY_NAME_MAX = 28;
const SEARCH_MIN = 3;
const SEARCH_MAX = 64;
const OPERATION_KEY = /^[A-Za-z0-9:_-]{1,160}$/;

/* The one error vocabulary: the message IS the bare code, exactly like the legacy store and the
 * packages/contracts errors. Diagnostics travel in `.detail`, never in the message. */
function fail(code) { throw Error(code); }

function normalizeEmail(value) {
 if (typeof value !== 'string') fail('INVALID_EMAIL');
 const email = value.trim().toLowerCase();
 if (email.length < 6 || email.length > 254 || !EMAIL.test(email)) fail('INVALID_EMAIL');
 return email;
}
function validatePassword(value) {
 if (typeof value !== 'string' || value.length < 10 || value.length > 128 || !/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) fail('PASSWORD_WEAK');
 return value;
}
/* scrypt parameters are part of the stored format: a verifier computed with other parameters is a
 * different algorithm, so they are frozen here and never re-derived at a call site. */
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024, keylen: 32 });
function passwordHash(password, salt) {
 return crypto.scryptSync(password, Buffer.from(salt, 'base64url'), SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem }).toString('base64url');
}
function passwordSalt() { return crypto.randomBytes(16).toString('base64url'); }
function otpCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function maskEmail(email) { const [local, domain] = email.split('@'); return local.slice(0, 1) + '***@' + domain; }

/* Constant-time comparison for CSRF tokens and one-time codes (server/identity-provider.js
 * `equal`, same semantics: unequal lengths compare false without touching the buffers). */
function equal(a, b) {
 if (typeof a !== 'string' || typeof b !== 'string') return false;
 const x = Buffer.from(a), y = Buffer.from(b);
 return x.length === y.length && crypto.timingSafeEqual(x, y);
}
/* Operation fingerprint. SOURCE TRUTH: server/community-store.js:210 stores
 * sha(JSON.stringify({command,target})) where sha is sha256 base64url (43 chars, no padding),
 * which is exactly the grammar social.command_outcomes.fingerprint accepts (0007). */
function fingerprint(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('base64url'); }
/* Legacy session/credential stamp: sha256(actor + '|' + password_hash) hex. */
function credentialStamp(actor, passwordHashValue) { return crypto.createHash('sha256').update(String(actor) + '|' + String(passwordHashValue)).digest('hex'); }

function safeText(value, max) { return typeof value === 'string' && value.trim().length > 0 && [...value.trim()].length <= max && !/[\u0000-\u001f\u007f<>]/.test(value); }
function safeKey(k) { return typeof k === 'string' && OPERATION_KEY.test(k); }

function sanitizePractice(value) {
 if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== PRACTICE_VERSION) fail('INVALID_SAVE');
 const text = JSON.stringify(value);
 if (Buffer.byteLength(text) > MAX_SAVE_BYTES) fail('SAVE_TOO_LARGE');
 const clean = JSON.parse(text, (k, v) => { if (['__proto__', 'constructor', 'prototype'].includes(k)) fail('INVALID_SAVE'); return v; });
 for (const k of Object.keys(clean)) if (!PRACTICE_ROOTS.includes(k)) delete clean[k];
 if (!Array.isArray(clean.records) || clean.records.length > MAX_PRACTICE_RECORDS || !clean.settings || !clean.wallet) fail('INVALID_SAVE');
 clean.records = clean.records.filter((r) => r?.mode === 'bot' && ['win', 'loss', 'draw'].includes(r.result) && typeof r.id === 'string' && r.id.length < 160 && Number.isFinite(r.activeSeconds) && r.activeSeconds >= 0 && r.activeSeconds <= 86400);
 if (!PRACTICE_THEMES.includes(clean.settings.theme)) fail('INVALID_SAVE');
 for (const key of ['coins', 'crowns']) if (!Number.isSafeInteger(clean.wallet[key]) || clean.wallet[key] < 0) fail('INVALID_SAVE');
 if (!Array.isArray(clean.wallet.ledger) || !Array.isArray(clean.wallet.owned) || !Array.isArray(clean.processed)) fail('INVALID_SAVE');
 if (clean.offlineMatch && (!Array.isArray(clean.offlineMatch.moves) || clean.offlineMatch.moves.length > MAX_OFFLINE_MOVES)) fail('INVALID_SAVE');
 // The archive is untrusted practice data. It is never read by economy settlement.
 return clean;
}

module.exports = {
 DAY, MAX_SAVE_BYTES, MAX_PRACTICE_RECORDS, MAX_OFFLINE_MOVES, PRACTICE_VERSION, PRACTICE_THEMES, PRACTICE_ROOTS,
 AVATARS, NAME, EMAIL, RESERVED, OTP_TTL, OTP_COOLDOWN, OTP_ATTEMPTS, REPORT_CATEGORIES,
 PRIVACY_STATS, PRIVACY_PRESENCE, DISPLAY_NAME_MAX, SEARCH_MIN, SEARCH_MAX, OPERATION_KEY, SCRYPT,
 fail, normalizeEmail, validatePassword, passwordHash, passwordSalt, otpCode, maskEmail, equal,
 fingerprint, credentialStamp, safeText, safeKey, sanitizePractice,
};
