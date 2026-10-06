'use strict';
const fs = require('node:fs');
const path = require('node:path');

function secret(env, key, required = false) {
  if (env[key] && env[key + '_FILE']) throw Error('AMBIGUOUS_' + key);
  let value = env[key] || '';
  if (env[key + '_FILE']) {
    const file = env[key + '_FILE'];
    if (!path.isAbsolute(file)) throw Error('ABSOLUTE_SECRET_PATH_REQUIRED');
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o007)) throw Error('INSECURE_SECRET_FILE');
    value = fs.readFileSync(file, 'utf8').trim();
  }
  if (required && !value) throw Error('MISSING_' + key);
  return value;
}
function integer(env, key, fallback, min, max) {
  const raw = env[key] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw Error('INVALID_' + key);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error('INVALID_' + key);
  return value;
}
function config(env = process.env) {
  const stage = env.MEGA_ENV || 'production';
  if (!['production', 'staging'].includes(stage)) throw Error('INVALID_MEGA_ENV');
  let origin;
  try { origin = new URL(env.MEGA_ORIGIN); } catch { throw Error('INVALID_MEGA_ORIGIN'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !origin.hostname.includes('.') || origin.hostname.endsWith('.example')) throw Error('PUBLIC_HTTPS_ORIGIN_REQUIRED');
  const file = env.MEGA_DB || '/data/mega.sqlite';
  if (!path.isAbsolute(file) || file === ':memory:') throw Error('ABSOLUTE_DATABASE_PATH_REQUIRED');
  const otpSecret = secret(env, 'MEGA_OTP_SECRET', true);
  const proxySecret = secret(env, 'MEGA_PROXY_SECRET', true);
  if (!/^[a-f0-9]{64}$/i.test(otpSecret) || !/^[a-f0-9]{64}$/i.test(proxySecret) || otpSecret === proxySecret) throw Error('INDEPENDENT_256_BIT_SECRETS_REQUIRED');
  for (const key of ['MEGA_PAID_ENTRY_ENABLED', 'MEGA_PURCHASES_ENABLED']) if (env[key] && env[key] !== 'false') throw Error('PAID_FEATURES_NOT_RELEASED');
  if (env.MEGA_ACCOUNT_DELETION_ENABLED && env.MEGA_ACCOUNT_DELETION_ENABLED !== 'false') throw Error('ACCOUNT_DELETION_POLICY_NOT_APPROVED');
  if (env.MEGA_AD_MODE && env.MEGA_AD_MODE !== 'off') throw Error('ADS_NOT_RELEASED');
  const apiKey = secret(env, 'RESEND_API_KEY');
  if (apiKey && !/^re_[A-Za-z0-9_-]+$/.test(apiKey)) throw Error('INVALID_RESEND_API_KEY');
  const from = env.MEGA_EMAIL_FROM || 'Mega XO by Antimatter Innovations <contact@antimatterinnovations.com>';
  if (/[\r\n]/.test(from) || from.length > 254 || !/^[^<>]*<[^<>\s]+@[^<>\s]+>$/.test(from)) throw Error('INVALID_EMAIL_FROM');
  const googleId = env.GOOGLE_CLIENT_ID || '';
  const googleSecret = secret(env, 'GOOGLE_CLIENT_SECRET');
  if (!!googleId !== !!googleSecret) throw Error('INCOMPLETE_GOOGLE_WEB_CONFIG');
  const apple = {clientId: env.APPLE_SERVICE_ID, teamId: env.APPLE_TEAM_ID, keyId: env.APPLE_KEY_ID, privateKey: secret(env, 'APPLE_PRIVATE_KEY').replace(/\\n/g, '\n'), nativeAudiences: (env.APPLE_NATIVE_AUDIENCES || '').split(',').filter(Boolean)};
  const appleWeb = [apple.clientId, apple.teamId, apple.keyId, apple.privateKey];
  if (appleWeb.some(Boolean) && !appleWeb.every(Boolean)) throw Error('INCOMPLETE_APPLE_WEB_CONFIG');
  return Object.freeze({stage, origin: origin.origin, file, otpSecret, proxySecret,
    host: env.MEGA_BIND || '0.0.0.0', port: integer(env, 'PORT', 8080, 1024, 65535),
    adminPort: integer(env, 'MEGA_METRICS_PORT', 9091, 1024, 65535),
    maxInflight: integer(env, 'MEGA_MAX_INFLIGHT', 128, 8, 512),
    maxConnections: integer(env, 'MEGA_MAX_CONNECTIONS', 256, 32, 1024),
    maxQueued: integer(env, 'MEGA_MAX_QUEUED', 200, 20, 500),
    drainMs: integer(env, 'MEGA_DRAIN_MS', 15000, 1000, 30000),
    mailDaily: integer(env, 'MEGA_MAIL_DAILY_LIMIT', 80, 1, 100),
    mailMonthly: integer(env, 'MEGA_MAIL_MONTHLY_LIMIT', 2400, 1, 3000),
    authWorkers: integer(env, 'MEGA_AUTH_WORKERS', 2, 1, 4),
    backupStatus: env.MEGA_BACKUP_STATUS || '/backup-status/last-success.json',
    release: /^[a-f0-9]{40}$/.test(env.MEGA_RELEASE || '') ? env.MEGA_RELEASE : 'local',
    email: {apiKey, from},
    providers: {google: {clientId: googleId, clientSecret: googleSecret, nativeAudiences: (env.GOOGLE_NATIVE_AUDIENCES || '').split(',').filter(Boolean), authorizedParties: (env.GOOGLE_AUTHORIZED_PARTIES || '').split(',').filter(Boolean)}, apple}
  });
}
module.exports = {config, secret};
