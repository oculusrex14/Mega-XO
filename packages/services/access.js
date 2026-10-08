/* packages/services/access.js - V5 P05 Ed25519 access-token signing and public verification.
 *
 * The V5 successor to "no access token, no JWT, no JWKS, no signing-key registry" (design A9).
 * It signs the frozen minimal claim set of design B2.1 with EdDSA over Ed25519, keeps the PRIVATE
 * key exclusively in a sealed operator file, and stores only the public JWK plus a custody
 * REFERENCE in identity.signing_keys (design G3/B2.2).
 *
 *   const access = await createAccessService(pool, {
 *     now,                  // injected clock, epoch milliseconds (default Date.now)
 *     issuer,               // REQUIRED exact issuer, e.g. https://api.megaxo.online
 *     environment,          // REQUIRED 'stg' | 'prd'
 *     keyFile,              // REQUIRED absolute path of the sealed private-key file
 *     playerAudiences,      // REQUIRED non-empty client-class audiences (e.g. mega-browser)
 *     serviceAudiences,     // REQUIRED non-empty service audiences (e.g. mega-core)
 *   });
 *
 * Factory contract: construction validates the pool/options, enforces key custody, runs
 * `verifyRuntimeSchema(pool)`, REQUIRES the `api_runtime` role, and ensures exactly one ACTIVE
 * key for the environment exists. It creates no actor, wallet, session or opening balance.
 *
 * KEY CUSTODY. The private key is Ed25519 PKCS8 PEM and lives ONLY in the sealed JSON file
 * (`{kid: pem}`, fsync'd through a temp file and renamed, chmod 600). The database stores the
 * public JWK, the file path as private_ref, and the RFC 7638 thumbprint. In `prd` a missing sealed
 * file is a hard `KEY_CUSTODY_REQUIRED` failure - production never auto-generates key material. In
 * `stg` the file is created on first boot and the first active key is minted there.
 *
 * kid GRAMMAR. `mxv5-<env>-<yyyyqq>-<seq>-<crc8>`:
 *   - env   the environment token ('stg' | 'prd'),
 *   - yyyyqq the UTC year and quarter of creation (e.g. 2026Q4),
 *   - seq   a per-environment monotonically increasing integer derived from the number of
 *           existing key rows for that environment (never a global counter),
 *   - crc8  two lowercase hex digits: CRC-8 (polynomial 0x07, init 0x00, no reflection) over the
 *           ASCII of the public-JWK thumbprint's base64url text. A routing hint/typo detector only.
 * Authority always comes from the registry row, never from the kid.
 *
 * CLAIMS (exactly, no more): iss, aud, sub, sid, gen, amr, ath, iat, nbf, exp, jti. A token NEVER
 * carries balances, ranks, entitlements, roles, permission grants or a provider subject.
 * TTLs: access token 300 s, API->Core service assertion 15 s (design Part F).
 *
 * VERIFICATION. kid is required; the row is looked up in any state ('retired' -> UNKNOWN_SIGNING_KEY);
 * the header alg must be exactly 'EdDSA' (else ALGORITHM_REJECTED); iss and aud are exact with the
 * signature checked against the stored public JWK; exp/nbf are compared at now() with ZERO leeway.
 * Player and service audiences are disjoint so a service assertion fails a player verification
 * (and vice versa) with AUDIENCE_MISMATCH. Failure codes are exactly: UNKNOWN_SIGNING_KEY,
 * TOKEN_EXPIRED, AUDIENCE_MISMATCH, ISSUER_MISMATCH, ALGORITHM_REJECTED, MALFORMED_TOKEN.
 */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ContextError } = require('../db/context');
const { verifyRuntimeSchema } = require('../db/pg/readiness');
const { createPgUnitOfWork } = require('../db/pg/uow');
const { lockTransactionIdentity } = require('../db/pg/locks');

const ALG = 'EdDSA';
const KTY = 'OKP';
const CRV = 'Ed25519';
const SERVICE_SUBJECT = 'service:api_runtime';
const ACCESS_TTL_SECONDS = 300;
const SERVICE_ASSERTION_TTL_SECONDS = 15;
const RETIRING_RESIDENCE_MS = 360000;
const JWKS_MAX_KEYS = 8;
const ENVIRONMENTS = Object.freeze(['stg', 'prd']);

const fail = (code) => { throw Error(code); };

/* ------------------------------------------------------------------ primitives */

const b64u = (value) => Buffer.from(value).toString('base64url');
const b64uJson = (value) => b64u(Buffer.from(JSON.stringify(value)));

function decodeJson(segment) {
 if (typeof segment !== 'string' || !segment) return null;
 try { return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')); } catch { return null; }
}

/* CRC-8/ATM: polynomial 0x07, init 0x00, no input/output reflection, no final XOR. */
function crc8Hex(text) {
 let crc = 0x00;
 for (let i = 0; i < text.length; i += 1) {
  crc ^= text.charCodeAt(i) & 0xff;
  for (let bit = 0; bit < 8; bit += 1) {
   crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
 }
 return crc.toString(16).padStart(2, '0');
}

/* RFC 7638 JWK thumbprint: the required members in lexicographic order, sha256, base64url. */
function jwkThumbprint(jwk) {
 const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
 return crypto.createHash('sha256').update(canonical).digest('base64url');
}

const quarterOf = (at) => `${at.getUTCFullYear()}Q${Math.floor(at.getUTCMonth() / 3) + 1}`;
const kidFor = (environment, at, seq, crc8) => `mxv5-${environment}-${quarterOf(at)}-${seq}-${crc8}`;

function audienceList(value, code) {
 if (!Array.isArray(value) || value.length === 0) fail(code);
 const out = [];
 for (const item of value) {
  if (typeof item !== 'string' || !item) fail(code);
  if (!out.includes(item)) out.push(item);
 }
 return Object.freeze(out);
}

function amrList(value) {
 if (!Array.isArray(value)) fail('INVALID_AMR');
 const out = [];
 for (const method of value) {
  if (typeof method !== 'string' || !method) fail('INVALID_AMR');
  if (!out.includes(method)) out.push(method);
 }
 return out;
}

/* ------------------------------------------------------------- sealed key file */

function readKeyFile(file) {
 let text;
 try { text = fs.readFileSync(file, 'utf8'); } catch { fail('KEY_CUSTODY_REQUIRED'); }
 let map;
 try { map = JSON.parse(text); } catch { fail('KEY_CUSTODY_INVALID'); }
 if (!map || typeof map !== 'object' || Array.isArray(map)) fail('KEY_CUSTODY_INVALID');
 for (const [kid, pem] of Object.entries(map)) {
  if (typeof kid !== 'string' || !kid || typeof pem !== 'string' || !pem.startsWith('-----BEGIN')) fail('KEY_CUSTODY_INVALID');
 }
 return map;
}

/* Atomic, fsync'd, owner-only write. The temp file is created in the same directory so the rename
 * is atomic on the same filesystem, and the mode is 600 before any private byte is written. */
function writeKeyFile(file, map) {
 const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
 const fd = fs.openSync(tmp, 'w', 0o600);
 try {
  fs.writeSync(fd, JSON.stringify(map));
  fs.fsyncSync(fd);
 } finally { fs.closeSync(fd); }
 fs.renameSync(tmp, file);
 fs.chmodSync(file, 0o600);
}

/* ------------------------------------------------------------------ factory */

async function createAccessService(pool, options = {}) {
 if (!pool || typeof pool.withTransaction !== 'function') throw new ContextError('PG_POOL_REQUIRED');
 const clock = typeof options.now === 'function' ? options.now : Date.now;
 const issuer = options.issuer;
 if (typeof issuer !== 'string' || !issuer) fail('ISSUER_REQUIRED');
 const environment = options.environment;
 if (!ENVIRONMENTS.includes(environment)) fail('ENVIRONMENT_REQUIRED');
 if (typeof options.keyFile !== 'string' || !options.keyFile) fail('KEY_FILE_REQUIRED');
 const playerAudiences = audienceList(options.playerAudiences, 'PLAYER_AUDIENCES_REQUIRED');
 const serviceAudiences = audienceList(options.serviceAudiences, 'SERVICE_AUDIENCES_REQUIRED');
 for (const audience of playerAudiences) {
  if (serviceAudiences.includes(audience)) fail('AUDIENCES_NOT_DISJOINT');
 }
 const absKeyFile = path.resolve(options.keyFile);

 /* Custody is decided BEFORE any database work: a production node without its sealed private key
  * must fail immediately and must never fall back to generating one. */
 if (environment === 'prd') {
  if (!fs.existsSync(absKeyFile)) fail('KEY_CUSTODY_REQUIRED');
 } else if (!fs.existsSync(absKeyFile)) {
  writeKeyFile(absKeyFile, {});
 }
 const pemMap = readKeyFile(absKeyFile);

 const readiness = await verifyRuntimeSchema(pool);
 const role = readiness.role;
 if (role !== 'api_runtime') {
  const error = new ContextError('ROLE_REQUIRED');
  error.detail = `createAccessService requires api_runtime, got ${role}`;
  throw error;
 }
 const uow = createPgUnitOfWork(pool, { now: clock, role });
 const privateCache = new Map();
 const publicCache = new Map();

 let closed = false;
 const run = (fn) => {
  if (closed) return Promise.reject(new ContextError('UNIT_OF_WORK_CLOSED'));
  return uow.run(fn);
 };

 const persistKeyFile = () => writeKeyFile(absKeyFile, pemMap);

 const privateKeyFor = (kid) => {
  const pem = pemMap[kid];
  if (typeof pem !== 'string' || !pem) fail('KEY_CUSTODY_REQUIRED');
  let key = privateCache.get(kid);
  if (!key) { key = crypto.createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' }); privateCache.set(kid, key); }
  return key;
 };

 const publicKeyFor = (row) => {
  let key = publicCache.get(row.kid);
  if (!key) { key = crypto.createPublicKey({ key: row.public_jwk, format: 'jwk' }); publicCache.set(row.kid, key); }
  return key;
 };

 /* Mint one new ACTIVE key: generate the pair, seal the PKCS8 PEM, then record the public row.
  * The caller holds the per-environment advisory lock, so `count` cannot race a sibling mint and
  * seq is strictly increasing. The file is written before the insert: an orphaned sealed key is
  * harmless, a recorded key with no private half would not be. */
 const mintKey = async (tx) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const exported = publicKey.export({ format: 'jwk' });
  const publicJwk = { kty: exported.kty, crv: exported.crv, x: exported.x };
  const thumbprint = jwkThumbprint(publicJwk);
  const counted = await tx.query('SELECT count(*)::int AS n FROM identity.signing_keys WHERE environment = $1', [environment]);
  const kid = kidFor(environment, new Date(clock()), Number(counted.rows[0].n) + 1, crc8Hex(thumbprint));
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  pemMap[kid] = pem;
  persistKeyFile();
  const at = new Date(clock());
  await tx.query(
   'INSERT INTO identity.signing_keys (kid, environment, algorithm, public_jwk, private_ref, state, created_at, activate_at, retire_at, thumbprint)'
   + ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9)',
   [kid, environment, ALG, JSON.stringify(publicJwk), absKeyFile, 'active', at, at, thumbprint]);
  return kid;
 };

 const activeKid = async (tx) => {
  const r = await tx.query("SELECT kid FROM identity.signing_keys WHERE environment = $1 AND state = 'active' ORDER BY created_at DESC LIMIT 1", [environment]);
  if (!r.rows[0]) fail('UNKNOWN_SIGNING_KEY');
  return r.rows[0].kid;
 };

 const sign = async (claims) => {
  const kid = await run((tx) => activeKid(tx));
  const header = { alg: ALG, typ: 'JWT', kid };
  const input = `${b64uJson(header)}.${b64uJson(claims)}`;
  const signature = crypto.sign(null, Buffer.from(input), privateKeyFor(kid));
  return `${input}.${b64u(signature)}`;
 };

 /* Ensure exactly one active key exists for this environment (design B2.2 staging/active state
  * machine; the boot mint covers the first boot and a node that lost its active row). */
 await run(async (tx) => {
  await lockTransactionIdentity(tx, 'signing-key', [environment]);
  const r = await tx.query("SELECT kid FROM identity.signing_keys WHERE environment = $1 AND state = 'active' ORDER BY created_at DESC LIMIT 1", [environment]);
  if (r.rows[0]) {
   privateKeyFor(r.rows[0].kid);
   return;
  }
  await mintKey(tx);
 });

 /* ---------------------------------------------------------------- interface */

 async function issue(grant = {}) {
  const { actor, sessionId, generation, amr, authAt, audience } = grant;
  if (!playerAudiences.includes(audience)) fail('AUDIENCE_MISMATCH');
  if (typeof actor !== 'string' || !actor) fail('INVALID_SUBJECT');
  if (typeof sessionId !== 'string' || !sessionId) fail('INVALID_SESSION_ID');
  if (!Number.isSafeInteger(generation) || generation < 1) fail('INVALID_GENERATION');
  if (!Number.isSafeInteger(authAt) || authAt < 0) fail('INVALID_AUTH_AT');
  const methods = amrList(amr);
  const issuedAt = Math.floor(clock() / 1000);
  return sign({
   iss: issuer,
   aud: audience,
   sub: actor,
   sid: sessionId,
   gen: generation,
   amr: methods,
   ath: Math.floor(authAt / 1000),
   iat: issuedAt,
   nbf: issuedAt,
   exp: issuedAt + ACCESS_TTL_SECONDS,
   jti: crypto.randomUUID(),
  });
 }

 async function issueServiceAssertion(assertion = {}) {
  const { op, fp, actor, scope, audience } = assertion;
  if (!serviceAudiences.includes(audience)) fail('AUDIENCE_MISMATCH');
  if (typeof op !== 'string' || !op) fail('INVALID_OPERATION');
  if (typeof fp !== 'string' || !fp) fail('INVALID_FINGERPRINT');
  if (typeof actor !== 'string' || !actor) fail('INVALID_SUBJECT');
  if (typeof scope !== 'string' || !scope) fail('INVALID_SCOPE');
  const issuedAt = Math.floor(clock() / 1000);
  return sign({
   iss: issuer,
   aud: audience,
   sub: SERVICE_SUBJECT,
   scope,
   actor,
   op,
   fp,
   iat: issuedAt,
   nbf: issuedAt,
   exp: issuedAt + SERVICE_ASSERTION_TTL_SECONDS,
   jti: crypto.randomUUID(),
  });
 }

 async function verify(token, verifyOptions = {}) {
  const audience = verifyOptions.audience;
  if (typeof token !== 'string' || !token) fail('MALFORMED_TOKEN');
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1]) fail('MALFORMED_TOKEN');
  const header = decodeJson(parts[0]);
  if (!header || typeof header.alg !== 'string') fail('MALFORMED_TOKEN');
  /* The per-issuer algorithm allowlist (design B2.2): our tokens are EdDSA only, and the
   * header-parameter attacks (alg:none, jku/x5u key injection, crit) are refused before any
   * key material is considered. ALGORITHM_REJECTED is the frozen code for all of them. */
  if (header.alg !== ALG || header.crit !== undefined || header.jku !== undefined || header.x5u !== undefined) fail('ALGORITHM_REJECTED');
  if (typeof header.kid !== 'string' || !header.kid) fail('MALFORMED_TOKEN');
  if (!parts[2]) fail('MALFORMED_TOKEN');
  const row = await run(async (tx) => {
   const r = await tx.query('SELECT kid, environment, state, public_jwk FROM identity.signing_keys WHERE kid = $1', [header.kid]);
   return r.rows[0] || null;
  });
  /* This service only accepts keys of its OWN environment: a key row for another environment is not
   * this issuer's key, even though the table is shared. 'retired' is likewise unknown. */
  if (!row || row.environment !== environment || row.state === 'retired') fail('UNKNOWN_SIGNING_KEY');
  const signed = `${parts[0]}.${parts[1]}`;
  const valid = crypto.verify(null, Buffer.from(signed), publicKeyFor(row), Buffer.from(parts[2], 'base64url'));
  if (!valid) fail('MALFORMED_TOKEN');
  const payload = decodeJson(parts[1]);
  if (!payload) fail('MALFORMED_TOKEN');
  if (payload.iss !== issuer) fail('ISSUER_MISMATCH');
  if (payload.aud !== audience) fail('AUDIENCE_MISMATCH');
  const nowSeconds = Math.floor(clock() / 1000);
  /* Zero leeway at now(): exp must be strictly future and nbf must not be future. The frozen
   * failure set has one temporal code, so a future nbf is also TOKEN_EXPIRED (a token that is
   * not yet valid is never accepted). */
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= nowSeconds) fail('TOKEN_EXPIRED');
  if (!Number.isSafeInteger(payload.nbf) || payload.nbf > nowSeconds) fail('TOKEN_EXPIRED');
  return payload;
 }

 async function jwks() {
  const rows = (await run((tx) => tx.query(
   "SELECT kid, public_jwk, state FROM identity.signing_keys WHERE environment = $1 AND state IN ('active', 'retiring')"
   + " ORDER BY (state = 'active') DESC, activate_at DESC NULLS LAST, created_at DESC LIMIT $2",
   [environment, JWKS_MAX_KEYS]))).rows;
  return {
   keys: rows.map((row) => ({ kty: KTY, crv: CRV, x: row.public_jwk.x, use: 'sig', alg: ALG, kid: row.kid })),
  };
 }

 async function rotateKeys() {
  await run(async (tx) => {
   await lockTransactionIdentity(tx, 'signing-key', [environment]);
   const actives = await tx.query("SELECT kid FROM identity.signing_keys WHERE environment = $1 AND state = 'active'", [environment]);
   const retireAt = new Date(clock() + RETIRING_RESIDENCE_MS);
   for (const row of actives.rows) {
    await tx.query("UPDATE identity.signing_keys SET state = 'retiring', retire_at = $2 WHERE kid = $1", [row.kid, retireAt]);
   }
   await mintKey(tx);
  });
 }

 async function retireDueKeys() {
  const at = new Date(clock());
  return run(async (tx) => {
   const r = await tx.query(
    "UPDATE identity.signing_keys SET state = 'retired' WHERE environment = $1 AND state = 'retiring' AND retire_at IS NOT NULL AND retire_at <= $2 RETURNING kid",
    [environment, at]);
   return r.rowCount;
  });
 }

 function close() {
  closed = true;
  uow.close();
 }

 return Object.freeze({
  issue,
  issueServiceAssertion,
  verify,
  jwks,
  rotateKeys,
  retireDueKeys,
  close,
 });
}

module.exports = {
 createAccessService,
 ACCESS_TTL_SECONDS,
 SERVICE_ASSERTION_TTL_SECONDS,
 RETIRING_RESIDENCE_MS,
 JWKS_MAX_KEYS,
 SERVICE_SUBJECT,
 ALG,
 KTY,
 CRV,
 crc8Hex,
 jwkThumbprint,
 kidFor,
};
