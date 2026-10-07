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
  if (env.MEGA_PAID_ENTRY_ENABLED && env.MEGA_PAID_ENTRY_ENABLED !== 'false') throw Error('PAID_FEATURES_NOT_RELEASED');
  if (!['true','false'].includes(env.MEGA_PURCHASES_ENABLED||'false')) throw Error('INVALID_PURCHASES_FLAG');
  const purchasesEnabled=(env.MEGA_PURCHASES_ENABLED||'false')==='true';
  const deletionEnabled=(env.MEGA_ACCOUNT_DELETION_ENABLED||'false')==='true';
  if (!['true','false'].includes(env.MEGA_ACCOUNT_DELETION_ENABLED||'false')) throw Error('INVALID_ACCOUNT_DELETION_FLAG');
  const privacyPolicyVersion=env.MEGA_PRIVACY_POLICY_VERSION||'',retentionPolicyVersion=env.MEGA_RETENTION_POLICY_VERSION||'';
  if (deletionEnabled && !/^[A-Za-z0-9._-]{3,64}$/.test(privacyPolicyVersion)) throw Error('ACCOUNT_DELETION_POLICY_NOT_APPROVED');
  if (deletionEnabled && !/^[A-Za-z0-9._-]{3,64}$/.test(retentionPolicyVersion)) throw Error('ACCOUNT_DELETION_RETENTION_NOT_APPROVED');
  if (purchasesEnabled && !deletionEnabled) throw Error('STORE_RELEASE_REQUIRES_ACCOUNT_DELETION');
  const adMode=env.MEGA_AD_MODE||'off';if(!['off','rewarded','hybrid'].includes(adMode))throw Error('INVALID_AD_MODE');
  const adUnit=value=>{if(!value)return '';if(!/^ca-app-pub-\d{16}\/\d{10}$/.test(value))throw Error('INVALID_ADMOB_UNIT');return value;};
  const adPlatforms={};for(const platform of ['ANDROID','IOS']){const rewarded=adUnit(env['ADMOB_'+platform+'_REWARDED_UNIT']||''),interstitial=adUnit(env['ADMOB_'+platform+'_INTERSTITIAL_UNIT']||'');if(interstitial&&!rewarded)throw Error('ADMOB_REWARDED_UNIT_REQUIRED');if(rewarded||interstitial)adPlatforms[platform.toLowerCase()]={rewarded,interstitial};}
  const consentVersion=env.MEGA_AD_CONSENT_VERSION||'';
  if(adMode!=='off'){
   if(!deletionEnabled||!/^[A-Za-z0-9._-]{3,64}$/.test(privacyPolicyVersion))throw Error('ADS_REQUIRE_PRIVACY_RELEASE');
   if(!/^[A-Za-z0-9._-]{3,64}$/.test(consentVersion))throw Error('ADS_REQUIRE_CONSENT_RELEASE');
   if(!Object.keys(adPlatforms).length)throw Error('ADMOB_UNITS_REQUIRED');
   if(Object.values(adPlatforms).some(x=>!x.rewarded||(adMode==='hybrid'&&!x.interstitial)))throw Error('INCOMPLETE_ADMOB_UNITS');
  }
  const apiKey = secret(env, 'RESEND_API_KEY');
  if (apiKey && !/^re_[A-Za-z0-9_-]+$/.test(apiKey)) throw Error('INVALID_RESEND_API_KEY');
  const from = env.MEGA_EMAIL_FROM || 'Mega XO by Antimatter Innovations <contact@antimatterinnovations.com>';
  if (/[\r\n]/.test(from) || from.length > 254 || !/^[^<>]*<[^<>\s]+@[^<>\s]+>$/.test(from)) throw Error('INVALID_EMAIL_FROM');
  const emailDomain=(env.MEGA_EMAIL_DOMAIN||'antimatterinnovations.com').trim().toLowerCase();
  if(!/^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(emailDomain))throw Error('INVALID_EMAIL_DOMAIN');
  const fromAddress=from.match(/<([^<>\s]+)>$/)?.[1]||'',fromDomain=fromAddress.split('@')[1]?.toLowerCase()||'';
  if(fromDomain!==emailDomain)throw Error('EMAIL_FROM_DOMAIN_MISMATCH');
  const googleId = env.GOOGLE_CLIENT_ID || '';
  const googleSecret = secret(env, 'GOOGLE_CLIENT_SECRET');
  if (!!googleId !== !!googleSecret) throw Error('INCOMPLETE_GOOGLE_WEB_CONFIG');
  const apple = {clientId: env.APPLE_SERVICE_ID, teamId: env.APPLE_TEAM_ID, keyId: env.APPLE_KEY_ID, privateKey: secret(env, 'APPLE_PRIVATE_KEY').replace(/\\n/g, '\n'), nativeAudiences: (env.APPLE_NATIVE_AUDIENCES || '').split(',').filter(Boolean)};
  const appleWeb = [apple.clientId, apple.teamId, apple.keyId, apple.privateKey];
  if (appleWeb.some(Boolean) && !appleWeb.every(Boolean)) throw Error('INCOMPLETE_APPLE_WEB_CONFIG');
  const productKeys=['CROWNS_100','CROWNS_525','CROWNS_1100','REMOVE_ADS'],internal=['crowns_100','crowns_525','crowns_1100','remove_ads'];
  const mapProducts=prefix=>{const values=productKeys.map(k=>env[prefix+k]||'');if(values.some(Boolean)&&!values.every(Boolean))throw Error('INCOMPLETE_'+prefix+'PRODUCTS');if(new Set(values.filter(Boolean)).size!==values.filter(Boolean).length)throw Error('DUPLICATE_'+prefix+'PRODUCT');const map={};values.forEach((v,i)=>{if(v&&!/^[A-Za-z0-9._-]{1,160}$/.test(v))throw Error('INVALID_'+prefix+'PRODUCT');if(v)map[v]=internal[i];});return map;};
  const playJson=secret(env,'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'),playPackage=env.GOOGLE_PLAY_PACKAGE_NAME||'',playProducts=mapProducts('GOOGLE_PLAY_PRODUCT_'),playAudience=env.GOOGLE_PLAY_PUBSUB_AUDIENCE||'',playPushEmail=env.GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT||'';
  const playParts=[playJson,playPackage,Object.keys(playProducts).length?1:'',playAudience,playPushEmail];if(playParts.some(Boolean)&&!playParts.every(Boolean))throw Error('INCOMPLETE_GOOGLE_PLAY_CONFIG');
  let playAccount=null;if(playJson)try{playAccount=JSON.parse(playJson);}catch{throw Error('INVALID_GOOGLE_PLAY_SERVICE_ACCOUNT');}
  if(playAccount&&(!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(playAccount.client_email||'')||typeof playAccount.private_key!=='string'||!playAccount.private_key.includes('BEGIN PRIVATE KEY')))throw Error('INVALID_GOOGLE_PLAY_SERVICE_ACCOUNT');
  const rootsFile=env.APPLE_STORE_ROOTS_FILE||'',appleBundle=env.APPLE_STORE_BUNDLE_ID||'',appleEnvironment=env.APPLE_STORE_ENVIRONMENT||'',appleAppIdRaw=env.APPLE_STORE_APP_ID||'',appleProducts=mapProducts('APPLE_STORE_PRODUCT_');let appleRoots=[],appleAppId=null;
  if(appleAppIdRaw){if(!/^[1-9]\d*$/.test(appleAppIdRaw))throw Error('INVALID_APPLE_STORE_APP_ID');appleAppId=Number(appleAppIdRaw);if(!Number.isSafeInteger(appleAppId))throw Error('INVALID_APPLE_STORE_APP_ID');}
  const appleStoreParts=[rootsFile,appleBundle,appleEnvironment,Object.keys(appleProducts).length?1:''];if([...appleStoreParts,appleAppIdRaw].some(Boolean)&&!appleStoreParts.every(Boolean))throw Error('INCOMPLETE_APPLE_STORE_CONFIG');
  if(rootsFile){if(!path.isAbsolute(rootsFile))throw Error('ABSOLUTE_APPLE_ROOTS_PATH_REQUIRED');const stat=fs.statSync(rootsFile);if(!stat.isFile()||stat.size>65536)throw Error('INVALID_APPLE_ROOTS_FILE');const pem=fs.readFileSync(rootsFile,'utf8');appleRoots=pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)||[];if(!appleRoots.length)throw Error('INVALID_APPLE_ROOTS_FILE');}
  if(appleEnvironment&&!['Production','Sandbox'].includes(appleEnvironment))throw Error('INVALID_APPLE_STORE_ENVIRONMENT');
  if(appleEnvironment==='Production'&&!appleAppId)throw Error('APPLE_STORE_APP_ID_REQUIRED');
  const googlePlay=playJson?{packageName:playPackage,serviceAccount:playAccount,products:playProducts,pubsubAudience:playAudience,pubsubServiceAccount:playPushEmail}:null;
  const appleStore=rootsFile?{bundleId:appleBundle,environment:appleEnvironment,appAppleId:appleAppId,products:appleProducts,trustedRoots:appleRoots}:null;
  if(purchasesEnabled&&!googlePlay&&!appleStore)throw Error('STORE_PROVIDER_NOT_CONFIGURED');
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
    storage: Object.freeze({dbWarnBytes:integer(env,'MEGA_DB_WARN_BYTES',1073741824,1048576,1099511627776),walWarnBytes:integer(env,'MEGA_WAL_WARN_BYTES',134217728,1048576,1099511627776),stateWarnBytes:integer(env,'MEGA_STATE_WARN_BYTES',67108864,1048576,1073741824)}),
    backupStatus: env.MEGA_BACKUP_STATUS || '/backup-status/last-success.json',
    release: /^[a-f0-9]{40}$/.test(env.MEGA_RELEASE || '') ? env.MEGA_RELEASE : 'local',
    email: {apiKey, from, domain:emailDomain},
    privacy: {deletionEnabled, policyVersion:privacyPolicyVersion, retentionVersion:retentionPolicyVersion},
    ads: {mode:adMode,consentVersion,platforms:Object.freeze(adPlatforms)},
    purchases: {enabled:purchasesEnabled,googlePlay,appleStore},
    providers: {google: {clientId: googleId, clientSecret: googleSecret, nativeAudiences: (env.GOOGLE_NATIVE_AUDIENCES || '').split(',').filter(Boolean), authorizedParties: (env.GOOGLE_AUTHORIZED_PARTIES || '').split(',').filter(Boolean)}, apple}
  });
}
module.exports = {config, secret};
