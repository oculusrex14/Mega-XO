'use strict';
/* Guard against the schema-growth class of defect that broke three writes when 8b8d811 added
 * identities.verified_email and signin_attempts.decision_*: a positional `INSERT INTO t VALUES(?,…)`
 * silently rots as soon as a column is appended. This test materialises the real sqlite schema the
 * runtime builds, then checks every positional insert in the shipped code and the fixtures against
 * the live column count of its table, so a future ADD COLUMN fails here instead of in production or
 * in the migration import proof. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DurableStore } = require('../server/economy-store');
const { CommunityStore } = require('../server/community-store');

function liveSchema() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-schema-guard-'));
  const store = new DurableStore(path.join(dir, 'db.sqlite'), { now: () => Date.parse('2026-10-05T12:00Z') });
  // Constructing the store is what runs the CREATE TABLE + ADD COLUMN sequence.
  new CommunityStore({ store, origin: 'https://mega.example', now: () => Date.parse('2026-10-05T12:00Z') });
  const tables = new Map();
  for (const row of store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    const columns = store.db.prepare(`PRAGMA table_info(${JSON.stringify(row.name)})`).all();
    tables.set(row.name, columns.length);
  }
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return tables;
}

/* Files that ship positional INSERTs against runtime-created tables, walked for source of truth. */
const SCAN_ROOTS = ['server', 'src', 'tools/v5-migration'];
const POSITIONAL = /INSERT\s+(?:OR\s+(?:IGNORE|REPLACE)\s+)?INTO\s+([a-z_][a-z0-9_]*)\s+VALUES\s*\(([^)]*)\)/gi;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full, out); }
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.cjs')) out.push(full);
  }
  return out;
}

test('every positional INSERT matches its table column count, so a schema growth cannot silently rot a write', () => {
  const tables = liveSchema();
  assert.ok(tables.get('identities') >= 5, 'identities must carry the verified_email column');
  assert.ok(tables.get('signin_attempts') >= 15, 'signin_attempts must carry the decision_* columns');
  const offenders = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(path.resolve(__dirname, '..', root))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(POSITIONAL)) {
        const [, table, params] = match;
        const count = tables.get(table);
        if (count === undefined) continue; // table not created by this runtime (e.g. v4_* DDL elsewhere)
        const supplied = params.split(',').length;
        if (supplied !== count) offenders.push(`${path.relative(path.resolve(__dirname, '..'), file)}: INSERT INTO ${table} VALUES(${supplied}) but ${table} has ${count} columns`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'positional INSERTs drifted from their table schema:\n' + offenders.join('\n'));
});
