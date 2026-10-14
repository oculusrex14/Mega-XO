/* In-app LAN host bridge, shared by the Android and iOS shells.
 *
 * The shell owns the socket and the discovery record; this module owns the rules. The shell hands
 * a request to `window.MegaLanRoom.handle(json)` and sends the returned JSON back over its own
 * HTTP transport, so the approved tournament rules, the guest-session contract and the HTTP
 * contract stay in ONE place (src/lan/) instead of being reimplemented in Kotlin and Swift.
 *
 * Frozen contract (do not change without updating both shells):
 *
 *   window.MegaLanRoom = {
 *     open(hostName, port)      -> {ok:true, port, code}      start hosting, restore any rooms
 *     close()                   -> {ok:true}                  stop hosting, persist
 *     ready()                   -> {ok:true, port, rooms}     hosting state for the shell
 *     info()                    -> {port, rooms, guests}      what the lobby screen shows
 *     handle(requestJson)       -> responseJson               one HTTP request/response
 *   }
 *
 * `requestJson`  = {"method","path","query":{},"headers":{},"body":"<raw>","remote":"ip"}
 * `responseJson` = {"status":<int>,"body":<object>,"headers":{}} | {"error":"<CODE>"}
 *
 * `handle` must never throw across the bridge: the native side gets a JSON string in every case,
 * including a malformed request. It is synchronous, because a ServerSocket/Network.framework
 * accept loop has to answer on the same thread it received the request.
 *
 * The persisted state lives in localStorage under one namespaced key. That is honest for a LAN
 * room: it is disposable coordination between devices on one Wi-Fi, never economy or account
 * authority, and a lost key only means the guests rejoin.
 */
(function (root, factory) {
  'use strict';
  const api = factory(
    typeof module === 'object' && module.exports
      ? { LAN: require('./lan-room-store.js'), HTTP: require('./lan-room-http.js'), root: null }
      : { LAN: root.MegaLanRoomStore, HTTP: root.MegaLanRoomHttp, root },
    typeof module === 'object' && module.exports ? globalThis : root
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    /* The page needs a ready instance, and the shell needs a stable name to call for every HTTP
     * request. Publishing the factory under both would leave the lobby calling factory methods,
     * so the instance is created once here and exposed under both names. `create` stays available
     * for tests and for a host that wants its own storage slot. */
    root.MegaLanHostFactory = api;
    root.MegaLanHost = api.create();
    root.MegaLanRoom = root.MegaLanHost;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps, root) {
  const LAN = deps.LAN, HTTP = deps.HTTP;
  if (!LAN || !LAN.LanRoomStore) throw Error('LAN_ROOM_STORE_MISSING');
  if (!HTTP || !HTTP.createLanRoomHandler) throw Error('LAN_ROOM_HTTP_MISSING');

  const STORAGE_KEY = 'mega_lan_host_v1';
  const VERSION = 'lan-host-1';

  function create({ storageKey = STORAGE_KEY, now = () => Date.now(), storage = null } = {}) {
    /* The shell may inject its own durable slot (Android SharedPreferences / iOS defaults).
     * Otherwise localStorage is the slot inside a WebView. */
    const slot = storage || {
      get: () => { try { return root.localStorage?.getItem(storageKey) ?? null; } catch { return null; } },
      set: (s) => { try { root.localStorage?.setItem(storageKey, s); } catch { /* full or denied: keep serving */ } },
    };

    let store = null, handler = null, port = null, hostName = null;

    function boot() {
      store = new LAN.LanRoomStore({ storage: slot, now });
      // A host that was interrupted comes back PAUSED, exactly like the Node LAN server, so an
      // interrupted private tournament never looks settled.
      try { store.recover(); } catch { /* first run: nothing to recover */ }
      handler = HTTP.createLanRoomHandler({ store, now });
      setInterval(() => { try { handler.tick(); } catch { /* a bad room must not kill the host */ } }, 500).unref?.();
      return store;
    }

    /* Native transport primitives, published by the shell (see native/README.md):
     *   window.MegaLanSocket.start(port) -> {ok,port} | {ok:false,error}
     *   window.MegaLanSocket.stop()      -> {ok}
     *   window.MegaLanSocket.status()    -> {listening,port,origin}
     *   window.MegaLanDiscovery.advertise(name, port) -> {ok} / stop()
     *   window.MegaLanDiscovery.browse(timeoutMs)     -> Promise<[{name,origin,rooms}]>
     * Absent in a plain browser or Node, where the same module is served by server/party-server.js
     * or the test harness instead. */
    const socket = () => root.MegaLanSocket || null;
    const discovery = () => root.MegaLanDiscovery || null;

    function open(name, requestedPort) {
      if (!store) boot();
      const p = Number(requestedPort);
      if (!Number.isInteger(p) || p < 1024 || p > 65535) return { ok: false, error: 'INVALID_PORT' };
      hostName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 48) : 'Mega XOXO host';
      const s = socket();
      if (!s) return { ok: false, error: 'HOST_UNAVAILABLE' };
      const started = s.start(p);
      if (!started || started.ok !== true) return { ok: false, error: (started && started.error) || 'BIND_FAILED' };
      port = Number(started.port) || p;
      const d = discovery();
      if (d && typeof d.advertise === 'function') { try { d.advertise(hostName, port); } catch { /* discovery is best-effort */ } }
      return { ok: true, port, code: VERSION, version: VERSION };
    }

    function close() {
      const d = discovery();
      if (d && typeof d.stop === 'function') { try { d.stop(); } catch { /* ignore */ } }
      const s = socket();
      if (s && typeof s.stop === 'function') { try { s.stop(); } catch { /* ignore */ } }
      if (store) store.close();
      store = null; handler = null; port = null;
      return { ok: true };
    }

    function ready() {
      if (!store) boot();
      const s = socket();
      const st = s && typeof s.status === 'function' ? s.status() : null;
      return { ok: !!(st && st.listening), port: st?.port ?? port, origin: st?.origin ?? null, rooms: store.active().length, version: VERSION };
    }

    /* Same-Wi-Fi discovery of other hosts. Resolves [] when the shell has no discovery service. */
    async function discover(timeoutMs = 2500) {
      const d = discovery();
      if (!d || typeof d.browse !== 'function') return { ok: false, error: 'DISCOVERY_UNAVAILABLE', hosts: [] };
      try {
        const hosts = await d.browse(timeoutMs);
        return { ok: true, hosts: Array.isArray(hosts) ? hosts : [] };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || 'DISCOVERY_FAILED'), hosts: [] };
      }
    }

    function info() {
      if (!store) boot();
      return {
        hostName, port, version: VERSION,
        rooms: store.discover(),
        guests: store.state.guests.length,
        active: store.active().length,
      };
    }

    function handle(requestJson) {
      if (!store) boot();
      let request;
      try { request = typeof requestJson === 'string' ? JSON.parse(requestJson) : requestJson; }
      catch { return JSON.stringify({ error: 'INVALID_JSON' }); }
      if (!request || typeof request !== 'object' || typeof request.method !== 'string' || typeof request.path !== 'string') {
        return JSON.stringify({ error: 'INVALID_COMMAND' });
      }
      let result;
      try {
        result = handler.handle({
          method: request.method.toUpperCase(),
          path: request.path,
          query: request.query && typeof request.query === 'object' ? request.query : {},
          headers: request.headers && typeof request.headers === 'object' ? request.headers : {},
          body: typeof request.body === 'string' ? request.body : undefined,
          remote: typeof request.remote === 'string' ? request.remote : 'local',
        });
      } catch (e) {
        return JSON.stringify({ error: String((e && e.message) || 'SERVICE_UNAVAILABLE') });
      }
      if (result === null) return JSON.stringify({ error: 'NOT_FOUND' });
      return JSON.stringify({ status: result.status, body: result.body, headers: { 'cache-control': 'no-store' } });
    }

    return Object.freeze({ open, close, ready, info, handle, discover, VERSION });
  }

  return Object.freeze({ create, VERSION, STORAGE_KEY });
});
