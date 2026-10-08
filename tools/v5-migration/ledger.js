'use strict';
/* tools/v5-migration/ledger.js - the ONE canonical target-row / locator contract for the P03 import.
 *
 * WHY THIS FILE EXISTS. The importer (loader.js) commits a hash of every destination row it writes
 * into `v5_migration.row_ledger.row_hash`, and the reconciler (reconcile.js) recomputes that hash to
 * prove the row was not modified after it was committed (design 3.5 rule 7: "a hash mismatch on a
 * previously committed row is a hard failure, never an overwrite"). If the two sides do not hash
 * byte-for-byte identically, every clean run reports a tampered row. A `to_jsonb(row)` computed by
 * PostgreSQL cannot be that shared function: it renders `timestamptz` in the SESSION TimeZone and
 * re-renders `jsonb` in its own canonical form, so the digest depends on the importer's session and
 * on a TimeZone that is recorded nowhere - a resumed run from a different session would legitimately
 * disagree with a row nothing touched. The design's 3.1 canonical serializer is timezone- and
 * session-independent by construction, so the contract is expressed here, once, in JS.
 *
 * CONTRACT (frozen; changing any line invalidates every run's identity via `canonicalizerSpec`)
 *   locator        = `<schema-qualified table>#<key>`, key = the stable SOURCE key of the row with
 *                    U+001F between the parts of a composite key (e.g. `identity.actors#alice-1`,
 *                    `match.participants#m_1\u001f0`). Human-auditable, needs no kind map, and is
 *                    what the DDL's "kind + stable source key" (0036:101-103) requires.
 *   row_hash       = sha256(canon(plain object of ALL columns by column name, values normalized))
 *   target_pk_hash = sha256(canon(plain object of the primary-key columns by column name))
 *   normalization  = timestamptz/timestamp -> integer epoch milliseconds; date -> 'YYYY-MM-DD'
 *                    (produced in SQL by `to_char(col,'YYYY-MM-DD') AS "col"`, because the driver
 *                    would otherwise hand back a LOCAL-midnight Date and because PostgreSQL names a
 *                    bare function call after the function); numeric/bigint -> JS number;
 *                    CHAR(n) -> trailing blank padding trimmed (Postgres blank-pads it, the source
 *                    never carried the padding); arrays -> element-wise (numeric arrays -> number);
 *                    json/jsonb -> the value the driver parsed; everything else verbatim.
 *
 * No column is ever excluded from the hash. A small, explicitly listed set of TARGET-OWNED
 * bookkeeping clocks/lease fences has no source counterpart and is skipped by the reconciler's
 * SEMANTIC pass only - never by this hash.
 *
 * The read helpers take a `client` with `query(text, values)` and issue only explicit column lists
 * (never `SELECT *`), so a caller can hash exactly the row the database stores.
 */

const {canonical, hash, hashSet} = require('./canonical.js');

const LOCATOR_SEPARATOR = '\u001f';

/* The versioned canonicalizer specification. `extractor_release` hashes this together with the
 * mapping manifest and the source release (design 3.4), so ANY change to a normalization rule or to
 * the locator vocabulary changes every run's identity - a run can never be silently reinterpreted
 * under a new hashing convention. */
const NORMALIZATION_SPEC = Object.freeze({
  version: 1,
  locator: ['<schema-qualified table>#<key>', 'U+001F between composite key parts'],
  rowHash: 'sha256(canon(plain object of ALL columns by column name, values normalized))',
  pkHash: 'sha256(canon(plain object of the primary-key columns by column name))',
  normalization: {
    'timestamp with time zone': 'integer epoch milliseconds (JS Date -> getTime())',
    'timestamp without time zone': 'integer epoch milliseconds',
    date: "SQL to_char(col,'YYYY-MM-DD') AS \"col\" (never the driver's local-midnight Date)",
    bigint: 'JS number',
    integer: 'JS number',
    smallint: 'JS number',
    numeric: 'JS number',
    boolean: 'JS boolean',
    'character(n)': 'trailing blank padding trimmed (Postgres blank-pads, the source never did)',
    'array<X>': 'element-wise: numeric arrays -> numbers, other arrays -> strings',
    'json/jsonb': 'the value the driver parsed',
    other: 'verbatim'
  }
});

/* extractor_release = sha256(canon({extractorVersion, canonicalizerSpec, mappingManifest,
 * reconciliationRules})). The source-side provenance fields of a run are the caller's; this value is
 * the canonicalizer half and is stable for a given ledger.js release. */
function extractorRelease(parts = {}) {
  return hash({
    extractorVersion: parts.extractorVersion === undefined ? NORMALIZATION_SPEC.version : parts.extractorVersion,
    canonicalizerSpec: NORMALIZATION_SPEC,
    mappingManifest: parts.mappingManifest === undefined ? null : parts.mappingManifest,
    reconciliationRules: parts.reconciliationRules === undefined ? null : parts.reconciliationRules
  });
}

/* ------------------------------------------------------------------ expressions */

/* An identifier safe to interpolate: it comes from information_schema or from a frozen spec table,
 * never from a source value. */
function quoteIdentifier(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

function tableParts(table) {
  const parts = String(table).split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw ledgerError('TABLE_INVALID', table);
  return {schema: parts[0], table: parts[1]};
}

/* One SELECT expression per column, with the alias that keeps the column's own name as the row key. */
function selectExpression(column) {
  const name = quoteIdentifier(column.column_name);
  if (column.data_type === 'date') return `to_char(${name}, 'YYYY-MM-DD') AS ${name}`;
  return name;
}

/* The SQL that renders a row the way canonical.js would: jsonb/text are passed through as TEXT and
 * the normalized value is assembled in JS. Only `date` needs SQL help (see the header). */
function hashExpression(alias, pkColumns) {
  const name = alias || 't';
  return `encode(sha256(convert_to(to_jsonb(${name})::text, 'UTF8')), 'hex')`;
}

/* ------------------------------------------------------------------ normalization */

function normalizeValue(column, value) {
  if (value === null || value === undefined) return null;
  const type = column.data_type;
  const udt = column.udt_name;
  if (type === 'timestamp with time zone' || type === 'timestamp without time zone') {
    return value instanceof Date ? value.getTime() : Number(value);
  }
  if (type === 'date') return String(value);
  if (type === 'bigint' || type === 'integer' || type === 'smallint') {
    return typeof value === 'number' ? value : Number(value);
  }
  if (type === 'numeric') return Number(value);
  if (type === 'boolean') return value === true;
  if (type === 'ARRAY') {
    if (!Array.isArray(value)) return value;
    const numericElement = udt === '_numeric' || udt === '_int4' || udt === '_int8';
    return value.map((element) => (element === null ? null : numericElement ? Number(element) : String(element)));
  }
  if (type === 'character') return String(value).replace(/\s+$/, ''); // blank-padded CHAR(n)
  return value; // json/jsonb arrive parsed; text stays text
}

function normalizeRow(columns, raw) {
  const row = {};
  for (const column of columns) row[column.column_name] = normalizeValue(column, raw[column.column_name]);
  return row;
}

/* row_hash: EVERY column, by name, canonical JSON. `normalizeRow` is idempotent (a millisecond
 * number, a 'YYYY-MM-DD' string, a Number, a boolean and a trimmed string all normalize to
 * themselves), so a caller may pass either the driver's row or an already-normalized one and get the
 * same digest. A column the row does not carry is hashed as null, never omitted. */
function rowHash(columns, raw) {
  const row = raw && columns.every((column) => Object.prototype.hasOwnProperty.call(raw, column.column_name))
    ? normalizeRow(columns, raw) : normalizeRow(columns, raw || {});
  const object = {};
  for (const column of columns) object[column.column_name] = row[column.column_name] === undefined ? null : row[column.column_name];
  return hash(object);
}

/* target_pk_hash: the primary-key columns only. */
function pkHash(pkColumns, row) {
  const object = {};
  for (const column of pkColumns) object[column] = row[column] === undefined ? null : row[column];
  return hash(object);
}

/* ------------------------------------------------------------------ locators */

function locatorOf(table, key) { return String(table) + '#' + String(key); }

function locatorKey(values) {
  if (Array.isArray(values)) return values.map((value) => String(value)).join(LOCATOR_SEPARATOR);
  return String(values);
}

/* The `key` of a locator, split back into the parts it names (the inverse of `locatorKey`). */
function locatorKeyParts(key, count) { return String(key).split(LOCATOR_SEPARATOR).slice(0, count); }

/* ------------------------------------------------------------------ read */

async function readTable(client, table, pkColumns = []) {
  const {schema, table: name} = tableParts(table);
  const columns = (await client.query(
    `SELECT column_name, data_type, udt_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, name])).rows;
  if (!columns.length) return {table, columns: [], rows: [], present: false};
  const select = columns.map(selectExpression).join(', ');
  /* The row is ALSO hashed by Postgres (`to_jsonb`) in the same round trip, so a ledger written by an
   * older importer that committed that rendering stays verifiable here. Nothing is inferred from it;
   * both digests come from the same stored row. */
  const dbHash = `${hashExpression('t')} AS "__row_hash_db"`;
  const dbPkHash = pkColumns.length
    ? `, encode(sha256(convert_to(jsonb_build_object(${pkColumns
      .map((column) => `'${String(column).replace(/'/g, "''")}', t.${quoteIdentifier(column)}`).join(', ')})::text, 'UTF8')), 'hex') AS "__pk_hash_db"`
    : '';
  const result = await client.query(`SELECT ${select}, ${dbHash}${dbPkHash} FROM ${quoteIdentifier(schema)}.${quoteIdentifier(name)} AS t`);
  return {table, columns, rows: result.rows, present: true};
}

/* Reads one table and returns, per row: the normalized object, the canonical row hash, the canonical
 * PK hash and the Postgres-rendered digests. `pkColumns` selects which columns form the PK. */
async function readHashedTable(client, table, pkColumns = []) {
  const read = await readTable(client, table, pkColumns);
  if (!read.present) return {...read, hashed: []};
  const hashed = read.rows.map((raw) => {
    const normalized = normalizeRow(read.columns, raw);
    return {
      raw,
      normalized,
      rowHash: rowHash(read.columns, normalized),
      pkHash: pkColumns.length ? pkHash(pkColumns, normalized) : null,
      dbRowHash: raw.__row_hash_db,
      dbPkHash: raw.__pk_hash_db === undefined ? null : raw.__pk_hash_db
    };
  });
  return {...read, hashed};
}

function ledgerError(code, detail) {
  const error = new Error(code + (detail === undefined ? '' : ': ' + detail));
  error.code = code;
  error.detail = detail === undefined ? null : detail;
  return error;
}

module.exports = {
  LOCATOR_SEPARATOR,
  NORMALIZATION_SPEC,
  extractorRelease,
  quoteIdentifier,
  tableParts,
  selectExpression,
  hashExpression,
  normalizeValue,
  normalizeRow,
  rowHash,
  pkHash,
  locatorOf,
  locatorKey,
  locatorKeyParts,
  readTable,
  readHashedTable,
  ledgerError,
  hashSet,
  canonical,
  hash
};
