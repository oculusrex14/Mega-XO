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
