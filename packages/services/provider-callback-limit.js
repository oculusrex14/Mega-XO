'use strict';

/* SEC-V52-SSV-UNLIMITED-DOS fix (2026-10-16, owner-delegated decision: implement now).
 * The actor-free provider-callback lanes (admob-ssv, the Cashfree webhook, the Polar webhook)
 * previously had NO admission budget: a per-actor limiter cannot apply, and a public callback
 * endpoint triggers signature verification, signed-ingress round-trips and provider lookups for
 * anyone who can reach it. This module adds the missing admission control:
 *
 *   - 600 requests per canonical source IP per UTC minute, independently per provider lane
 *     (callback-admob / callback-cashfree / callback-polar). Initial admission limits, not
 *     measured capacity claims.
 *   - The source IP is trusted ONLY through the deployment edge: X-Mega-Client-IP is accepted
 *     solely when the immediate socket peer is inside the explicit trusted-proxy allowlist AND
 *     X-Mega-Proxy-Key passes a constant-time comparison against the host-managed proxy secret.
 *     An authenticated-but-unmatched assertion is a misconfigured proxy and refuses 403; a
 *     non-proxy peer just uses its own address and client-supplied Forwarded / X-Forwarded-For
 *     headers are never read.
 *   - The address is canonicalized (IPv4, IPv6, IPv4-mapped IPv6) to raw bytes and hashed with a
 *     purpose-separated HMAC before it becomes a bucket key. No raw address is persisted or
 *     logged, and the HMAC key is derived from the proxy secret, not reused from the Core
 *     ingress HMAC.
 *   - Counters reuse the durable ops.rate_buckets upsert from LR12 (createRateLimiter) with a
 *     lane prefix; no migration. Storage failure fails CLOSED (503 RATE_LIMIT_UNAVAILABLE).
 *   - Exhaustion refuses 429 RATE_LIMITED with Retry-After set to the remaining window seconds;
 *     the route must NEVER acknowledge a rejected callback with 200 (AdMob retries five times;
 *     providers retry on non-2xx).
 */

const crypto = require('node:crypto');
const { createRateLimiter, KEY_PATTERN } = require('./rate-limit');

const DEFAULT_LIMIT = 600;
const WINDOW_MS = 60000;
const PROVIDERS = Object.freeze(['admob', 'cashfree', 'polar']);
const PURPOSE = 'megaxo:callback-ip-bucket:v1';

function fail(code, status) {
  const error = Error(code);
  error.code = code;
  if (status) error.status = status;
  throw error;
}

/* Parse an IP literal into its canonical raw bytes: 4 bytes for IPv4 (including any
 * IPv4-mapped IPv6 form) or 16 bytes for IPv6. Returns null for anything malformed. */
function canonicalIpBytes(raw) {
  if (typeof raw !== 'string') return null;
  let ip = raw.trim().toLowerCase();
  if (!ip) return null;
  if (!ip.includes(':')) {
    if (!/^[0-9.]+$/.test(ip)) return null;
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    const out = Buffer.alloc(4);
    for (let i = 0; i < 4; i += 1) {
      const p = parts[i];
      if (p.length === 0 || p.length > 3 || (p.length > 1 && p[0] === '0')) return null;
      const v = Number(p);
      if (!Number.isInteger(v) || v > 255) return null;
      out[i] = v;
    }
    return out;
  }
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(ip)) return null;
  const sections = ip.split('::');
  if (sections.length > 2) return null;
  const head = sections[0] ? sections[0].split(':') : [];
  const tail = sections.length === 2 ? (sections[1] ? sections[1].split(':') : []) : [];
  /* Embedded IPv4 (the ::ffff:a.b.c.d form and IPv4-compatible spellings) becomes the final
   * two hex groups before the general validation. */
  if (tail.length && tail[tail.length - 1].includes('.')) {
    const v4 = tail[tail.length - 1].split('.');
    if (v4.length !== 4) return null;
    tail.splice(tail.length - 1, 1,
      ((Number(v4[0]) << 8) | Number(v4[1])).toString(16).padStart(4, '0'),
      ((Number(v4[2]) << 8) | Number(v4[3])).toString(16).padStart(4, '0'));
  }
  if (head.length && head[head.length - 1].includes('.') && !tail.length) {
    const v4 = head[head.length - 1].split('.');
    if (v4.length !== 4) return null;
    head.splice(head.length - 1, 1,
      ((Number(v4[0]) << 8) | Number(v4[1])).toString(16).padStart(4, '0'),
      ((Number(v4[2]) << 8) | Number(v4[3])).toString(16).padStart(4, '0'));
  }
  const missing = 8 - head.length - tail.length;
  if (sections.length === 2 && missing < 1) return null;
  if (sections.length === 1 && head.length !== 8) return null;
  const groups = sections.length === 2 ? head.concat(Array(missing).fill('0'), tail) : head;
  if (groups.length !== 8) return null;
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 8; i += 1) {
    const g = groups[i];
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes[i * 2] = v >> 8;
    bytes[i * 2 + 1] = v & 0xff;
  }
  /* IPv4-mapped IPv6 collapses to the IPv4 identity. */
  let mapped = true;
  for (let i = 0; i < 10; i += 1) if (bytes[i] !== 0) { mapped = false; break; }
  if (mapped && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.subarray(12);
  return bytes;
}

function ipToCidrBytes(ip, prefixLen) {
  const bytes = canonicalIpBytes(ip);
  if (!bytes) return null;
  const total = bytes.length * 8;
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > total) return null;
  return { bytes, prefixLen };
}

function ipInCidr(candidateBytes, entry) {
  if (candidateBytes.length !== entry.bytes.length) return false;
  const full = Math.floor(entry.prefixLen / 8);
  for (let i = 0; i < full; i += 1) {
    if (candidateBytes[i] !== entry.bytes[i]) return false;
  }
  const rem = entry.prefixLen % 8;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (candidateBytes[full] & mask) === (entry.bytes[full] & mask);
}

function parseTrustedProxies(spec) {
  const list = [];
  for (const part of String(spec || '').split(',')) {
    const item = part.trim();
    if (!item) continue;
    const slash = item.indexOf('/');
    const ip = slash >= 0 ? item.slice(0, slash) : item;
    const prefixLen = slash >= 0 ? Number(item.slice(slash + 1)) : (canonicalIpBytes(ip) || { length: 0 }).length * 8;
    const entry = ipToCidrBytes(ip, prefixLen);
    if (!entry) fail('TRUSTED_PROXY_CONFIG', 503);
    list.push(entry);
  }
  return list;
}

function headerOf(req, name) {
  const v = req && req.headers ? req.headers[name] : null;
  if (Array.isArray(v)) return String(v[0] || '');
  return typeof v === 'string' ? v : '';
}

function createCallbackSourceIp({ proxySecret, trustedProxies } = {}) {
  if (typeof proxySecret !== 'string' || proxySecret.length < 16) fail('PROXY_SECRET_CONFIG', 503);
  const proxies = parseTrustedProxies(trustedProxies || '127.0.0.1/32,::1/128');
  const macKey = crypto.createHmac('sha256', Buffer.from(proxySecret, 'utf8')).update(PURPOSE).digest();
  return Object.freeze({
    /* Returns the bucket-key input (a 64-char hex HMAC) for the request's canonical source. */
    resolve(req) {
      const rawPeer = req && req.socket ? req.socket.remoteAddress : null;
      const peerBytes = canonicalIpBytes(rawPeer);
      const asserted = headerOf(req, 'x-mega-client-ip').trim();
      const proxyKey = headerOf(req, 'x-mega-proxy-key');
      const peerIsTrusted = peerBytes ? proxies.some((entry) => ipInCidr(peerBytes, entry)) : false;
      let sourceBytes;
      if (asserted) {
        if (!peerIsTrusted) {
          /* A client (or an untrusted hop) asserting the edge header is refused outright. */
          fail('UNTRUSTED_PROXY_ASSERTION', 403);
        }
        const expected = Buffer.from(proxySecret, 'utf8');
        const got = Buffer.from(proxyKey, 'utf8');
        if (expected.length < 1 || got.length !== expected.length || !crypto.timingSafeEqual(expected, got)) {
          fail('UNTRUSTED_PROXY_ASSERTION', 403);
        }
        sourceBytes = canonicalIpBytes(asserted);
        if (!sourceBytes) fail('INVALID_SOURCE_IP', 400);
      } else {
        if (!peerBytes) fail('INVALID_SOURCE_IP', 400);
        /* A non-proxy peer is its own source; any spoofed forwarded headers are ignored. */
        sourceBytes = peerBytes;
      }
      return crypto.createHmac('sha256', macKey).update(Buffer.from(sourceBytes)).digest('hex');
    },
  });
}

function createProviderCallbackLimiter({ pool, limit = DEFAULT_LIMIT, windowMs = WINDOW_MS } = {}) {
  const limiters = Object.fromEntries(PROVIDERS.map((p) => [p, createRateLimiter({ pool, limit, windowMs, prefix: 'callback-' + p })]));
  return Object.freeze({
    limit,
    windowMs,
    providers: PROVIDERS.slice(),
    async check(provider, ipKey, at) {
      if (!PROVIDERS.includes(provider)) fail('INVALID_CALLBACK_PROVIDER', 400);
      if (typeof ipKey !== 'string' || !KEY_PATTERN.test(ipKey)) fail('INVALID_RATE_KEY', 400);
      try {
        return await limiters[provider].check(ipKey, at);
      } catch (error) {
        if (error && error.code === 'RATE_LIMITED') {
          const now = typeof at === 'number' && Number.isFinite(at) ? at : Date.now();
          error.retryAfter = Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000));
        }
        throw error;
      }
    },
  });
}

module.exports = { createProviderCallbackLimiter, createCallbackSourceIp, canonicalIpBytes, PROVIDERS, DEFAULT_LIMIT, WINDOW_MS };
