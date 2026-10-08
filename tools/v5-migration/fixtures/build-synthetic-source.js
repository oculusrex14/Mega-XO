'use strict';
/* tools/v5-migration/fixtures/build-synthetic-source.js
 *
 * P03 source-side fixture generator (owner: SourceFixtures).
 *
 * Builds a COMPLETE synthetic V4 source database - all 35 verified V4 tables, 14 named indexes,
 * 2 audit-immutability triggers, 0 views and the 8 serialized `state(id=1,json)` roots - inside a
 * caller-owned EMPTY directory, using only the existing isolated fixture seams:
 *
 *   server/economy-store.js            DurableStore      (state row + `commands` outcomes, one UoW)
 *   server/community-store.js          CommunityStore    (profile/identity/social/save/privacy)
 *   server/monetization-store.js       MonetizationStore (v35 outcomes/tickets/credits)
 *   server/rooms.js                    RoomStore         (party_rooms/party_commands/party_guests)
 *   server/production/migrations.js    migrate()         (v4_schema + v4_* + v41_* DDL)
 *   server/production/operator-service.js  OperatorService (immutable audit chain)
 *   server/production/mail-outbox.js   MailOutbox        (real AES-GCM sealed outbox payload)
 *   server/store-bindings.js           StoreBindings     (permanent store bindings)
 *   src/{domain,monetization,game}.js                   approved pure rules + legal-move search
 *
 * Constructors are used ONLY here, to BUILD a synthetic fixture source. The reader never uses them.
 * Calling this module never starts a server, worker interval, timer or provider request, and performs
 * no HTTP. Anything that would normally require a remote platform store is satisfied in-process (an
 * injected purchase verifier, exactly as tests/monetization-store.test.js does) and the rows that a
 * provider-backed path writes but this synchronous builder cannot invoke are applied by an explicit,
 * hazard-flagged patch (see `hazards` / `limitations`). Nothing here is provider, device or production
 * proof, and `expected.restricted` says so.
 *
 * Determinism: ids, tags, token hashes, bindings, ticket ids and tombstones come from a counter-based
 * sha256 stream installed over `crypto.randomBytes/randomUUID/randomInt`; `Date.now` also returns
 * `clockMs` for the duration of the build. Everything is restored in `finally`. Two builds with the
 * same `variant` + `clockMs` produce byte-identical source files.
 *
 * Interface (frozen by local://v5-p03-source-contract.md):
 *   buildSyntheticSource({directory, clockMs = 1791460800000, variant = 'representative'})
 *     -> {file, directory, variant, clockMs, sourceRelease, layout, expected, hazards, limitations, trace}
 *
 * Variants:
 *   representative  coherent multi-actor state, disjoint occupancy, all hazards except corruption
 *   legacy          historic shapes (H2-normalized optional fields absent, prior-quarter season with a
 *                   9-entry seasonHistory, later-added match fields absent, archived product receipt,
 *                   opaque nested save payload, free private rooms)
 *   unknown-field   representative + unknown root/account/terms/monetization fields that extraction
 *                   must refuse by default at the reported locators
 *   unsafe-asset    representative + fractional money, an unsafe integer, an out-of-range literal, a
 *                   negative credit balance and unsafe asset references that extraction must refuse
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { DatabaseSync } = require('node:sqlite');

const { DurableStore } = require('../../../server/economy-store.js');
const { CommunityStore } = require('../../../server/community-store.js');
const { MonetizationStore } = require('../../../server/monetization-store.js');
const { RoomStore } = require('../../../server/rooms.js');
const { StoreBindings } = require('../../../server/store-bindings.js');
const { migrate, migrations } = require('../../../server/production/migrations.js');
const { OperatorService } = require('../../../server/production/operator-service.js');
const { MailOutbox } = require('../../../server/production/mail-outbox.js');
const { sha } = require('../../../server/identity-provider.js');
const D = require('../../../src/domain.js');
const M = require('../../../src/monetization.js');
const G = require('../../../src/game.js');

const DAY = 86400000;
const MINUTE = 60000;
const DEFAULT_CLOCK_MS = 1791460800000; // 2026-10-08T12:00:00.000Z
const SOURCE_SHA = '455b8ec9ea4070b4410d78f9eea2aaa06d32c0b2';
const SOURCE_RELEASE = 'v4.1.2';
const SCHEMA_HEAD = 8;
const VARIANTS = Object.freeze(['representative', 'legacy', 'unknown-field', 'unsafe-asset']);

const SOURCE_TABLES = Object.freeze([
  'account_sessions', 'commands', 'community_limits', 'email_challenges', 'email_credentials',
  'identities', 'party_commands', 'party_guests', 'party_rooms', 'profile_saves', 'profiles',
  'session_presence', 'signin_attempts', 'social_operations', 'state', 'v35_casual', 'v35_commands',
  'v35_events', 'v35_tickets', 'v41_ad_ticket_context', 'v41_deletion_receipts', 'v41_operator_audit',
  'v41_privacy_requests', 'v41_reports', 'v41_store_bindings', 'v41_store_finalize',
  'v41_store_notifications', 'v41_store_revocations', 'v41_support_events', 'v4_controls',
  'v4_email_versions', 'v4_limits', 'v4_outbox', 'v4_runtime', 'v4_schema',
]);
const SOURCE_INDEXES = 14;
const SOURCE_TRIGGERS = 2;
const STATE_ROOTS = Object.freeze(['accounts', 'burned', 'journal', 'leagueWeek', 'matches', 'receipts', 'snapshots', 'weeklyPaid']);

const ID_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;

const fail = (code, detail) => { const error = new Error(detail ? code + ': ' + detail : code); error.code = code; throw error; };
const sha256 = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const sha256Short = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
/* Same algorithm as server/production/migrations.js (sha256 of `name + '\n' + sql`); that module does
   not export its `checksum` helper, so the fixture regenerates the value it just wrote. */
const migrationChecksum = (migration) => crypto.createHash('sha256').update(migration.name + '\n' + migration.sql).digest('hex');
const sorted = (values) => values.slice().sort((a, b) => String(a).localeCompare(String(b)));

/* ------------------------------------------------------------------- deterministic entropy --- */

function withDeterministicEntropy(variant, clockMs, fn) {
  const original = { randomBytes: crypto.randomBytes, randomUUID: crypto.randomUUID, randomInt: crypto.randomInt, now: Date.now };
  let counter = 0;
  const stream = () => { counter += 1; return crypto.createHash('sha256').update('mega-xo/v5-p03-fixture|' + variant + '|' + counter).digest(); };
  crypto.randomBytes = (size) => {
    if (!Number.isInteger(size) || size < 0 || size > 65536) fail('INVALID_RANDOM_SIZE');
    const out = Buffer.alloc(size);
    for (let offset = 0; offset < size; offset += 32) stream().copy(out, offset, 0, Math.min(32, size - offset));
    return out;
  };
  crypto.randomUUID = () => {
    const bytes = crypto.randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  crypto.randomInt = (max) => stream().readUInt32BE(0) % (Number.isInteger(max) && max > 0 ? max : 1);
  Date.now = () => clockMs;
  try { return fn(); } finally {
    crypto.randomBytes = original.randomBytes;
    crypto.randomUUID = original.randomUUID;
    crypto.randomInt = original.randomInt;
    Date.now = original.now;
  }
}

/* ---------------------------------------------------------------------------- build state --- */

class Fixture {
  constructor({ directory, clockMs, variant }) {
    this.directory = path.resolve(directory);
    this.clockMs = clockMs;
    this.variant = variant;
    this.file = path.join(this.directory, 'mega-source-' + variant + '.sqlite');
    this.hazards = [];
    this.limitations = [];
    this.trace = [];
    this.counters = new Map();
    this.now = clockMs - 26 * DAY;
    this.principal = Object.freeze({
      operator: Object.freeze({ actor: 'ops-fixture-1', scope: 'operator' }),
      matchmaker: Object.freeze({ actor: 'matchmaker', scope: 'matchmaker' }),
      store: Object.freeze({ actor: 'store-fixture-1', scope: 'store' }),
      player: (actor, name) => Object.freeze({ actor, name: name || actor, scope: 'player' }),
    });
    this.hazard = (locator, kind, note) => { this.hazards.push({ locator, kind, note }); };
  }

  /* -- clock -- */
  advance(ms) { if (!Number.isFinite(ms) || ms < 0) fail('INVALID_ADVANCE'); this.now = Math.min(this.clockMs, this.now + ms); return this.now; }
  setTime(ms) { if (!Number.isFinite(ms) || ms <= 0) fail('INVALID_FIXTURE_TIME'); this.now = ms; return this.now; }

  /* -- deterministic unique operation keys -- */
  key(kind) { const n = (this.counters.get(kind) || 0) + 1; this.counters.set(kind, n); return kind + '-fixture-' + n; }

  /* ------------------------------------------------------------------------------ open ---- */
  open() {
    const now = () => this.now;
    this.store = new DurableStore(this.file, {
      now,
      random: () => 0,
      verifyPurchase: (evidence, actor) => ({ ...evidence, valid: true, accountId: actor, refunded: false }),
    });
    migrate(this.store.db);
    this.community = new CommunityStore({
      store: this.store,
      origin: 'https://mega.example',
      now,
      otpSecret: 'synthetic-fixture-otp-secret-not-a-real-secret',
      deletionPolicy: { enabled: true, policyVersion: 'privacy-1' },
      securityNotify: () => {},
    });
    this.monetization = new MonetizationStore(this.store, {
      now,
      eligible: () => true,
      purchasesEnabled: true,
      verifyPurchase: async (evidence, actor) => ({ ...evidence, valid: true, accountId: actor, refunded: false }),
      adMode: 'hybrid',
      /* `adUnit` builds the normalized `legacy` platform entry (the constructor only accepts
         android/ios in `adUnits`); both platforms get explicit units. */
      adUnit: 'synthetic-legacy-rewarded-unit',
      adUnits: { android: { rewarded: 'synthetic-android-rewarded-unit', interstitial: 'synthetic-android-interstitial-unit' } },
      rewardItem: 'cosmetic_reward',
      verifyAd: async (raw) => JSON.parse(raw),
      busy: () => false,
    });
    this.rooms = new RoomStore(this.file, { now });
    this.operator = new OperatorService({ community: this.community, store: this.store }, { secret: 'synthetic-fixture-operator-secret-0123456789abcdef', now });
    this.bindings = new StoreBindings(this.store.db, { now });
    this.outbox = new MailOutbox(this.community, { secret: 'synthetic-fixture-mail-secret', now });
    const tables = this.store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n;
    if (tables !== SOURCE_TABLES.length) fail('FIXTURE_SCHEMA_TABLES', String(tables));
  }

  /* ---------------------------------------------------------------------------- accounts ---- */
  provision(id, options = {}) {
    if (!ID_GRAMMAR.test(id)) fail('INVALID_SYNTHETIC_ACTOR', id);
    const defaults = { verified: true, games: 30, rating: 1000, coins: 5000, crowns: 1000, createdAt: this.now - 30 * DAY };
    this.store.run(this.principal.operator, this.key('provision'), { type: 'provision', account: id, options: { ...defaults, ...options } });
    this.community.ensureProfile(id, this.store.read());
    return id;
  }

  flag(id, field, value) { return this.operator.flag(id, 'ops-fixture-1', 'Synthetic moderation fixture', field, value); }

  /* --------------------------------------------------------------- raw source text patching ---- */

  /* Applied to the raw `state` text between store operations (never after any reader has run, and no
     reader exists in this process). `raw()` returns a marker that is substituted with a verbatim JSON
     numeric literal so unsafe/non-finite/fractional source values can be modelled exactly. */
  patchState(mutate) {
    const value = JSON.parse(this.store.db.prepare('SELECT json FROM state WHERE id=1').get().json);
    const literals = [];
    const raw = (literal) => { const token = '@@RAW_LITERAL_' + literals.length + '@@'; literals.push({ token: '"' + token + '"', literal }); return token; };
    const overridden = mutate(value, raw);
    let text = overridden && typeof overridden.text === 'string' ? overridden.text : JSON.stringify(value);
    for (const entry of literals) {
      if (!text.includes(entry.token)) fail('RAW_PATCH_MARKER_LOST');
      text = text.split(entry.token).join(entry.literal);
    }
    this.store.db.prepare('UPDATE state SET json=? WHERE id=1').run(text);
    return text;
  }

  rawState() { return this.store.db.prepare('SELECT json FROM state WHERE id=1').get().json; }
  readState() { return JSON.parse(this.rawState()); }
  readRooms() {
    return this.query('SELECT id,code,json FROM party_rooms ORDER BY id').map((row) => ({ id: row.id, code: row.code, room: JSON.parse(row.json) }));
  }
  query(sql, ...args) { return this.community.db.prepare(sql).all(...args); }

  /* ------------------------------------------------------------------- phase: identity/social ---- */
  phaseIdentityAndSocial() {
    const core = [
      ['alice-1', { coins: 5000, crowns: 1000, rating: 1180, region: 'in-west' }],
      ['bob_2', { coins: 4200, crowns: 900, rating: 1210 }],
      ['eve5', { coins: 6000, crowns: 1000, rating: 1500 }],
      ['frank-6', { coins: 3000, crowns: 1000, rating: 1480 }],
      ['gina-3', { coins: 2600, crowns: 800, rating: 1005 }],
      ['hank-4', { coins: 2600, crowns: 800, rating: 990 }],
      ['jack-5', { coins: 1800, crowns: 700, rating: 1330 }],
      ['kate-10', { coins: 4400, crowns: 900, rating: 1620 }],
      ['leo-11', { coins: 4400, crowns: 900, rating: 1580 }],
      ['mona-12', { coins: 3200, crowns: 700, rating: 1400 }],
      ['weekly-1', { coins: 5200, crowns: 1000, rating: 1600, region: 'eu-central' }],
      ['legacy-1', { coins: 2500, crowns: 400, rating: 1215 }],
      ['suspend-8', { coins: 1500, crowns: 300, rating: 1150 }],
      ['ads-1', { coins: 1500, crowns: 300, rating: 1200 }],
      ['ent-1', { coins: 1500, crowns: 300, rating: 1200 }],
      ['ivy-4', { coins: 2000, crowns: 500, rating: 1050 }],
      ['quinn-17', { coins: 2000, crowns: 500, rating: 1100 }],
      ['jill-13', { coins: 2000, crowns: 500, rating: 1250 }],
      ['refund-9', { coins: 1800, crowns: 1400, rating: 1280 }],
      ['offr-1', { coins: 2400, crowns: 900, rating: 1300 }],
      ['offr-2', { coins: 2400, crowns: 900, rating: 1320 }],
      ['offr-3', { coins: 2400, crowns: 900, rating: 1360 }],
      ['offr-4', { coins: 2400, crowns: 900, rating: 1380 }],
    ];
    for (const [id, options] of core) this.provision(id, options);
    for (let i = 0; i < 10; i += 1) this.provision('tour-' + i, { coins: 4000, crowns: 1000, rating: 1000 + i });
    for (let i = 0; i < 10; i += 1) this.provision('done-' + i, { coins: 4000, crowns: 500, rating: 1000 + i });

    /* Public profile edits (real validation, deterministic usernames/tags). */
    this.community.edit('alice-1', { username: 'alice_fixture', displayName: 'Alice Fixture', avatar: 'ring', statsVisibility: 'friends', presenceVisibility: 'friends' });
    this.community.edit('bob_2', { username: 'bob_fixture', displayName: 'Bob Fixture', avatar: 'board', statsVisibility: 'public' });
    this.community.edit('kate-10', { username: 'kate_fixture', displayName: 'Kate Fixture', avatar: 'crown' });
    this.community.edit('jack-5', { username: 'jack_fixture', displayName: 'Jack Fixture', avatar: 'star' });
    this.community.edit('weekly-1', { username: 'weekly_fixture', displayName: 'Weekly Fixture', avatar: 'rook' });
    this.advance(MINUTE);

    /* Allowlisted account preferences. */
    this.store.run(this.principal.player('alice-1'), this.key('prefs'), { type: 'preferences', changes: { wealthPublic: true, region: 'in-west' } });

    /* Provider identities through the real one-use attempt/consume/finishVerified seam. */
    this.linkProvider('alice-1', 'google', 'google-subject-alice-fixture');
    this.linkProvider('bob_2', 'apple', 'apple-subject-bob-fixture');
    this.linkProvider('kate-10', 'apple', 'apple-subject-kate-fixture');
    this.advance(MINUTE);

    /* Email credentials: mixed-case verified plus lower-case unverified (COLLATE NOCASE uniqueness). */
    const salt = crypto.randomBytes(16).toString('base64url');
    const passwordHash = crypto.scryptSync('SyntheticFixture1', Buffer.from(salt, 'base64url'), 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64url');
    const insertCredential = this.community.db.prepare('INSERT INTO email_credentials(email,actor,salt,password_hash,created,verified_at) VALUES(?,?,?,?,?,?)');
    const insertIdentity = this.community.db.prepare('INSERT INTO identities VALUES(?,?,?,?)');
    insertCredential.run('Alice.Fixture@Example.test', 'alice-1', salt, passwordHash, this.now - 10 * DAY, this.now - 10 * DAY);
    insertIdentity.run('email', 'Alice.Fixture@Example.test', 'alice-1', this.now - 10 * DAY);
    insertCredential.run('bob.fixture@example.test', 'bob_2', salt, passwordHash, this.now - 9 * DAY, null);
    insertIdentity.run('email', 'bob.fixture@example.test', 'bob_2', this.now - 9 * DAY);

    /* One consumed verify-existing challenge with its matching v4_email_versions stamp, one expired and
       unconsumed challenge. Both code hashes are opaque HMAC digests. */
    const challengeSession = sha('sess-fixture-challenge');
    const insertChallenge = this.community.db.prepare('INSERT INTO email_challenges(id,session,email,purpose,actor,code_hash,password_salt,password_hash,created,expires,attempts,verified_at,consumed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    insertChallenge.run('challenge-consumed-1', challengeSession, 'Alice.Fixture@Example.test', 'verify-existing', 'alice-1', this.hashCode('challenge-consumed-1'), salt, passwordHash, this.now - 2 * DAY, this.now - 2 * DAY + 600000, 0, this.now - 2 * DAY + 60000, 1);
    this.community.db.prepare('INSERT INTO v4_email_versions VALUES(?,?)').run('challenge-consumed-1', sha256Short('alice-1|' + passwordHash));
    insertChallenge.run('challenge-expired-1', challengeSession, 'eve5.fixture@example.test', 'signup', null, this.hashCode('challenge-expired-1'), salt, passwordHash, this.now - 20 * MINUTE, this.now - 10 * MINUTE, 0, null, 0);
    this.community.db.prepare('INSERT INTO v4_email_versions VALUES(?,?)').run('challenge-expired-1', null);

    /* Social graph: symmetric friendship, directional pending request, declaration, block. */
    this.community.social('alice-1', this.key('social'), 'request', 'bob_2');
    this.community.social('bob_2', this.key('social'), 'accept', 'alice-1');
    this.community.social('gina-3', this.key('social'), 'request', 'hank-4');
    this.community.social('mona-12', this.key('social'), 'request', 'leo-11');
    this.community.social('leo-11', this.key('social'), 'decline', 'mona-12');
    this.community.social('gina-3', this.key('social'), 'block', 'frank-6');
    this.advance(MINUTE);
    /* A held profile: hidden from search and public profile statistics. */
    this.flag('suspend-8', 'suspended', true);
    this.flag('suspend-8', 'hold', true);
    this.advance(MINUTE);
  }

  hashCode(id) { return sha256Short('synthetic-fixture-otp|' + id); }

  linkProvider(actor, provider, subject) {
    const token = 'sess-link-' + provider + '-' + actor;
    this.community.db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?,?,?)').run(sha(token), actor, 'csrf-' + provider + '-' + actor, this.now, this.now + 14 * DAY, this.now);
    const started = this.community.start(token, provider, 'link', 'native');
    const attempt = this.community.consume(token, started.state, provider, 'native');
    this.community.finishVerified(token, attempt, { provider, subject });
    return this.community.identities(actor);
  }

  /* ------------------------------------------------------------- phase: completed tournament ---- */
  /* A full 10-seat public Low table played to completion: real reserve, payouts, 10% burn, ranking,
     tournamentRecord and a party_commands outcome per room command. Runs early so every fixture
     `opens`/`expires`/`finished` timestamp is in the past relative to the capture clock. */
  phaseCompletedTournament() {
    for (let i = 0; i < 10; i += 1) {
      this.rooms.run(this.principal.player('done-' + i, 'done-' + i), this.key('party'), { type: 'publicJoin', table: 'low' });
    }
    const row = this.query("SELECT id,json FROM party_rooms WHERE json_extract(json,'$.table')='low'").at(-1);
    const room = JSON.parse(row.json);
    for (const player of room.players) {
      this.rooms.run(this.principal.player(player.id, player.name), this.key('party'), { type: 'ready', id: room.id, value: true, rulesVersion: room.rulesVersion });
    }
    let current = this.rooms.get(room.id);
    if (current.status !== 'RUNNING' || !current.escrow) fail('FIXTURE_LOW_RESERVE', current.status);
    /* Group games are resigned (fast, deterministic, and they produce the archived empty-move fixture
       history the source already allows). Every bracket game is then PLAYED OUT through the real room
       `move` command so `fixtures[].history[].moves` carries a non-empty authoritative move list and
       the final placements are decided by real board results, not by forfeits. */
    let guard = 0;
    let playedOut = 0;
    while (current.status === 'RUNNING' && guard < 4000) {
      guard += 1;
      this.advance(16000);
      this.rooms.tick();
      /* Work from a fresh room read each round and re-check each fixture's live status by id, because
         every command and every clock advance changes the room state. */
      current = this.rooms.get(room.id);
      const ready = current.fixtures.filter((f) => f.status === 'READY' && f.opens <= this.now).map((f) => f.id);
      for (const fixtureId of ready) {
        current = this.rooms.get(room.id);
        let live = current.fixtures.find((f) => f.id === fixtureId);
        if (!live || live.status !== 'READY' || live.opens > this.now) continue;
        this.rooms.run(this.principal.player(live.players[0], live.players[0]), this.key('party'), { type: 'matchReady', id: room.id, fixture: fixtureId });
        this.rooms.run(this.principal.player(live.players[1], live.players[1]), this.key('party'), { type: 'matchReady', id: room.id, fixture: fixtureId });
        if (live.group) {
          const resigner = live.players.slice().sort().at(-1);
          this.rooms.run(this.principal.player(resigner, resigner), this.key('party'), { type: 'resign', id: room.id, fixture: fixtureId });
          continue;
        }
        /* Play the bracket game to a real line win: always the first legal move (decisive in 50).
           The whole batch is played at the iteration's frozen clock instant (the same discipline the
           source's own tournament driver uses), so a long game cannot expire its batch mates. */
        live = this.rooms.get(room.id).fixtures.find((f) => f.id === fixtureId);
        let moves = 0;
        while (live.status === 'PLAYING' && moves < 81) {
          const legal = G.legal(live.state);
          if (!legal.length) fail('FIXTURE_ROOM_NO_LEGAL_MOVE', room.id + '/' + fixtureId);
          const actor = live.players[live.state.turn === 'X' ? 0 : 1];
          this.rooms.run(this.principal.player(actor, actor), this.key('party'), { type: 'move', id: room.id, fixture: fixtureId, revision: live.state.moves.length, move: legal[0] });
          live = this.rooms.get(room.id).fixtures.find((f) => f.id === fixtureId);
          moves += 1;
        }
        if (live.status !== 'DONE') fail('FIXTURE_ROOM_FIXTURE_INCOMPLETE', room.id + '/' + fixtureId + '/' + live.status);
        playedOut += 1;
      }
    }
    if (current.status !== 'COMPLETE' || !current.receipt || !current.ranking) fail('FIXTURE_LOW_NOT_COMPLETE', current.status);
    if (current.ranking.length !== 10 || new Set(current.ranking).size !== 10) fail('FIXTURE_LOW_RANKING');
    const historyWithMoves = current.fixtures.filter((f) => f.history.some((h) => h.moves.length)).length;
    if (!historyWithMoves) fail('FIXTURE_ROOM_NO_MOVE_HISTORY');
    this.trace.push('low:' + room.id + ';payouts=' + current.receipt.payouts.length + ';burn=' + current.receipt.burn + ';ranking=' + current.ranking.length + ';playedOut=' + playedOut + ';histWithMoves=' + historyWithMoves);
  }

  /* A ranked queue match played to a real line win: real Coin burn, pre/rating hundredths, history,
     season counters, daily progress and a ~50-entry authoritative move-command chain. */
  phaseFinishedRankedMatch() {
    const queue = this.store.run(this.principal.matchmaker, this.key('queue'), { type: 'queue', id: 'match-ranked-1', a: 'kate-10', b: 'leo-11', mode: 'ranked' });
    this.store.run(this.principal.player('kate-10'), this.key('accept'), { type: 'accept', id: 'match-ranked-1', termsHash: queue.termsHash });
    this.store.run(this.principal.player('leo-11'), this.key('accept'), { type: 'accept', id: 'match-ranked-1', termsHash: queue.termsHash });
    let match = this.store.read().matches.get('match-ranked-1');
    let moves = 0;
    /* Deterministic legal-move policy: always the first legal move for both sides. This always ends
       in a decisive line win (verified: 50 moves) so the receipt carries a real winner, a real
       rating delta and a real Coin burn, and the authoritative command chain is fully exercised. */
    while (!match.state.winner && moves < 81) {
      const legal = G.legal(match.state);
      if (!legal.length) fail('FIXTURE_NO_LEGAL_MOVE');
      this.advance(2000);
      this.store.run(this.principal.player(match.symbols[match.state.turn]), this.key('move'), { type: 'move', id: 'match-ranked-1', revision: match.revision, move: legal[0] });
      match = this.store.read().matches.get('match-ranked-1');
      moves += 1;
    }
    if (!match.settled || match.receipt.reason !== 'line' || !match.receipt.rating) fail('FIXTURE_RANKED_UNSETTLED', String(match.receipt && match.receipt.reason));
    if (!match.players.includes(match.receipt.winner)) fail('FIXTURE_RANKED_WINNER');
    this.store.run(this.principal.player(match.receipt.winner), this.key('quest'), { type: 'quest', quest: 'ranked' });
    this.trace.push('ranked:winner=' + match.receipt.winner + ';moves=' + moves + ';burn=' + match.receipt.burn + ';ratingDelta=' + match.receipt.rating.delta);
  }

  /* One expired offer, one declined offer, one cancelled offer. */
  phaseUnsettledOffers() {
    this.store.run(this.principal.player('mona-12'), this.key('offer'), { type: 'offer', id: 'match-expired-1', opponent: 'leo-11', terms: { kind: 'friend', amount: 20, rated: false } });
    this.advance(D.POLICY.offerMinutes * MINUTE + MINUTE);
    this.store.run(this.principal.operator, this.key('expire'), { type: 'expire', id: 'match-expired-1' });

    const declined = this.store.run(this.principal.player('mona-12'), this.key('offer'), { type: 'offer', id: 'match-declined-1', opponent: 'kate-10', terms: { kind: 'friend', amount: 20, rated: false } });
    this.store.run(this.principal.player('kate-10'), this.key('decline'), { type: 'decline', id: 'match-declined-1', termsHash: declined.termsHash });

    this.store.run(this.principal.player('mona-12'), this.key('offer'), { type: 'offer', id: 'match-cancelled-1', opponent: 'legacy-1', terms: { kind: 'friend', amount: 20, rated: false } });
    this.store.run(this.principal.player('mona-12'), this.key('cancel'), { type: 'cancel', id: 'match-cancelled-1' });
  }

  /* Free match left to its server deadline, settled by the trusted timeout command (loss, no bonus). */
  phaseTimeoutMatch() {
    this.store.run(this.principal.player('gina-3'), this.key('offer'), { type: 'offer', id: 'match-timeout-1', opponent: 'eve5', terms: { kind: 'friend', amount: 20, rated: false } });
    const offer = this.store.read().matches.get('match-timeout-1');
    this.store.run(this.principal.player('eve5'), this.key('accept'), { type: 'accept', id: 'match-timeout-1', termsHash: offer.termsHash });
    this.advance(offer.terms.turnSeconds * 1000 + 1000);
    this.store.run(this.principal.operator, this.key('timeout'), { type: 'timeout', id: 'match-timeout-1' });
  }

  /* Paid direct Crown challenge voided by the operator: exact contributor refunded, zero burn. */
  phaseVoidedMatch() {
    this.store.run(this.principal.player('hank-4'), this.key('offer'), { type: 'offer', id: 'match-void-1', opponent: 'mona-12', terms: { kind: 'leaderboard' } });
    const offer = this.store.read().matches.get('match-void-1');
    this.store.run(this.principal.player('mona-12'), this.key('accept'), { type: 'accept', id: 'match-void-1', termsHash: offer.termsHash });
    const match = this.store.read().matches.get('match-void-1');
    if (match.quote.currency !== 'crowns' || !match.escrow) fail('FIXTURE_VOID_ESCROW');
    this.store.run(this.principal.operator, this.key('void'), { type: 'void', id: 'match-void-1', reason: 'Synthetic server cancellation' });
  }

  /* Paid direct challenge settled as a draw: escrow refunded to the exact contributor, no burn.
     The final move is issued through the real command with a crafted near-draw board position. */
  phaseDrawnMatch() {
    this.store.run(this.principal.player('frank-6'), this.key('offer'), { type: 'offer', id: 'match-draw-1', opponent: 'legacy-1', terms: { kind: 'leaderboard' } });
    const offer = this.store.read().matches.get('match-draw-1');
    this.store.run(this.principal.player('legacy-1'), this.key('accept'), { type: 'accept', id: 'match-draw-1', termsHash: offer.termsHash });
    let match = this.store.read().matches.get('match-draw-1');
    if (match.quote.currency !== 'crowns' || !match.escrow) fail('FIXTURE_DRAW_ESCROW');
    /* All nine Mini Boards locally drawn except board 4, which is one cell from a draw. */
    this.patchState((state) => {
      for (const [, candidate] of state.matches) {
        if (candidate.id !== 'match-draw-1') continue;
        candidate.state.mini = Array(9).fill('DRAW');
        candidate.state.mini[4] = null;
        candidate.state.board[4] = ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', null];
        candidate.state.required = 4;
        candidate.state.turn = 'X';
        candidate.state.moves = [{ b: 0, c: 0, player: 'X' }];
      }
    });
    this.advance(1500);
    this.store.run(this.principal.player(match.symbols.X), this.key('move'), { type: 'move', id: 'match-draw-1', revision: 0, move: { b: 4, c: 8 } });
    match = this.store.read().matches.get('match-draw-1');
    if (match.receipt?.reason !== 'draw' || match.receipt.burn !== 0) fail('FIXTURE_DRAW_NOT_SETTLED');
    this.trace.push('draw:' + match.id + ';refunded=' + match.receipt.refunded);
  }

  /* A finished rated match whose participant is then genuinely deleted through the store transaction,
     plus one pre-existing deleted actor: both leave tombstone references the extractor must classify. */
  phaseDeletion() {
    const queue = this.store.run(this.principal.matchmaker, this.key('queue'), { type: 'queue', id: 'match-deleted-1', a: 'quinn-17', b: 'ivy-4', mode: 'ranked' });
    this.store.run(this.principal.player('quinn-17'), this.key('accept'), { type: 'accept', id: 'match-deleted-1', termsHash: queue.termsHash });
    this.store.run(this.principal.player('ivy-4'), this.key('accept'), { type: 'accept', id: 'match-deleted-1', termsHash: queue.termsHash });
    this.advance(4000);
    const match = this.store.read().matches.get('match-deleted-1');
    this.store.run(this.principal.player(match.symbols.X), this.key('resign'), { type: 'resign', id: 'match-deleted-1' });

    /* Pre-existing deleted actor: receipt + completed privacy request + tombstone referenced from
       another actor's history/season, with no account row (what deleteAccount leaves behind). */
    const tombstone = 'deleted_' + crypto.randomBytes(16).toString('hex');
    const actorHash = crypto.createHash('sha256').update('mega-xo-deleted-account:ivy-preexisting').digest('base64url');
    this.community.db.prepare('INSERT INTO v41_privacy_requests(id,actor,kind,state,requested_at,updated_at,completed_at,policy_version,note) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('privacy-preexisting-1', tombstone, 'deletion', 'completed', this.now - 6 * DAY, this.now - 5 * DAY, this.now - 5 * DAY, 'privacy-1', '');
    this.community.db.prepare('INSERT INTO v41_deletion_receipts VALUES(?,?,?,?,?,?)')
      .run('receipt-preexisting-1', actorHash, tombstone, this.now - 5 * DAY, 'privacy-1', JSON.stringify(['purchase_replay_records', 'operator_security_audit', 'pseudonymized_moderation_outcomes']));
    this.patchState((state) => {
      const actor = new Map(state.accounts).get('gina-3');
      actor.history.unshift({ id: 'match-preexisting-1', at: this.now - 5 * DAY, opponent: tombstone, mode: 'ranked', queue: true, symbol: 'O', rated: true, qualified: true, activityQualified: true, result: 'loss', reason: 'resign', activeSeconds: 40, ratingDelta: -11.5, casualDelta: 0 });
      actor.season.opponents = Array.from(new Set([...(actor.season.opponents || []), tombstone]));
    });

    const token = 'sess-delete-quinn-17';
    this.community.db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?,?,?)').run(sha(token), 'quinn-17', 'csrf-quinn-17', this.now, this.now + DAY, this.now);
    const tag = this.community.profileRow('quinn-17').tag;
    const result = this.community.deleteAccount(token, tag);
    this.deletedTombstone = this.community.db.prepare('SELECT tombstone FROM v41_deletion_receipts WHERE id=?').get(result.receiptId).tombstone;
    this.trace.push('deleted:' + this.deletedTombstone.slice(0, 14) + '…;policy=' + result.policyVersion);
    this.advance(MINUTE);
  }

  /* --------------------------------------------------------------- phase: economy/purchases ---- */
  phaseEconomy() {
    /* Real cosmetic spend (legacy authority path) keeps the legacy coin-spend journal shape. */
    this.store.run(this.principal.player('alice-1'), this.key('cosmetic'), { type: 'cosmetic', name: 'Copper edge' });
    /* Crown purchase, duplicate retry (no re-grant), then a provenance-preserving conversion. */
    const buyEvidence = { store: 'apple', transactionId: 'tx-apple-crowns-100', productId: 'crowns_100' };
    this.store.run(this.principal.player('alice-1'), this.key('purchase'), { type: 'purchase', evidence: buyEvidence });
    this.store.run(this.principal.player('alice-1'), this.key('purchase'), { type: 'purchase', evidence: buyEvidence });
    this.store.run(this.principal.player('alice-1'), this.key('convert'), { type: 'convert', from: 'crowns', amount: 50 });
    this.store.run(this.principal.player('bob_2'), this.key('purchase'), { type: 'purchase', evidence: { store: 'google', transactionId: 'tx-google-crowns-525', productId: 'crowns_525' } });
    /* Refunded purchase: refundPurchase freezes the account with an explicit hold and never claws
       back. The actor is dedicated so nothing later needs it to be eligible. */
    this.store.run(this.principal.player('refund-9'), this.key('purchase'), { type: 'purchase', evidence: { store: 'google', transactionId: 'tx-google-refunded-1100', productId: 'crowns_1100' } });
    this.store.run(this.principal.store, this.key('refund'), { type: 'refund', store: 'google', transactionId: 'tx-google-refunded-1100' });
    this.advance(MINUTE);
  }

  /* Verified-store entitlement + monetization state. `MonetizationStore.purchase`/`callback` are async
     (remote verification); this builder is synchronous, so the already-verified outcome is applied with
     the exact source formulas and the rows are flagged as synthetic provider outcomes. */
  phaseMonetization() {
    /* remove_ads: one entitlement kept, one revoked by the store (no Crown hold for non-currency). */
    this.applyVerifiedPurchase('ent-1', 'tx-entitlement-kept', 'remove_ads');
    this.applyVerifiedPurchase('ads-1', 'tx-entitlement-refunded', 'remove_ads');
    this.monetization.refund('google', 'tx-entitlement-refunded');
    /* A Crown-product purchase through the same verified-outcome path (second provenance shape). */
    this.applyVerifiedPurchase('jill-13', 'tx-google-crowns-525-jill', 'crowns_525');

    /* Qualified casual history -> banked cosmetic credits with real per-match dedupe rows. */
    this.patchState((state) => {
      const actor = new Map(state.accounts).get('gina-3');
      actor.history = [
        { id: 'match-casual-1', at: this.now - 3 * 3600000, mode: 'casual', queue: true, rated: false, qualified: true, activityQualified: true, result: 'win', reason: 'line', activeSeconds: 120, symbol: 'X', opponent: 'hank-4', ratingDelta: 0, casualDelta: 12.25 },
        { id: 'match-casual-2', at: this.now - 2 * 3600000, mode: 'casual', queue: true, rated: false, qualified: true, activityQualified: true, result: 'draw', reason: 'draw', activeSeconds: 95, symbol: 'O', opponent: 'jack-5', ratingDelta: 0, casualDelta: 0 },
      ];
      actor.casualGames = 2;
    });
    this.monetization.claim('gina-3', this.key('v35-claim'));

    /* Rewarded-ad tickets via the real ticket seam, then the settled/expired shapes. */
    const boostTicket = this.monetization.ticket('jack-5', this.key('v35-ticket'), 'boost', 'legacy');
    this.applyAdGrant('jack-5', boostTicket.ticket, 'ssv-transaction-boost-1', 'boost');
    this.advance(M.POLICY.boostDuration + 5 * MINUTE); // the granted boost is expired at capture
    this.advance(M.POLICY.rewardedGap + 1000);
    const creditTicket = this.monetization.ticket('jack-5', this.key('v35-ticket'), 'credits', 'legacy');
    this.applyAdGrant('jack-5', creditTicket.ticket, 'ssv-transaction-credits-1', 'credits');
    /* A permanently unsettled boost ticket that has already expired: a real inert retry row. */
    this.advance(M.POLICY.rewardedGap + 1000);
    this.monetization.ticket('jack-5', this.key('v35-ticket'), 'boost', 'legacy');
    this.advance(M.POLICY.ticketLifetime + MINUTE);
    this.advance(M.POLICY.fullScreenGap + 1000);
    this.monetization.automaticPermit('jack-5', this.key('v35-permit'), 'legacy');
    this.trace.push('v35:tickets=' + this.query('SELECT count(*) n FROM v35_tickets')[0].n + ';adContexts=' + this.query('SELECT count(*) n FROM v41_ad_ticket_context')[0].n);
  }

  applyVerifiedPurchase(actor, transactionId, productId) {
    const product = M.product(productId);
    if (!product) fail('FIXTURE_UNKNOWN_PRODUCT', productId);
    const safeReceipt = { valid: true, accountId: actor, store: 'google', transactionId, productId, refunded: false };
    const command = { type: 'purchase', receipt: safeReceipt };
    const result = { productId: product.id, crowns: product.crowns, duplicate: false };
    if (product.crowns) {
      this.patchState((state) => {
        const target = new Map(state.accounts).get(actor);
        target.crowns += product.crowns;
        target.purchasedCrowns = (target.purchasedCrowns || 0) + product.crowns;
        target.purchaseInfluenced = true;
        state.receipts.push(['google:' + transactionId, { actor, productId: product.id, crowns: product.crowns, refunded: false, at: this.now }]);
        state.journal.push({ id: 'purchase:google:' + transactionId, actor, currency: 'crowns', amount: product.crowns, reason: 'Crown purchase', source: 'verified-store', at: this.now });
      });
    } else {
      this.patchState((state) => { state.receipts.push(['google:' + transactionId, { actor, productId: product.id, crowns: 0, refunded: false, at: this.now }]); });
    }
    this.community.db.prepare('INSERT INTO v35_commands(actor,key,fingerprint,response) VALUES(?,?,?,?)')
      .run(actor, 'purchase-fixture-' + transactionId, sha256(JSON.stringify(command)), JSON.stringify(result));
    this.community.db.prepare('INSERT INTO v35_events(actor,kind,at,value) VALUES(?,?,?,?)').run(actor, 'purchase_verified', this.now, product.crowns);
    this.hazard('v41_store_bindings/v35_commands(actor=' + actor + ',tx=' + transactionId + ')', 'synthetic-provider-outcome', 'Verified-store outcome applied by this synchronous builder with the exact source formulas (fingerprint sha256(JSON(command)), response vocabulary). No remote provider call, no platform verification; P03 must treat the fingerprint as opaque.');
  }

  applyAdGrant(actor, ticket, transactionId, kind) {
    const event = { actor, ticket, transactionId, rewardItem: 'cosmetic_reward', amount: 1, timestamp: this.now, adUnit: 'synthetic-legacy-rewarded-unit' };
    const digest = crypto.createHash('sha256').update(transactionId).digest('hex');
    const response = { granted: kind, credits: null, boost: null };
    this.patchState((state) => {
      const m = new Map(state.accounts).get(actor).monetization;
      if (kind === 'credits') { m.credits = D.add(m.credits, M.POLICY.rewardCredits); response.credits = m.credits; }
      else { m.boosts.push({ startedAt: this.now, endsAt: this.now + M.POLICY.boostDuration }); response.boost = m.boosts.at(-1); }
      m.lastAdAt = this.now;
    });
    this.community.db.prepare('UPDATE v35_tickets SET settled=1,transaction_id=? WHERE id=?').run(transactionId, ticket);
    this.community.db.prepare('INSERT INTO v35_commands(actor,key,fingerprint,response) VALUES(?,?,?,?)')
      .run(actor, 'ssv:' + digest, sha256(JSON.stringify({ type: 'ssv', event })), JSON.stringify(response));
    this.community.db.prepare('INSERT INTO v35_events(actor,kind,at,value) VALUES(?,?,?,?)').run(actor, 'reward_verified', this.now, kind === 'credits' ? M.POLICY.rewardCredits : 0);
    this.hazard('v35_tickets(id=' + ticket + ')/v35_commands(ssv:' + digest.slice(0, 12) + '…)', 'synthetic-provider-outcome', 'Settled rewarded-ad outcome applied by this synchronous builder with the exact source formulas. No AdMob SSV call was made; the reward is synthetic fixture state, never provider proof.');
  }

  /* Store follow-up, revocation, notification and retry rows (all inert). */
  phaseStoreRows() {
    const revocations = this.community.db.prepare('INSERT OR IGNORE INTO v41_store_revocations(store,transaction_id,product_id,occurred_at,reason) VALUES(?,?,?,?,?)');
    revocations.run('google', 'tx-orphan-revocation-1', null, this.now - DAY, 'google_refund');
    revocations.run('apple', 'tx-apple-revocation-2', 'crowns_525', this.now - 12 * 3600000, 'apple_refund');
    this.hazard('v41_store_revocations(google,tx-orphan-revocation-1)', 'orphan-tombstone', 'Permanent revocation tombstone with no matching purchase receipt in state (expected explained category orphan-tombstone).');
    const notification = this.community.db.prepare('INSERT INTO v41_store_notifications(store,id,received_at) VALUES(?,?,?)');
    notification.run('google', 'notification-message-1', this.now - 3600000);
    notification.run('apple', 'notification-message-2', this.now - 1800000);
    const finalize = this.community.db.prepare('INSERT INTO v41_store_finalize(store,transaction_id,product_id,purchase_token,kind,state,attempts,next_at,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)');
    finalize.run('google', 'tx-google-crowns-525', 'crowns_525', 'purchase-token-fixture-1', 'acknowledge', 'pending', 1, this.now + 60000, this.now - 3600000, this.now - 1800000);
    finalize.run('google', 'tx-google-refunded-1100', 'crowns_1100', 'purchase-token-fixture-2', 'consume', 'done', 1, this.now - DAY, this.now - 2 * DAY, this.now - DAY);
    /* Permanent store bindings: minted once here, then copied verbatim by every later import. */
    this.bindingAlice = this.binding('alice-1');
    this.bindingBob = this.binding('bob_2');
    this.bindingKate = this.binding('kate-10');
  }

  binding(actor) { const value = this.bindings.get(actor); return { actor, googleAccountId: value.googleAccountId, appleAppAccountToken: value.appleAppAccountToken, created: value.created }; }

  /* ------------------------------------------------------------- phase: weekly/season/daily ---- */
  phaseWeekly() {
    const weekKey = '2026-09-28';
    const start = D.weekStart(weekKey);
    const end = start + 7 * DAY;
    /* Historic qualified-season shape (same construction the source test fixture uses) so the week
       can be published and paid for real, without fabricating a payment row. */
    this.patchState((state) => {
      const actor = new Map(state.accounts).get('weekly-1');
      actor.season = { id: D.season(this.now).id, startedAt: D.season(this.now).start, games: 6, queueGames: 4, opponents: ['kate-10', 'leo-11', 'mona-12'], wins: 4, losses: 2, draws: 0, peakRating: actor.rating, lastRatedAt: start + 3 * DAY, qualifiedAt: start + DAY };
      actor.lastRatedAt = start + 3 * DAY;
      actor.history = [0, 1, 2, 3, 4].map((i) => ({
        id: 'match-weekly-' + i, at: start + i * DAY + 3600000, rated: true, qualified: true, activityQualified: true,
        queue: i < 4, mode: 'ranked', opponent: ['kate-10', 'leo-11', 'mona-12'][i % 3], symbol: i % 2 ? 'O' : 'X',
        result: i < 4 ? 'win' : 'loss', reason: 'line', activeSeconds: 180, ratingDelta: i < 4 ? 12.5 : -12.5, casualDelta: 0,
      }));
      /* Seven archived daily snapshots for the closed week (historic observation rows). */
      for (let day = 0; day < 7; day += 1) state.snapshots.push([D.day(start + day * DAY), { 'weekly-1': 'gold' }]);
    });
    this.hazard('state.snapshots[2026-09-28..2026-10-04]', 'historic-observation-rows', 'Closed-week daily tier snapshots written as raw source text; the week payout itself is executed through the real operator weekly command.');
    this.setTime(end + 3600000);
    const payments = this.store.run(this.principal.operator, this.key('weekly'), { type: 'weekly', week: weekKey });
    if (!payments.length) fail('FIXTURE_WEEKLY_NOT_PAID');
    this.trace.push('weekly:paid=' + payments.length + ';amount=' + payments[0].amount + ';tier=' + payments[0].tier + ';days=' + payments[0].days);
    /* Current-week daily snapshots through the same real operator seam. */
    for (const date of ['2026-10-05', '2026-10-06', '2026-10-07']) {
      this.setTime(Date.parse(date + 'T01:00:00Z'));
      this.store.run(this.principal.operator, this.key('snapshot'), { type: 'snapshot' });
    }
  }

  /* ------------------------------------------------------------ phase: live reservations ---- */
  /* Three live paid encumbrances with DISJOINT actors plus two free room shapes, all near the capture
     clock, so every actor's reserved total has exactly one owner (no double counting). */
  phaseLive() {
    this.setTime(this.clockMs);

    /* Premium table: 10 joined players, all ready -> a real 200-Crown reservation each. */
    for (let i = 0; i < 10; i += 1) {
      this.rooms.run(this.principal.player('tour-' + i, 'tour-' + i), this.key('party'), { type: 'publicJoin', table: 'premium' });
    }
    const premiumRoom = JSON.parse(this.query("SELECT json FROM party_rooms WHERE json_extract(json,'$.table')='premium'").at(-1).json);
    if (premiumRoom.players.length !== 10) fail('FIXTURE_PREMIUM_SEATS');
    for (const player of premiumRoom.players) {
      this.rooms.run(this.principal.player(player.id, player.name), this.key('party'), { type: 'ready', id: premiumRoom.id, value: true, rulesVersion: premiumRoom.rulesVersion });
    }
    const premium = this.rooms.get(premiumRoom.id);
    if (premium.status !== 'RUNNING' || !premium.escrow) fail('FIXTURE_PREMIUM_RESERVE', premium.status);
    this.trace.push('premium:' + premium.id + ';escrow=' + premium.escrow + ';seats=' + premium.players.length + ';currency=' + premium.quote.currency);

    /* Free private duel (running) and a stale free lobby (paused by the source's free-room rule). */
    const duel = this.rooms.run(this.principal.player('eve5', 'eve5'), this.key('party'), { type: 'create', format: 'duel', name: 'Fixture duel' });
    this.rooms.run(this.principal.player('mona-12', 'mona-12'), this.key('party'), { type: 'join', id: duel.code });
    this.rooms.run(this.principal.player('eve5', 'eve5'), this.key('party'), { type: 'ready', id: duel.id, value: true, rulesVersion: duel.rulesVersion });
    this.rooms.run(this.principal.player('mona-12', 'mona-12'), this.key('party'), { type: 'ready', id: duel.id, value: true, rulesVersion: duel.rulesVersion });
    this.rooms.run(this.principal.player('eve5', 'eve5'), this.key('party'), { type: 'start', id: duel.id });

    /* Live paid queue match: two equal Coin contributions reserved, one authoritative move. */
    const queue = this.store.run(this.principal.matchmaker, this.key('queue'), { type: 'queue', id: 'match-live-queue-1', a: 'eve5', b: 'frank-6', mode: 'ranked' });
    this.store.run(this.principal.player('eve5'), this.key('accept'), { type: 'accept', id: 'match-live-queue-1', termsHash: queue.termsHash });
    this.store.run(this.principal.player('frank-6'), this.key('accept'), { type: 'accept', id: 'match-live-queue-1', termsHash: queue.termsHash });
    const live = this.store.read().matches.get('match-live-queue-1');
    this.store.run(this.principal.player(live.symbols.X), this.key('move'), { type: 'move', id: 'match-live-queue-1', revision: 0, move: { b: 4, c: 4 } });

    /* Live paid direct Crown challenge: challenger-funded, contributions [pool, 0]. */
    const direct = this.store.run(this.principal.player('alice-1'), this.key('offer'), { type: 'offer', id: 'match-live-direct-1', opponent: 'bob_2', terms: { kind: 'friend', amount: 20 } });
    this.store.run(this.principal.player('bob_2'), this.key('accept'), { type: 'accept', id: 'match-live-direct-1', termsHash: direct.termsHash });
    const directMatch = this.store.read().matches.get('match-live-direct-1');
    if (directMatch.status !== 'PLAYING' || !directMatch.escrow) fail('FIXTURE_DIRECT_LIVE');
    this.trace.push('direct:escrow=' + directMatch.escrow + ';contributions=' + JSON.stringify(directMatch.quote.contributions));

    /* One live OFFERED paid direct challenge (no escrow yet: reservation happens at final accept)
       and one live OFFERED free challenge, both with `expires` in the future at the capture clock. */
    this.store.run(this.principal.player('offr-1'), this.key('offer'), { type: 'offer', id: 'match-offered-1', opponent: 'offr-2', terms: { kind: 'leaderboard' } });
    this.store.run(this.principal.player('offr-3'), this.key('offer'), { type: 'offer', id: 'match-offered-2', opponent: 'offr-4', terms: { kind: 'friend', amount: 20, rated: false } });
  }

  /* -------------------------------------------------------------------- phase: inert rows ---- */
  phaseInertRows() {
    const insertSession = this.community.db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?,?,?)');
    insertSession.run(sha('sess-live-alice-1'), 'alice-1', 'csrf-alice-1', this.now - 3600000, this.now + 14 * DAY, this.now - 60000);
    insertSession.run(sha('sess-expired-bob-2'), 'bob_2', 'csrf-bob-2', this.now - 30 * DAY, this.now - 16 * DAY, this.now - 30 * DAY);
    insertSession.run(sha('sess-anonymous-1'), null, 'csrf-anonymous-1', this.now - 60000, this.now + DAY, 0);
    const insertPresence = this.community.db.prepare('INSERT INTO session_presence VALUES(?,?,?,?)');
    insertPresence.run(sha('sess-live-alice-1'), 'alice-1', this.now - 5000, 1);
    insertPresence.run(sha('sess-expired-bob-2'), 'bob_2', this.now - 20 * DAY, 0);

    const insertAttempt = this.community.db.prepare('INSERT INTO signin_attempts VALUES(?,?,?,?,?,?,?,?,?,?)');
    insertAttempt.run(sha('attempt-used-1'), sha('sess-live-alice-1'), 'google', 'native', 'link', 'alice-1', 'nonce-used-1', 'verifier-used-1', this.now + 300000, 1);
    insertAttempt.run(sha('attempt-open-1'), sha('sess-live-alice-1'), 'apple', 'native', 'link', 'alice-1', 'nonce-open-1', 'verifier-open-1', this.now + 300000, 0);

    const insertLimit = this.community.db.prepare('INSERT INTO community_limits VALUES(?,?)');
    for (const [bucket, hits] of [['social:alice-1:1', 4], ['search:bob_2:1', 11], ['edit:gina-3:1', 2]]) insertLimit.run(bucket, hits);
    const insertV4Limit = this.community.db.prepare('INSERT INTO v4_limits VALUES(?,?,?)');
    insertV4Limit.run('mail-budget:2026-10-08', 12, this.now + 40 * DAY);
    insertV4Limit.run('auth-address:' + sha256Short('alice.fixture@example.test').slice(0, 24), 3, this.now + 3600000);

    /* Durable ops control continuity: maintenance stays OFF and is never auto-enabled. */
    this.community.db.prepare('INSERT OR REPLACE INTO v4_controls VALUES(?,?)').run(1, 0);
    const insertRuntime = this.community.db.prepare('INSERT INTO v4_runtime VALUES(?,?)');
    insertRuntime.run('source_release', SOURCE_RELEASE);
    insertRuntime.run('schema_head', String(SCHEMA_HEAD));
    insertRuntime.run('fixture_variant', this.variant);

    /* Encrypted outbox rows: one queued (real AES-GCM sealed payload), one cancelled with a null
       payload, one failed after exhausting retries. */
    const insertOutbox = this.community.db.prepare('INSERT INTO v4_outbox(id,payload,kind,state,created,expires,next_at,lease_until,attempts) VALUES(?,?,?,?,?,?,?,?,?)');
    insertOutbox.run('outbox-queued-1', this.outbox.seal({ to: 'alice.fixture@example.test', code: '000000', purpose: 'verify-existing', idempotencyKey: 'mega-xo/v4/outbox-queued-1' }), 'otp', 'queued', this.now - 120000, this.now + 480000, this.now - 120000, 0, 0);
    insertOutbox.run('outbox-cancelled-1', null, 'security', 'cancelled', this.now - 2 * DAY, this.now - DAY, this.now - 2 * DAY, 0, 1);
    insertOutbox.run('outbox-failed-1', this.outbox.seal({ to: 'bob.fixture@example.test', event: 'email_changed', detail: 'Synthetic fixture notice' }), 'changed', 'failed', this.now - 3 * DAY, this.now - 2 * DAY, this.now - 2 * DAY, 0, 3);

    const insertSupport = this.community.db.prepare('INSERT INTO v41_support_events VALUES(?,?,?,?,?,?)');
    const supportRows = [['support-event-1', 'GET', '/livez', 200, ''], ['support-event-2', 'POST', '/api/account/session', 401, 'AUTH_REQUIRED'], ['support-event-3', 'GET', '/opsz', 503, 'STORAGE_DEGRADED']];
    supportRows.forEach(([id, method, route, status, code], index) => insertSupport.run(id, this.now - (supportRows.length - index) * 1000, method, route, status, code));

    /* Reports: one resolved by the operator (audit entry), one still open. */
    const resolved = this.community.report('gina-3', 'eve5', 'cheating', 'Synthetic fixture report detail');
    this.operator.resolveReport(resolved.id, 'action_taken', 'ops-fixture-1', 'Synthetic moderation resolution');
    this.community.report('hank-4', 'gina-3', 'unsportsmanlike', 'Synthetic open fixture report');

    /* LAN guest principals in the same source file (quarantined, never platform actors). */
    this.lan = new RoomStore(this.file, { lanOnly: true, now: () => this.now });
    const guestOne = this.lan.guest('Fixture Guest One');
    const guestTwo = this.lan.guest('Fixture Guest Two');
    this.guestActors = [guestOne.actor, guestTwo.actor];
    const lanRoom = this.lan.run(this.principal.player(guestOne.actor, guestOne.name), this.key('lan-party'), { type: 'create', format: 'duel', name: 'LAN fixture duel' });
    this.lan.run(this.principal.player(guestTwo.actor, guestTwo.name), this.key('lan-party'), { type: 'join', id: lanRoom.code });
    this.trace.push('lan:guests=' + this.guestActors.length + ';rooms=' + lanRoom.id.slice(0, 8) + '…');

    /* Practice archives: one historic opaque payload, one offline-match payload with extra keys. */
    const legacySave = D.fresh(this.now - 20 * DAY);
    legacySave.settings.theme = 'midnight';
    legacySave.settings.legacySoundFlag = true;
    legacySave.records = [{ id: 'practice-record-1', mode: 'bot', difficulty: 'Medium', result: 'win', reason: 'line', activeSeconds: 240.75, moves: 21, practice: true, claimed: 3 }];
    legacySave.legacy = { source: 'v3-archive', exportedAt: this.now - 400 * DAY, nested: { unknownLegacyKey: ['opaque', 1, true] } };
    legacySave.playSeconds = 12345.5;
    this.community.save('alice-1', 0, legacySave);
    const secondSave = D.fresh(this.now - 5 * DAY);
    secondSave.settings.theme = 'afterhours';
    secondSave.offlineMatch = { id: 'offline-1', first: 'X', mode: 'bot', difficulty: 'Hard', practice: true, moves: [{ b: 4, c: 4 }], active: true, turnLimit: 60, turnRemaining: 42, fixtureExtraField: 'kept' };
    secondSave.processed = ['practice-record-1'];
    this.community.save('gina-3', 0, secondSave);
    this.community.save('gina-3', 1, secondSave);
    this.advance(MINUTE);
  }

  /* ------------------------------------------------------------------ phase: variant patch ---- */
  patchRepresentative() {
    this.patchState((state) => {
      const accounts = Object.fromEntries(state.accounts);
      const alice = accounts['alice-1'];
      alice.owned = Array.from(new Set([...alice.owned, 'Orbit frame', 'Legacy Crown frame']));
      const jack = accounts['jack-5'];
      jack.monetization.redeemed = Array.from(new Set([...(jack.monetization.redeemed || []), 'aurora_frame', 'sunset_frame']));
      jack.monetization.equipped = 'aurora_frame';
      jack.monetization.boosts = [{ startedAt: this.now - 40 * MINUTE, endsAt: this.now - 30 * MINUTE }, ...(jack.monetization.boosts || [])];
      jack.monetization.lastAdAt = this.now - MINUTE;
      jack.monetization.lastRewardStart = this.now - 2 * MINUTE;
      /* Fractional active-seconds / expectedA semantics must survive extraction exactly. */
      const kate = accounts['kate-10'];
      const date = D.day(this.now);
      const daily = kate.daily[date] || (kate.daily[date] = { finished: 0, seconds: 0, boards: 0, casual: 0, friend: 0, ranked: 0, rankedBonus: 0, claimed: [] });
      daily.seconds = 214.75;
      daily.boards = 3;
    });
    this.hazard('state.accounts[*].monetization', 'archived-cosmetic-catalogue', 'redeemed/equipped reference frame ids outside the current classic-only catalogue and are preserved verbatim (archived, never re-enabled).');
    this.hazard('state.accounts[kate-10].daily[<utc date>].seconds', 'fractional-seconds', 'Fractional source number that must be copied exactly, never rounded.');
  }

  patchLegacy() {
    this.patchState((state) => {
      const accounts = Object.fromEntries(state.accounts);
      /* Exactly the fields `Authority.restore()` defensively defaults, i.e. the fields a pre-V3.5
         account row genuinely can lack: casualRating/casualGames (restore defaults a non-finite
         value), tournamentRecord/seasonHistory (restore creates them), purchasedCoins/purchasedCrowns
         (restore zeroes them and sets legacyCompetitionRestricted), and the lazily created
         `monetization` root (server/monetization-store.js state()). Fields that `addAccount()` always
         writes for every historic shape (peak/tier/reachedAt/owned) are deliberately kept. */
      const actor = accounts['legacy-1'];
      for (const field of ['casualRating', 'casualGames', 'tournamentRecord', 'seasonHistory', 'purchasedCoins', 'purchasedCrowns', 'purchaseInfluenced', 'legacyCompetitionRestricted', 'monetization']) delete actor[field];
      /* Prior-quarter season with a 9-entry seasonHistory (source limit is 8; raw text is kept whole). */
      const weekly = accounts['weekly-1'];
      weekly.season = { id: '2026-Q3', startedAt: Date.parse('2026-07-01T00:00:00Z'), games: 9, queueGames: 5, opponents: ['kate-10', 'leo-11', 'mona-12'], wins: 5, losses: 3, draws: 1, peakRating: weekly.rating + 30, lastRatedAt: Date.parse('2026-09-20T00:00:00Z'), qualifiedAt: Date.parse('2026-09-02T00:00:00Z') };
      weekly.seasonHistory = Array.from({ length: 9 }, (_, i) => ({ id: '2025-Q' + ((i % 4) + 1), startedAt: Date.parse('2025-01-01T00:00:00Z'), games: 5, queueGames: 3, opponents: ['kate-10'], wins: 3, losses: 2, draws: 0, peakRating: weekly.rating, lastRatedAt: null, qualifiedAt: null, finishRating: weekly.rating, finishTier: 'gold', endedAt: Date.parse('2026-01-01T00:00:00Z') }));
      /* Later-added match fields absent on older settled matches. */
      for (const [, match] of state.matches) {
        if (match.status === 'FINISHED' || match.status === 'VOID') {
          for (const field of ['_lastMoveAt', '_moveTimings', '_riskActors', 'preTiers', 'preRatings']) delete match[field];
        }
      }
      /* Archived product catalogue receipt (the source always writes `refunded`, so that field is
         kept); only the product id is outside the current catalogue. */
      state.receipts.push(['apple:tx-archived-crowns-9999', { actor: 'legacy-1', productId: 'crowns_9999', crowns: 9999, refunded: false, at: this.now - 300 * DAY }]);
    });
    this.hazard('state.accounts[legacy-1]', 'legacy-missing-optional', 'casualRating/casualGames/tournamentRecord/seasonHistory/purchasedCoins/purchasedCrowns/purchaseInfluenced/legacyCompetitionRestricted/monetization absent: exactly the fields Authority.restore() defensively defaults. H2 normalization deltas, never silently filled.');
    this.hazard('state.accounts[weekly-1].season', 'legacy-prior-quarter', 'season id 2026-Q3 with a 9-entry seasonHistory while the capture clock is 2026-Q4: the raw text must stay byte-identical (no season roll).');
    this.hazard('state.matches[*]', 'legacy-match-shape', '_lastMoveAt/_moveTimings/_riskActors/preRatings/preTiers absent on older settled matches.');
    this.hazard('state.receipts[apple:tx-archived-crowns-9999]', 'legacy-product-catalogue', 'Archived product id crowns_9999 outside the current catalogue: coverage review with explained category legacy-product-catalogue, never a drop.');
    this.hazard('profile_saves.payload', 'legacy-opaque', 'legacy root non-null with nested unknown keys and an extra settings flag; payload stays opaque, never authoritative.');
    this.hazard('party_rooms(free private room)', 'legacy-free-room', 'Free private duel without table/quote/escrow/contributions.');
  }

  patchUnknownField() {
    const locatorNames = [
      'state.legacyRootUnknown',
      'state.accounts[gina-3].unknownProfileFlag',
      'state.matches[match-live-queue-1].terms.unknownTermsKey',
      'state.accounts[jack-5].monetization.daily[<utc date>].unknownNestedKey',
    ];
    this.patchState((state) => {
      state.legacyRootUnknown = { importedFrom: 'v3.2', note: 'unknown root kept verbatim' };
      const accounts = Object.fromEntries(state.accounts);
      accounts['gina-3'].unknownProfileFlag = { value: true };
      const jack = accounts['jack-5'];
      const date = D.day(this.now);
      jack.monetization.daily[date] = { ...(jack.monetization.daily[date] || { base: 0, bonus: 0, automatic: 0 }), unknownNestedKey: 'unknown' };
      for (const [, match] of state.matches) if (match.id === 'match-live-queue-1') match.terms.unknownTermsKey = 17;
    });
    return locatorNames.map((locator) => {
      const entry = { locator, kind: 'unknown-field', note: 'Unknown source field: extraction must refuse by default with this locator and never discard the value.' };
      this.hazards.push(entry);
      return entry;
    });
  }

  patchUnsafeAsset() {
    const locators = [];
    const add = (locator, kind, note) => { locators.push({ locator, kind, note }); this.hazard(locator, kind, note); };
    this.patchState((state, raw) => {
      const accounts = Object.fromEntries(state.accounts);
      const alice = accounts['alice-1'];
      alice.crowns = raw('10.5');
      add('state.accounts[alice-1].crowns', 'non-integer-money', 'Fractional Crown balance: must be refused, never rounded.');
      alice.coins = raw('9007199254740993');
      add('state.accounts[alice-1].coins', 'unsafe-integer', 'Coin balance beyond Number.MAX_SAFE_INTEGER: must be refused, never rounded.');
      alice.rating = raw('1e400');
      add('state.accounts[alice-1].rating', 'non-finite', 'Numeric literal that parses to Infinity: must be refused.');
      alice.owned = [...(alice.owned || []), '../escape/asset', 42, '__proto__'];
      add('state.accounts[alice-1].owned', 'unsafe-asset-reference', 'Path-like, non-string and prototype-like asset entries: must be refused as unsafe assets.');
      const jack = accounts['jack-5'];
      jack.monetization.credits = -1;
      add('state.accounts[jack-5].monetization.credits', 'negative-credit', 'Negative cosmetic credit balance: must be refused.');
      jack.monetization.boosts = [{ startedAt: this.now - MINUTE, endsAt: raw('1791461000000.5') }];
      add('state.accounts[jack-5].monetization.boosts[0].endsAt', 'non-integer-timestamp', 'Fractional boost end timestamp: must be refused.');
    });
    return locators;
  }

  /* ---------------------------------------------------------------------------- coherence ---- */

  verifyCoherence(state, rooms, tables) {
    /* Raw source text round-trips entry-array roots as [key,value] pairs; normalize for analysis. */
    const accounts = new Map(state.accounts);
    const matches = new Map(state.matches);
    const snapshots = new Map(state.snapshots);
    const weeklyPaid = new Map(state.weeklyPaid);
    const openMatches = [...matches.values()].filter((m) => m.escrow > 0 && !m.settled);
    const openRooms = rooms.map((r) => r.room).filter((r) => r.escrow > 0 && !r.settled);

    /* C2 reserved-closure: per actor and currency, reserved must equal the sum of exactly the open
       match/room contributions. This is the no-double-counting check. */
    const reserved = { coins: new Map(), crowns: new Map() };
    for (const match of openMatches) {
      const currency = match.quote?.currency;
      if (!currency) continue;
      match.players.forEach((id, index) => {
        const amount = match.quote.contributions[index];
        if (amount) reserved[currency].set(id, (reserved[currency].get(id) || 0) + amount);
      });
    }
    for (const room of openRooms) {
      for (const contribution of room.contributions || []) reserved[room.quote.currency].set(contribution.id, (reserved[room.quote.currency].get(contribution.id) || 0) + contribution.amount);
    }
    const closure = [];
    for (const [id, actor] of accounts) {
      for (const [currency, field] of [['coins', 'reservedCoins'], ['crowns', 'reservedCrowns']]) {
        const derived = reserved[currency].get(id) || 0;
        const actual = actor[field] || 0;
        closure.push({ actor: id, currency, actual, derived, residual: actual - derived });
        if (actual !== derived) fail('FIXTURE_RESERVED_CLOSURE', id + '/' + currency + ' actual=' + actual + ' derived=' + derived);
      }
    }

    /* C7 occupancy: every actor has at most one target, every target's actor set is exactly the
       documented owner set (a match owns exactly its two players; a tournament room owns exactly its
       contributors), and no actor is claimed by two different live entities. */
    const occupancy = new Map();
    for (const [id, actor] of accounts) {
      if (!actor.activeMatch) continue;
      occupancy.set(actor.activeMatch, [...(occupancy.get(actor.activeMatch) || []), id]);
    }
    for (const match of openMatches) {
      /* An open (escrow-bearing) match is always PLAYING: both players must have accepted it. */
      if (match.status !== 'PLAYING') fail('FIXTURE_MATCH_OPEN_NOT_PLAYING', match.id + ' status=' + match.status);
      for (const player of match.players) if (!match.accepted.includes(player)) fail('FIXTURE_MATCH_ACCEPTED', match.id + '/' + player);
      for (const player of match.players) if (accounts.get(player)?.activeMatch !== match.id) fail('FIXTURE_OCCUPANCY_MATCH', match.id + '/' + player);
      const owners = (occupancy.get(match.id) || []).slice().sort();
      const expected = match.players.slice().sort();
      if (owners.join(',') !== expected.join(',')) fail('FIXTURE_OCCUPANCY_MATCH_OWNERS', match.id + ' owners=' + owners.join(',') + ' players=' + expected.join(','));
    }
    for (const room of openRooms) {
      const contributors = (room.contributions || []).map((c) => c.id).sort();
      for (const id of contributors) if (accounts.get(id)?.activeMatch !== 'tournament:' + room.id) fail('FIXTURE_OCCUPANCY_ROOM', room.id + '/' + id);
      const owners = (occupancy.get('tournament:' + room.id) || []).slice().sort();
      if (owners.join(',') !== contributors.join(',')) fail('FIXTURE_OCCUPANCY_ROOM_OWNERS', room.id + ' owners=' + owners.join(',') + ' contributors=' + contributors.join(','));
    }
    /* Every occupancy target must belong to a live (open) entity - no dangling activeMatch. */
    const liveTargets = new Set([...openMatches.map((m) => m.id), ...openRooms.map((r) => 'tournament:' + r.id)]);
    for (const [target, actors] of occupancy) if (!liveTargets.has(target)) fail('FIXTURE_OCCUPANCY_DANGLING', target + ' actors=' + actors.join(','));

    /* C3 burn composition and C5 pool algebra over every settled entity. */
    let burnedFromMatches = 0;
    let burnedFromRooms = 0;
    for (const match of matches.values()) {
      if (match.escrow > 0 && match.quote?.currency && match.escrow !== match.quote.pool) fail('FIXTURE_MATCH_POOL', match.id);
      if (match.receipt && match.settled && match.receipt.currency === 'coins') burnedFromMatches += match.receipt.burn || 0;
    }
    for (const room of rooms.map((r) => r.room)) {
      if (room.escrow > 0 && room.quote && room.escrow !== room.quote.pool) fail('FIXTURE_ROOM_POOL', room.id);
      if (room.receipt && room.settled && room.receipt.currency === 'coins') burnedFromRooms += room.receipt.burn || 0;
      if (room.receipt && !room.receipt.refunded) {
        const payouts = room.receipt.payouts.reduce((sum, p) => sum + p.amount, 0);
        if (payouts + room.receipt.burn !== room.quote.pool) fail('FIXTURE_ROOM_PAYOUT_SUM', room.id);
        if (!room.ranking || new Set(room.ranking).size !== 10) fail('FIXTURE_ROOM_RANKING', room.id);
      }
    }
    const burnResidual = { coins: state.burned.coins - (burnedFromMatches + burnedFromRooms), crowns: state.burned.crowns };
    if (burnResidual.coins !== 0 || burnResidual.crowns !== 0) fail('FIXTURE_BURN_RESIDUAL', JSON.stringify(burnResidual));

    /* C8 friendship symmetry. */
    for (const [id, actor] of accounts) for (const friend of actor.friends || []) if (!accounts.get(friend)?.friends?.includes(id)) fail('FIXTURE_FRIENDSHIP_ASYMMETRIC', id + '<->' + friend);

    /* C9 every referenced principal resolves to an account, a deletion tombstone, a LAN guest, or
       the source's own `system` journal sentinel used by match burns (`src/authority.js` _settle). */
    const tombstones = new Set(this.query('SELECT tombstone FROM v41_deletion_receipts').map((r) => r.tombstone));
    const guests = new Set(this.query('SELECT actor FROM party_guests').map((r) => r.actor));
    const sentinels = new Set(['system']);
    const isPrincipal = (id) => accounts.has(id) || tombstones.has(id) || guests.has(id) || sentinels.has(id);
    const unresolved = [];
    const noteRef = (id, where) => { if (typeof id === 'string' && !isPrincipal(id)) unresolved.push(where + '=' + id); };
    for (const [id, actor] of accounts) {
      for (const entry of actor.history || []) noteRef(entry.opponent, id + '.history[].opponent');
      for (const entry of actor.season?.opponents || []) noteRef(entry, id + '.season.opponents');
      for (const season of actor.seasonHistory || []) for (const entry of season.opponents || []) noteRef(entry, id + '.seasonHistory[].opponents');
      for (const entry of actor.friends || []) noteRef(entry, id + '.friends[]');
      for (const entry of actor.friendRequests || []) noteRef(entry, id + '.friendRequests[]');
      for (const entry of actor.blocked || []) noteRef(entry, id + '.blocked[]');
    }
    for (const match of matches.values()) {
      for (const player of [...(match.players || []), ...(match.accepted || [])]) noteRef(player, match.id + '.players');
      for (const symbol of Object.values(match.symbols || {})) noteRef(symbol, match.id + '.symbols');
      if (match.receipt?.winner) noteRef(match.receipt.winner, match.id + '.receipt.winner');
    }
    for (const room of rooms.map((r) => r.room)) {
      for (const player of room.players || []) noteRef(player.id, room.id + '.players');
      for (const id of room.ranking || []) noteRef(id, room.id + '.ranking');
      for (const contribution of room.contributions || []) noteRef(contribution.id, room.id + '.contributions[]');
    }
    for (const entry of state.journal) noteRef(entry.actor, 'journal.actor');
    for (const [, payment] of weeklyPaid) noteRef(payment.account, 'weeklyPaid.account');
    for (const [date, tiers] of snapshots) for (const id of Object.keys(tiers)) noteRef(id, 'snapshots[' + date + ']');
    if (unresolved.length) fail('FIXTURE_UNRESOLVED_PRINCIPAL', unresolved.slice(0, 6).join(','));

    /* Money safety is asserted on the importable variants only (corruption variants must fail). */
    if (this.variant === 'representative' || this.variant === 'legacy') {
      const integer = D.integer;
      for (const [id, actor] of accounts) {
        for (const field of ['coins', 'crowns', 'reservedCoins', 'reservedCrowns']) {
          if (!Number.isSafeInteger(actor[field])) fail('FIXTURE_UNSAFE_BALANCE', id + '.' + field);
          integer(actor[field], 'FIXTURE_BALANCE');
        }
      }
      if (!Number.isSafeInteger(state.burned.coins) || !Number.isSafeInteger(state.burned.crowns)) fail('FIXTURE_UNSAFE_BURN');
    }

    return {
      reservedClosure: closure,
      burnResidual,
      openMatchEscrows: openMatches.map((m) => ({ id: m.id, currency: m.quote.currency, escrow: m.escrow, contributions: m.quote.contributions, players: m.players })),
      openRoomEscrows: openRooms.map((r) => ({ id: r.id, table: r.table, currency: r.quote.currency, escrow: r.escrow, contributions: r.contributions, seats: r.players.length })),
      occupancy: [...occupancy].flatMap(([target, ids]) => ids.map((actor) => ({ actor, target }))),
      principals: { accounts: accounts.size, tombstones: [...tombstones], guests: [...guests].sort(), sentinels: [...sentinels] },
      tables,
    };
  }

  /* ------------------------------------------------------------------------------ expected ---- */

  expected(coherence, rooms) {
    const state = this.readState();
    const accounts = new Map(state.accounts);
    const matches = new Map(state.matches);
    const snapshots = new Map(state.snapshots);
    const weeklyPaid = new Map(state.weeklyPaid);
    const balances = [...accounts].map(([id, actor]) => ({
      actor: id, coins: actor.coins, crowns: actor.crowns, reservedCoins: actor.reservedCoins,
      reservedCrowns: actor.reservedCrowns, purchasedCoins: actor.purchasedCoins ?? null,
      purchasedCrowns: actor.purchasedCrowns ?? null, credits: actor.monetization?.credits ?? 0,
      hold: actor.hold === true, suspended: actor.suspended === true, verified: actor.verified === true,
      activeMatch: actor.activeMatch ?? null, rating: actor.rating, games: actor.games,
      wealth: Number.isSafeInteger(actor.coins) && Number.isSafeInteger(actor.crowns) ? D.wealth(actor) : null,
    })).sort((a, b) => a.actor.localeCompare(b.actor));
    const totals = balances.reduce((sum, row) => ({
      coins: sum.coins + (Number.isSafeInteger(row.coins) ? row.coins : 0),
      crowns: sum.crowns + (Number.isSafeInteger(row.crowns) ? row.crowns : 0),
      reservedCoins: sum.reservedCoins + (Number.isSafeInteger(row.reservedCoins) ? row.reservedCoins : 0),
      reservedCrowns: sum.reservedCrowns + (Number.isSafeInteger(row.reservedCrowns) ? row.reservedCrowns : 0),
    }), { coins: 0, crowns: 0, reservedCoins: 0, reservedCrowns: 0 });

    const commandIds = this.query('SELECT id FROM commands').map((r) => r.id);
    const partyIds = this.query('SELECT id FROM party_commands').map((r) => r.id);
    const socialIds = this.query('SELECT id FROM social_operations').map((r) => r.id);
    const v35Ids = this.query('SELECT actor,key FROM v35_commands').map((r) => r.actor + '/' + r.key);
    let moveCommands = 0;
    const matchesWithCommands = [];
    for (const [id, match] of matches) {
      const count = Array.isArray(match.commands) ? match.commands.length : 0;
      if (count) { moveCommands += count; matchesWithCommands.push(id); }
    }
    const outcome = (count, ids) => ({ count, idsSha256: sha256(sorted(ids)), ids: sorted(ids) });
    const byStatus = (values, key) => values.reduce((acc, value) => ({ ...acc, [value[key]]: (acc[value[key]] || 0) + 1 }), {});

    return {
      variant: this.variant,
      restricted: true,
      synthetic: true,
      clockMs: this.clockMs,
      sourceRelease: { sha: SOURCE_SHA, release: SOURCE_RELEASE, schemaHead: SCHEMA_HEAD },
      schema: { tables: SOURCE_TABLES.length, indexes: SOURCE_INDEXES, triggers: SOURCE_TRIGGERS, views: 0, journalMode: 'wal' },
      tables: coherence.tables,
      stateRoots: Object.keys(state).sort(),
      actors: balances.map((row) => row.actor),
      balances,
      totals,
      bindings: { 'alice-1': this.bindingAlice, 'bob_2': this.bindingBob, 'kate-10': this.bindingKate },
      reservations: {
        reservedClosureResiduals: coherence.reservedClosure.filter((row) => row.actual || row.derived),
        openMatchEscrows: coherence.openMatchEscrows,
        openRoomEscrows: coherence.openRoomEscrows,
        occupancy: coherence.occupancy,
      },
      matches: [...matches].map(([id, match]) => ({
        id, status: match.status, players: match.players, settled: match.settled,
        currency: match.quote?.currency ?? null, escrow: match.escrow,
        contributions: match.quote?.contributions ?? null, pool: match.quote?.pool ?? null,
        terms: match.terms ? { source: match.terms.source, mode: match.terms.mode, kind: match.terms.kind, rated: match.terms.rated, amount: match.terms.amount, currency: match.terms.currency, turnSeconds: match.terms.turnSeconds } : null,
        commandCount: Array.isArray(match.commands) ? match.commands.length : 0,
        receipt: match.receipt ? {
          winner: match.receipt.winner ?? null, reason: match.receipt.reason, currency: match.receipt.currency,
          payout: match.receipt.payout, burn: match.receipt.burn, bonus: match.receipt.bonus, refunded: match.receipt.refunded,
          rating: match.receipt.rating ? { a: match.receipt.rating.a, b: match.receipt.rating.b, delta: match.receipt.rating.delta, expectedA: match.receipt.rating.expectedA } : null,
        } : null,
      })).sort((a, b) => a.id.localeCompare(b.id)),
      matchesByStatus: byStatus([...matches.values()], 'status'),
      rooms: rooms.map(({ id, code, room }) => ({
        id, code, status: room.status, table: room.table ?? null, seats: room.players.length,
        escrow: room.escrow ?? null, settled: room.settled ?? null, currency: room.quote?.currency ?? null,
        contributions: room.contributions ?? null, ranking: room.ranking ?? null, receipt: room.receipt ?? null,
        fixtureCount: room.fixtures.length, fixtureStatuses: byStatus(room.fixtures, 'status'),
      })).sort((a, b) => a.id.localeCompare(b.id)),
      roomsByStatus: byStatus(rooms.map((r) => r.room), 'status'),
      receipts: [...state.receipts].map(([key, receipt]) => ({
        key, actor: receipt.actor, productId: receipt.productId, crowns: receipt.crowns,
        refunded: receipt.refunded === true, hasAt: Number.isSafeInteger(receipt.at),
      })).sort((a, b) => a.key.localeCompare(b.key)),
      journal: {
        count: state.journal.length,
        bySource: state.journal.reduce((acc, row) => ({ ...acc, [row.source]: (acc[row.source] || 0) + 1 }), {}),
        burned: { ...state.burned },
        burnResidual: coherence.burnResidual,
        conversionEntries: state.journal.filter((row) => row.source === 'conversion').length,
        entriesSha256: sha256(state.journal),
      },
      outcomes: {
        economy: outcome(commandIds.length, commandIds),
        party: outcome(partyIds.length, partyIds),
        social: outcome(socialIds.length, socialIds),
        v35: outcome(v35Ids.length, v35Ids),
        matchMove: { matches: sorted(matchesWithCommands), commands: moveCommands },
      },
      credentials: this.query('SELECT actor,email,salt,password_hash,created,verified_at FROM email_credentials ORDER BY actor').map((row) => ({
        actor: row.actor,
        emailNormalizedSha256: sha256Short(row.email.trim().toLowerCase()),
        saltSha256: sha256Short(row.salt),
        passwordHashSha256: sha256Short(row.password_hash),
        passwordHashScheme: row.password_hash.startsWith('scrypt-v1$') ? 'scrypt-v1' : 'legacy-scrypt',
        verified: row.verified_at !== null, created: row.created, verifiedAt: row.verified_at,
      })),
      identities: this.query('SELECT provider,subject,actor,created FROM identities ORDER BY actor,provider').map((row) => ({ actor: row.actor, provider: row.provider, subjectSha256: sha256Short(row.subject), subjectLength: row.subject.length, created: row.created })),
      saves: this.query('SELECT actor,revision,updated,payload FROM profile_saves ORDER BY actor').map((row) => ({
        actor: row.actor, revision: row.revision, updated: row.updated,
        payloadSha256: sha256Short(row.payload), payloadBytes: Buffer.byteLength(row.payload),
        payloadRoots: Object.keys(JSON.parse(row.payload)).sort(),
      })),
      seasons: [...accounts].map(([id, actor]) => ({
        actor: id,
        season: actor.season ? { id: actor.season.id, games: actor.season.games ?? 0, queueGames: actor.season.queueGames ?? 0, opponents: actor.season.opponents?.length ?? 0, peakRating: actor.season.peakRating ?? null, lastRatedAt: actor.season.lastRatedAt ?? null } : null,
        seasonHistoryEntries: Array.isArray(actor.seasonHistory) ? actor.seasonHistory.length : null,
        seasonHistorySha256: Array.isArray(actor.seasonHistory) ? sha256(actor.seasonHistory) : null,
        historyEntries: Array.isArray(actor.history) ? actor.history.length : 0,
        lastRatedAt: actor.lastRatedAt ?? null,
        tournamentRecord: actor.tournamentRecord ? { ...actor.tournamentRecord } : null,
      })).sort((a, b) => a.actor.localeCompare(b.actor)).filter((row) => row.season || row.seasonHistoryEntries !== null || row.historyEntries),
      daily: [...accounts].flatMap(([id, actor]) => Object.entries(actor.daily || {}).map(([date, value]) => ({ actor: id, date, finished: value.finished, seconds: value.seconds, boards: value.boards, ranked: value.ranked, claimed: value.claimed }))),
      weekly: {
        leagueWeek: state.leagueWeek,
        snapshotDates: [...snapshots.keys()].sort(),
        snapshotAccounts: [...snapshots.keys()].sort().reduce((acc, date) => ({ ...acc, [date]: Object.keys(snapshots.get(date)).sort() }), {}),
        weeklyPaid: [...weeklyPaid].map(([key, payment]) => ({ key, account: payment.account, week: payment.week, amount: payment.amount, tier: payment.tier, days: payment.days })).sort((a, b) => a.key.localeCompare(b.key)),
      },
      cosmetics: [...accounts].map(([id, actor]) => ({
        actor: id, owned: (actor.owned || []).slice().sort(), equipped: actor.monetization?.equipped ?? null,
        redeemed: (actor.monetization?.redeemed || []).slice().sort(), credits: actor.monetization?.credits ?? null,
        boosts: actor.monetization?.boosts ?? [], dailyAd: actor.monetization?.daily ?? {},
        lastAdAt: actor.monetization?.lastAdAt ?? null, lastRewardStart: actor.monetization?.lastRewardStart ?? null,
      })).filter((row) => row.owned.length || row.equipped !== null || row.redeemed.length || row.boosts.length || row.credits !== null),
      tickets: this.query('SELECT id,actor,kind,issued,expires,day,settled,transaction_id FROM v35_tickets ORDER BY id').map((row) => ({ ...row, settled: row.settled === 1, expired: row.expires <= this.clockMs })),
      casualCredits: this.query('SELECT actor,match_id,base,bonus FROM v35_casual ORDER BY actor,match_id'),
      adContexts: this.query('SELECT ticket,platform,ad_unit FROM v41_ad_ticket_context ORDER BY ticket'),
      revocations: this.query('SELECT store,transaction_id,product_id,occurred_at,reason FROM v41_store_revocations ORDER BY store,transaction_id'),
      notifications: this.query('SELECT store,id,received_at FROM v41_store_notifications ORDER BY store,id'),
      finalize: this.query('SELECT store,transaction_id,product_id,kind,state,attempts,next_at FROM v41_store_finalize ORDER BY transaction_id'),
      deletions: {
        receipts: this.query('SELECT id,actor_hash,tombstone,completed_at,policy_version FROM v41_deletion_receipts ORDER BY id'),
        privacyRequests: this.query('SELECT id,actor,kind,state,policy_version FROM v41_privacy_requests ORDER BY id'),
        journalTombstoneRefs: state.journal.filter((row) => typeof row.actor === 'string' && row.actor.startsWith('deleted_')).length,
      },
      audit: this.operator.verifyAudit(),
      reports: this.query('SELECT id,reporter,target,category,state,outcome,reviewed_by FROM v41_reports ORDER BY id'),
      providers: this.query('SELECT actor,provider FROM identities ORDER BY actor,provider').reduce((acc, row) => ({ ...acc, [row.actor]: [...(acc[row.actor] || []), row.provider] }), {}),
      inert: {
        outbox: this.query("SELECT id,kind,state,expires,next_at,lease_until,attempts,length(CAST(payload AS BLOB)) payloadBytes FROM v4_outbox ORDER BY id"),
        challenges: this.query('SELECT id,purpose,actor,consumed,verified_at,expires FROM email_challenges ORDER BY id').map((row) => ({ ...row, expired: row.expires <= this.clockMs })),
        emailVersions: this.query('SELECT challenge,credential_hash FROM v4_email_versions ORDER BY challenge').map((row) => ({ challenge: row.challenge, credentialHashPresent: row.credential_hash !== null })),
        sessions: this.query('SELECT token,actor,created,expires,auth_at FROM account_sessions ORDER BY token').map((row) => ({ tokenSha256: sha256Short(row.token), actor: row.actor, created: row.created, expires: row.expires, authAt: row.auth_at, linked: row.actor !== null, expired: row.expires <= this.clockMs })),
        presence: this.query('SELECT session,actor,seen,foreground FROM session_presence ORDER BY session').map((row) => ({ sessionSha256: sha256Short(row.session), actor: row.actor, seen: row.seen, foreground: row.foreground === 1 })),
        attempts: this.query('SELECT state,provider,kind,intent,target,used,expires FROM signin_attempts ORDER BY state').map((row) => ({ ...row, stateSha256: sha256Short(row.state), used: row.used === 1, expired: row.expires <= this.clockMs })),
        limits: this.query('SELECT id,hits FROM community_limits ORDER BY id'),
        v4Limits: this.query('SELECT id,hits,expires FROM v4_limits ORDER BY id'),
        guests: this.query('SELECT token,actor,name,expires FROM party_guests ORDER BY actor').map((row) => ({ tokenSha256: sha256Short(row.token), actor: row.actor, name: row.name, expires: row.expires })),
        controls: this.query('SELECT id,maintenance FROM v4_controls'),
        runtime: this.query('SELECT key,value FROM v4_runtime ORDER BY key'),
        supportEvents: this.query('SELECT id,at,method,route,status,code FROM v41_support_events ORDER BY id'),
        schema: this.query('SELECT id,name,checksum FROM v4_schema ORDER BY id').map((row) => ({ id: row.id, name: row.name, checksum: row.checksum, checksumMatches: row.checksum === migrationChecksum(migrations[row.id - 1]) })),
      },
      principals: coherence.principals,
      rawStateSha256: sha256Short(this.rawState()),
    };
  }

  limitationsList() {
    return [
      'Synthetic only. No provider, device, platform-store, AdMob or production data is involved and no network call is made. Verified-purchase/ad-grant rows are applied in-process and flagged as `synthetic-provider-outcome`; they are NOT platform verification proof.',
      'This module builds SOURCE fixtures only: it performs no capture, no snapshot, no extraction and no import. The parent owns capture (tools/v5-migration/capture.js) and the CLI smoke; the capture must consume an immutable snapshot, never this live fixture file.',
      'Actor ids are deterministic synthetic text (for example `alice-1`, `tour-0`) and deliberately non-UUID, so text fidelity must be preserved rather than cast to UUID.',
      'The live paid queue match, live paid direct challenge and live premium tournament are captured mid-flight near the capture clock; a real production recover() would void them, which is exactly the hazard this fixture must survive unchanged.',
      'Archived cosmetic ids, the current catalogue-external frame references, the 9-entry seasonHistory, the archived product receipt and the closed-week snapshot rows are deliberate historic shapes written by a pre-capture raw patch, because no current constructor produces them.',
      'Timestamps are compressed: all history fits inside 26 days before clockMs. Weekly/quarter boundaries exercised are 2026-09-28 and 2026-Q4 (capture clock 2026-10-08T12:00:00Z).',
      '`expected` carries synthetic balances, ids and credential HASHES only - never emails, salts, password hashes or row dumps - and is restricted output; do not publish it as phase evidence.',
      'MonetizationStore.purchase/callback are async (remote verification) and are intentionally not invoked by this synchronous builder; their verified effects are applied with the exact source formulas and flagged in `hazards`.',
      'The `legacy` variant models pre-V3.5 absence (restore-defaulted fields simply absent) and reads cleanly against the current mapping; if a consumer marks those fields required it will refuse there, which is the intended signal rather than a fixture defect.',
      ...(this.variant === 'unknown-field' || this.variant === 'unsafe-asset'
        ? ['This variant deliberately corrupts the source. Extraction and reconciliation MUST REFUSE it by default at the locators listed in `expected.refusal`; it is not an importable fixture.']
        : []),
    ];
  }

  checkpoint() {
    if (this.lan) { this.lan.close(); this.lan = null; }
    this.rooms.close();
    this.store.close();
    const db = new DatabaseSync(this.file);
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
  }
}

/* ---------------------------------------------------------------------------- public API ---- */

function prepareDirectory(directory) {
  if (typeof directory !== 'string' || !directory) fail('FIXTURE_DIRECTORY_REQUIRED');
  const resolved = path.resolve(directory);
  if (fs.existsSync(resolved)) {
    if (!fs.statSync(resolved).isDirectory()) fail('FIXTURE_DIRECTORY_NOT_A_DIRECTORY', resolved);
    if (fs.readdirSync(resolved).length) fail('FIXTURE_DIRECTORY_NOT_EMPTY', resolved);
  } else {
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  }
  return resolved;
}

function buildSyntheticSource({ directory, clockMs = DEFAULT_CLOCK_MS, variant = 'representative' } = {}) {
  if (!VARIANTS.includes(variant)) fail('UNKNOWN_FIXTURE_VARIANT', String(variant));
  if (!Number.isSafeInteger(clockMs) || clockMs <= 0) fail('INVALID_FIXTURE_CLOCK');
  const resolved = prepareDirectory(directory);
  const file = path.join(resolved, 'mega-source-' + variant + '.sqlite');
  if (fs.existsSync(file)) fail('FIXTURE_ALREADY_EXISTS', file);

  return withDeterministicEntropy(variant, clockMs, () => {
    const fixture = new Fixture({ directory: resolved, clockMs, variant });
    let layout = null;
    try {
      fixture.open();
      fixture.phaseIdentityAndSocial();
      fixture.phaseCompletedTournament();
      fixture.phaseFinishedRankedMatch();
      fixture.phaseUnsettledOffers();
      fixture.phaseTimeoutMatch();
      fixture.phaseVoidedMatch();
      fixture.phaseDrawnMatch();
      fixture.phaseDeletion();
      fixture.phaseEconomy();
      fixture.phaseMonetization();
      fixture.phaseStoreRows();
      fixture.phaseWeekly();
      fixture.phaseLive();
      fixture.phaseInertRows();

      /* Corruption/legacy patches are applied to the RAW source before any capture; no reader has run
         in this process and none can, because the generator never imports one. */
      let refusal = null;
      if (variant === 'representative') fixture.patchRepresentative();
      if (variant === 'legacy') { fixture.patchRepresentative(); fixture.patchLegacy(); }
      if (variant === 'unknown-field') { fixture.patchRepresentative(); refusal = { kind: 'unknown-field', locators: fixture.patchUnknownField() }; }
      if (variant === 'unsafe-asset') { fixture.patchRepresentative(); refusal = { kind: 'unsafe-asset', locators: fixture.patchUnsafeAsset() }; }

      const namedIndexes = fixture.query("SELECT count(*) n FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex%'")[0].n;
      const triggerCount = fixture.query("SELECT count(*) n FROM sqlite_master WHERE type='trigger'")[0].n;
      const viewCount = fixture.query("SELECT count(*) n FROM sqlite_master WHERE type='view'")[0].n;
      const tableList = fixture.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name);
      const tableCounts = {};
      for (const name of tableList) tableCounts[name] = fixture.query('SELECT count(*) n FROM "' + name + '"')[0].n;
      layout = { tables: tableList.length, indexes: namedIndexes, triggers: triggerCount, views: viewCount, schemaHead: SCHEMA_HEAD, journalMode: 'wal' };
      if (layout.tables !== SOURCE_TABLES.length || layout.indexes !== SOURCE_INDEXES || layout.triggers !== SOURCE_TRIGGERS || layout.views !== 0) fail('FIXTURE_SCHEMA_INCOMPLETE', JSON.stringify(layout));
      const missing = SOURCE_TABLES.filter((name) => !tableList.includes(name));
      if (missing.length) fail('FIXTURE_SCHEMA_MISSING_TABLES', missing.join(','));

      const rooms = fixture.readRooms();
      const state = fixture.readState();
      const rootKeys = Object.keys(state).sort();
      if (variant !== 'unsafe-asset') {
        for (const root of STATE_ROOTS) if (!rootKeys.includes(root)) fail('FIXTURE_MISSING_STATE_ROOT', root);
      }
      const coherence = fixture.verifyCoherence(state, rooms, tableCounts);
      const expected = fixture.expected(coherence, rooms);
      if (refusal) expected.refusal = refusal;

      fixture.checkpoint();
      const sourceFileSha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      expected.hashes = { sourceFileSha256, rawStateSha256: expected.rawStateSha256, sourceFileBytes: fs.statSync(file).size };
      if (fixture.now !== fixture.clockMs) fail('FIXTURE_CLOCK_NOT_SETTLED', String(fixture.now));

      return {
        file,
        directory: resolved,
        variant,
        clockMs,
        sourceRelease: { sha: SOURCE_SHA, release: SOURCE_RELEASE, schemaHead: SCHEMA_HEAD },
        layout: { ...layout, file },
        expected,
        hazards: fixture.hazards,
        limitations: fixture.limitationsList(),
        trace: fixture.trace,
      };
    } finally {
      try { if (fixture.lan) fixture.lan.close(); } catch {}
      try { if (fixture.rooms) fixture.rooms.close(); } catch {}
      try { if (fixture.store) fixture.store.close(); } catch {}
    }
  });
}

/* Builds all four variants into their own sub-directory of one caller-owned EMPTY directory. */
function buildAllSyntheticSources({ directory, clockMs = DEFAULT_CLOCK_MS } = {}) {
  const resolved = prepareDirectory(directory);
  const out = {};
  for (const variant of VARIANTS) {
    const target = path.join(resolved, variant);
    fs.mkdirSync(target, { mode: 0o700 });
    out[variant] = buildSyntheticSource({ directory: target, clockMs, variant });
  }
  return out;
}

module.exports = { buildSyntheticSource, buildAllSyntheticSources, VARIANTS, SOURCE_TABLES, STATE_ROOTS, DEFAULT_CLOCK_MS, SOURCE_SHA, SOURCE_RELEASE };

/* Direct smoke build: prints counts, locators and hashes only - never rows, emails or credentials. */
if (require.main === module) {
  const variant = process.argv[2] && VARIANTS.includes(process.argv[2]) ? process.argv[2] : 'representative';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-v5-p03-smoke-'));
  const result = buildSyntheticSource({ directory, variant });
  process.stdout.write(JSON.stringify({
    file: result.file,
    variant: result.variant,
    clockMs: result.clockMs,
    layout: result.layout,
    schema: result.expected.schema,
    stateRoots: result.expected.stateRoots,
    tablesNonEmpty: Object.entries(result.expected.tables).filter(([, n]) => n > 0).map(([name, n]) => name + '=' + n),
    matchesByStatus: result.expected.matchesByStatus,
    roomsByStatus: result.expected.roomsByStatus,
    outcomeCounts: {
      economy: result.expected.outcomes.economy.count,
      party: result.expected.outcomes.party.count,
      social: result.expected.outcomes.social.count,
      v35: result.expected.outcomes.v35.count,
      matchMoveCommands: result.expected.outcomes.matchMove.commands,
    },
    burn: result.expected.journal.burned,
    burnResidual: result.expected.journal.burnResidual,
    reservedClosure: result.expected.reservations.reservedClosureResiduals.map((row) => row.actor + ':' + row.currency + '=' + row.actual),
    weeklyPaid: result.expected.weekly.weeklyPaid.map((row) => row.key + '=' + row.amount + '/' + row.tier),
    audit: result.expected.audit,
    hashes: result.expected.hashes,
    refusal: result.expected.refusal || null,
    hazards: result.hazards.map((h) => h.locator + ' [' + h.kind + ']'),
    limitations: result.limitations.length,
    trace: result.trace,
  }, null, 2) + '\n');
}
