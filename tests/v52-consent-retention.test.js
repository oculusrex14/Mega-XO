/* V5.2 DC00/D1 - one-time research consent, the retention schedule as data, and the retention
 * jobs. Two layers:
 *
 *   PURE (always runs): the schedule is data, a copy never extends its source, the journal target
 *   is run-scoped, the archive carries the subject's research decision, and no absent decision is
 *   ever read as a grant.
 *
 *   REAL DATABASE (skips with a clear reason): the migration's CHECK constraints, the withdrawal
 *   fence, the spool bound and the export consent fence, against an owned lab PostgreSQL.
 *   It skips unless V5_PG_URL (owned, loopback) or V5_PG_REQUIRED=1 is set, exactly like the other
 *   gameplay suites; it never points at staging or production.
 *
 * Run: node --test --test-force-exit tests/v52-consent-retention.test.js
 */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs').promises, path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const C = require('../packages/learning/capture.js');
const P = require('../packages/learning/privacy.js');
const S = require('../packages/learning/encrypted.js');
const X = require('../packages/learning/exporter.js');
const R = require('../packages/learning/policy.js');
const { source } = require('./helpers/gameplay-fixture.js');
const provenance = { sourceCommit: 'a'.repeat(40), environment: 'production', population: 'human-v-human' };

/* ---------------------------------------------------------------- pure: the schedule */

test('the owner-approved schedule is data, with a basis and a review duty on every class', () => {
 assert.ok(R.SCHEDULE.length >= 10);
 for (const row of R.SCHEDULE) {
  assert.match(row.classId, /^[a-z][a-z0-9.-]{0,79}$/, row.classId);
  assert.ok(['consent','necessary-operational','legal-obligation','fraud-prevention','operations','security','separate-lawful-protocol'].includes(row.basis), row.classId);
  assert.ok(row.days === null || (Number.isSafeInteger(row.days) && row.days >= 1), row.classId);
  // A class with no window must carry a review obligation; a window must be justified without one.
  if (row.days === null) assert.equal(row.legalReviewRequired, true, row.classId);
 }
});

test('the five approved windows are exactly 24 months, 90, 90, 7 and 35 days', () => {
 assert.equal(R.scheduleFor('capture.adult-gameplay-consented').days, 730);
 assert.equal(R.scheduleFor('capture.adult-gameplay-consented').reviewIntervalDays, 365);
 assert.equal(R.scheduleFor('export.working-research').days, 90);
 assert.equal(R.scheduleFor('export.working-research').neverPastSource, true);
 assert.equal(R.scheduleFor('analytics.raw-ad').days, 90);
 assert.equal(R.scheduleFor('spool.pending-upload').days, 7);
 assert.equal(R.scheduleFor('backup.ordinary-encrypted').days, 35);
});

test('purchases, fraud, operations and security have separate necessary schedules, never an invented window', () => {
 for (const id of ['purchase.records','fraud.integrity','operations.support','security.audit']) {
  const row = R.scheduleFor(id);
  assert.equal(row.days, null, id);
  assert.equal(row.legalReviewRequired, true, id);
  assert.notEqual(row.basis, 'consent', id);
 }
});

test('youth research is a separate lawful protocol and can never carry an adult window', () => {
 const youth = R.scheduleFor('youth.research-protocol');
 assert.equal(youth.basis, 'separate-lawful-protocol');
 assert.equal(youth.days, null);
 assert.notEqual(youth.days, R.scheduleFor('capture.adult-gameplay-consented').days);
});

test('a copy can never extend its source: the bound is min(scheduled, source)', () => {
 assert.equal(R.boundExpiry(1000, 900), 900);
 assert.equal(R.boundExpiry(900, 1000), 900);
 assert.equal(R.boundExpiry(1000, null), 1000);
 assert.equal(R.boundExpiry(null, 900), 900);
 assert.equal(R.boundExpiry(null, null), null);
 assert.equal(R.boundExpiry(1000, 1000), 1000);
});

/* ---------------------------------------------------------------- pure: the engine contract */

function engineDb(rows) {
 const calls = [];
 return { calls, query: async (sql, args = []) => {
  calls.push([sql.replace(/\s+/g, ' ').trim(), args]);
  if (sql.includes('retention_status')) return { rows: [{ value: rows }] };
  if (sql.includes('backup_prune_ready')) return { rows: [{ value: true }] };
  if (sql.includes('journal_obligation')) return { rows: [{ value: { due: false, journalEpoch: 2, liveEpoch: 2, cipherSha256: 'a'.repeat(64), records: 3, watermarks: 4 } }] };
  return { rows: [{ value: 0 }] };
 }};
}
const status = (over = {}) => ({
 schedule: R.SCHEDULE.map(r => ({ classId: r.classId, basis: r.basis, windowDays: r.days, legalReviewRequired: r.legalReviewRequired })),
 retentionDays: 730, exportRetentionDays: 90, backupRetentionDays: 35, ...over,
});

test('runRetention sweeps each kind idempotently and refuses an unknown kind or a bad clock', async () => {
 for (const kind of R.KINDS) {
  const db = engineDb(status());
  const a = await R.runRetention(db, { now: 1760000000000, kind });
  const b = await R.runRetention(db, { now: 1760000000000, kind });
  assert.deepEqual(a, b, kind);
  assert.equal(a.kind, kind);
  assert.equal(a.at, new Date(1760000000000).toISOString());
 }
 await assert.rejects(R.runRetention(engineDb(status()), { now: 1, kind: 'everything' }), /CAPTURE_RETENTION_KIND/);
 await assert.rejects(R.runRetention(engineDb(status()), { now: -1, kind: 'captures' }), /CAPTURE_RETENTION_CLOCK/);
 await assert.rejects(R.runRetention(engineDb(status()), { now: 1, kind: 'captures', limit: 0 }), /CAPTURE_RETENTION_ARGUMENT/);
 await assert.rejects(R.runRetention({}, { now: 1, kind: 'captures' }), /CAPTURE_RETENTION_DATABASE/);
});

test('a sweep refuses to delete on an unapproved number: drift, a missing window and a youth class all fail closed', async () => {
 await assert.rejects(R.runRetention(engineDb(status({ schedule: R.SCHEDULE.map(r => ({ classId: r.classId, basis: r.basis, windowDays: r.classId === 'capture.adult-gameplay-consented' ? 7300 : r.days, legalReviewRequired: r.legalReviewRequired })) })), { now: 1, kind: 'captures' }), /CAPTURE_RETENTION_SCHEDULE_DRIFT/);
 await assert.rejects(R.runRetention(engineDb(status({ schedule: [] })), { now: 1, kind: 'captures' }), /CAPTURE_RETENTION_SCHEDULE_MISSING/);
 const legal = status({ schedule: R.SCHEDULE.map(r => ({ classId: r.classId, basis: r.basis, windowDays: r.classId === 'purchase.records' ? 100 : r.days, legalReviewRequired: r.legalReviewRequired })) });
 await assert.rejects(R.windowDays(engineDb(legal), 'purchase.records'), /CAPTURE_RETENTION_SCHEDULE_DRIFT/, 'a stored window that contradicts the approved schedule is drift, a stronger refusal than the review duty');
 await assert.rejects(R.windowDays(engineDb(status()), 'purchase.records'), /CAPTURE_RETENTION_LEGAL_REVIEW_REQUIRED/);
 await assert.rejects(R.windowDays(engineDb(status()), 'youth.research-protocol'), /CAPTURE_RETENTION_SEPARATE_PROTOCOL/);
 assert.throws(() => R.scheduleFor('some.other.class'), /CAPTURE_RETENTION_CLASS_UNKNOWN/);
});

test('the backup sweep reports the journal obligation and never claims prune permission it does not have', async () => {
 const ready = await R.sweepBackups(engineDb(status()));
 assert.equal(ready.pruneReady, true);
 assert.equal(ready.journalObligation, 'CURRENT');
 assert.equal(ready.windowDays, 35);
 const notReady = engineDb(status());
 notReady.query = (sql => { const base = engineDb(status()).query; return async (s, a) => (s.includes('backup_prune_ready') ? { rows: [{ value: false }] } : base(s, a)); })();
 const held = await R.sweepBackups(notReady);
 assert.equal(held.pruneReady, false);
 assert.equal(held.pruneAllowed, false);
 assert.equal(held.watermarksPruned, 0, 'nothing is pruned while pruning is unverified');
});

/* ---------------------------------------------------------------- pure: the journal target */

test('the journal target is run-scoped, UTC-sortable and never the fixed path that collided every run', () => {
 const base = '/var/lib/mega-xo/capture/privacy-journal.mxojournal';
 const a = P.journalTarget(base, Date.parse('2026-10-14T02:22:49Z'));
 const b = P.journalTarget(base, Date.parse('2026-10-14T02:37:49Z'));
 assert.equal(a, '/var/lib/mega-xo/capture/privacy-journal-20261014T022249Z.mxojournal');
 assert.equal(b, '/var/lib/mega-xo/capture/privacy-journal-20261014T023749Z.mxojournal');
 assert.notEqual(a, base);
 assert.notEqual(a, b);
 assert.ok(a < b, 'lexicographic order is chronological order');
 // Sub-second differences collapse to one stamp, so a rerun in the same second is still refused
 // rather than silently overwriting.
 assert.equal(P.journalTarget(base, Date.parse('2026-10-14T02:22:49.900Z')), a);
 for (const bad of [undefined, '', '/', 'dir/', 'x/'.repeat(600), null]) assert.throws(() => P.journalTarget(bad, 0), /CAPTURE_JOURNAL_BASE_REQUIRED/, String(bad));
 assert.throws(() => P.journalTarget('/tmp/x.mxojournal', NaN), /CAPTURE_JOURNAL_CLOCK/);
});

test('a storage collision is reported as a CAPTURE_ code, never the CLI generic catch-all', () => {
 for (const [code, want] of [['EEXIST','CAPTURE_JOURNAL_TARGET_EXISTS'],['ENOENT','CAPTURE_JOURNAL_DIRECTORY_MISSING'],['EACCES','CAPTURE_JOURNAL_STORAGE_DENIED'],['EROFS','CAPTURE_JOURNAL_STORAGE_DENIED'],['ENOSPC','CAPTURE_JOURNAL_STORAGE_FULL']]) {
  const mapped = P.mapStorageFailure(Object.assign(new Error('synthetic'), { code }));
  assert.equal(mapped.message, want);
  assert.ok(/^CAPTURE_/.test(mapped.message));
 }
 const already = new Error('CAPTURE_ENCRYPTED_HEADER');
 assert.equal(P.mapStorageFailure(already), already);
 assert.equal(P.mapStorageFailure(new Error('synthetic')).message, 'CAPTURE_JOURNAL_FAILED');
});

/* ---------------------------------------------------------------- pure: two journal runs, no clobber */

function journalDb() {
 return { connect: async () => ({ query: async (sql) => {
  if (sql.includes('configuration')) return { rows: [{ value: { enabled: false, privacyEpoch: 3 } }] };
  if (sql.includes('privacy_page')) return { rows: [] };
  if (sql.includes('erasure_page')) return { rows: [] };
  return { rows: [] };
 }, release: () => {} }) };
}
test('two consecutive scheduled journal exports both succeed and both files survive; the run-scoped name is what makes that true', async t => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'v52-journal-'));
 await fs.chmod(dir, 0o700);
 t.after(() => fs.rm(dir, { recursive: true, force: true }));
 const base = path.join(dir, 'privacy-journal.mxojournal');
 const options = { key: crypto.randomBytes(32), keyId: 'v52-test' };
 const first = P.journalTarget(base, Date.parse('2026-10-14T02:22:49Z'));
 const second = P.journalTarget(base, Date.parse('2026-10-14T02:37:49Z'));
 const a = await P.exportPrivacyJournal(journalDb(), { ...options, file: first });
 const b = await P.exportPrivacyJournal(journalDb(), { ...options, file: second });
 assert.notEqual(a.cipherSha256, b.cipherSha256, 'each run publishes a distinct immutable file');
 const names = (await fs.readdir(dir)).sort();
 assert.deepEqual(names, ['privacy-journal-20261014T022249Z.mxojournal', 'privacy-journal-20261014T023749Z.mxojournal']);
 assert.equal(await S.verifyFile(first, options.key, { keyId: options.keyId, kind: 'privacy-journal' }), true);
 assert.equal(await S.verifyFile(second, options.key, { keyId: options.keyId, kind: 'privacy-journal' }), true);
 // The replay path is pointed at the newest journal by the lexicographically last name, and its
 // digest is the one that must be replayed.
 const newest = P.journalTarget(base, Date.parse('2026-10-14T02:37:49Z'));
 assert.equal(newest, path.join(dir, names.at(-1)));
 // A third run forced onto an existing path must still refuse to overwrite, with the diagnostic code.
 await assert.rejects(P.exportPrivacyJournal(journalDb(), { ...options, file: first }), /CAPTURE_JOURNAL_TARGET_EXISTS/);
 assert.equal((await fs.readdir(dir)).length, 2, 'the refusal never removed the surviving journal');
});

/* ---------------------------------------------------------------- pure: the consent decision in the archive */

test('the archive carries the subject research decision, and an absent decision is never a grant', () => {
 const granted = C.seal(source(4), { ...provenance, researchEligible: true });
 assert.deepEqual(granted.payload.consent, { researchEligible: true, basis: 'one-time-subject-choice' });
 assert.equal(C.validate(granted.payload, granted.sha256).plies, granted.payload.moves.length);
 const declined = C.seal(source(4), { ...provenance, researchEligible: false });
 assert.equal(declined.payload.consent.researchEligible, false);
 const undecided = C.seal(source(4), { ...provenance, researchEligible: null });
 assert.equal(undecided.payload.consent.researchEligible, null, 'no decision on file is not consent');
 assert.throws(() => C.seal(source(4), { ...provenance, researchEligible: 'yes' }), /CAPTURE_RESEARCH_DECISION/);
});

test('a pre-0052 archive still validates unchanged and is never reinterpreted as consent', () => {
 const r = C.seal(source(5), provenance);
 const legacy = JSON.parse(JSON.stringify(r.payload));
 delete legacy.consent;
 assert.equal(C.validate(legacy).plies, legacy.moves.length);
 assert.ok(!Object.hasOwn(legacy, 'consent'));
 // The new shape is still bound to its own checksum, and a forged decision breaks it.
 const forged = JSON.parse(JSON.stringify(r.payload));
 forged.consent.researchEligible = true;
 assert.notEqual(C.sha256(forged), r.sha256);
 assert.throws(() => C.validate(forged, r.sha256), /CAPTURE_HASH/);
 const badBasis = JSON.parse(JSON.stringify(r.payload));
 badBasis.consent.basis = 'pre-ticked';
 assert.throws(() => C.validate(badBasis), /CAPTURE_CONSENT_SHAPE/);
 const badField = JSON.parse(JSON.stringify(r.payload));
 badField.consent.demographic = 'adult';
 assert.throws(() => C.validate(badField), /CAPTURE_CONSENT_SHAPE/);
});

/* ---------------------------------------------------------------- pure: the exporter fence */

test('a recorded research decline is excluded from a dataset, and an unrecorded decision changes nothing', async t => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'v52-export-'));
 await fs.chmod(dir, 0o700);
 t.after(() => fs.rm(dir, { recursive: true, force: true }));
 const rows = [true, false, null].map((decision, i) => {
  const v = C.seal(source(i + 11), { ...provenance, researchEligible: decision });
  return { capture_id: C.sha256('v52-' + i), payload: C.stable(v.payload), payload_sha256: v.sha256 };
 }).sort((a, b) => a.capture_id.localeCompare(b.capture_id));
 const runs = new Map();
 const db = { query: async (sql, args = []) => {
  const id = args[0];
  if (sql.includes('begin_export')) { runs.set(id, { state: 'building', privacyEpoch: 0, members: [] }); return { rows: [{ value: { policyVersion: 'v52-test' } }] }; }
  if (sql.includes('export_page')) { if (runs.get(id).state !== 'building') throw Error('CAPTURE_EXPORT_REVOKED'); return { rows: rows.filter(r => r.capture_id > args[1]).slice(0, args[2]) }; }
  if (sql.includes('export_member')) runs.get(id).members.push(args[1]);
  if (sql.includes('finish_export')) { const r = runs.get(id); r.state = 'ready'; r.manifest = args[1]; }
  if (sql.includes('revoke_export')) runs.get(id).state = 'revoked';
  if (sql.includes('export_status')) return { rows: [{ value: runs.get(id) }] };
  return { rows: [] };
 }};
 const out = await X.exportDataset(db, { directory: dir, key: crypto.randomBytes(32), keyId: 'v52-test', pseudonymKey: crypto.randomBytes(32), splitSeed: 'v52-frozen-v1', privacyEpoch: 0, positions: false });
 assert.equal(out.manifest.stats.excludedConsent, 1, 'the recorded decline never reaches a dataset');
 assert.equal(out.manifest.stats.accepted, 2, 'granted and undecided still follow the existing eligibility rules');
});

/* ---------------------------------------------------------------- the release receipt */

const RECEIPT = path.join(__dirname, '..', 'docs', 'v5.2', 'release', 'dc00-consent-retention-receipt.json');
const GATE = require('../packages/learning/release-gate.js');

test('the new receipt carries all 15 gate classes with a non-blank artifact inside the 1000-character budget', () => {
 const receipt = JSON.parse(require('node:fs').readFileSync(RECEIPT, 'utf8'));
 assert.equal(receipt.format, 'day-one-gameplay-capture-receipt/v1');
 assert.equal(receipt.rulesHash, C.RULES_HASH);
 assert.deepEqual(Object.keys(receipt.evidence).sort(), [...GATE.REQUIRED].sort());
 for (const key of GATE.REQUIRED) {
  const e = receipt.evidence[key];
  assert.equal(e.status, 'PASS', key);
  assert.equal(typeof e.artifact, 'string', key);
  assert.ok(e.artifact.trim().length > 0, key);
  assert.ok(e.artifact.length <= 1000, `${key} is ${e.artifact.length} characters`);
 }
 // The two classes this work supplies must name the implemented mechanism and its reproducing test,
 // and the document must keep the legal questions explicitly outside the claim.
 assert.match(receipt.evidence.privacyPurpose.artifact, /0052/);
 assert.match(receipt.evidence.privacyPurpose.artifact, /consent_affirmative_required_ck/);
 assert.match(receipt.evidence.privacyPurpose.artifact, /tests\/v52-consent-retention\.test\.js/);
 assert.match(receipt.evidence.retention.artifact, /retention_schedule/);
 assert.match(receipt.evidence.retention.artifact, /packages\/learning\/policy\.js/);
 assert.match(receipt.evidence.retention.artifact, /tests\/v52-consent-retention\.test\.js/);
 assert.match(receipt.note, /NOT legal approval/i);
 assert.match(receipt.absent.noticeAndControllerSignoff, /owed/i);
 assert.match(receipt.absent.retentionLegalBasis, /legal/i);
});

test('bound to a source commit, the gate no longer reports the two previously-missing classes', () => {
 const sourceCommit = 'f'.repeat(40);
 const receipt = JSON.parse(require('node:fs').readFileSync(RECEIPT, 'utf8'));
 const now = Date.now();
 const stamp = { ...receipt, sourceCommit, checkedAt: new Date(now).toISOString() };
 // Take the policy identity from the committed receipt rather than hardcoding a revision: the point
 // of this test is that the receipt BINDS to the deployed policy, not that a particular version
 // string was frozen forever. A receipt must still fail when the binding does not match.
 const configuration = { enabled: true, sourceCommit, rulesHash: C.RULES_HASH, environment: receipt.environment, policyVersion: receipt.policyVersion, privacyEpoch: receipt.privacyEpoch };
 const metrics = { pending: 0, quarantined: 0, expiredUnpurged: 0, sealed: 1 };
 const report = GATE.assess({ sourceCommit, configuration, metrics, receipt: stamp, now });
 assert.ok(!report.failures.includes('MISSING_privacyPurpose'), JSON.stringify(report.failures));
 assert.ok(!report.failures.includes('MISSING_retention'), JSON.stringify(report.failures));
 assert.deepEqual(report.failures, []);
 assert.equal(report.result, 'RECEIPTS_READY_FOR_MAIN_REVIEW');
 // A green receipt is evidence, never authorization.
 assert.equal(report.productionAuthorized, false);
 assert.equal(report.trainingAuthorized, false);
 // The same evidence bound to a DIFFERENT source commit must still be refused: the binding is real.
 const wrong = GATE.assess({ sourceCommit, configuration, metrics, receipt: { ...stamp, sourceCommit: 'b'.repeat(40) }, now });
 assert.ok(wrong.failures.includes('RECEIPT_BINDING'));
 // And a blank artifact for either class still fails, so this receipt is evidence and not a bypass.
 for (const key of ['privacyPurpose', 'retention']) {
  const broken = { ...stamp, evidence: { ...stamp.evidence, [key]: { status: 'PASS', artifact: '' } } };
  assert.ok(GATE.assess({ sourceCommit, configuration, metrics, receipt: broken, now }).failures.includes('MISSING_' + key), key);
 }
});

/* ---------------------------------------------------------------- real database */

const lab = require('./v5-pg-lab.js');
const roles = ['capture_runtime', 'capture_exporter', 'capture_privacy'];
lab.installCleanup(test);

async function policyOn(admin, extra = '') {
 await admin.query(`UPDATE learning.policy SET enabled=true,policy_version='v52-test',approval_ref='synthetic-not-legal-approval',
  encryption_ref='synthetic-isolated-cluster',choice_ref='synthetic-test',capture_after='epoch',retention_days=730,
  export_retention_days=90,backup_retention_days=35,source_commit=$1,rules_hash=$2,environment='test' ${extra}`, ['a'.repeat(40), C.RULES_HASH]);
}
/* A sealed capture with a payload that satisfies the 0044 format CHECKs (the test never replays it). */
async function insertCapture(admin, cid, sourceId, seconds = 2592000) {
 const payload = JSON.stringify({ format: 'game-capture/v1', moves: [] });
 const sha = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
 await admin.query(`INSERT INTO learning.captures(capture_id,source_kind,source_id,source_attempt,policy_version,source_commit,rules_hash,environment,intent_at,expires_at,sealed_at,state,payload,payload_sha256,source_token)
  VALUES($1,'match',$2,0,'v52-test',$3,$4,'test',clock_timestamp(),clock_timestamp()+make_interval(secs=>$5::double precision),clock_timestamp(),'sealed',$6,$7,$7)`,
  [cid, sourceId, 'a'.repeat(40), C.RULES_HASH, seconds, payload, sha]);
}

test('0052 consent and retention: no pre-ticked default, adult-only affirmative, withdrawal dominates, and the export fence', async t => {
 if (!await lab.boot(t)) return;   // skips with 'no V5_PG_URL' when no owned lab cluster is configured
 const { Pool } = require('pg');
 const db = await lab.createDatabase('v52_consent', { runtimeRoles: [...lab.RUNTIME_ROLES, ...roles] });
 await lab.seedActors(db);
 const admin = await lab.adminClient(db); t.after(() => admin.end());
 await policyOn(admin);
 const pools = {};
 for (const role of roles) { const u = new URL(lab.dbUrl(db)); u.username = role; u.password = ''; pools[role] = new Pool({ connectionString: u.toString(), max: 2 }); t.after(() => pools[role].end()); }
 const privacy = pools.capture_privacy, exp = pools.capture_exporter;
 const val = async (sql, args = []) => Object.values((await admin.query(sql, args)).rows[0] || {})[0];

 await t.test('the migration applied on top of 0051 and re-applies with nothing pending', async () => {
  assert.equal(lab.CHAIN_LENGTH, 52, 'the manifest carries exactly the 0044-0052 chain');
  const again = lab.runMigrator(db);
  assert.equal(again.status, 0);
  assert.equal(again.json.appliedCount, 0);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM meta.migrations')).rows[0].n, 52);
  const ledger = (await admin.query('SELECT name FROM meta.migrations WHERE id=52')).rows[0].name;
  assert.equal(ledger, '0052_research_consent_and_retention');
 });

 await t.test('absence of a record means NOT consented, and there is no pre-ticked default', async () => {
  assert.equal(await val("SELECT count(*)::int FROM learning.consent"), 0);
  assert.equal(await val("SELECT learning.research_eligible($1)", ['f'.repeat(64)]), false);
  // A row cannot even claim a choice without an explicit version, and cannot grant without an adult band.
  await assert.rejects(admin.query("INSERT INTO learning.consent(actor_id,necessary_notice_version,optional_research,consent_version,granted_at,age_band) VALUES('svc_alice','notice-v1',true,NULL,clock_timestamp(),'adult')"),
   (e) => e.code === '23502', 'consent_version is NOT NULL');
  await assert.rejects(admin.query("INSERT INTO learning.consent(actor_id,necessary_notice_version,optional_research,consent_version,granted_at,age_band) VALUES('svc_alice','notice-v1',true,'v1',clock_timestamp(),'youth')"),
   (e) => e.code === '23514', 'an affirmative may only be an adult');
  await assert.rejects(admin.query("INSERT INTO learning.consent(actor_id,necessary_notice_version,optional_research,consent_version,granted_at,age_band) VALUES('svc_alice','notice-v1',true,'v1',NULL,'adult')"),
   (e) => e.code === '23514', 'an affirmative needs an explicit granted_at');
  await assert.rejects(admin.query("INSERT INTO learning.consent(actor_id,necessary_notice_version,optional_research,consent_version,granted_at,age_band) VALUES('svc_alice','notice-v1',false,'v1',clock_timestamp(),'adult')"),
   (e) => e.code === '23514', 'an operational-only record may not look like an unrecorded grant');
  assert.equal(await val("SELECT count(*)::int FROM learning.consent"), 0, 'nothing was written by the refusals');
 });

 await t.test('the one-time choice is recorded once and the necessary notice is separate from the optional one', async () => {
  await privacy.query("SELECT learning.record_consent('svc_alice','notice-necessary-v1',true,'choice-v1','adult')");
  await privacy.query("SELECT learning.record_consent('svc_bob','notice-necessary-v1',false,'choice-v1','unknown')");
  await privacy.query("SELECT learning.record_consent('svc_operational','notice-necessary-v1',false,'choice-v1','unknown')");
  const alice = (await admin.query("SELECT * FROM learning.consent WHERE actor_id='svc_alice'")).rows[0];
  assert.equal(alice.optional_research, true);
  assert.equal(alice.age_band, 'adult');
  assert.ok(alice.granted_at instanceof Date);
  assert.equal(alice.withdrawn_at, null);
  const bob = (await admin.query("SELECT * FROM learning.consent WHERE actor_id='svc_bob'")).rows[0];
  assert.equal(bob.optional_research, false);
  assert.equal(bob.granted_at, null);
  assert.equal(bob.necessary_notice_version, 'notice-necessary-v1');
  // A youth/unknown subject cannot be recorded as an adult research affirmative.
  await assert.rejects(privacy.query("SELECT learning.record_consent('svc_carol','notice-necessary-v1',true,'choice-v1','youth')"), /CAPTURE_CONSENT_ADULT_ONLY/);
  // A repeated choice is idempotent on identity and does not invent a second grant time.
  await privacy.query("SELECT learning.record_consent('svc_alice','notice-necessary-v1',true,'choice-v1','adult')");
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM learning.consent WHERE actor_id IN ('svc_alice','svc_bob')")).rows[0].n, 2, 'a repeated choice updates the row, it does not add one');
  assert.equal((await admin.query("SELECT granted_at FROM learning.consent WHERE actor_id='svc_alice'")).rows[0].granted_at.getTime(), alice.granted_at.getTime());
  assert.equal((await privacy.query('SELECT learning.consent_summary() AS value')).rows[0].value.researchAffirmative, 1);
 });

 // Turning an affirmative into "no" is a withdrawal, not a silent flag flip: it fences the
 // records already archived under the grant.
 await privacy.query("SELECT learning.record_consent('svc_redecline','notice-necessary-v1',true,'choice-v1','adult')");
 assert.equal(await val("SELECT optional_research FROM learning.consent WHERE actor_id='svc_redecline'"), true);
 const epochBefore = await val('SELECT privacy_epoch FROM learning.policy');
 const epochAfter = (await privacy.query("SELECT learning.record_consent('svc_redecline','notice-necessary-v1',false,'choice-v2','adult') AS epoch")).rows[0].epoch;
 assert.ok(epochAfter > epochBefore, 'changing an affirmative to no raises the epoch');
 assert.equal(await val("SELECT optional_research FROM learning.consent WHERE actor_id='svc_redecline'"), false);
 assert.equal(await val("SELECT withdrawn_at IS NOT NULL FROM learning.consent WHERE actor_id='svc_redecline'"), true);
 assert.ok((await admin.query("SELECT count(*)::int AS n FROM learning.suppressions WHERE actor_id='svc_redecline'")).rows[0].n >= 1);
 // Withdrawal is durable: a withdrawn subject cannot re-affirm consent over the records that were
 // already collected, so the suppression the erasure path relies on is never silently removed.
 await assert.rejects(privacy.query("SELECT learning.record_consent('svc_redecline','notice-necessary-v1',true,'choice-v3','adult')"), /CAPTURE_CONSENT_WITHDRAWN/);
 assert.equal(await val("SELECT optional_research FROM learning.consent WHERE actor_id='svc_redecline'"), false);
 assert.ok((await admin.query("SELECT count(*)::int AS n FROM learning.suppressions WHERE actor_id='svc_redecline'")).rows[0].n >= 1);
 // A subject who never withdrew and is still affirmative can refresh the necessary notice freely.
 await privacy.query("SELECT learning.record_consent('svc_alice','notice-necessary-v2',true,'choice-v2','adult')");
 assert.equal(await val("SELECT necessary_notice_version FROM learning.consent WHERE actor_id='svc_alice'"), 'notice-necessary-v2');

 await t.test('the stored schedule and the engine agree, and a legal-review class can never be swept', async () => {
  const status = (await privacy.query('SELECT learning.retention_status() AS value')).rows[0].value;
  assert.deepEqual(await R.retentionStatus(privacy), status, 'the engine refuses any drift between the DB rows and the approved schedule');
  assert.equal(status.retentionDays, 730);
  await assert.rejects(privacy.query("SELECT learning.withdraw_research('svc_alice',NULL)"), /CAPTURE_CONSENT_ARGUMENT/);
  const youth = status.schedule.find(x => x.classId === 'youth.research-protocol');
  assert.equal(youth.windowDays, null);
  assert.equal(youth.basis, 'separate-lawful-protocol');
 });

 await t.test('the client-upload spool is bounded by its window AND by its source', async () => {
  const cid = 'b'.repeat(64);
  await insertCapture(admin, cid, 'v52-spool', 3600);
  await admin.query(`INSERT INTO learning.upload_spool(spool_id,actor_id,kind,state,payload_sha256,byte_size,received_at,ingested_capture_id)
   VALUES('spool-source-bound','svc_alice','local-bot','ingested',$1,512,clock_timestamp(),$2)`, ['d'.repeat(64), cid]);
  await admin.query(`INSERT INTO learning.upload_spool(spool_id,actor_id,kind,payload_sha256,byte_size,received_at,expires_at)
   VALUES('spool-over-window','svc_alice','local-bot',$1,512,clock_timestamp(),clock_timestamp()+interval '90 days')`, ['e'.repeat(64)]);
  const bound = (await admin.query("SELECT expires_at FROM learning.upload_spool WHERE spool_id='spool-source-bound'")).rows[0].expires_at;
  const src = (await admin.query('SELECT expires_at FROM learning.captures WHERE capture_id=$1', [cid])).rows[0].expires_at;
  assert.ok(bound.getTime() <= src.getTime(), 'the spool copy cannot outlive its source');
  const capped = (await admin.query("SELECT received_at,expires_at FROM learning.upload_spool WHERE spool_id='spool-over-window'")).rows[0];
  assert.equal(capped.expires_at.getTime(), capped.received_at.getTime() + 7 * 86400000, 'a 90-day request is capped to the 7-day window');
  // Nothing is due yet, so the sweep is an idempotent no-op.
  assert.equal(await val('SELECT learning.purge_spool(500)'), 0);
  await admin.query(`UPDATE learning.upload_spool SET expires_at=clock_timestamp()-interval '1 second' WHERE spool_id='spool-over-window'`);
  const swept = await R.runRetention(privacy, { now: Date.now(), kind: 'spool' });
  assert.equal(swept.purged, 1);
  assert.equal((await R.runRetention(privacy, { now: Date.now(), kind: 'spool' })).purged, 0, 'a second sweep is a no-op');
  assert.equal(await val("SELECT count(*)::int FROM learning.upload_spool WHERE spool_id='spool-source-bound'"), 1);
 });

 await t.test('withdrawal records the choice, raises the epoch and is the property that dominates', async () => {
  // Both subjects must have affirmatively chosen adult research for the pair to be eligible, which
  // is the point: one operational-only participant is enough to keep the game out of research.
  await privacy.query("SELECT learning.record_consent('svc_carol','notice-necessary-v1',true,'choice-v1','adult')");
  await insertCapture(admin, '1'.repeat(64), 'v52-withdraw');
  await admin.query("INSERT INTO learning.capture_subjects(capture_id,actor_id,seat,symbol) VALUES($1,'svc_alice',0,'X'),($1,'svc_carol',1,'O')", ['1'.repeat(64)]);
  assert.deepEqual((await privacy.query('SELECT learning.research_decision($1) AS value', ['1'.repeat(64)])).rows[0].value, { eligible: true, recorded: true });
  const before = await val('SELECT privacy_epoch FROM learning.policy');
  const epoch = (await privacy.query("SELECT learning.withdraw_research('svc_alice') AS epoch")).rows[0].epoch;
  assert.ok(epoch > before, 'withdrawal raises the privacy epoch');
  assert.equal(await val("SELECT withdrawn_at IS NULL FROM learning.consent WHERE actor_id='svc_alice'"), false);
  assert.equal(await val("SELECT optional_research FROM learning.consent WHERE actor_id='svc_alice'"), false, 'no affirmative survives a withdrawal');
  assert.deepEqual((await privacy.query('SELECT learning.research_decision($1) AS value', ['1'.repeat(64)])).rows[0].value, { eligible: false, recorded: true });
  // The epoch bump makes every open export stale immediately, before the erasure sweep runs.
  await assert.rejects(exp.query("SELECT learning.begin_export($1,'k','gameplay-opening6-v1-20261013',0)", ['00000000-0000-4000-8000-000000000052']), /CAPTURE_EXPORT_PRIVACY_FENCE/);
 });

 await t.test('the export page and member write both honour the subject choice from the declared cutoff', async () => {
  // Two subjects affirmatively allow adult research -> research-eligible.
  await privacy.query("SELECT learning.record_consent('svc_bob','notice-necessary-v1',true,'choice-v1','adult')");
  await admin.query('UPDATE learning.policy SET consent_after=clock_timestamp() WHERE id');
  assert.equal(await val("SELECT learning.research_eligible($1)", ['4'.repeat(64)]), false);
  await insertCapture(admin, '4'.repeat(64), 'v52-eligible');
  await admin.query("INSERT INTO learning.capture_subjects(capture_id,actor_id,seat,symbol) VALUES($1,'svc_bob',0,'X'),($1,'svc_alice',1,'O')", ['4'.repeat(64)]);
  // alice withdrew in the previous case, so this pair is still ineligible: one participant is enough.
  assert.equal(await val("SELECT learning.research_eligible($1)", ['4'.repeat(64)]), false);
  // A pair consisting of one affirmative and one operational-only subject is ineligible too.
  await insertCapture(admin, '5'.repeat(64), 'v52-mixed');
  await admin.query("INSERT INTO learning.capture_subjects(capture_id,actor_id,seat,symbol) VALUES($1,'svc_bob',0,'X'),($1,'svc_operational',1,'O')", ['5'.repeat(64)]);
  // Both captures were sealed AFTER the declared cutoff, so both are in the enforced period: the ineligible rows must not be paged or attached.
  const epoch = await val("SELECT privacy_epoch FROM learning.policy");
  const begin = (await exp.query("SELECT learning.begin_export($1,'v52-key','gameplay-opening6-v1-20261013',$2) AS value",
   ['00000000-0000-4000-8000-000000000052', epoch])).rows[0].value;
  assert.ok(begin.highWater);
  const page = (await exp.query('SELECT * FROM learning.export_page($1)', ['00000000-0000-4000-8000-000000000052'])).rows;
  const ids = page.map(r => r.capture_id);
  assert.ok(!ids.includes('4'.repeat(64)), 'a pair with one withdrawn subject is never paged out');
  assert.ok(!ids.includes('5'.repeat(64)), 'a pair with one operational-only subject is never paged out');
  await assert.rejects(exp.query('SELECT learning.export_member($1,$2)', ['00000000-0000-4000-8000-000000000052', '5'.repeat(64)]), /CAPTURE_EXPORT_CONSENT_REQUIRED/);
  // A recorded decline is never governed by the cutoff: it always dominates, exactly like a withdrawal.
  await admin.query(`UPDATE learning.captures SET sealed_at=clock_timestamp()-interval '365 days' WHERE capture_id=$1`, ['5'.repeat(64)]);
  const page2 = (await exp.query('SELECT * FROM learning.export_page($1)', ['00000000-0000-4000-8000-000000000052'])).rows.map(r => r.capture_id);
  assert.ok(!page2.includes('5'.repeat(64)), 'a recorded decline is fenced even for an old capture');
  // A capture whose subjects never made a choice at all, sealed before the cutoff, keeps the
  // pre-existing (pre-0052) export semantics: history is not retroactively fenced.
  await insertCapture(admin, '6'.repeat(64), 'v52-undecided');
  await admin.query("INSERT INTO learning.capture_subjects(capture_id,actor_id,seat,symbol) VALUES($1,'svc_undecided_a',0,'X'),($1,'svc_undecided_b',1,'O')", ['6'.repeat(64)]);
  await admin.query(`UPDATE learning.captures SET sealed_at=clock_timestamp()-interval '1 hour' WHERE capture_id=$1`, ['6'.repeat(64)]);
  const page3 = (await exp.query('SELECT * FROM learning.export_page($1)', ['00000000-0000-4000-8000-000000000052'])).rows.map(r => r.capture_id);
  assert.ok(page3.includes('6'.repeat(64)), 'a capture with no recorded choice, sealed before the declared cutoff, is governed by the pre-existing rules');
  await exp.query('SELECT learning.export_member($1,$2)', ['00000000-0000-4000-8000-000000000052', '6'.repeat(64)]);
  assert.equal(await val("SELECT count(*)::int AS n FROM learning.export_members"), 1);
  // The regime declaration is reported so a receipt or a sweep can assert it.
  const ready = (await exp.query('SELECT learning.consent_regime_ready() AS value')).rows[0].value;
  assert.equal(ready.declared, true);
  assert.equal(ready.enforcedOnRealTarget, true);
  assert.ok(Number.isFinite(Date.parse(ready.consentAfter)), 'the declared cutoff is a real timestamp');
 });

 await t.test('the 35-day backup window is not enforceable until safe pruning is verified', async () => {
  assert.equal(await val('SELECT learning.backup_prune_ready()'), false);
  await assert.rejects(privacy.query('SELECT learning.set_backup_prune_enabled(true)'), /CAPTURE_BACKUP_PRUNE_NOT_VERIFIED/);
  await assert.rejects(privacy.query('SELECT learning.record_backup_prune(90,NULL,NULL)'), /CAPTURE_RETENTION_ARGUMENT/);
  await assert.rejects(privacy.query("SELECT learning.record_backup_prune(90,'synthetic-verified',NULL)"), /CAPTURE_RETENTION_SCHEDULE_DRIFT/);
  await privacy.query("SELECT learning.record_backup_prune(35,'synthetic-verified',NULL)");
  assert.equal(await val('SELECT learning.backup_prune_ready()'), false, 'a verified window is not permission: the operator must still enable the prune schedule');
  await privacy.query('SELECT learning.set_backup_prune_enabled(true)');
  assert.equal(await val('SELECT learning.backup_prune_ready()'), true);
  assert.equal((await R.sweepBackups(privacy)).pruneReady, true);
  await privacy.query('SELECT learning.set_backup_prune_enabled(false)');
  assert.equal(await val('SELECT learning.backup_prune_ready()'), false);
 });

 await t.test('journal watermarks record the replay obligation and prune only what is not needed', async () => {
  const first = (await privacy.query("SELECT learning.record_journal_watermark($1,$2,$3,4,'v52-key') AS value", [0, 'a'.repeat(64), 'b'.repeat(64)])).rows[0].value;
  const again = (await privacy.query("SELECT learning.record_journal_watermark($1,$2,$3,4,'v52-key') AS value", [0, 'a'.repeat(64), 'b'.repeat(64)])).rows[0].value;
  assert.equal(first, again, 'the watermark ledger is idempotent per (epoch, digest)');
  const obligation = (await privacy.query('SELECT learning.journal_obligation() AS value')).rows[0].value;
  assert.equal(typeof obligation.due, 'boolean');
  assert.equal(obligation.journalEpoch, 0);
  assert.ok(Number.isSafeInteger(obligation.ageSeconds));
  assert.equal(await val('SELECT learning.prune_journal_watermarks(20)'), 0, 'the newest row is never pruned');
 });

 await t.test('least privilege: zero table ACLs, and the retention lanes hold only their own functions', async () => {
  for (const role of ['capture_runtime', 'capture_exporter', 'capture_privacy', 'api_runtime', 'core_runtime', 'worker_runtime']) {
   const u = new URL(lab.dbUrl(db)); u.username = role; u.password = '';
   const p = new Pool({ connectionString: u.toString() });
   try {
    await assert.rejects(p.query('SELECT * FROM learning.consent'), (e) => e.code === '42501', role + ' must not read the consent table directly');
    await assert.rejects(p.query('SELECT * FROM learning.retention_schedule'), (e) => e.code === '42501', role + ' must not read the schedule table directly');
    await assert.rejects(p.query('SELECT * FROM learning.upload_spool'), (e) => e.code === '42501', role);
   } finally { await p.end(); }
  }
  // capture_runtime may read the research decision but may not record or withdraw a choice.
  await assert.rejects(pools.capture_runtime.query("SELECT learning.record_consent('svc_alice','n',false,'v','adult')"), (e) => e.code === '42501');
  await assert.rejects(pools.capture_runtime.query("SELECT learning.withdraw_research('svc_alice')"), (e) => e.code === '42501');
  await assert.rejects(pools.capture_exporter.query("SELECT learning.record_consent('svc_alice','n',false,'v','adult')"), (e) => e.code === '42501');
  assert.equal((await pools.capture_runtime.query('SELECT learning.research_decision($1) AS value', ['1'.repeat(64)])).rows[0].value.recorded, true);
 });
});
