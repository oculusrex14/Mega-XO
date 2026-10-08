/* V5 P03 (V5-03-02) - source-behaviour tests for the pure deterministic extractor.
 *
 * These cover only consumer-visible boundaries that cannot be settled by reading the code:
 * duplicate-key detection before overwrite, no lost nested data, a mutation-free quarter boundary,
 * non-UUID identity and bought-Crown reservation fidelity, opaque command responses, unsafe-asset
 * rejection, WAL-consistent capture, and byte-identical reruns.
 *
 * Each case builds its source database in a temp directory through the EXISTING isolated seams
 * (DurableStore/CommunityStore/MonetizationStore/RoomStore/migrate - all with an injected clock), so
 * no production file, provider or network is involved. Capture then goes through the real backup path
 * so the reader always consumes an immutable snapshot, never a live database.
 *
 * Run: node --test tests/v5-migration-extract.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const {DurableStore} = require(path.join(ROOT, 'server/economy-store.js'));
const {CommunityStore} = require(path.join(ROOT, 'server/community-store.js'));
const {MonetizationStore} = require(path.join(ROOT, 'server/monetization-store.js'));
const {RoomStore} = require(path.join(ROOT, 'server/rooms.js'));
const {migrate} = require(path.join(ROOT, 'server/production/migrations.js'));
const {capture} = require(path.join(ROOT, 'tools/v5-migration/capture.js'));
const {readSnapshot, hashFile} = require(path.join(ROOT, 'tools/v5-migration/reader.js'));
const {canonical, parseStrictJson} = require(path.join(ROOT, 'tools/v5-migration/canonical.js'));

const CLOCK = Date.parse('2026-10-05T12:00:00Z');

/* Full 35-table source schema through the existing constructors, with a fixed clock. */
function buildSource(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'p03-source-'));
  const file = path.join(directory, 'db.sqlite');
  const store = new DurableStore(file, {now: () => CLOCK});
  migrate(store.db);
  const community = new CommunityStore({store, origin: 'https://fixture.test', now: () => CLOCK, otpSecret: 'f'.repeat(64)});
  new MonetizationStore(store, {now: () => CLOCK});
  const rooms = new RoomStore(file, {now: () => CLOCK});
  rooms.close();
  store.close();
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return {directory, file, snapshot: path.join(directory, 'snapshot.sqlite'), community: null};
}

function account(id, overrides = {}) {
  return {
    id, friendCode: 'MEGA-' + id.toUpperCase().slice(0, 6), coins: 150, crowns: 0,
    purchasedCoins: 0, purchasedCrowns: 0, legacyCompetitionRestricted: false,
    reservedCoins: 0, reservedCrowns: 0, rating: 600, peak: 600, games: 0, tier: 'wood',
    casualRating: 1000, casualGames: 0, verified: true, createdAt: CLOCK, region: '', wealthPublic: false,
    suspended: false, hold: false, blocked: [], friends: [], friendRequests: [], activeMatch: null,
    history: [], daily: {}, operations: {}, ledger: [], owned: [], purchaseInfluenced: false,
    tournamentRecord: {entered: 0, wins: 0, runnerUp: 0, top3: 0, top5: 0, bestFinish: null, finishSum: 0, premiumWins: 0},
    season: null, seasonHistory: [], ...overrides
  };
}

function stateJson(overrides = {}) {
  return JSON.stringify({
    accounts: [], matches: [], receipts: [], snapshots: [], weeklyPaid: [],
    burned: {coins: 0, crowns: 0}, journal: [], leagueWeek: null, ...overrides
  });
}

function writeState(file, json) {
  const db = new DatabaseSync(file);
  try { db.prepare('UPDATE state SET json=? WHERE id=1').run(typeof json === 'string' ? json : stateJson(json)); }
  finally { db.close(); }
}

async function captureSnapshot(source) {
  return capture(source.file, source.snapshot, {captureClockMs: CLOCK, sourceRelease: {sha: '455b8ec9ea4070b4410d78f9eea2aaa06d32c0b2'}});
}

test('capture produces an immutable snapshot without touching the live WAL database', async (t) => {
  const source = buildSource(t);
  /* Hold a separate writer open so the source is genuinely in WAL mode with -wal/-shm present. */
  const writer = new DurableStore(source.file, {now: () => CLOCK});
  t.after(() => writer.close());
  const before = hashFile(source.file);

  const record = await captureSnapshot(source);

  assert.equal(record.snapshot.journalMode, 'delete');
  assert.deepEqual(record.snapshot.sideFiles, []);
  assert.equal(record.snapshot.mode & 0o777, 0o600);
  assert.equal(record.source.mainFileChangedDuringCapture, false);
  assert.equal(hashFile(source.file), before);
  assert.equal(record.inventory.tables, 35);
  assert.equal(record.inventory.indexes, 14);
  assert.equal(record.inventory.triggers, 2);
  assert.equal(record.inventory.views, 0);
  assert.equal(record.captureClockMs, CLOCK);
  assert.ok(record.captureClockMs > 0);
  assert.equal(record.extraction.coverage.unclassified_count, 0);

  /* The reader adds nothing next to the snapshot either. */
  const filesBefore = fs.readdirSync(source.directory).sort();
  readSnapshot(source.snapshot, {captureClockMs: CLOCK});
  assert.deepEqual(fs.readdirSync(source.directory).sort(), filesBefore);
});

test('capture refuses to overwrite an existing snapshot', async (t) => {
  const source = buildSource(t);
  await captureSnapshot(source);
  await assert.rejects(() => captureSnapshot(source), (error) => error.code === 'CAPTURE_TARGET_EXISTS');
});

test('all 35 tables and all eight serialized roots are accounted for with no lost nested data', async (t) => {
  const source = buildSource(t);
  writeState(source.file, {
    accounts: [['p0', account('p0', {
      coins: 321, crowns: 12, reservedCrowns: 4, purchasedCrowns: 12, purchaseInfluenced: true,
      daily: {'2026-07-02': {finished: 1, seconds: 12.5, boards: 3, casual: 1, friend: 0, ranked: 0, rankedBonus: 0, claimed: ['q1']}},
      operations: {conv1: {fingerprint: 'fp', result: {from: 'coins', to: 'crowns', debit: 10, credit: 1, id: 'conv1'}}},
      ledger: [{id: 'conv1:out', operation: 'conv1', currency: 'coins', amount: -10, reason: 'Convert to crowns', at: CLOCK}],
      owned: ['Copper edge', 'Archived frame name'],
      monetization: {credits: 7, redeemed: ['copper'], equipped: 'copper', boosts: [{startedAt: CLOCK - 1000, endsAt: CLOCK + 600000}], daily: {'2026-10-05': {base: 2, bonus: 2, automatic: 1}}, lastAdAt: CLOCK - 100, lastRewardStart: CLOCK - 50}
    })]],
    matches: [['m1', {
      id: 'm1', players: ['p0', 'p1'],
      terms: {source: 'direct', mode: 'direct', kind: 'friend', rated: true, amount: 4, currency: 'crowns', turnSeconds: 30, from: 'wood', to: 'stone', ratings: [600, 700]},
      quote: {version: 'economy-2', mode: 'direct', kind: 'friend', rated: true, currency: 'crowns', minimum: 2, ceiling: 20, fee: 4, contributions: [4, 0], pool: 4, burn: 2, payout: 2, bonus: 0, netWin: -2, gap: 1},
      termsHash: 'hash', accepted: ['p0', 'p1'], created: CLOCK, expires: CLOCK + 1, status: 'PLAYING',
      state: {board: Array.from({length: 9}, () => Array(9).fill(null)), mini: Array(9).fill(null), turn: 'X', required: null, winner: null, line: null, moves: [{b: 0, c: 0, player: 'X'}]},
      symbols: {X: 'p0', O: 'p1'}, revision: 1,
      commands: [['k1', {fingerprint: 'fp', result: {state: {board: Array.from({length: 9}, () => Array(9).fill(null)), mini: Array(9).fill(null), turn: 'O', required: 0, winner: null, line: null, moves: [{b: 0, c: 0, player: 'X'}]}, revision: 1, receipt: null}}]],
      escrow: 4, settled: false, riskFlags: ['HIGH_VALUE_DIRECT_POT'],
      started: CLOCK, _lastMoveAt: CLOCK, _moveTimings: [{actor: 'p0', ms: 1234.5}], preRatings: [600, 700], preTiers: ['wood', 'stone'],
      deadline: CLOCK + 30000, _riskActors: {AUTOMATION_SPEED_REVIEW: ['p0']}
    }]],
    receipts: [['google:tx-1', {actor: 'p0', productId: 'crowns_100', crowns: 100, refunded: false, at: CLOCK}]],
    snapshots: [['2026-10-04', {p0: 'wood', p1: 'stone'}]],
    weeklyPaid: [['2026-W40:p0', {id: '2026-W40:p0', account: 'p0', week: '2026-W40', amount: 20, tier: 'wood', eligible: true, days: 7}]],
    burned: {coins: 0, crowns: 2},
    journal: [{id: 'j1', actor: 'system', currency: 'crowns', amount: -2, reason: 'Currency retired', source: 'game', at: CLOCK}]
  });
  const db = new DatabaseSync(source.file);
  db.prepare('INSERT INTO v35_events(actor,kind,at,value) VALUES(?,?,?,?)').run('p0', 'cosmetic_redeemed', CLOCK, 0);
  db.prepare('INSERT INTO v41_support_events VALUES(?,?,?,?,?,?)').run('s-1', CLOCK, 'GET', '/x', 200, '');
  db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(JSON.stringify(['p0', 'k1']), 'p0', 'deadbeef', JSON.stringify({state: {moves: [{b: 0, c: 0, player: 'X'}]}, revision: 1, receipt: null}));
  const roomJson = JSON.stringify({
    version: 'tournament-2', id: 'room-1', code: 'ABCD1234', owner: 'p0', name: 'Public', format: 'mixed', table: 'premium',
    sequential: false,
    quote: {name: 'Premium', currency: 'crowns', entry: 200, table: 'premium', seats: 10, pool: 2000, burn: 200, payouts: [720, 400, 260, 220, 200, 0, 0, 0, 0, 0], net: [520, 200, 60, 20, 0, -200, -200, -200, -200, -200]},
    clock: 120, increment: 1, capacity: 10, rulesVersion: 1,
    players: [{id: 'p0', name: 'Alice', ready: true, withdrawn: false}, {id: 'p1', name: 'Bob', ready: false, withdrawn: false}],
    status: 'RUNNING', created: CLOCK, expires: CLOCK + 300000, fixtures: [], groups: [], ranking: null, finalRefs: null,
    started: CLOCK, revision: 3, roundDelay: 15000, seed: ['p0', 'p1'], deadline: CLOCK + 7200000,
    escrow: 2000, settled: false, contributions: [{id: 'p0', amount: 200}, {id: 'p1', amount: 200}], riskFlags: []
  });
  db.prepare('INSERT INTO party_rooms VALUES(?,?,?)').run('room-1', 'ABCD1234', roomJson);
  db.prepare('INSERT INTO party_commands VALUES(?,?,?)').run(JSON.stringify(['p0', 'r1']), 'fp', JSON.stringify({id: 'room-1'}));
  db.prepare('INSERT INTO v35_commands VALUES(?,?,?,?)').run('p0', 'buy', 'fp', JSON.stringify({crowns: 100, duplicate: false}));
  db.prepare('INSERT INTO social_operations VALUES(?,?,?)').run('p0:req-1', 'fp', JSON.stringify({requested: true}));
  db.prepare('INSERT INTO profile_saves VALUES(?,?,?,?)').run('p0', 3, JSON.stringify({version: 3.2, economyVersion: 'economy-2', settings: {theme: 'vector'}, records: [], processed: [], wallet: {coins: 1, crowns: 0, ledger: [], owned: []}, daily: {}, weekly: {}, legacy: {unknownNested: true}, profile: {name: 'You'}}), CLOCK);
  db.prepare('INSERT INTO email_credentials VALUES(?,?,?,?,?,?)').run('Mixed.Case@Example.test', 'p0', 'salt', 'hash', CLOCK, CLOCK);
  db.prepare('INSERT INTO email_challenges VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('ch-1', 'sess', 'Mixed.Case@Example.test', 'signup', null, 'codehash', 'salt', 'hash', CLOCK, CLOCK + 60000, 0, null, 0);
  db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?,?,?)').run('tokenhash', 'p0', 'csrf', CLOCK, CLOCK + 86400000, CLOCK);
  db.prepare('INSERT INTO session_presence VALUES(?,?,?,?)').run('sesshash', 'p0', CLOCK, 1);
  db.prepare('INSERT INTO party_guests VALUES(?,?,?,?)').run('guesthash', 'guest-actor', 'Guest', CLOCK + 86400000);
  db.prepare('INSERT INTO v41_store_bindings VALUES(?,?,?,?)').run('p0', 'google-obf-1', 'apple-app-1', CLOCK);
  db.prepare('INSERT INTO v41_store_revocations VALUES(?,?,?,?,?)').run('google', 'tx-9', 'crowns_100', CLOCK, 'refund');
  db.prepare('INSERT INTO v41_store_notifications VALUES(?,?,?)').run('apple', 'n-1', CLOCK);
  db.prepare('INSERT INTO v41_store_finalize VALUES(?,?,?,?,?,?,?,?,?,?)').run('google', 'tx-1', 'crowns_100', 'tok-1', 'consume', 'pending', 1, CLOCK, CLOCK, CLOCK);
  db.prepare('INSERT INTO v35_tickets(id,actor,kind,issued,expires,day,settled,transaction_id) VALUES(?,?,?,?,?,?,?,?)').run('t-1', 'p0', 'credits', CLOCK, CLOCK + 300000, '2026-10-05', 0, null);
  db.prepare('INSERT INTO v35_casual VALUES(?,?,?,?)').run('p0', 'c-1', 2, 0);
  db.prepare('INSERT INTO v41_ad_ticket_context VALUES(?,?,?)').run('t-1', 'android', 'android-reward');
  db.prepare('INSERT INTO v41_operator_audit VALUES(?,?,?,?,?,?,?,?,?)').run('op_1', CLOCK, 'ops', 'suspend', 'p0', 'abuse', '{"x":1}', 'GENESIS', 'hash-1');
  db.prepare('INSERT INTO v41_reports VALUES(?,?,?,?,?,?,?,?,?,?)').run('r-1', 'p1', 'p0', 'cheating', 'detail', CLOCK, 'open', null, null, null);
  db.prepare('INSERT INTO v41_privacy_requests VALUES(?,?,?,?,?,?,?,?,?)').run('pr-1', 'p0', 'deletion', 'completed', CLOCK, CLOCK, CLOCK, 'v1', '');
  db.prepare('INSERT INTO v41_deletion_receipts VALUES(?,?,?,?,?,?)').run('d-1', 'actorhash', 'deleted_p0', CLOCK, 'v1', '["purchase_replay_records"]');
  db.prepare('INSERT INTO v4_runtime VALUES(?,?)').run('incident_lockdown_at', String(CLOCK));
  db.prepare('INSERT INTO v4_outbox VALUES(?,?,?,?,?,?,?,?,?)').run('o-1', 'cipher.text', 'reset', 'queued', CLOCK, CLOCK + 60000, CLOCK, 0, 0);
  db.prepare('INSERT INTO v4_limits VALUES(?,?,?)').run('mail-budget:2026-10', 3, CLOCK + 40 * 86400000);
  db.prepare('INSERT INTO community_limits VALUES(?,?)').run('search:p0', 1);
  db.prepare('INSERT INTO identities VALUES(?,?,?,?)').run('apple', 'synthetic-apple', 'p0', CLOCK);
  db.prepare('INSERT INTO profiles VALUES(?,?,?,?,?,?,?,?,?,?)').run('p0', 'MEGA-AAAAAA', 'alice', 'Alice', 'ring', 'friends', 'friends', CLOCK, 0, 1);
  db.close();

  const record = await captureSnapshot(source);
  const model = readSnapshot(source.snapshot, {captureClockMs: CLOCK});
  assert.equal(model.capture.schemaHead.maxId, 8);
  assert.equal(model.capture.schemaHead.allMatch, true);

  /* Every table in the source is present, and no table is unclassified. */
  const live = new DatabaseSync(source.snapshot, {readOnly: true});
  const names = live.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
  live.close();
  assert.equal(names.length, 35);
  for (const name of names) {
    assert.ok(model.tables[name], 'table ' + name + ' missing from the model');
    assert.notEqual(model.tables[name].classification, 'undescribed');
  }
  assert.equal(model.coverage.unclassified_count, 0);
  assert.equal(model.schema.drift.missingTables.length, 0);
  assert.deepEqual(model.schema.drift.views, []);

  /* Raw JSON text is preserved verbatim alongside the parsed value for every JSON column. */
  const liveAgain = new DatabaseSync(source.snapshot, {readOnly: true});
  const stateText = liveAgain.prepare('SELECT json FROM state WHERE id=1').get().json;
  for (const row of liveAgain.prepare('SELECT id,code,json FROM party_rooms').all()) assert.equal(model.rooms.find((room) => room.id === row.id).raw, row.json);
  liveAgain.close();
  assert.equal(model.state.raw, stateText);
  assert.equal(canonical(parseStrictJson(stateText).value), canonical(model.state.parsed));

  /* Nested account, match, room and fixture fields survive, including the fractional ones. */
  const held = model.state.parsed.accounts[0][1];
  assert.equal(held.daily['2026-07-02'].seconds, 12.5);
  assert.equal(held.monetization.boosts[0].endsAt, CLOCK + 600000);
  assert.deepEqual(held.owned, ['Copper edge', 'Archived frame name']);
  const match = model.state.parsed.matches[0][1];
  assert.equal(match.quote.ceiling, 20);
  assert.equal(match._moveTimings[0].ms, 1234.5);
  assert.deepEqual(match._riskActors.AUTOMATION_SPEED_REVIEW, ['p0']);
  assert.equal(match.commands.length, 1);
  assert.deepEqual(match.commands[0][1].result.receipt, null);
  const room = model.rooms.find((entry) => entry.id === 'room-1');
  assert.equal(room.parsed.escrow, 2000);
  assert.deepEqual(room.parsed.contributions, [{id: 'p0', amount: 200}, {id: 'p1', amount: 200}]);
  assert.deepEqual(room.parsed.quote.payouts.slice(0, 5), [720, 400, 260, 220, 200]);

  /* Opaque command responses are carried byte-for-byte, never recomputed. */
  const command = model.tables.commands.rows.find((row) => row.values.actor === 'p0');
  assert.equal(command.values.response, JSON.stringify({state: {moves: [{b: 0, c: 0, player: 'X'}]}, revision: 1, receipt: null}));
  assert.equal(model.tables.v35_commands.rows[0].values.response, JSON.stringify({crowns: 100, duplicate: false}));
  assert.equal(model.tables.social_operations.rows[0].values.result, JSON.stringify({requested: true}));
  assert.equal(model.tables.party_commands.rows[0].values.response, JSON.stringify({id: 'room-1'}));

  /* Ephemeral dispositions are explicit and never re-issued. */
  const dispositions = Object.fromEntries(model.coverage.tables.map((entry) => [entry.table, entry.disposition]));
  for (const table of ['account_sessions', 'signin_attempts', 'session_presence', 'email_challenges', 'v4_email_versions', 'community_limits', 'party_guests', 'v4_outbox', 'v41_support_events']) {
    assert.equal(dispositions[table], 'E', table + ' should carry an ephemeral disposition');
  }
  /* v4_limits mixes durable mail-budget spend counters with ephemeral abuse buckets, so it is copied
   * verbatim (V) and a durable row survives unchanged rather than being rebuilt or reset. */
  assert.equal(dispositions.v4_limits, 'V');
  const budget = model.tables.v4_limits.rows.find((row) => row.values.id === 'mail-budget:2026-10');
  assert.equal(budget.values.hits, 3);
  assert.equal(budget.values.expires, CLOCK + 40 * 86400000);
  assert.equal(model.tables.v41_store_bindings.rows[0].values.google_id, 'google-obf-1');
  assert.equal(model.coverage.dispositions.O >= 3, true);
  assert.ok(model.coverage.fields.total > 0);
  assert.ok(record.extraction.sourceFingerprint);
  assert.equal(record.extraction.sourceFingerprint, model.hashes.sourceFingerprint);
});

test('a duplicate serialized key is refused before any value can be overwritten', async (t) => {
  const source = buildSource(t);
  /* The second `accounts` would silently replace the first under JSON.parse. */
  writeState(source.file, '{"accounts":[["first",{"id":"first"}]],"accounts":[],"matches":[],"receipts":[],"snapshots":[],"weeklyPaid":[],"burned":{"coins":0,"crowns":0},"journal":[],"leagueWeek":null}');
  await assert.rejects(async () => {
    await capture(source.file, source.snapshot, {captureClockMs: CLOCK});
    readSnapshot(source.snapshot, {captureClockMs: CLOCK});
  }, (error) => error.code === 'JSON_DUPLICATE_KEY' && error.locator === '$.accounts');
});

test('a quarter boundary is not rolled and fractional clocks are preserved exactly', async (t) => {
  const source = buildSource(t);
  const priorQuarterHistory = Array.from({length: 9}, (_, index) => ({
    id: '20' + (24 + index) + '-Q1', startedAt: 0, games: 1, queueGames: 1, opponents: ['p1'],
    wins: 1, losses: 0, draws: 0, peakRating: 1000.25, lastRatedAt: 0, qualifiedAt: 0,
    finishRating: 1000.5, finishTier: 'wood', endedAt: 0
  }));
  const held = account('p0', {
    rating: 1234.56, peak: 1300.25, casualRating: 1000.75, casualGames: 11,
    season: {id: '2026-Q3', startedAt: Date.parse('2026-07-01T00:00:00Z'), games: 9, queueGames: 3, opponents: ['p1'], wins: 5, losses: 3, draws: 1, peakRating: 1234.56, lastRatedAt: CLOCK, qualifiedAt: CLOCK},
    seasonHistory: priorQuarterHistory
  });
  writeState(source.file, {accounts: [['p0', held]]});
  const before = hashFile(source.file);

  const record = await captureSnapshot(source);
  const model = readSnapshot(source.snapshot, {captureClockMs: CLOCK});

  /* The source's own restore() would append to seasonHistory and truncate it to 8; nothing may change. */
  const raw = model.state.parsed.accounts[0][1];
  assert.equal(raw.season.id, '2026-Q3');
  assert.equal(raw.seasonHistory.length, 9);
  assert.deepEqual(raw.seasonHistory.map((entry) => entry.id), priorQuarterHistory.map((entry) => entry.id));
  assert.equal(raw.seasonHistory[8].peakRating, 1000.25);
  assert.equal(raw.season.peakRating, 1234.56);
  assert.equal(canonical(parseStrictJson(model.state.raw).value), canonical(model.state.parsed));
  /* The reported delta describes the season restore() would roll: the RAW quarter is the stored one, and
   * the normalized projection is the capture clock's quarter. Nothing is written to the raw copy. */
  const seasonDelta = model.hashes.normalization.find((entry) => entry.field === 'state.accounts[].season');
  assert.ok(seasonDelta, 'the season roll must be reported');
  assert.equal(seasonDelta.raw.id, '2026-Q3');
  assert.equal(seasonDelta.normalized.id, '2026-Q4');
  assert.equal(hashFile(source.file), before);
  assert.equal(record.source.mainFileChangedDuringCapture, false);

  /* Two runs over the same immutable snapshot are byte-identical. */
  const second = readSnapshot(source.snapshot, {captureClockMs: CLOCK});
  assert.equal(canonical(model), canonical(second));
  /* A different capture clock changes the recorded clock and the fingerprint, never the raw data. */
  const shifted = readSnapshot(source.snapshot, {captureClockMs: CLOCK + 86400000});
  assert.equal(shifted.capture.clockMs, CLOCK + 86400000);
  assert.equal(canonical(shifted.state.parsed), canonical(model.state.parsed));
  assert.notEqual(shifted.hashes.sourceFingerprint, model.hashes.sourceFingerprint);
});

test('non-UUID identity, linked providers and a bought-Crown reservation survive verbatim', async (t) => {
  const source = buildSource(t);
  /* A legacy text actor id that is not a UUID; still inside the source's own id grammar. */
  const actor = 'u_legacy-actor_1';
  writeState(source.file, {
    accounts: [[actor, account(actor, {
      id: actor, coins: 500, crowns: 250, purchasedCrowns: 250, reservedCrowns: 200, purchaseInfluenced: true,
      activeMatch: 'tournament:room-1', rating: 1500.25
    })]],
    matches: [['m1', {
      id: 'm1', players: [actor, 'p1'],
      terms: {source: 'queue', mode: 'queue', kind: 'ranked', rated: true, amount: 4, currency: 'coins', turnSeconds: 30, from: 'gold', to: 'gold', ratings: [1500.25, 1500.5]},
      quote: {version: 'economy-2', mode: 'queue', rated: true, currency: 'coins', minimum: 12, ceiling: 12, fee: 12, contributions: [12, 12], pool: 24, burn: 12, payout: 12, bonus: 7, netWin: 0},
      termsHash: 'fp', accepted: [actor, 'p1'], created: CLOCK, expires: CLOCK + 15000, status: 'OFFERED',
      state: {board: Array.from({length: 9}, () => Array(9).fill(null)), mini: Array(9).fill(null), turn: 'X', required: null, winner: null, line: null, moves: []},
      symbols: null, revision: 0, commands: [], escrow: 0, settled: false, riskFlags: [],
      _pendingReason: 'line'
    }]]
  });
  const db = new DatabaseSync(source.file);
  db.prepare('INSERT INTO identities VALUES(?,?,?,?)').run('google', 'google-subject-legacy', actor, CLOCK);
  db.prepare('INSERT INTO identities VALUES(?,?,?,?)').run('apple', 'apple-subject-legacy', actor, CLOCK);
  db.prepare('INSERT INTO identities VALUES(?,?,?,?)').run('email', 'Legacy.User@Example.test', actor, CLOCK);
  db.prepare('INSERT INTO profiles VALUES(?,?,?,?,?,?,?,?,?,?)').run(actor, 'MEGA-LEGACY1', 'legacy_user', 'Legacy', 'board', 'friends', 'friends', CLOCK, 0, 1);
  db.prepare('INSERT INTO email_credentials VALUES(?,?,?,?,?,?)').run('Legacy.User@Example.test', actor, 'c2FsdA', 'aGFzaA', CLOCK, CLOCK);
  db.prepare('INSERT INTO v41_store_bindings VALUES(?,?,?,?)').run(actor, 'obfuscated-account-id', 'apple-app-account-uuid', CLOCK);
  db.prepare('INSERT INTO party_guests VALUES(?,?,?,?)').run('guesthash', 'guest-actor', 'Guest', CLOCK + 86400000);
  db.close();

  await captureSnapshot(source);
  const model = readSnapshot(source.snapshot, {captureClockMs: CLOCK});
  const held = model.state.parsed.accounts[0][1];

  assert.equal(model.state.parsed.accounts[0][0], actor);
  assert.equal(held.id, actor);
  assert.equal(held.crowns, 250);
  assert.equal(held.purchasedCrowns, 250);
  assert.equal(held.reservedCrowns, 200);
  assert.equal(held.activeMatch, 'tournament:room-1');
  assert.equal(held.rating, 1500.25);
  assert.equal(model.state.parsed.matches[0][1].terms.currency, 'coins');
  assert.equal(model.state.parsed.matches[0][1]._pendingReason, 'line');
  assert.equal(model.tables.email_credentials.rows[0].values.email, 'Legacy.User@Example.test');
  assert.equal(model.tables.v41_store_bindings.rows[0].values.google_id, 'obfuscated-account-id');
  assert.equal(model.tables.v41_store_bindings.rows[0].values.apple_token, 'apple-app-account-uuid');
  assert.deepEqual(model.tables.identities.rows.map((row) => row.values.provider).sort(), ['apple', 'email', 'google']);
  assert.deepEqual(model.coverage.tables.find((entry) => entry.table === 'party_guests').disposition, 'E');
  assert.deepEqual(model.hashes.grammarDrift, []);
  /* An id outside the source's own grammar is preserved exactly and reported, never recast. */
  const second = buildSource(t);
  writeState(second.file, {accounts: [['a b', account('a b')]]});
  const secondRecord = await captureSnapshot(second);
  assert.equal(secondRecord.extraction.coverage.unclassified_count, 0);
  const odd = readSnapshot(second.snapshot, {captureClockMs: CLOCK});
  assert.deepEqual(odd.hashes.grammarDrift.map((entry) => entry.locator), ['state.accounts[a b].id']);
  assert.equal(odd.hashes.grammarDrift[0].grammar, 'authority-id');
  assert.equal(odd.state.parsed.accounts[0][0], 'a b');
});

test('an unsafe asset is rejected instead of rounded or silently truncated', async (t) => {
  const source = buildSource(t);
  writeState(source.file, {accounts: [['p0', account('p0', {coins: 9007199254740991})]]});
  const db = new DatabaseSync(source.file);
  /* A row value beyond 2^53-1 cannot be represented as a JS number at all. */
  db.prepare('INSERT INTO v35_events(actor,kind,at,value) VALUES(?,?,?,?)').run('p0', 'k', CLOCK, 9007199254740993n);
  db.close();
  await assert.rejects(() => capture(source.file, source.snapshot, {captureClockMs: CLOCK}), (error) => error.code === 'SOURCE_COLUMN_TYPE_DRIFT');

  /* A fractional value in a currency field is a type error, not a rounding opportunity. */
  const second = buildSource(t);
  writeState(second.file, {burned: {coins: 0.5, crowns: 0}});
  await assert.rejects(() => capture(second.file, second.snapshot, {captureClockMs: CLOCK}), (error) => error.code === 'INVALID_FIELD_TYPE');

  /* An unsafe integer inside the serialized JSON is refused by the strict parser. */
  const third = buildSource(t);
  writeState(third.file, '{"accounts":[["p0",{"id":"p0","coins":9007199254740993,"crowns":0,"purchasedCoins":0,"purchasedCrowns":0,"legacyCompetitionRestricted":false,"reservedCoins":0,"reservedCrowns":0,"rating":600,"peak":600,"games":0,"tier":"wood","casualRating":1000,"casualGames":0,"verified":true,"createdAt":0,"region":"","wealthPublic":false,"suspended":false,"hold":false,"blocked":[],"friends":[],"friendRequests":[],"activeMatch":null,"history":[],"daily":{},"operations":{},"ledger":[],"owned":[],"purchaseInfluenced":false,"tournamentRecord":{"entered":0,"wins":0,"runnerUp":0,"top3":0,"top5":0,"bestFinish":null,"finishSum":0,"premiumWins":0},"season":null,"seasonHistory":[]}]],"matches":[],"receipts":[],"snapshots":[],"weeklyPaid":[],"burned":{"coins":0,"crowns":0},"journal":[],"leagueWeek":null}');
  await assert.rejects(() => capture(third.file, third.snapshot, {captureClockMs: CLOCK}), (error) => error.code === 'JSON_UNSAFE_INTEGER');
});

test('an explicit preserve rule accepts an unknown field and keeps its value', async (t) => {
  const source = buildSource(t);
  writeState(source.file, {accounts: [['p0', account('p0', {legacyRatingCache: 1234})]]});
  const record = await captureSnapshot(source);
  assert.equal(record.extraction.coverage.unclassified_count, 1);
  assert.deepEqual(record.extraction.coverage.unclassified_locators, ['state.accounts[p0].legacyRatingCache']);
  assert.throws(
    () => readSnapshot(source.snapshot, {captureClockMs: CLOCK}),
    (error) => error.code === 'COVERAGE_INCOMPLETE' && error.locator === 'state.accounts[p0].legacyRatingCache'
  );

  const model = readSnapshot(source.snapshot, {captureClockMs: CLOCK, allowUnclassified: {'state.accounts[].legacyRatingCache': 'LEGACY-RATING-CACHE-1'}});
  assert.equal(model.coverage.unclassified_count, 0);
  assert.deepEqual(model.coverage.accepted, [{locator: 'state.accounts[p0].legacyRatingCache', ruleId: 'LEGACY-RATING-CACHE-1'}]);
  assert.equal(model.state.parsed.accounts[0][1].legacyRatingCache, 1234);
});

test('the extractor refuses a WAL-mode file and a mismatched checksum', async (t) => {
  const source = buildSource(t);
  writeState(source.file, {accounts: [['p0', account('p0')]]});
  await captureSnapshot(source);
  const good = readSnapshot(source.snapshot, {captureClockMs: CLOCK});
  assert.throws(
    () => readSnapshot(source.snapshot, {captureClockMs: CLOCK, expectedSha256: '0'.repeat(64)}),
    (error) => error.code === 'FILE_SHA_MISMATCH'
  );
  /* A raw live WAL database must be captured, never read directly. */
  assert.throws(() => readSnapshot(source.file, {captureClockMs: CLOCK}), (error) => error.code === 'SNAPSHOT_JOURNAL_MODE_NOT_IMMUTABLE' || error.code === 'SNAPSHOT_NOT_IMMUTABLE');
  assert.equal(good.tables.state.count, 1);
});

test('a legacy account missing optional fields stays absent and is reported, not defaulted', async (t) => {
  const source = buildSource(t);
  const legacy = account('p0');
  delete legacy.casualGames;
  delete legacy.tournamentRecord;
  delete legacy.seasonHistory;
  delete legacy.monetization;
  writeState(source.file, {accounts: [['p0', legacy]]});
  await captureSnapshot(source);
  const model = readSnapshot(source.snapshot, {captureClockMs: CLOCK});
  const held = model.state.parsed.accounts[0][1];
  assert.equal(Object.prototype.hasOwnProperty.call(held, 'casualGames'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(held, 'tournamentRecord'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(held, 'monetization'), false);
  /* Each absent field the source defaults is reported with the projection restore() would apply, and the
   * raw absence above proves nothing was written back. */
  const reported = new Map(model.hashes.normalization.map((entry) => [entry.field, entry]));
  assert.equal(reported.get('state.accounts[].casualGames').normalized, 0);
  assert.deepEqual(reported.get('state.accounts[].seasonHistory').normalized, []);
  assert.equal(reported.get('state.accounts[].tournamentRecord').normalized.entered, 0);
  assert.ok(reported.has('state.accounts[].season'));
});

test('an unknown field is reported by structural shape in summaries, exact locators only in the model', async (t) => {
  const source = buildSource(t);
  writeState(source.file, {accounts: [['p0', account('p0', {legacyRatingCache: 1234})]]});
  await captureSnapshot(source);
  const {readSnapshot} = require(path.join(ROOT, 'tools/v5-migration/reader.js'));
  const {sanitizedSummary} = require(path.join(ROOT, 'tools/v5-migration/cli.js'));
  const model = readSnapshot(source.snapshot, {captureClockMs: CLOCK, allowUnclassified: {'state.accounts[].legacyRatingCache': 'LEGACY-RATING-CACHE-1'}});
  const summary = sanitizedSummary(model);

  /* The restricted model names the actor; the shareable summary must not. */
  assert.equal(model.coverage.accepted[0].locator, 'state.accounts[p0].legacyRatingCache');
  assert.deepEqual(summary.coverage.acceptedShapes, ['state.accounts[].legacyRatingCache']);
  assert.equal(summary.coverage.acceptedCount, 1);
  assert.equal(summary.coverage.unclassified_count, 0);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes('p0'), false, 'the summary must not embed an actor id');
  assert.equal(serialized.includes('legacyRatingCache=p0'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(summary.coverage, 'accepted'), false, 'raw accepted entries stay restricted');

  /* An unknown-with-no-rule extraction still reports the exact locator in the thrown error (the console
   * copy is reduced to a shape by cli.js, but the library error keeps the actionable path). */
  assert.throws(
    () => readSnapshot(source.snapshot, {captureClockMs: CLOCK}),
    (error) => error.code === 'COVERAGE_INCOMPLETE' && error.locator === 'state.accounts[p0].legacyRatingCache'
  );
});

test('the CLI physically bounds raw destinations, including --snapshot, with no override flag', (t) => {
  const {execFileSync} = require('node:child_process');
  const {main} = require(path.join(ROOT, 'tools/v5-migration/cli.js'));
  assert.equal(typeof main, 'function');
  const cli = path.join(ROOT, 'tools', 'v5-migration', 'cli.js');
  const run = (args) => {
    try { return {out: execFileSync(process.execPath, [cli, ...args], {encoding: 'utf8'}), code: 0}; }
    catch (error) { return {out: String(error.stdout || '') + String(error.stderr || ''), code: error.status}; }
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'p03-bound-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const source = buildSource(t);
  writeState(source.file, {accounts: [['p0', account('p0')]]});

  /* A good snapshot in the private fixture directory, so the extract cases reach the output guard rather
   * than failing earlier on a missing snapshot. */
  const goodSnapshot = path.join(directory, 'snap.sqlite');
  assert.equal(run(['capture', '--source', source.file, '--snapshot', goodSnapshot, '--capture-clock', String(CLOCK)]).code, 0);

  /* Every raw destination is refused when the same leaf name is placed inside the repository:
   * --snapshot on capture, and --out / --record on the command that owns them. */
  for (const raw of [
    {flag: '--snapshot', args: () => ['capture', '--source', source.file, '--capture-clock', String(CLOCK), '--snapshot', path.join(ROOT, 'docs', 'raw-snapshot.sqlite')]},
    {flag: '--out', args: () => ['extract', '--snapshot', goodSnapshot, '--clock', String(CLOCK), '--out', path.join(ROOT, 'docs', 'raw-out.json')]},
    {flag: '--record', args: () => ['capture', '--source', source.file, '--snapshot', path.join(directory, 'rec-snap.sqlite'), '--capture-clock', String(CLOCK), '--record', path.join(ROOT, 'docs', 'raw-record.json')]}
  ]) {
    const result = run(raw.args());
    assert.equal(result.code, 1, raw.flag + ' must be refused inside the repository');
    assert.equal(result.out.includes('OUTPUT_INSIDE_GIT_CHECKOUT'), true, raw.flag + ' must report the Git bound');
    assert.equal(fs.existsSync(path.join(ROOT, 'docs', raw.flag.replace('--', 'raw-') + (raw.flag === '--out' || raw.flag === '--record' ? '.json' : '.sqlite'))), false, raw.flag + ' must not have leaked a raw file');
  }
  /* The override flags were removed rather than kept as an unsafe path: they are now unknown options. */
  for (const flag of ['allow-in-repo', 'allow-public-dir']) {
    const override = run(['extract', '--snapshot', goodSnapshot, '--clock', String(CLOCK), '--out', path.join(directory, 'x.json'), '--' + flag, 'because']);
    assert.equal(override.out.includes('UNKNOWN_OPTION'), true, flag + ' must no longer be accepted');
  }

  /* A named published/CI-artifact directory is refused even when the leaf directory is private (0700):
   * the content would still be published. */
  const {assertRawDestinationBound} = require(path.join(ROOT, 'tools', 'v5-migration', 'capture.js'));
  for (const segment of ['public', 'public_html', 'dist', 'coverage', '.github', '.artifacts']) {
    const publishedDirectory = path.join(directory, segment);
    fs.mkdirSync(publishedDirectory, {recursive: true, mode: 0o700});
    fs.chmodSync(publishedDirectory, 0o700);
    assert.throws(
      () => assertRawDestinationBound(path.join(publishedDirectory, 'raw.sqlite'), 'snapshot'),
      (error) => error.code === 'OUTPUT_IN_PUBLISHED_LOCATION',
      segment + ' must be refused even at 0700'
    );
    const viaCli = run(['capture', '--source', source.file, '--snapshot', path.join(publishedDirectory, 'raw.sqlite'), '--capture-clock', String(CLOCK)]);
    assert.equal(viaCli.out.includes('OUTPUT_IN_PUBLISHED_LOCATION'), true, segment + ' must be refused via the CLI');
  }
  /* A private, unremarkable directory (including a fresh 0700 staging sibling) is still allowed. */
  const privateDirectory = path.join(directory, 'restricted');
  fs.mkdirSync(privateDirectory, {recursive: true, mode: 0o700});
  fs.chmodSync(privateDirectory, 0o700);
  assert.equal(assertRawDestinationBound(path.join(privateDirectory, 'raw.sqlite'), 'snapshot'), path.join(privateDirectory, 'raw.sqlite'));
});

test('a symlinked raw destination resolves to its real location and is refused', (t) => {
  if (process.platform === 'win32') return; // symlink semantics differ
  const {execFileSync} = require('node:child_process');
  const cli = path.join(ROOT, 'tools', 'v5-migration', 'cli.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'p03-symlink-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const source = buildSource(t);
  writeState(source.file, {accounts: [['p0', account('p0')]]});
  /* A symlink placed in a writable temp directory points back into the Git checkout. */
  const alias = path.join(directory, 'innocent.json');
  fs.symlinkSync(path.join(ROOT, 'docs'), alias);
  let result;
  try {
    execFileSync(process.execPath, [cli, 'extract', '--snapshot', path.join(directory, 's.sqlite'), '--clock', String(CLOCK), '--out', path.join(alias, 'leak.json')], {encoding: 'utf8'});
    result = '';
  } catch (error) { result = String(error.stderr || '') + String(error.stdout || ''); }
  assert.equal(result.includes('OUTPUT_INSIDE_GIT_CHECKOUT'), true, 'the symlink alias must resolve into the checkout');
});

test('an operator void with an object reason is preserved verbatim, not refused', async (t) => {
  /* SOURCE CORRECTION (consumer-visible): Authority.voidByOperator (src/authority.js:101-104) stores the
   * caller's reason verbatim with no validator, so a trusted operator 'void' command admits an
   * arbitrary JSON value. The reader's nested receipt.reason must accept and preserve it. */
  const source = buildSource(t);
  writeState(source.file, {
    accounts: [['p0', account('p0')], ['p1', account('p1')]],
    matches: [['v1', {
      id: 'v1', players: ['p0', 'p1'],
      terms: {source: 'direct', mode: 'direct', kind: 'friend', rated: false, amount: 0, currency: null, turnSeconds: 60, from: 'wood', to: 'wood', ratings: [600, 600]},
      quote: {version: 'economy-2', mode: 'unranked', rated: false, currency: null, minimum: 0, ceiling: 0, fee: 0, contributions: [0, 0], pool: 0, burn: 0, payout: 0, bonus: 0, netWin: 0},
      termsHash: 'fp', accepted: ['p0'], created: CLOCK, expires: CLOCK + 1, status: 'VOID',
      state: {board: Array.from({length: 9}, () => Array(9).fill(null)), mini: Array(9).fill(null), turn: 'X', required: null, winner: null, line: null, moves: []},
      symbols: null, revision: 0, commands: [], escrow: 0, settled: true, riskFlags: [],
      receipt: {reason: {note: 'operator cancellation', nested: {code: 7}}, refunded: 0, burn: 0, payout: 0, rating: null}
    }]]
  });
  await captureSnapshot(source);
  const model = readSnapshot(source.snapshot, {captureClockMs: CLOCK});
  const receipt = model.state.parsed.matches[0][1].receipt;
  /* The object reason is preserved verbatim, nested values included, and the raw text keeps it. */
  assert.deepEqual(receipt.reason, {note: 'operator cancellation', nested: {code: 7}});
  assert.equal(model.state.raw.includes('"reason":{"note":"operator cancellation","nested":{"code":7}}'), true);
  /* A string reason is equally accepted and preserved as an escaped JSON string. A fresh source is used
   * because the first snapshot is immutable and a second capture to the same path is refused. */
  const secondSource = buildSource(t);
  writeState(secondSource.file, {
    accounts: [['p0', account('p0')], ['p1', account('p1')]],
    matches: [['v1', {
      id: 'v1', players: ['p0', 'p1'],
      terms: {source: 'direct', mode: 'direct', kind: 'friend', rated: false, amount: 0, currency: null, turnSeconds: 60, from: 'wood', to: 'wood', ratings: [600, 600]},
      quote: {version: 'economy-2', mode: 'unranked', rated: false, currency: null, minimum: 0, ceiling: 0, fee: 0, contributions: [0, 0], pool: 0, burn: 0, payout: 0, bonus: 0, netWin: 0},
      termsHash: 'fp', accepted: ['p0'], created: CLOCK, expires: CLOCK + 1, status: 'VOID',
      state: {board: Array.from({length: 9}, () => Array(9).fill(null)), mini: Array(9).fill(null), turn: 'X', required: null, winner: null, line: null, moves: []},
      symbols: null, revision: 0, commands: [], escrow: 0, settled: true, riskFlags: [],
      receipt: {reason: 'lone\ud800surrogate', refunded: 0, burn: 0, payout: 0, rating: null}
    }]]
  });
  await captureSnapshot(secondSource);
  const second = readSnapshot(secondSource.snapshot, {captureClockMs: CLOCK});
  assert.equal(second.state.parsed.matches[0][1].receipt.reason, 'lone\ud800surrogate');
  assert.equal(second.state.raw.includes('\\ud800'), true);
});
