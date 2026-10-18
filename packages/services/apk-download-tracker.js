'use strict';

/* First-party download counts for the DIRECT Android APK, not store redirects or button clicks.
 * A completed GET is a download response, NOT evidence of installation. A signed, random,
 * HttpOnly cookie estimates participating browsers only when the individual request explicitly
 * opts in; it is never tied to identity, IP or User-Agent.
 *
 * Existing ops.rate_buckets (api_runtime SELECT/INSERT/UPDATE) stores:
 *   apkdl:total                         all completed responses
 *   apkdl:unique                        first-seen participating browser IDs
 *   apkdl:version:<code>:{total,unique}  cumulative per pinned APK versionCode
 *   apkdl:day:<date>:{total,unique-new}  responses + first-seen opted-in browser IDs that day
 *   apkdl:day:<date>:version:<code>:{total,unique-new}
 * Visitor deduplication hashes expire after 400 days and never store the raw cookie ID. Aggregate
 * cumulative counts persist; return visits after the retention window may count as new, so this
 * is an ESTIMATE, not an exact count of people, installs, or fully received file bytes. Requests
 * without explicit per-request consent still record completed-response totals, but never read or
 * store a cookie identity or create a deduplication hash.
 *
 * Server-only: not an alternate path to client opt-in gameplay telemetry or account profiling.
 */
const crypto = require('node:crypto');

const COOKIE = 'mx_apk_dl';
const COOKIE_AGE_SECONDS = 365 * 24 * 60 * 60;
const DEDUP_AGE_MS = 400 * 24 * 60 * 60 * 1000;
const COOKIE_GRAMMAR = /^v1\.([0-9a-f]{32})\.([0-9a-f]{64})$/;
const BOT = /(?:bot|crawler|spider|slurp|preview|monitor|headless|wget|curl|python-requests)/i;
const INSERT_UNIQUE = 'INSERT INTO ops.rate_buckets (bucket_id, hits, expires_at) VALUES ($1, 1, $2) '
  + 'ON CONFLICT (bucket_id) DO NOTHING RETURNING bucket_id';
const UPSERT = 'INSERT INTO ops.rate_buckets (bucket_id, hits, expires_at) VALUES ($1, 1, $2) '
  + 'ON CONFLICT (bucket_id) DO UPDATE SET hits = ops.rate_buckets.hits + 1';

function createApkDownloadTracker({ pool, secret, now = Date.now, randomId } = {}) {
  if (!pool || typeof pool.withTransaction !== 'function') throw Error('APK_METRICS_POOL_REQUIRED');
  if (!(typeof secret === 'string' || Buffer.isBuffer(secret)) || Buffer.byteLength(secret) < 16) {
    throw Error('APK_METRICS_SECRET_REQUIRED');
  }
  const key = crypto.createHmac('sha256', secret).update('mega-xoxo/apk-download-analytics/v1').digest();
  const nonce = randomId || (() => crypto.randomBytes(16).toString('hex'));
  const mac = input => crypto.createHmac('sha256', key).update(input).digest('hex');
  const publicCookie = id => `v1.${id}.${mac('cookie:' + id)}`;

  function checkedCookie(raw) {
    if (typeof raw !== 'string' || raw.length > 8192) return null;
    const pairs = raw.split(';').map(value => value.trim());
    const candidates = pairs.filter(value => value.startsWith(COOKIE + '='));
    if (candidates.length !== 1) return null;
    const match = COOKIE_GRAMMAR.exec(candidates[0].slice(COOKIE.length + 1));
    if (!match) return null;
    const expected = Buffer.from(mac('cookie:' + match[1]), 'hex');
    const presented = Buffer.from(match[2], 'hex');
    return presented.length === expected.length && crypto.timingSafeEqual(presented, expected) ? match[1] : null;
  }

  function hasCookieName(raw, name) {
    return typeof raw === 'string' && raw.split(';').some(part => part.trim().split('=', 1)[0] === name);
  }

  function observe(req, res, apk, { metricsEnabled = false } = {}) {
    const method = String(req?.method || 'GET').toUpperCase();
    const ua = String(req?.headers?.['user-agent'] || '');
    if (method !== 'GET' || !apk || !Number.isSafeInteger(apk.versionCode) || apk.versionCode < 1 ||
        BOT.test(ua) || req?.headers?.purpose === 'prefetch' || req?.headers?.['sec-purpose'] === 'prefetch') return null;

    res.setHeader('Cache-Control', 'private, no-store');
    if (metricsEnabled !== true) {
      // An unchecked request revokes this download-only opt-in on the next APK GET. Inspect only
      // the cookie name; do not parse, validate, hash, or otherwise use the presented identifier.
      if (hasCookieName(req.headers?.cookie, COOKIE)) {
        res.setHeader('Set-Cookie',
          `${COOKIE}=; Max-Age=0; Path=/downloads/android/; Secure; HttpOnly; SameSite=Lax`);
      }
      return () => record({ versionCode: apk.versionCode });
    }

    const existingId = checkedCookie(req.headers?.cookie);
    const id = existingId || nonce();
    if (!/^[0-9a-f]{32}$/.test(id)) throw Error('APK_METRICS_RANDOM_INVALID');
    if (!existingId) {
      // Narrowly scoped, non-auth cookie; no IP/user-agent fingerprint and no cross-page tracking.
      res.setHeader('Set-Cookie',
        `${COOKIE}=${publicCookie(id)}; Max-Age=${COOKIE_AGE_SECONDS}; Path=/downloads/android/; Secure; HttpOnly; SameSite=Lax`);
    }
    return () => record({ id, versionCode: apk.versionCode });
  }

  async function record({ id, versionCode }) {
    const participating = id !== undefined;
    if ((participating && !/^[0-9a-f]{32}$/.test(id)) || !Number.isSafeInteger(versionCode) || versionCode < 1) {
      throw Error('APK_METRICS_INVALID_EVENT');
    }
    const at = now(), day = new Date(at).toISOString().slice(0, 10);
    const expire = new Date(at + DEDUP_AGE_MS);
    const version = 'version:' + versionCode;
    return pool.withTransaction(async tx => {
      let newGlobal = false, newRelease = false;
      if (participating) {
        const digest = mac('visitor:' + id); // raw cookie IDs never enter PostgreSQL
        const globalVisitorKey = 'apkdl:visitor:' + digest;
        const releaseVisitorKey = 'apkdl:visitor:' + version + ':' + digest;
        const global = await tx.query(INSERT_UNIQUE, [globalVisitorKey, expire]);
        const release = await tx.query(INSERT_UNIQUE, [releaseVisitorKey, expire]);
        newGlobal = global.rows.length > 0;
        newRelease = release.rows.length > 0;
      }
      const counters = [
        ['apkdl:total', null],
        ['apkdl:' + version + ':total', null],
        ['apkdl:day:' + day + ':total', expire],
        ['apkdl:day:' + day + ':' + version + ':total', expire],
      ];
      if (participating && newGlobal) {
        counters.push(['apkdl:unique', null], ['apkdl:day:' + day + ':unique-new', expire]);
      }
      if (participating && newRelease) {
        counters.push(['apkdl:' + version + ':unique', null],
          ['apkdl:day:' + day + ':' + version + ':unique-new', expire]);
      }
      for (const [counter, expiresAt] of counters) await tx.query(UPSERT, [counter, expiresAt]);
      return { newGlobal, newRelease };
    });
  }

  return Object.freeze({ observe, record, checkedCookie });
}

module.exports = { createApkDownloadTracker, COOKIE, COOKIE_AGE_SECONDS, DEDUP_AGE_MS };
