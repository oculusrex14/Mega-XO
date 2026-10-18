'use strict';

/* First-party download counts for the DIRECT Android APK, not store redirects or button clicks.
 * A completed GET is a download response, NOT evidence of installation. A signed, random,
 * HttpOnly cookie estimates distinct browsers; it is never tied to identity, IP or User-Agent.
 *
 * Existing ops.rate_buckets (api_runtime SELECT/INSERT/UPDATE) stores:
 *   apkdl:total                         all completed responses
 *   apkdl:unique                        first-seen anonymous browser IDs
 *   apkdl:version:<code>:{total,unique}  cumulative per pinned APK versionCode
 *   apkdl:day:<date>:{total,unique-new}  requests + first-seen browser IDs that day
 *   apkdl:day:<date>:version:<code>:{total,unique-new}
 * Visitor deduplication hashes expire after 400 days and never store the raw cookie ID. Aggregate
 * cumulative counts persist; return visits after the retention window may count as new, so this
 * is an ESTIMATE, not an exact count of people, installs, or fully received file bytes.
 *
 * Server-only: not an alternate path to client opt-in gameplay telemetry or account profiling.
 */
const crypto = require('node:crypto');

const COOKIE = 'mx_apk_dl';
const COOKIE_AGE_SECONDS = 365 * 24 * 60 * 60;
const DEDUP_AGE_MS = 400 * 24 * 60 * 60 * 1000;
const COOKIE_GRAMMAR = /^v1\.([0-9a-f]{32})\.([0-9a-f]{64})$/;
const BOT = /\b(?:bot|crawler|spider|slurp|preview|monitor|headless|wget|curl|python-requests)\b/i;
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

  function observe(req, res, apk) {
    const method = String(req?.method || 'GET').toUpperCase();
    const ua = String(req?.headers?.['user-agent'] || '');
    if (method !== 'GET' || !apk || !Number.isSafeInteger(apk.versionCode) || apk.versionCode < 1 ||
        BOT.test(ua) || req?.headers?.purpose === 'prefetch' || req?.headers?.['sec-purpose'] === 'prefetch') return null;
    const id = checkedCookie(req.headers?.cookie) || nonce();
    if (!/^[0-9a-f]{32}$/.test(id)) throw Error('APK_METRICS_RANDOM_INVALID');
    if (!checkedCookie(req.headers?.cookie)) {
      // Narrowly scoped, non-auth cookie; no IP/user-agent fingerprint and no cross-page tracking.
      res.setHeader('Set-Cookie',
        `${COOKIE}=${publicCookie(id)}; Max-Age=${COOKIE_AGE_SECONDS}; Path=/downloads/android/; Secure; HttpOnly; SameSite=Lax`);
    }
    res.setHeader('Cache-Control', 'private, no-store');
    return () => record({ id, versionCode: apk.versionCode });
  }

  async function record({ id, versionCode }) {
    if (!/^[0-9a-f]{32}$/.test(id) || !Number.isSafeInteger(versionCode) || versionCode < 1) throw Error('APK_METRICS_INVALID_EVENT');
    const at = now(), day = new Date(at).toISOString().slice(0, 10);
    const expire = new Date(at + DEDUP_AGE_MS);
    const digest = mac('visitor:' + id); // raw cookie IDs never enter PostgreSQL
    const version = 'version:' + versionCode;
    const globalVisitorKey = 'apkdl:visitor:' + digest;
    const releaseVisitorKey = 'apkdl:visitor:' + version + ':' + digest;
    return pool.withTransaction(async tx => {
      const global = await tx.query(INSERT_UNIQUE, [globalVisitorKey, expire]);
      const release = await tx.query(INSERT_UNIQUE, [releaseVisitorKey, expire]);
      const newGlobal = global.rows.length > 0, newRelease = release.rows.length > 0;
      const counters = [
        ['apkdl:total', null],
        ['apkdl:' + version + ':total', null],
        ['apkdl:day:' + day + ':total', expire],
        ['apkdl:day:' + day + ':' + version + ':total', expire],
      ];
      if (newGlobal) {
        counters.push(['apkdl:unique', null], ['apkdl:day:' + day + ':unique-new', expire]);
      }
      if (newRelease) {
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
