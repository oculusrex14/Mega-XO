/* LAN-local room HTTP contract, shared by the Node LAN server and the in-app host.
 *
 * Pure UMD with no Node-only dependency, so the exact request/response shapes the client
 * already speaks (`src/party-ui.js` -> `/api/party/*`) are handled identically on a phone-hosted
 * server and on `server/party-server.js`. The transport (ServerSocket on Android,
 * Network.framework on iOS, node:http in tests) lives outside this module: it only has to hand
 * over {method, path, query, headers, body} and send back the returned {status, body}.
 *
 * Differences from server/party-http.js, and why:
 *   - `lanOnly` only. There is no `authenticate` hook and no economy: a LAN host is a private
 *     room host, never an authority for Coins, Crowns or Elo.
 *   - Identity is the guest bearer token this store issued, matched case-insensitively as the
 *     `Authorization: Bearer <token>` header or `?token=<token>`.
 *   - `allowedHosts` is the set of literal `host:port` values the client may present. A LAN host
 *     binds its own addresses, so this is the anti-DNS-rebinding guard.
 */
(function (root, factory) {
  'use strict';
  const api = factory(
    typeof module === 'object' && module.exports
      ? { T: require('../tournament.js'), LAN: require('./lan-room-store.js') }
      : { T: root.MegaTournament, LAN: root.MegaLanRoomStore }
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MegaLanRoomHttp = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  const T = deps.T, LAN = deps.LAN;
  if (!T) throw Error('LAN_ROOM_RULES_MISSING');
  if (!LAN || !LAN.LanRoomStore) throw Error('LAN_ROOM_STORE_MISSING');

  const MAX_BODY = 16384;
  const RATE_WINDOW_MS = 60000;
  const RATE_MAX = 2400;
  const MAX_TRACKED_REMOTES = 1000;

  /* The app is served from its own asset origin (Android) or from file:// (iOS) and talks to a
   * room host on a different origin, so every response is a cross-origin fetch and a bearer header
   * forces an OPTIONS preflight. The room host holds no cookie-backed session and grants nothing
   * but a guest seat in a private, economy-free room, so `*` is the honest policy: the bearer
   * token is what authorises a command, and no browser on the Wi-Fi can be sent a user's cookie.
   * `Access-Control-Allow-Credentials` is deliberately never set. */
  const CORS = Object.freeze({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, idempotency-key',
    'access-control-max-age': '600',
  });

  /* Public error codes, matching the vocabulary src/party-ui.js already renders. */
  const PUBLIC = {
    AUTH_REQUIRED: 401, INVALID_NAME: 400, SESSION_LIMIT: 503, INVALID_COMMAND: 400,
    IDEMPOTENCY_CONFLICT: 409, ROOM_NOT_FOUND: 404, NOT_IN_ROOM: 403, HOST_ONLY: 403,
    ROOM_LIMIT: 429, ROOM_FULL: 409, CODE_EXHAUSTED: 503, FREE_PRIVATE_ONLY: 403,
    USE_PUBLIC_QUEUE: 400, UNKNOWN_COMMAND: 400, EVENT_FINISHED: 409, ROOM_TOO_LARGE: 400,
    INVALID_TABLE: 400, INELIGIBLE: 403, ALREADY_IN_MATCH: 409, ALREADY_QUEUED: 409,
    INSUFFICIENT_COINS: 402, INSUFFICIENT_CROWNS: 402, RATE_LIMIT: 429, INVALID_JSON: 400,
    BAD_HOST: 403, NOT_FOUND: 404, RULES_CHANGED: 409, PAYLOAD_TOO_LARGE: 413,
    INVALID_LOCAL_COMMAND: 400,
  };

  function createLanRoomHandler({ store, allowedHosts = null, now = () => Date.now() } = {}) {
    if (!store || typeof store.run !== 'function') throw Error('STORE_REQUIRED');
    const hosts = allowedHosts ? new Set(allowedHosts) : null;
    const limits = new Map();

    const send = (status, body) => ({ status, body, headers: { ...CORS } });

    /* A LAN address is a private, link-local or loopback literal. Never a public name: a public
     * DNS name would reintroduce the internet dependency this whole path exists to avoid. */
    function isLanHost(hostHeader) {
      if (typeof hostHeader !== 'string' || !hostHeader) return false;
      const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
      if (host === 'localhost') return true;
      if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
      if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
      if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
      if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
      if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
      // IPv6 loopback and unique-local / link-local.
      if (host === '::1') return true;
      if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
      if (/^fe80:/.test(host)) return true;
      return false;
    }

    function gateHost(headers) {
      const hostHeader = headers?.host ?? headers?.Host;
      if (hosts) { if (!hosts.has(hostHeader)) throw Error('BAD_HOST'); return; }
      if (!isLanHost(hostHeader)) throw Error('BAD_HOST');
    }

    function rateLimit(remote) {
      const key = String(remote || '');
      const t = now();
      const rec = limits.get(key) || { time: t, count: 0 };
      if (t - rec.time > RATE_WINDOW_MS) { rec.time = t; rec.count = 0; }
      rec.count += 1;
      limits.set(key, rec);
      if (limits.size > MAX_TRACKED_REMOTES) limits.delete(limits.keys().next().value);
      if (rec.count > RATE_MAX) throw Error('RATE_LIMIT');
    }

    function bearer(headers, query) {
      const raw = headers?.authorization ?? headers?.Authorization ?? '';
      const m = /^Bearer\s+(.+)$/i.exec(String(raw));
      if (m) return m[1].trim();
      if (query && typeof query.token === 'string') return query.token;
      return '';
    }

    /**
     * @param {{method:string, path:string, query?:object, headers?:object, body?:string, remote?:string}} req
     * @returns {{status:number, body:object}|null}  null = not a party route
     */
    function handle(req) {
      const path = String(req.path || '');
      if (!path.startsWith('/api/party/')) return null;
      try {
        gateHost(req.headers);
        rateLimit(req.remote);
        const query = req.query || {};
        // Cross-origin preflight from the app to this room host.
        if (req.method === 'OPTIONS') return send(204, {});
        if (req.method === 'GET' && path === '/api/party/capabilities') {
          return send(200, { lan: true, online: false, publicEnabled: false, tables: Object.keys(T.TABLES).map(T.prize) });
        }
        if (req.method === 'POST' && path === '/api/party/session') {
          const body = parseBody(req.body);
          return send(200, store.guest(body.name));
        }
        if (req.method === 'GET' && path === '/api/party/discover') {
          // Same-Wi-Fi discovery. The client is told only what it needs to choose a room.
          return send(200, { host: true, rooms: store.discover() });
        }
        const identity = store.authenticate(bearer(req.headers, query));
        if (!identity) throw Error('AUTH_REQUIRED');
        const principal = { actor: identity.actor, name: identity.name, scope: 'player' };
        if (req.method === 'GET' && path === '/api/party/me') return send(200, { actor: principal.actor, name: principal.name });
        if (req.method === 'GET' && path.startsWith('/api/party/rooms/')) {
          const id = decodeURIComponent(path.slice('/api/party/rooms/'.length));
          const view = store.view(id, principal.actor);
          if (String(query.revision) === String(view.revision)) return send(200, { unchanged: true, serverNow: view.serverNow });
          return send(200, view);
        }
        if (req.method === 'POST' && path === '/api/party/command') {
          const body = parseBody(req.body);
          const key = req.headers?.['idempotency-key'] ?? req.headers?.['Idempotency-Key'];
          if (typeof key !== 'string' || !key) throw Error('INVALID_COMMAND');
          return send(200, store.run(principal, key, body));
        }
        return send(404, { error: 'NOT_FOUND' });
      } catch (e) {
        const code = String(e && e.message || 'SERVICE_UNAVAILABLE');
        const status = PUBLIC[code] || 503;
        return send(status, { error: PUBLIC[code] ? code : 'SERVICE_UNAVAILABLE' });
      }
    }

    function parseBody(raw) {
      if (raw === undefined || raw === null || raw === '') return {};
      const text = String(raw);
      if (text.length > MAX_BODY) throw Error('PAYLOAD_TOO_LARGE');
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw Error('INVALID_JSON'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('INVALID_JSON');
      return parsed;
    }

    function tick() { return store.tick(); }
    function recover() { return store.recover(); }
    function close() { store.close(); }

    return Object.freeze({ handle, tick, recover, close, isLanHost, PUBLIC });
  }

  return Object.freeze({ createLanRoomHandler, PUBLIC, MAX_BODY });
});
