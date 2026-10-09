/* packages/services/managed-ephemera.js - V5 P06 managed (free-only) Redis/Valkey binding (V5-06-01).
 *
 * `createManagedEphemera` turns two owner-supplied artefacts into the owned ephemera adapter:
 *   1. the NON-SECRET environment inventory (whole environment JSON; the `redis` section is the
 *      exact intended managed target: provider, service id, host, port, region, plan, tls,
 *      autoUpgrade), and
 *   2. a PRIVATE runtime credential envelope (0600 or stricter regular file outside any fixture
 *      tree) carrying the provider, environment, the provider-native database/service id, the
 *      credential-bearing `rediss://` URL and an optional trusted CA.
 *
 * Guard order is deliberate: inventory shape -> environment agreement -> free-only policy ->
 * credential file privacy -> envelope identity -> URL endpoint/protocol. Every refusal happens
 * BEFORE `createEphemeraService` is called, so a mismatch can never open a Redis socket. Errors
 * carry a stable code as the message (and as `error.code`); no URL, credential, file content or
 * full envelope is ever echoed into a cause, message or log.
 *
 * Cross-environment refusal: `environment` must equal `inventory.environment`, and the envelope
 * environment must equal it too. A staging envelope therefore cannot be bound to a production
 * inventory by merely changing the requested namespace (the namespace is DERIVED, never a caller
 * switch). The namespace map is staging => stg, production => prd; the adapter is created with
 * plaintext disabled and no socket/verification override.
 *
 * A managed dependency being down is not a boot outage: the returned adapter keeps the existing
 * conservative per-operation fallbacks (`available:false`), exactly as the owned local adapter.
 */
'use strict';
const fs = require('node:fs');

const { createEphemeraService } = require('./ephemera.js');

/* staging => stg, production => prd (the adapter's hard namespace boundary). */
const NAMESPACE_BY_ENVIRONMENT = Object.freeze({ staging: 'stg', production: 'prd' });
const MANAGED_ENVIRONMENTS = new Set(Object.keys(NAMESPACE_BY_ENVIRONMENT));
const PROVIDERS = new Set(['upstash', 'aiven']);
/* The provider-native id the private envelope must carry, keyed by provider. */
const ID_KEY_BY_PROVIDER = Object.freeze({ upstash: 'databaseId', aiven: 'serviceId' });
/* Non-secret inventory: the required managed configuration inputs. Any OTHER `redis` field - the
 * documentary metadata real inventories carry (name, nonserving, a credentialFile reference,
 * providerLimits, documentedMonthlyCommandLimit, evidence paths, ...) - is IGNORED, because the
 * adapter options are constructed explicitly from these inputs alone and an unknown field can
 * therefore never change a socket, a namespace or a TLS setting. Requested configuration that
 * carries runtime meaning (plan/tls/autoUpgrade/provider/host/port/serviceId) is still validated. */
const INVENTORY_REDIS_INPUTS = Object.freeze(['provider', 'serviceId', 'host', 'port', 'region', 'plan', 'tls', 'autoUpgrade']);
/* Private runtime envelope: the exact frozen field set; anything else (developer API key, REST
 * token, admin email...) is refused rather than quietly tolerated. */
const ENVELOPE_KEYS = new Set(['provider', 'environment', 'databaseId', 'serviceId', 'url', 'ca']);
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const SERVICE_ID_RE = /^[A-Za-z0-9._:\/-]{1,128}$/;
const MAX_CA_BYTES = 65536;

const fail = (code) => { const error = new Error(code); error.code = code; throw error; };

/* Reads the private runtime envelope as a regular, non-symlinked file whose mode grants nothing to
 * group/other (POSIX). The mode is checked on the OPENED descriptor, so a path swapped after the
 * initial lstat cannot slip a world-readable file past the guard. */
function readPrivateEnvelope(file) {
  if (typeof file !== 'string' || file.length === 0) fail('CREDENTIAL_FILE_REQUIRED');
  let lst;
  try { lst = fs.lstatSync(file); }
  catch { fail('CREDENTIAL_FILE_UNREADABLE'); }
  if (!lst.isFile()) fail('CREDENTIAL_FILE_UNSAFE');
  let fd;
  /* O_NOFOLLOW is defence in depth: the leaf must not become a symlink between lstat and open. */
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
  catch { fail('CREDENTIAL_FILE_UNREADABLE'); }
  let text;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) fail('CREDENTIAL_FILE_UNSAFE');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) fail('CREDENTIAL_FILE_NOT_PRIVATE');
    text = fs.readFileSync(fd, 'utf8');
  } catch (error) {
    if (error && error.code === 'CREDENTIAL_FILE_UNSAFE') throw error;
    if (error && error.code === 'CREDENTIAL_FILE_NOT_PRIVATE') throw error;
    fail('CREDENTIAL_FILE_UNREADABLE');
  } finally {
    try { fs.closeSync(fd); } catch { /* descriptor already gone */ }
  }
  let doc;
  try { doc = JSON.parse(text); }
  catch { fail('CREDENTIAL_ENVELOPE_INVALID'); }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) fail('CREDENTIAL_ENVELOPE_INVALID');
  return doc;
}

function validateInventory(inventory) {
  if (inventory === null || typeof inventory !== 'object' || Array.isArray(inventory)) fail('INVENTORY_REQUIRED');
  const environment = inventory.environment;
  if (!MANAGED_ENVIRONMENTS.has(environment)) fail('INVENTORY_ENVIRONMENT_INVALID');
  const redis = inventory.redis;
  if (redis === null || typeof redis !== 'object' || Array.isArray(redis)) fail('INVENTORY_REDIS_REQUIRED');
  /* Documentary metadata on `redis` (name, nonserving, credentialFile reference, providerLimits,
   * documentedMonthlyCommandLimit, evidence paths, or any other top-level section) is NOT part of
   * the frozen configuration inputs and is deliberately ignored: the returned config is a fresh
   * object built only from the known inputs, so an unknown field can never reach the adapter. */
  const config = {};
  for (const key of INVENTORY_REDIS_INPUTS) config[key] = redis[key];

  if (!PROVIDERS.has(config.provider)) fail('INVENTORY_PROVIDER_UNSUPPORTED');
  if (typeof config.serviceId !== 'string' || !SERVICE_ID_RE.test(config.serviceId)) fail('INVENTORY_SERVICE_ID_REQUIRED');
  if (typeof config.host !== 'string' || !HOST_RE.test(config.host)) fail('INVENTORY_HOST_REQUIRED');
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535) fail('INVENTORY_PORT_INVALID');
  if (typeof config.region !== 'string' || config.region.length === 0 || config.region.length > 64) fail('INVENTORY_REGION_REQUIRED');

  /* Explicit all-free policy: the managed dependency must be a free plan with TLS on and
   * automatic paid upgrades off. Actual quota/region measures are separate evidence, never a
   * marketing guarantee asserted here. */
  if (config.plan !== 'free') fail('INVENTORY_PLAN_NOT_FREE');
  if (config.tls !== true) fail('INVENTORY_TLS_REQUIRED');
  if (config.autoUpgrade !== false) fail('INVENTORY_AUTO_UPGRADE_FORBIDDEN');

  return { environment, redis: config };
}

function validateEnvelope(doc, environment, redis) {
  for (const key of Object.keys(doc)) if (!ENVELOPE_KEYS.has(key)) fail('CREDENTIAL_ENVELOPE_UNKNOWN_FIELD');
  if (doc.provider !== redis.provider) fail('CREDENTIAL_PROVIDER_MISMATCH');
  if (doc.environment !== environment) fail('CREDENTIAL_ENVIRONMENT_MISMATCH');

  const expectedKey = ID_KEY_BY_PROVIDER[redis.provider];
  const otherKey = expectedKey === 'databaseId' ? 'serviceId' : 'databaseId';
  if (doc[otherKey] !== undefined) fail('CREDENTIAL_ID_MISMATCH');
  const id = doc[expectedKey];
  if (typeof id !== 'string' || id.length === 0) fail('CREDENTIAL_ID_REQUIRED');
  if (id !== redis.serviceId) fail('CREDENTIAL_ID_MISMATCH');

  if (typeof doc.url !== 'string' || doc.url.length === 0) fail('CREDENTIAL_URL_REQUIRED');

  let ca;
  if (doc.ca !== undefined) {
    if (typeof doc.ca !== 'string' || doc.ca.length === 0 || doc.ca.length > MAX_CA_BYTES || !doc.ca.includes('-----BEGIN CERTIFICATE-----')) {
      fail('CREDENTIAL_CA_INVALID');
    }
    ca = doc.ca;
  }
  return { url: doc.url, ca };
}

/* Binds the envelope URL to the exact intended inventory endpoint. `rediss://` only - a plaintext
 * `redis://`, a non-Redis scheme, a query string (a verification/`ssl` bypass cannot ride along), a
 * fragment, a database path and a missing embedded credential are all refused. */
function validateEndpoint(url, redis) {
  let parsed;
  try { parsed = new URL(url); }
  catch { fail('CREDENTIAL_URL_INVALID'); }
  if (parsed.protocol !== 'rediss:') fail('CREDENTIAL_URL_INSECURE');
  if (parsed.search.length > 0 || parsed.hash.length > 0) fail('CREDENTIAL_URL_QUERY_FORBIDDEN');
  if (parsed.pathname !== '' && parsed.pathname !== '/') fail('CREDENTIAL_URL_PATH_FORBIDDEN');
  if (!parsed.password) fail('CREDENTIAL_URL_CREDENTIALS_REQUIRED');
  if (parsed.hostname.toLowerCase() !== redis.host.toLowerCase()) fail('CREDENTIAL_URL_HOST_MISMATCH');
  const port = parsed.port === '' ? 6379 : Number(parsed.port);
  if (port !== redis.port) fail('CREDENTIAL_URL_PORT_MISMATCH');
}

/* Pure guard + option builder: validates the inventory, the private envelope and the endpoint and
 * returns the non-secret target descriptor plus the exact options for `createEphemeraService`.
 * Exported so callers (and the guard tests) can preflight without opening a socket; the factory is
 * a thin wrapper over it so a refusal is always identical on both paths. */
function resolveManagedRedisTarget({ inventory, environment, credentialFile } = {}) {
  const inventoryInfo = validateInventory(inventory);
  if (!MANAGED_ENVIRONMENTS.has(environment)) fail('ENVIRONMENT_REQUIRED');
  if (environment !== inventoryInfo.environment) fail('ENVIRONMENT_MISMATCH');
  const { redis } = inventoryInfo;

  const doc = readPrivateEnvelope(credentialFile);
  const { url, ca } = validateEnvelope(doc, inventoryInfo.environment, redis);
  validateEndpoint(url, redis);

  const namespace = NAMESPACE_BY_ENVIRONMENT[inventoryInfo.environment];
  /* Plaintext stays disabled (no `allowPlaintext`, no `tls` override) and no CA is invented: the
   * envelope CA is used when supplied, otherwise platform trust applies. */
  const options = ca === undefined
    ? { url, environment: namespace }
    : { url, environment: namespace, ca };
  return Object.freeze({
    provider: redis.provider,
    environment: inventoryInfo.environment,
    namespace,
    serviceId: redis.serviceId,
    host: redis.host,
    port: redis.port,
    region: redis.region,
    options: Object.freeze(options),
  });
}

/* Builds the real owned ephemera adapter for the managed target. Connectivity is NOT awaited: a
 * down dependency resolves to the adapter's existing conservative fallbacks, never a boot outage. */
async function createManagedEphemera(input = {}) {
  const target = resolveManagedRedisTarget(input);
  return createEphemeraService(target.options);
}

module.exports = { createManagedEphemera, resolveManagedRedisTarget };
