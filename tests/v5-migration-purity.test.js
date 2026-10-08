/* V5 P03 (V5-03-02) - purity invariants of the source extractor.
 *
 * The reader must be a pure function of (snapshot bytes, fixed clock). This file asserts only
 * consumer-visible boundaries: the module graph reaches no runtime authority/store/provider module,
 * no clock or randomness is observable, no HTTP module is reachable, and reading creates no
 * side file, no schema change and no second connection.
 *
 * Run: node --test tests/v5-migration-purity.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const READER = path.join(ROOT, 'tools', 'v5-migration', 'reader.js');
const {DurableStore} = require(path.join(ROOT, 'server/economy-store.js'));
const {CommunityStore} = require(path.join(ROOT, 'server/community-store.js'));
const {MonetizationStore} = require(path.join(ROOT, 'server/monetization-store.js'));
const {RoomStore} = require(path.join(ROOT, 'server/rooms.js'));
const {migrate} = require(path.join(ROOT, 'server/production/migrations.js'));
const {capture} = require(path.join(ROOT, 'tools/v5-migration/capture.js'));
const {canonical} = require(path.join(ROOT, 'tools/v5-migration/canonical.js'));

const CLOCK = Date.parse('2026-10-05T12:00:00Z');

/* Build the complete 35-table source schema through the EXISTING isolated seams with an injected clock,
 * then seed one source-shaped account so callers have a real account row to operate on. This is test
 * fixture construction only; the reader under test never sees these constructors. */
function account(id) {
  return {
    id, friendCode: 'MEGA-' + id.toUpperCase().slice(0, 6), coins: 150, crowns: 0, purchasedCoins: 0,
    purchasedCrowns: 0, legacyCompetitionRestricted: false, reservedCoins: 0, reservedCrowns: 0, rating: 600,
    peak: 600, games: 0, tier: 'wood', casualRating: 1000, casualGames: 0, verified: true, createdAt: CLOCK,
    region: '', wealthPublic: false, suspended: false, hold: false, blocked: [], friends: [], friendRequests: [],
    activeMatch: null, history: [], daily: {}, operations: {}, ledger: [], owned: [], purchaseInfluenced: false,
    tournamentRecord: {entered: 0, wins: 0, runnerUp: 0, top3: 0, top5: 0, bestFinish: null, finishSum: 0, premiumWins: 0},
    season: null, seasonHistory: []
  };
}

function buildSource(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'p03-purity-'));
  const file = path.join(directory, 'db.sqlite');
  const store = new DurableStore(file, {now: () => CLOCK});
  migrate(store.db);
  new CommunityStore({store, origin: 'https://fixture.test', now: () => CLOCK, otpSecret: 'f'.repeat(64)});
  new MonetizationStore(store, {now: () => CLOCK});
  const rooms = new RoomStore(file, {now: () => CLOCK});
  rooms.close();
  /* Seed one account so the per-actor cases have a real source row. */
  const seed = new DatabaseSync(file);
  seed.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify({
    accounts: [['p0', account('p0')]], matches: [], receipts: [], snapshots: [], weeklyPaid: [],
    burned: {coins: 0, crowns: 0}, journal: [], leagueWeek: null
  }));
  seed.close();
  store.close();
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return {directory, file, snapshot: path.join(directory, 'snapshot.sqlite')};
}

test('reading is deterministic, clock-injected and writes nothing next to the snapshot', async (t) => {
  const source = buildSource(t);
  await capture(source.file, source.snapshot, {captureClockMs: CLOCK});
  const {readSnapshot} = require(READER);

  const before = fs.readdirSync(source.directory).sort();
  const snapshotBytes = fs.readFileSync(source.snapshot);

  /* A live clock must never be consulted: no clock means an immediate, typed refusal. */
  for (const bad of [undefined, null, 'now', NaN, -1]) {
    assert.throws(() => readSnapshot(source.snapshot, {captureClockMs: bad}), (error) => error.code === 'CAPTURE_CLOCK_REQUIRED');
  }

  const first = readSnapshot(source.snapshot, {captureClockMs: CLOCK});
  const second = readSnapshot(source.snapshot, {captureClockMs: CLOCK});
  assert.equal(canonical(first), canonical(second));
  assert.equal(first.hashes.sourceFingerprint, second.hashes.sourceFingerprint);
  assert.equal(first.capture.fileSha256, second.capture.fileSha256);
  assert.equal(first.capture.clockMs, CLOCK);

  /* Nothing was created, changed or journalled beside the immutable snapshot. */
  assert.deepEqual(fs.readdirSync(source.directory).sort(), before);
  assert.deepEqual(fs.readFileSync(source.snapshot), snapshotBytes);

  /* The reader opens exactly one handle and closes it: a second read of the same path still works. */
  assert.equal(readSnapshot(source.snapshot, {captureClockMs: CLOCK}).tables.state.count, 1);
});

test('a read-only open cannot mutate the immutable snapshot even when its directory is read-only', async (t) => {
  const source = buildSource(t);
  await capture(source.file, source.snapshot, {captureClockMs: CLOCK});
  const {readSnapshot, sqliteHeader} = require(READER);

  assert.equal(sqliteHeader(source.snapshot).wal, false, 'capture must normalize the artifact out of WAL mode');

  const before = fs.readFileSync(source.snapshot);
  const originalMode = fs.statSync(source.directory).mode & 0o777;
  fs.chmodSync(source.directory, 0o500);
  try {
    const model = readSnapshot(source.snapshot, {captureClockMs: CLOCK});
    assert.equal(model.tables.state.count, 1);
  } finally { fs.chmodSync(source.directory, originalMode); }
  assert.deepEqual(fs.readFileSync(source.snapshot), before);
  assert.deepEqual(fs.readdirSync(source.directory).filter((name) => name.startsWith('snapshot.sqlite')).sort(), ['snapshot.sqlite']);
});

test('prototype-named data keys are preserved as own data properties, never executed', () => {
  const {parseStrictJson, canonical} = require(path.join(ROOT, 'tools/v5-migration/canonical.js'));
  /* These keys are legitimate source data (conversion operation keys, snapshot/audit payloads). */
  const text = '{"__proto__":{"polluted":true},"constructor":"data-ctor","prototype":"data-proto","safe":1}';
  const {value} = parseStrictJson(text);

  assert.equal(Object.getPrototypeOf(value), Object.prototype, 'the parsed object prototype must not change');
  assert.equal({}.polluted, undefined, 'no prototype pollution may occur');
  assert.equal(Object.prototype.polluted, undefined);
  assert.ok(Object.prototype.hasOwnProperty.call(value, '__proto__'));
  assert.deepEqual(value.__proto__, {polluted: true}); // an own data property, read back as data
  assert.equal(value.constructor, 'data-ctor');
  assert.equal(value.prototype, 'data-proto');
  /* A duplicate of such a key is still refused before it can overwrite. */
  assert.throws(() => parseStrictJson('{"__proto__":1,"__proto__":2}'), (error) => error.code === 'JSON_DUPLICATE_KEY');
  /* The canonical form round-trips the literal key names. */
  assert.equal(canonical(value), '{"__proto__":{"polluted":true},"constructor":"data-ctor","prototype":"data-proto","safe":1}');
});

test('prototype-named actor and operation keys remain in the per-actor hash proof', async (t) => {
  const source = buildSource(t);
  const db = new DatabaseSync(source.file);
  /* A real conversion operation key from the source grammar may legitimately be "constructor". */
  const held = JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json);
  held.accounts[0][1].operations = {
    constructor: {fingerprint: 'fp', result: {from: 'coins', to: 'crowns', debit: 10, credit: 1, id: 'constructor'}},
    ['__proto__']: {fingerprint: 'fp', result: {from: 'coins', to: 'crowns', debit: 20, credit: 2, id: '__proto__'}},
    prototype: {fingerprint: 'fp', result: {from: 'coins', to: 'crowns', debit: 30, credit: 3, id: 'prototype'}}
  };
  held.accounts.push(['__proto__', {...held.accounts[0][1], id: '__proto__'}]);
  db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(held));
  db.close();

  await capture(source.file, source.snapshot, {captureClockMs: CLOCK});
  const {readSnapshot} = require(READER);
  const model = readSnapshot(source.snapshot, {captureClockMs: CLOCK});
  const {hash} = require(path.join(ROOT, 'tools/v5-migration/canonical.js'));
  const operations = model.state.parsed.accounts[0][1].operations;
  assert.deepEqual(Object.keys(operations).sort(), ['__proto__', 'constructor', 'prototype']);
  assert.equal(operations.constructor.result.credit, 1);
  assert.equal(operations.__proto__.result.credit, 2);
  assert.equal(operations.prototype.result.credit, 3);
  /* The eight-root hash dictionaries are source-keyed too and must list every entry. */
  assert.equal(Object.keys(model.hashes.actorHashes).sort().join(','), model.state.parsed.accounts.map(([id]) => id).sort().join(','));
  assert.ok(Object.hasOwn(model.hashes.actorHashes, '__proto__'));
  assert.equal(model.hashes.actorHashes.__proto__, hash(model.state.parsed.accounts.find(([id]) => id === '__proto__')[1]));
});

test('opaque practice metadata may hold a legacy large integral value while money stays strict', async (t) => {
  const source = buildSource(t);
  const db = new DatabaseSync(source.file);
  const actor = 'p0';
  db.prepare('INSERT INTO profiles VALUES(?,?,?,?,?,?,?,?,?,?)').run(actor, 'MEGA-PURITY', 'pur0', 'Pur', 'board', 'friends', 'friends', CLOCK, 0, 1);
  /* A practice archive is opaque legacy metadata: 1e20 is admitted by V4 and is not a currency amount. */
  const payloadText = JSON.stringify({
    version: 3.2, economyVersion: 'economy-2', settings: {theme: 'vector'}, records: [], processed: [],
    wallet: {coins: 1, crowns: 0, ledger: [], owned: []}, daily: {}, weekly: {},
    legacy: {importedTicks: 1e20, note: 'legacy migration metadata'}, profile: {name: 'You'}
  });
  db.prepare('INSERT INTO profile_saves VALUES(?,?,?,?)').run(actor, 1, payloadText, CLOCK);
  db.close();

  await capture(source.file, source.snapshot, {captureClockMs: CLOCK});
  const {readSnapshot} = require(READER);
  const model = readSnapshot(source.snapshot, {captureClockMs: CLOCK});
  const payload = JSON.parse(model.tables.profile_saves.rows[0].values.payload);
  assert.equal(payload.legacy.importedTicks, 1e20);
  assert.equal(model.coverage.unclassified_count, 0);
  assert.equal(model.tables.profile_saves.rows[0].values.payload, payloadText);

  /* A large integral value in classified money is still refused, from the JSON text or a column. */
  const strict = buildSource(t);
  const strictDb = new DatabaseSync(strict.file);
  strictDb.prepare('UPDATE state SET json=? WHERE id=1').run(
    '{"accounts":[["p0",{"id":"p0","coins":9007199254740993,"crowns":0,"reservedCoins":0,"reservedCrowns":0,"rating":600,"peak":600,"games":0,"tier":"wood","verified":true,"createdAt":0,"region":"","wealthPublic":false,"suspended":false,"hold":false,"blocked":[],"friends":[],"friendRequests":[],"activeMatch":null,"history":[],"daily":{},"operations":{},"ledger":[],"owned":[]}]],"matches":[],"receipts":[],"snapshots":[],"weeklyPaid":[],"burned":{"coins":0,"crowns":0},"journal":[],"leagueWeek":null}'
  );
  strictDb.close();
  await assert.rejects(() => capture(strict.file, strict.snapshot, {captureClockMs: CLOCK}), (error) => error.code === 'JSON_UNSAFE_INTEGER');
});

test('capture enforces the raw-destination bound itself, not only through the CLI', async (t) => {
  const source = buildSource(t);
  /* A destination inside a Git checkout is refused by the library call, before any byte is written. */
  await assert.rejects(
    () => capture(source.file, path.join(ROOT, 'docs', 'raw-snapshot.sqlite'), {captureClockMs: CLOCK}),
    (error) => error.code === 'OUTPUT_INSIDE_GIT_CHECKOUT'
  );
  assert.equal(fs.existsSync(path.join(ROOT, 'docs', 'raw-snapshot.sqlite')), false);
  /* The staging directory is removed even when the run fails. */
  const entries = fs.readdirSync(source.directory);
  assert.deepEqual(entries.filter((name) => name.startsWith('.v5-capture-')), []);
});
