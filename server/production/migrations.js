'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const migrations = Object.freeze([
 {id:1, name:'production-boundaries', sql:`
CREATE TABLE IF NOT EXISTS v4_controls (id INTEGER PRIMARY KEY CHECK(id=1), maintenance INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO v4_controls(id,maintenance) VALUES(1,0);
CREATE TABLE IF NOT EXISTS v4_limits (id TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS v4_outbox (id TEXT PRIMARY KEY, payload TEXT, kind TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, next_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS v4_outbox_due ON v4_outbox(state,next_at);
CREATE TABLE IF NOT EXISTS v4_email_versions (challenge TEXT PRIMARY KEY, credential_hash TEXT);
CREATE TABLE IF NOT EXISTS v4_runtime (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`},
 {id:2, name:'v41-operator-audit', sql:`
CREATE TABLE IF NOT EXISTS v41_operator_audit (
 id TEXT PRIMARY KEY,
 at INTEGER NOT NULL,
 operator TEXT NOT NULL,
 action TEXT NOT NULL,
 actor TEXT,
 reason TEXT NOT NULL,
 detail TEXT NOT NULL,
 prev_hash TEXT NOT NULL,
 entry_hash TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS v41_operator_audit_actor ON v41_operator_audit(actor,at);
CREATE TRIGGER IF NOT EXISTS v41_operator_audit_no_update BEFORE UPDATE ON v41_operator_audit BEGIN SELECT RAISE(ABORT,'AUDIT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS v41_operator_audit_no_delete BEFORE DELETE ON v41_operator_audit BEGIN SELECT RAISE(ABORT,'AUDIT_IMMUTABLE'); END;
`},
 {id:3, name:'v41-player-reports', sql:`
CREATE TABLE IF NOT EXISTS v41_reports (
 id TEXT PRIMARY KEY,
 reporter TEXT NOT NULL,
 target TEXT NOT NULL,
 category TEXT NOT NULL CHECK(category IN ('cheating','username','harassment','unsportsmanlike','other')),
 detail TEXT NOT NULL DEFAULT '',
 created INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','reviewed')),
 reviewed_at INTEGER,
 reviewed_by TEXT,
 outcome TEXT CHECK(outcome IS NULL OR outcome IN ('no_action','action_taken','duplicate'))
);
CREATE INDEX IF NOT EXISTS v41_reports_target_state ON v41_reports(target,state,created);
CREATE INDEX IF NOT EXISTS v41_reports_reporter_created ON v41_reports(reporter,created);
`},
 {id:4, name:'v41-privacy-requests', sql:`
CREATE TABLE IF NOT EXISTS v41_privacy_requests (
 id TEXT PRIMARY KEY,
 actor TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind='deletion'),
 state TEXT NOT NULL CHECK(state IN ('requested','verified','processing','completed','cancelled','failed')),
 requested_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 completed_at INTEGER,
 policy_version TEXT NOT NULL,
 note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS v41_privacy_requests_actor ON v41_privacy_requests(actor,requested_at);
`},
 {id:5, name:'v41-account-deletion-receipts', sql:`
CREATE TABLE IF NOT EXISTS v41_deletion_receipts (
 id TEXT PRIMARY KEY,
 actor_hash TEXT NOT NULL UNIQUE,
 tombstone TEXT NOT NULL UNIQUE,
 completed_at INTEGER NOT NULL,
 policy_version TEXT NOT NULL,
 retained TEXT NOT NULL
);
`},
 {id:6, name:'v41-store-purchase-boundaries', sql:`
CREATE TABLE IF NOT EXISTS v41_store_bindings (
 actor TEXT PRIMARY KEY,
 google_id TEXT NOT NULL UNIQUE,
 apple_token TEXT NOT NULL UNIQUE,
 created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v41_store_revocations (
 store TEXT NOT NULL CHECK(store IN ('google','apple')),
 transaction_id TEXT NOT NULL,
 product_id TEXT,
 occurred_at INTEGER NOT NULL,
 reason TEXT NOT NULL,
 PRIMARY KEY(store,transaction_id)
);
CREATE TABLE IF NOT EXISTS v41_store_finalize (
 store TEXT NOT NULL CHECK(store='google'),
 transaction_id TEXT NOT NULL,
 product_id TEXT NOT NULL,
 purchase_token TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('consume','acknowledge')),
 state TEXT NOT NULL CHECK(state IN ('pending','done')),
 attempts INTEGER NOT NULL DEFAULT 0,
 next_at INTEGER NOT NULL,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 PRIMARY KEY(store,transaction_id)
);
CREATE INDEX IF NOT EXISTS v41_store_finalize_due ON v41_store_finalize(state,next_at);
CREATE TABLE IF NOT EXISTS v41_store_notifications (
 store TEXT NOT NULL CHECK(store IN ('google','apple')),
 id TEXT NOT NULL,
 received_at INTEGER NOT NULL,
 PRIMARY KEY(store,id)
);
`}
]);
const checksum = m => crypto.createHash('sha256').update(m.name + '\n' + m.sql).digest('hex');
function inspect(db) {
 const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name='v4_schema'").get();
 if (!exists) return [];
 const rows = db.prepare('SELECT * FROM v4_schema ORDER BY id').all();
 for (let i=0;i<rows.length;i++) {
  const m=migrations[i];
  if (!m || rows[i].id!==m.id) throw Error('SCHEMA_NEWER_OR_INCONSISTENT');
  if (rows[i].checksum!==checksum(m)) throw Error('MIGRATION_CHECKSUM_MISMATCH');
 }
 return rows;
}
// Must run before legacy additive constructors touch an existing database.
function preflight(file) {
 if (!fs.existsSync(file)) return;
 const db=new DatabaseSync(file,{readOnly:true});
 try {
  if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok') throw Error('DATABASE_INTEGRITY_FAILED');
  inspect(db);
 } finally {db.close();}
}
// V3.5.1 constructors bootstrap their existing IF NOT EXISTS schema under the
// coordinator lock. V4 migration history starts here, before recovery/readiness.
function migrate(db) {
 db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
 db.exec('BEGIN IMMEDIATE');
 try {
  db.exec('CREATE TABLE IF NOT EXISTS v4_schema(id INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL)');
  const rows=inspect(db);
  for(const m of migrations.slice(rows.length)) {
   db.exec(m.sql);
   db.prepare('INSERT INTO v4_schema VALUES(?,?,?,?)').run(m.id,m.name,checksum(m),Date.now());
  }
  db.exec('COMMIT');
 } catch(e) {db.exec('ROLLBACK');throw e;}
 return migrations.length;
}
function control(db) {return db.prepare('SELECT maintenance FROM v4_controls WHERE id=1').get().maintenance===1;}
module.exports={migrations,preflight,migrate,inspect,control};
