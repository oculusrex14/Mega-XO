/* LAN-local private room authority, shared by the Node LAN server and the in-app host.
 *
 * This is the internet-free sibling of server/rooms.js. It runs the SAME approved tournament
 * rules (src/tournament.js) over the same guest-session and idempotency contract, but it is a
 * portable UMD module with no Node-only dependency (no node:sqlite, no node:crypto, no
 * packages/db): `native/android` runs it inside the WebView's JavaScript engine and
 * `native/ios` runs it inside JavaScriptCore, while tests and the Node LAN server load it with
 * `require`.
 *
 * Authority boundary, unchanged from the LAN-only store it mirrors:
 *   - `lanOnly` guests are anonymous. A guest gets a random 24h bearer token and a random actor
 *     id; there is no account service and no linkage to a permanent actor.
 *   - Private rooms only. Prize/public tables are refused with FREE_PRIVATE_ONLY, so a LAN host
 *     can never mutate Coins, Crowns, Elo or any other economic state.
 *   - A room command is idempotent per (actor, key) and per-command fingerprint, so a retried
 *     request cannot double-apply.
 *
 * Persistence is injected: the host supplies a `storage` object ({get,set}) and this module
 * keeps the whole LAN dataset (rooms, guests, outcomes) as one JSON document. That is honest for
 * a LAN room: the state is disposable coordination, not durable authority, and it never holds an
 * economy.
 */
(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports ? require('../tournament.js') : root.MegaTournament, root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MegaLanRoomStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (T, root) {
  'use strict';
  if (!T || typeof T.create !== 'function') throw Error('LAN_ROOM_RULES_MISSING');

  const VERSION = 'lan-room-2';
  const GUEST_TTL_MS = 86400000;
  const MAX_GUESTS = 200;
  const MAX_ROOMS_PER_OWNER = 3;
  const ROOM_GC_MS = 172800000;      // terminal rooms are dropped after 2 days
  const MAX_ROOM_BYTES = 65536;      // a room document is small; refuse anything absurd
  const ROOMS_PER_SNAPSHOT = 64;

  const err = (s) => { throw Error(s); };
  const clone = (x) => (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));

  /* --- base64url + SHA-256, in whichever engine we are on ------------------------------ */
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function bytesToB64url(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
      out += B64[a >> 2];
      out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
      if (b === undefined) break;
      out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
      if (c === undefined) break;
      out += B64[c & 63];
    }
    return out;
  }
  function hexOf(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }
  function randomBytes(n) {
    const c = root.crypto;
    if (!c || typeof c.getRandomValues !== 'function') err('NO_SECURE_RANDOM');
    const bytes = new Uint8Array(n);
    c.getRandomValues(bytes);
    return bytes;
  }
  /* SHA-256 without requiring subtle.digest to be async at every call site: a tiny synchronous
   * implementation keeps token hashing and command fingerprints comparable in both engines. */
  function sha256Hex(text) {
    const K = new Uint32Array([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const data = new TextEncoder().encode(text);
    const len = data.length;
    const withPad = new Uint8Array((((len + 9) >> 6) + 1) << 6);
    withPad.set(data);
    withPad[len] = 0x80;
    const bitLenHi = Math.floor((len * 8) / 4294967296), bitLenLo = (len * 8) >>> 0;
    const dv = new DataView(withPad.buffer);
    dv.setUint32(withPad.length - 8, bitLenHi);
    dv.setUint32(withPad.length - 4, bitLenLo);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < withPad.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return hexOf(new Uint8Array(H.buffer));
  }

  function emptyState() { return { version: VERSION, guests: [], rooms: [], outcomes: [] }; }
  function validState(s) {
    return !!s && s.version === VERSION && Array.isArray(s.guests) && Array.isArray(s.rooms) && Array.isArray(s.outcomes);
  }

  /* -------------------------------------------------------------------------------------- */
  class LanRoomStore {
    /**
     * @param {object} options
     * @param {{get:()=>string|null,set:(s:string)=>void}} options.storage  durable-ish JSON slot
     * @param {()=>number} [options.now]  injected clock (tests)
     */
    constructor({ storage, now = () => Date.now() } = {}) {
      if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') err('STORAGE_REQUIRED');
      this.storage = storage;
      this.now = now;
      this.lanOnly = true;                 // this store is private-only by construction
      const raw = storage.get();
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      this.state = validState(parsed) ? parsed : emptyState();
      this._roomIndex = new Map(this.state.rooms.map((r) => [r.id, r]));
    }
    /* --- persistence --------------------------------------------------------------------- */
    persist() {
      this.prune();
      const rooms = this.state.rooms.slice(0, ROOMS_PER_SNAPSHOT);
      this.state.rooms = rooms;
      this._roomIndex = new Map(rooms.map((r) => [r.id, r]));
      this.storage.set(JSON.stringify(this.state));
    }
    prune() {
      const now = this.now();
      this.state.guests = this.state.guests.filter((g) => g.expires > now);
      const kept = [];
      for (const r of this.state.rooms) {
        const terminal = ['COMPLETE', 'VOID', 'CANCELLED'].includes(r.status);
        const ended = r.ended || r.pausedAt || 0;
        if (terminal && ended && now - ended > ROOM_GC_MS) continue;
        kept.push(r);
      }
      this.state.rooms = kept;
      // Outcomes are idempotency records for live rooms; drop the ones whose room is gone.
      const live = new Set(kept.map((r) => r.id));
      this.state.outcomes = this.state.outcomes.filter((o) => live.has(JSON.parse(o.response).id));
      if (this.state.outcomes.length > 2000) this.state.outcomes = this.state.outcomes.slice(-2000);
    }
    /* --- guest sessions ------------------------------------------------------------------ */
    guest(name) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 32) err('INVALID_NAME');
      this.prune();
      if (this.state.guests.length >= MAX_GUESTS) err('SESSION_LIMIT');
      const token = bytesToB64url(randomBytes(32));
      const actor = bytesToB64url(randomBytes(16));
      const clean = name.trim();
      this.state.guests.push({ token: sha256Hex(token), actor, name: clean, expires: this.now() + GUEST_TTL_MS });
      this.persist();
      return { token, actor, name: clean };
    }
    authenticate(token) {
      if (typeof token !== 'string' || !token) return null;
      const digest = sha256Hex(token);
      const found = this.state.guests.find((g) => g.token === digest && g.expires > this.now());
      return found ? { actor: found.actor, name: found.name } : null;
    }
    /* --- room access --------------------------------------------------------------------- */
    all() { this.prune(); return this.state.rooms.map((r) => clone(r)); }
    active() { return this.all().filter((r) => !['COMPLETE', 'VOID', 'CANCELLED'].includes(r.status)); }
    get(id) {
      const r = this._roomIndex.get(id) || this.state.rooms.find((x) => x.id === id);
      if (!r) err('ROOM_NOT_FOUND');
      return r;
    }
    code() {
      const taken = new Set(this.state.rooms.map((r) => r.code));
      for (let i = 0; i < 32; i++) {
        const c = bytesToB64url(randomBytes(4)).replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 5).padEnd(5, 'X');
        if (!taken.has(c)) return c;
      }
      err('CODE_EXHAUSTED');
    }
    shuffle(ids) {
      const a = ids.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = (randomBytes(4)[0] | (randomBytes(4)[1] << 8)) % (i + 1);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }
    save(r) { this._roomIndex.set(r.id, r); if (!this.state.rooms.includes(r)) this.state.rooms.unshift(r); return r.id; }
    view(id, actor) {
      const r = this.get(id);
      if (!r.players.some((p) => p.id === actor)) err('NOT_IN_ROOM');
      return T.view(r, this.now());
    }
    /* --- the single command seam --------------------------------------------------------- */
    run(principal, key, command) {
      if (!principal || typeof principal.actor !== 'string' || !principal.actor) err('AUTH_REQUIRED');
      if (typeof key !== 'string' || !key || key.length > 160 || !command) err('INVALID_COMMAND');
      const actor = principal.actor, cmd = clone(command), op = JSON.stringify([actor, key]);
      const fp = sha256Hex(JSON.stringify(cmd));
      this.prune();
      const previous = this.state.outcomes.find((o) => o.op === op);
      if (previous) {
        if (previous.fingerprint !== fp) err('IDEMPOTENCY_CONFLICT');
        const room = this.get(JSON.parse(previous.response).id);
        return room.players.some((p) => p.id === actor) ? T.view(room, this.now()) : { id: room.id, status: 'LEFT' };
      }
      const now = this.now();
      let r;
      const active = this.active();
      if (cmd.type === 'create') {
        if (active.filter((x) => x.owner === actor).length >= MAX_ROOMS_PER_OWNER) err('ROOM_LIMIT');
        r = T.create({ id: bytesToB64url(randomBytes(16)), code: this.code(), owner: actor, name: cmd.name, format: cmd.format, clock: cmd.clock ?? 180, increment: cmd.increment ?? 2, now });
        T.join(r, actor, principal.name || actor, now);
      } else if (cmd.type === 'publicJoin') {
        // A LAN host never runs prize tables: that would need the account/economy authority.
        err('FREE_PRIVATE_ONLY');
      } else {
        /* C5.4: a join key may be an exact room id or this host's five-character code;
           every other command still resolves by exact id. */
        r = cmd.type === 'join' ? this.resolveJoin(cmd.id) : this.get(cmd.id);
        if (!r) err('ROOM_NOT_FOUND');
        if (cmd.type === 'join') {
          if (r.table) err('USE_PUBLIC_QUEUE');
          if (r.players.length >= r.capacity) err('ROOM_FULL');
          T.join(r, actor, principal.name || actor, now);
        } else {
          if (!r.players.some((p) => p.id === actor) && principal.scope !== 'operator') err('NOT_IN_ROOM');
          switch (cmd.type) {
            case 'ready': T.ready(r, actor, cmd.value, cmd.rulesVersion); break;
            case 'configure': T.configure(r, actor, { format: cmd.format, clock: cmd.clock, increment: cmd.increment }); break;
            case 'leave': T.leave(r, actor); break;
            case 'kick': if (r.table || r.status !== 'LOBBY' || r.owner !== actor || cmd.target === actor) err('HOST_ONLY'); T.leave(r, cmd.target); break;
            case 'transfer': if (r.table || r.status !== 'LOBBY' || r.owner !== actor || !r.players.some((p) => p.id === cmd.target)) err('HOST_ONLY'); r.owner = cmd.target; r.revision++; break;
            case 'start': if (r.table) err('AUTOMATIC_START_ONLY'); T.start(r, actor, this.shuffle(r.players.map((p) => p.id)), now); break;
            case 'matchReady': T.readyGame(r, cmd.fixture, actor, now); break;
            case 'move': T.move(r, cmd.fixture, actor, cmd.revision, cmd.move, now); break;
            case 'resign': T.resign(r, cmd.fixture, actor, now); break;
            case 'pause': T.pause(r, actor, now); break;
            case 'resume': T.resume(r, actor, now); break;
            case 'cancel': if (r.owner !== actor || r.table) err('HOST_ONLY'); if (r.status === 'COMPLETE') err('EVENT_FINISHED'); r.status = 'VOID'; r.reason = 'CANCELLED'; r.revision++; break;
            default: err('UNKNOWN_COMMAND');
          }
        }
      }
      if (JSON.stringify(r).length > MAX_ROOM_BYTES) err('ROOM_TOO_LARGE');
      this.save(r);
      const response = T.view(r, now);
      this.state.outcomes.push({ op, fingerprint: fp, response: JSON.stringify({ id: r.id }) });
      this.persist();
      return response;
    }
    /* Advance every live match clock. Safe to call on a timer. */
    tick() {
      this.prune();
      let changed = false;
      for (const r of this.state.rooms) {
        if (['COMPLETE', 'VOID', 'CANCELLED'].includes(r.status)) continue;
        const rev = r.revision;
        T.tick(r, this.now());
        if (r.revision !== rev) { this._roomIndex.set(r.id, r); changed = true; }
      }
      if (changed) this.persist();
    }
    /* Boot recovery: a private tournament interrupted by a restart comes back PAUSED, never a
     * silently settled result. Mirrors server/rooms.js recover(). */
    recover() {
      let changed = false;
      for (const r of this.state.rooms) {
        if (r.status === 'RUNNING') {
          r.status = 'PAUSED'; r.reason = 'SERVER_RESTART'; r.pausedAt = this.now();
          for (const f of r.fixtures) if (f.status === 'PLAYING') f.turnAt = this.now();
          r.revision++; changed = true;
        }
      }
      if (changed) this.persist();
      return changed;
    }
    /* The room list a guest on the same Wi-Fi may discover before joining. */
    discover() {
      return this.active().filter((r) => !r.table && r.status === 'LOBBY').map((r) => ({
        /* C5.4: status is part of the DTO so consumers can filter joinable lobbies without
           relying on a fixture to inject it. */
        id: r.id, code: r.code, name: r.name, owner: r.owner, status: r.status,
        players: r.players.length, capacity: r.capacity,
        format: r.format, clock: r.clock, increment: r.increment,
      }));
    }
    /* C5.4.2: resolve an exact room id or this host's emitted normalized five-character
       code. Codes are uppercased on lookup only, ids stay case-sensitive, and code
       uniqueness is per host. Capacity/membership guards stay in the join path. */
    resolveJoin(idOrCode) {
      if (typeof idOrCode !== 'string' || !idOrCode) err('ROOM_NOT_FOUND');
      const direct = this._roomIndex.get(idOrCode) || this.state.rooms.find((x) => x.id === idOrCode);
      if (direct) return direct;
      if (/^[A-Z0-9]{5}$/.test(idOrCode)) return this.active().find((r) => !r.table && r.code === idOrCode) || null;
      return null;
    }
    close() { this.persist(); }
  }

  return Object.freeze({
    VERSION, LanRoomStore, sha256Hex, bytesToB64url,
    constants: Object.freeze({ GUEST_TTL_MS, MAX_GUESTS, MAX_ROOMS_PER_OWNER, ROOM_GC_MS, MAX_ROOM_BYTES, ROOMS_PER_SNAPSHOT }),
  });
});
