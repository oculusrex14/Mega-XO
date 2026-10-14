'use strict';

/**
 * apps/api/config.js - Environment configuration validator and secret isolation
 * for the Vercel API stateless control plane (V5 Phase 11 Task V5-11-01).
 *
 * Enforces:
 * 1. Explicit environment classification ('preview', 'staging', 'production').
 * 2. Strict secret isolation: preview environments strictly reject production credentials.
 * 3. Nonproduction environments bind only to staging/dev databases and preview hostnames.
 * 4. Production environments strictly require production database and hostnames.
 */

const VALID_ENVIRONMENTS = Object.freeze(['preview', 'staging', 'production']);

const PROD_HOSTNAMES = Object.freeze([
  'api.megaxo.online',
  'megaxo.online',
  'play.antimatterinnovations.com'
]);

/**
 * Classifies current environment into 'preview', 'staging', or 'production'.
 * @param {Record<string, string|undefined>} env
 * @returns {'preview' | 'staging' | 'production'}
 */
function classifyEnvironment(env = process.env) {
  const raw = env.MEGA_ENV || env.VERCEL_ENV || 'production';
  const normalized = String(raw).trim().toLowerCase();
  if (VALID_ENVIRONMENTS.includes(normalized)) {
    return normalized;
  }
  throw new Error('INVALID_ENVIRONMENT');
}

/**
 * Tests whether a database connection string points to a production database.
 * @param {string} url
 * @returns {boolean}
 */
function isProductionDatabase(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const db = parsed.pathname.replace(/^\//, '').toLowerCase();
    if (host.includes('prod') || host.includes('production')) return true;
    if (db === 'production' || db === 'mega_prod' || db === 'megaxo_prod' || db === 'megaxo_production') return true;
    if (db.includes('prod') && !db.includes('repro') && !db.includes('product')) return true;
    return false;
  } catch {
    const lower = url.toLowerCase();
    return lower.includes('prod') || lower.includes('production');
  }
}

/**
 * Tests whether a database connection string points to a staging/dev/preview database.
 * @param {string} url
 * @returns {boolean}
 */
function isNonproductionDatabase(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const db = parsed.pathname.replace(/^\//, '').toLowerCase();
    const markers = ['staging', 'preview', 'dev', 'development', 'test', 'localhost', '127.0.0.1'];
    if (markers.some(m => host.includes(m))) return true;
    if (markers.some(m => db.includes(m))) return true;
    return false;
  } catch {
    const lower = url.toLowerCase();
    return lower.includes('staging') || lower.includes('preview') || lower.includes('dev') || lower.includes('test') || lower.includes('localhost');
  }
}

/**
 * Tests whether an environment variable key or value indicates a production secret.
 * @param {string} key
 * @param {string} [value]
 * @returns {boolean}
 */
function isProductionSecret(key, value = '') {
  if (typeof key === 'string') {
    const upper = key.toUpperCase();
    if (upper.startsWith('PROD_') || upper.includes('_PROD_') || upper.endsWith('_PROD')) return true;
    if (upper.includes('PRODUCTION') && (upper.includes('SECRET') || upper.includes('KEY') || upper.includes('TOKEN') || upper.includes('DB') || upper.includes('DATABASE') || upper.includes('CREDENTIAL'))) return true;
  }
  if (typeof value === 'string' && value.length > 0) {
    const lower = value.toLowerCase();
    if (lower.includes('prod-secret') || lower.includes('production-secret') || lower.includes('prod_secret') || lower.includes('production_secret')) return true;
  }
  return false;
}

/**
 * Asserts secret isolation between preview, staging, and production.
 * @param {Record<string, string|undefined>} env
 * @param {'preview' | 'staging' | 'production'} [environment]
 */
function assertSecretIsolation(env = process.env, environment = null) {
  const stage = environment || classifyEnvironment(env);

  if (stage === 'preview') {
    // 1. Production credentials and secrets are strictly barred from preview
    for (const [key, value] of Object.entries(env)) {
      if (!value) continue;
      if (isProductionSecret(key, value)) {
        throw new Error('PRODUCTION_SECRET_FORBIDDEN_IN_PREVIEW');
      }
    }

    // 2. Reject production database in preview
    const dbUrl = env.DATABASE_URL || env.POSTGRES_URL || env.MEGA_PG_URL;
    if (dbUrl && isProductionDatabase(dbUrl)) {
      throw new Error('PRODUCTION_DATABASE_FORBIDDEN_IN_NONPROD');
    }

    // 3. Reject production origin/host in preview
    const origin = env.MEGA_ORIGIN || (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : '');
    if (origin) {
      try {
        const u = new URL(origin.startsWith('http') ? origin : `https://${origin}`);
        if (PROD_HOSTNAMES.includes(u.hostname.toLowerCase())) {
          throw new Error('PRODUCTION_HOST_FORBIDDEN_IN_PREVIEW');
        }
      } catch (err) {
        if (err.message === 'PRODUCTION_HOST_FORBIDDEN_IN_PREVIEW') throw err;
      }
    }
  } else if (stage === 'staging') {
    // Nonproduction staging must not bind to production database
    const dbUrl = env.DATABASE_URL || env.POSTGRES_URL || env.MEGA_PG_URL;
    if (dbUrl && isProductionDatabase(dbUrl)) {
      throw new Error('PRODUCTION_DATABASE_FORBIDDEN_IN_NONPROD');
    }
  } else if (stage === 'production') {
    // Production must not bind to nonproduction/staging/dev database
    const dbUrl = env.DATABASE_URL || env.POSTGRES_URL || env.MEGA_PG_URL;
    if (dbUrl && isNonproductionDatabase(dbUrl)) {
      throw new Error('NONPRODUCTION_DATABASE_FORBIDDEN_IN_PROD');
    }
  }

  return true;
}

/**
 * Validates full API configuration for current environment.
 * @param {Record<string, string|undefined>} env
 * @returns {Readonly<{
 *   env: 'preview' | 'staging' | 'production',
 *   origin: string,
 *   databaseUrl: string,
 *   region: string,
 *   proxySecret: string,
 *   otpSecret: string,
 *   auditSecret: string,
 *   jwtSecret: string,
 *   coreUrl: string,
 *   isProduction: boolean,
 *   isPreview: boolean,
 *   isStaging: boolean
 * }>}
 */
function validateConfig(env = process.env) {
  const stage = classifyEnvironment(env);

  // Enforce secret isolation and environment boundaries
  assertSecretIsolation(env, stage);

  // Database URL
  const databaseUrl = env.DATABASE_URL || env.POSTGRES_URL || env.MEGA_PG_URL;
  if (!databaseUrl) {
    throw new Error('MISSING_DATABASE_URL');
  }

  // Origin
  const origin = env.MEGA_ORIGIN || (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : '');
  if (!origin) {
    throw new Error('MISSING_MEGA_ORIGIN');
  }

  let originUrl;
  try {
    originUrl = new URL(origin.startsWith('http') ? origin : `https://${origin}`);
  } catch {
    throw new Error('INVALID_ORIGIN');
  }

  const isLocal = originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1';
  if (!isLocal && originUrl.protocol !== 'https:') {
    throw new Error('INVALID_ORIGIN');
  }

  if (stage === 'preview' && PROD_HOSTNAMES.includes(originUrl.hostname.toLowerCase())) {
    throw new Error('PRODUCTION_HOST_FORBIDDEN_IN_PREVIEW');
  }

  // Required secrets for production
  if (stage === 'production') {
    if (!env.MEGA_PROXY_SECRET && !env.PROXY_SECRET) {
      throw new Error('MISSING_MEGA_PROXY_SECRET');
    }
    if (!env.MEGA_OTP_SECRET && !env.OTP_SECRET) {
      throw new Error('MISSING_MEGA_OTP_SECRET');
    }
    if (!env.MEGA_AUDIT_SECRET && !env.AUDIT_SECRET) {
      throw new Error('MISSING_MEGA_AUDIT_SECRET');
    }
  }

  return Object.freeze({
    env: stage,
    environment: stage,
    isProduction: stage === 'production',
    isPreview: stage === 'preview',
    isStaging: stage === 'staging',
    origin: originUrl.origin,
    databaseUrl,
    region: 'iad1',
    proxySecret: env.MEGA_PROXY_SECRET || env.PROXY_SECRET || '',
    otpSecret: env.MEGA_OTP_SECRET || env.OTP_SECRET || '',
    auditSecret: env.MEGA_AUDIT_SECRET || env.AUDIT_SECRET || '',
    jwtSecret: env.MEGA_JWT_SECRET || env.JWT_SECRET || '',
    coreUrl: env.MEGA_CORE_URL || env.CORE_SERVICE_URL || '',
    ...nativeSessionConfig(env),
  });
}

/** Splits a comma-separated list, trimming blank entries. Returns null when unset. */
function csvList(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  return items.length ? items : null;
}

/** Reads a non-negative integer; an unset value stays undefined so the service default applies. */
function optionalInt(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * P05 cookie-free native session plumbing (design B4.2/C5). The API runtime owns the signing
 * configuration; a partial configuration yields `accessOptions: null`, which is the honest
 * unconfigured state (the bearer routes answer 503) rather than an issuer, key file or audience
 * invented at request time. Never a fallback secret.
 */
function nativeSessionConfig(env = {}) {
  const issuer = env.MEGA_ACCESS_ISSUER;
  const environment = env.MEGA_ACCESS_ENVIRONMENT;
  const keyFile = env.MEGA_ACCESS_KEY_FILE;
  const playerAudiences = csvList(env.MEGA_ACCESS_PLAYER_AUDIENCES);
  const serviceAudiences = csvList(env.MEGA_ACCESS_SERVICE_AUDIENCES);
  const configured = Boolean(issuer && environment && keyFile && playerAudiences && serviceAudiences);
  const now = optionalInt(env.MEGA_SESSION_NOW_MS);
  const refresh = {};
  for (const [key, name] of [['graceMs', 'MEGA_REFRESH_GRACE_MS'], ['maxGraceReuse', 'MEGA_REFRESH_MAX_GRACE_REUSE'], ['absoluteTtlMs', 'MEGA_REFRESH_ABSOLUTE_TTL_MS']]) {
    const value = optionalInt(env[name]);
    if (value !== undefined) refresh[key] = value;
  }
  return {
    nativeAudiences: csvList(env.MEGA_NATIVE_AUDIENCES) || Object.freeze(['mega-ios', 'mega-android']),
    accessOptions: configured
      ? Object.freeze({
        ...(now === undefined ? {} : { now: () => now }),
        issuer,
        environment,
        keyFile,
        playerAudiences,
        serviceAudiences,
      })
      : null,
    refreshOptions: Object.keys(refresh).length
      ? Object.freeze({ ...(now === undefined ? {} : { now: () => now }), ...refresh })
      : null,
  };
}

// Export both named functions and config object
validateConfig.validateConfig = validateConfig;
validateConfig.config = validateConfig;
validateConfig.classifyEnvironment = classifyEnvironment;
validateConfig.assertSecretIsolation = assertSecretIsolation;
validateConfig.isProductionDatabase = isProductionDatabase;
validateConfig.isNonproductionDatabase = isNonproductionDatabase;
validateConfig.isProductionSecret = isProductionSecret;
validateConfig.nativeSessionConfig = nativeSessionConfig;
validateConfig.VALID_ENVIRONMENTS = VALID_ENVIRONMENTS;
validateConfig.PROD_HOSTNAMES = PROD_HOSTNAMES;

module.exports = validateConfig;
module.exports.validateConfig = validateConfig;
module.exports.config = validateConfig;
module.exports.classifyEnvironment = classifyEnvironment;
module.exports.assertSecretIsolation = assertSecretIsolation;
module.exports.isProductionDatabase = isProductionDatabase;
module.exports.isNonproductionDatabase = isNonproductionDatabase;
module.exports.isProductionSecret = isProductionSecret;
module.exports.nativeSessionConfig = nativeSessionConfig;
module.exports.VALID_ENVIRONMENTS = VALID_ENVIRONMENTS;
module.exports.PROD_HOSTNAMES = PROD_HOSTNAMES;
