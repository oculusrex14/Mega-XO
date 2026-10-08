'use strict';
/* tools/v5-migration/reader.js - pure deterministic read of an immutable V4.1.2 SQLite snapshot.
 *
 * Usage (library):
 *   const {readSnapshot} = require('./tools/v5-migration/reader.js');
 *   const model = readSnapshot('/restricted/mega.sqlite', {
 *     captureClockMs: 1791396595015,       // snapshot manifest createdAt; the ONLY clock used
 *     sourceRelease: {sha: '455b8ec9...', image: 'ghcr.io/...@sha256:...'},
 *     expectedSha256: 'd2f8461b...',       // refuses a mismatched file
 *     allowUnclassified: {'state.accounts[].legacyThing': 'recorded-rule-id'},
 *   });
 *
 * Guarantees (contract: local://v5-p03-source-contract.md):
 *   - One `DatabaseSync(file,{readOnly:true})` handle, opened with no pragma that persists state,
 *     after the file header proves the snapshot is journal_mode=delete (so the read creates no
 *     -shm/-wal side file and cannot mutate the artifact), no Authority/CommunityStore/RoomStore/
 *     MonetizationStore construction, no provider or HTTP call, no Date.now(), no randomness, no
 *     DDL, no WAL checkpoint, no second connection.
 *   - Raw JSON text is preserved next to the parsed value; every field value is preserved exactly
 *     (no rounding, no rescaling, no default injection). Legacy optional fields stay optional.
 *   - Deterministic: identical bytes + identical captureClockMs => byte-identical canonical model.
 *   - Unknown table/column/root/nested field fails the read with an actionable locator, unless an
 *     explicit preserve rule accepts it (`allowUnclassified`, wildcard form `state.accounts[].field`);
 *     an accepted value is preserved, never discarded.
 *   - Data keys named `__proto__`/`constructor`/`prototype` are preserved as own data properties (no
 *     prototype mutation) and source-keyed hash dictionaries hold every id, including those names.
 *   - Opaque TEXT payloads (practice archives, command responses, audit detail) are syntax/duplicate
 *     scanned without asset-number semantics: a legacy integral value beyond the safe range is accepted
 *     and recorded in `hashes.opaqueUnsafeNumbers`, while classified money/counter fields keep strict
 *     safe-integer checks.
 *   - The returned model contains raw player data. Never print it, never place it in Git, evidence
 *     JSON or a public CI artifact. `cli.js` prints counts and hashes only.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {hash, hashSet, hashText, parseStrictJson} = require('./canonical.js');
const MAPPING = require('./mapping.json');

const READER_VERSION = 1;
const MAX_LOCATORS_REPORTED = 25;
const ID_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;
const KEY_GRAMMAR = /^[A-Za-z0-9:_-]{1,160}$/;
const ATOMIC_KINDS = new Set(['uint', 'int', 'num', 'ms', 'hundredths', 'bool', 'str', 'text', 'id', 'ref', 'key', 'opaque', 'any', 'json-opaque']);

/* Opaque payload kinds: their TEXT is authoritative and may legitimately carry legacy metadata such as
 * `importedTicks: 1e20`. Syntax and duplicate-key integrity are still enforced; only the generic
 * safe-integer restriction is relaxed, and every accepted unsafe path is recorded. Classified
 * money/counter kinds (uint/int/ms/hundredths) keep the strict safe-integer rule. */
const OPAQUE_KINDS = new Set(['opaque', 'any', 'json-opaque']);

/* A keyed dictionary that can hold data keys named `__proto__`/`constructor`/`prototype` without
 * touching any prototype. Source keys come from the database, so they are data, not a namespace. */
function owned(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
function newDictionary() { return Object.create(null); }
function put(dictionary, key, value) { Object.defineProperty(dictionary, key, {value, writable: true, enumerable: true, configurable: true}); }
/* Columns whose JSON text is validated by a dedicated root validator after the tables are read. */
const DEFERRED_ROOT_KINDS = new Set(['source-roots', 'room-roots', 'practice-roots']);

/* The snapshot's own migration chain is the authoritative source-schema checksum source. Requiring
 * this module only reads a frozen array and pure functions; nothing runs at require time. */
let SOURCE_MIGRATIONS = [];
try {
  // eslint-disable-next-line global-require
  SOURCE_MIGRATIONS = require('../../server/production/migrations.js').migrations || [];
} catch { SOURCE_MIGRATIONS = []; }

/* Authority.restore() normalization rules, reproduced as *reported* deltas only (never applied to
 * the raw copy). Source: src/authority.js:27-28. */
const NORMALIZATION_RULES = new Set([
  'purchased-invalid-or-clamped', 'casual-rating-default', 'casual-games-default', 'missing-default',
  'season-roll-or-create', 'boolean-coercion'
]);

function extractionError(code, locator, detail) {
  const error = new Error(code + (locator ? ':' + locator : '') + (detail ? ' (' + detail + ')' : ''));
  error.code = code;
  error.locator = locator || null;
  if (detail) error.detail = detail;
  return error;
}

/* Quarter id in the source's own format, computed from the injected capture clock only.
 * Mirrors src/domain.js:season (UTC quarter) without importing the runtime module. */
function quarterOf(ms) {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return year + '-Q' + quarter;
}

/* ------------------------------------------------------------------ type library */

const TYPE_LIBRARY = {};
for (const [name, spec] of Object.entries(MAPPING.state.types)) TYPE_LIBRARY['state:' + name] = spec;
for (const [name, spec] of Object.entries(MAPPING.rooms.types)) TYPE_LIBRARY['rooms:' + name] = spec;

/* Type names are unique across the state and rooms domains (verified: no overlap), and the source
 * itself shares the board/fixture types between a match and a tournament fixture (src/game.js is used
 * by both src/authority.js and src/tournament.js). A spec may therefore reference a type declared in
 * either domain. */
function namedType(name, domain) {
  const spec = TYPE_LIBRARY[domain + ':' + name];
  if (spec) return spec;
  for (const other of ['state', 'rooms']) {
    const fallback = TYPE_LIBRARY[other + ':' + name];
    if (fallback) return fallback;
  }
  throw extractionError('MAPPING_TYPE_UNKNOWN', name);
}

/* ------------------------------------------------------------------ validator */

class Validator {
  constructor(options = {}) {
    this.allowUnclassified = options.allowUnclassified || {};
    this.unclassified = [];
    this.accepted = [];
    this.normalization = [];
    this.grammarDrift = [];
    this.unsafeNumberPaths = [];
    this.leafCount = 0;
    this.dispositionCounts = {V: 0, N: 0, E: 0, O: 0, Q: 0};
    this.actorId = null;
  }

  fail(code, locator, detail) { throw extractionError(code, locator, detail); }

  /* Rule locators use `[]` for "any key/index at this position", e.g.
   * `state.accounts[].legacyThing` covers `state.accounts[p0].legacyThing`. */
  ruleFor(locator) {
    const normalized = locator.replace(/\[[^\]]*\]/g, '[]');
    let best = null;
    for (const prefix of Object.keys(this.allowUnclassified)) {
      if (normalized === prefix || normalized.startsWith(prefix + '.') || normalized.startsWith(prefix + '[')) {
        if (!best || prefix.length > best.length) best = prefix;
      }
    }
    return best === null ? null : {prefix: best, rule: this.allowUnclassified[best]};
  }

  /* An undescribed path. Reported and fatal by default; an explicit rule accepts it, and the value
   * is preserved either way. */
  unknown(locator, value) {
    const match = this.ruleFor(locator);
    (match ? this.accepted : this.unclassified).push({locator, ruleId: match ? match.rule : null});
    return value;
  }

  noteNormalization(actor, field, rule, raw, normalized) {
    if (!NORMALIZATION_RULES.has(rule)) throw extractionError('NORMALIZATION_RULE_UNKNOWN', field, rule);
    /* `undefined` never appears in the model: an absent source value is recorded as null. */
    this.normalization.push({
      actor, field, rule,
      raw: raw === undefined ? null : raw,
      normalized: normalized === undefined ? null : normalized
    });
    this.dispositionCounts.N++;
  }

  /* A stored identifier outside the source's own grammar is real historical drift. The exact text is
   * preserved (never recast, never regenerated) and the mismatch is reported so reconciliation can
   * account for it explicitly. */
  noteGrammar(locator, value, grammar) {
    this.grammarDrift.push({locator, grammar, length: typeof value === 'string' ? value.length : null});
    this.dispositionCounts.N++;
  }

  countDisposition(code) {
    this.dispositionCounts[code] = (this.dispositionCounts[code] || 0) + 1;
    return code;
  }

  check(value, kind, locator) {
    if (typeof kind === 'string' && kind.startsWith('enum:')) {
      const values = kind.slice(5).split('|');
      if (!values.includes(value)) this.fail('INVALID_FIELD_TYPE', locator, 'unexpected value');
      this.leafCount++;
      return 'V';
    }
    switch (kind) {
      case 'uint': if (!Number.isSafeInteger(value) || value < 0) this.fail('INVALID_FIELD_TYPE', locator, 'expected non-negative safe integer'); break;
      case 'int': if (!Number.isSafeInteger(value)) this.fail('INVALID_FIELD_TYPE', locator, 'expected safe integer'); break;
      case 'num': if (typeof value !== 'number' || !Number.isFinite(value)) this.fail('INVALID_FIELD_TYPE', locator, 'expected finite number'); break;
      case 'ms':
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) this.fail('INVALID_FIELD_TYPE', locator, 'expected non-negative finite millisecond value');
        break;
      case 'hundredths':
        if (typeof value !== 'number' || !Number.isFinite(value) || Math.round(value * 100) / 100 !== value) {
          this.fail('INVALID_FIELD_TYPE', locator, 'expected a finite value exactly representable in hundredths');
        }
        break;
      case 'bool': if (typeof value !== 'boolean') this.fail('INVALID_FIELD_TYPE', locator, 'expected boolean'); break;
      case 'str': if (typeof value !== 'string' || value.length === 0) this.fail('INVALID_FIELD_TYPE', locator, 'expected non-empty string'); break;
      case 'text': if (typeof value !== 'string') this.fail('INVALID_FIELD_TYPE', locator, 'expected string'); break;
      case 'id': case 'ref':
        if (typeof value !== 'string' || value.length === 0) this.fail('INVALID_IDENTIFIER', locator, 'expected non-empty identifier text');
        if (!ID_GRAMMAR.test(value)) this.noteGrammar(locator, value, 'authority-id');
        break;
      case 'key':
        if (typeof value !== 'string' || value.length === 0) this.fail('INVALID_IDENTIFIER', locator, 'expected non-empty operation key text');
        if (!KEY_GRAMMAR.test(value)) this.noteGrammar(locator, value, 'operation-key');
        break;
      case 'opaque': case 'any': break;
      case 'json-opaque': {
        if (typeof value !== 'string') this.fail('INVALID_FIELD_TYPE', locator, 'expected JSON text');
        /* Duplicate keys are still refused. Legacy metadata may hold an integral number beyond the safe
         * asset range (e.g. a practice archive's importedTicks); the raw text stays authoritative and
         * each such path is recorded instead of failing a legitimate opaque payload. */
        const parsed = parseStrictJson(value, {allowUnsafeIntegralNumbers: true});
        for (const path of parsed.unsafeNumbers) this.unsafeNumberPaths.push(locator + path.slice(1));
        return 'O';
      }
      default: this.fail('MAPPING_KIND_UNKNOWN', locator, 'kind ' + String(kind));
    }
    this.leafCount++;
    return 'V';
  }

  /* Structural spec: a bare atomic kind name, or the name of a type in the current domain. */
  validate(value, spec, locator, domain) {
    if (typeof spec === 'string') {
      const atomic = ATOMIC_KINDS.has(spec) || spec.startsWith('enum:');
      const code = atomic ? this.check(value, spec, locator) : this.validate(value, namedType(spec, domain), locator, domain);
      return atomic ? this.countDisposition(code) : code;
    }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) this.fail('MAPPING_SPEC_INVALID', locator);
    const type = spec.type || spec.kind;
    let code;
    if (ATOMIC_KINDS.has(type)) {
      code = this.check(value, type, locator);
    } else {
      switch (type) {
        case 'nullable':
          if (value === null) { this.leafCount++; code = 'V'; }
          else code = this.validate(value, spec.of, locator, domain);
          break;
        case 'object':
          if (value === null || typeof value !== 'object' || Array.isArray(value)) this.fail('INVALID_FIELD_TYPE', locator, 'expected object');
          code = this.validateObject(value, spec.of ? namedType(spec.of, domain) : spec, locator, domain);
          break;
        case 'array': {
          if (!Array.isArray(value)) this.fail('INVALID_FIELD_TYPE', locator, 'expected array');
          const itemDomain = spec.itemDomain || domain;
          for (let index = 0; index < value.length; index++) this.validate(value[index], spec.of, locator + '[' + index + ']', itemDomain);
          this.leafCount++;
          code = 'V';
          break;
        }
        case 'entries':
          code = this.validateEntries(value, spec, locator, domain);
          break;
        case 'map': {
          if (value === null || typeof value !== 'object' || Array.isArray(value)) this.fail('INVALID_FIELD_TYPE', locator, 'expected map object');
          for (const key of Object.keys(value)) this.validate(value[key], spec.of, locator + '[' + key + ']', domain);
          this.leafCount++;
          code = 'V';
          break;
        }
        case 'enum': {
          const values = Array.isArray(spec.values) ? spec.values : null;
          if (values && !values.includes(value)) this.fail('INVALID_FIELD_TYPE', locator, 'unexpected value');
          this.leafCount++;
          code = 'V';
          break;
        }
        case 'union': {
          let resolved = null;
          for (const branch of spec.of || []) {
            try { resolved = this.validate(value, branch, locator, domain); break; }
            catch (error) { if (error.code !== 'INVALID_FIELD_TYPE') throw error; }
          }
          if (resolved === null) this.fail('INVALID_FIELD_TYPE', locator, 'no union branch matched');
          code = resolved;
          break;
        }
        default:
          this.fail('MAPPING_TYPE_UNKNOWN', locator, 'type ' + String(type));
      }
    }
    if (spec.disposition && spec.disposition !== 'V') code = spec.disposition;
    return this.countDisposition(code);
  }

  validateEntries(value, spec, locator, domain) {
    if (!Array.isArray(value)) this.fail('INVALID_FIELD_TYPE', locator, 'expected entry array');
    for (let index = 0; index < value.length; index++) {
      const pair = value[index];
      if (!Array.isArray(pair) || pair.length !== 2) this.fail('INVALID_ENTRY_PAIR', locator + '[' + index + ']', 'expected [key,value]');
      if (typeof pair[0] !== 'string' || pair[0].length === 0) this.fail('INVALID_ENTRY_PAIR', locator + '[' + index + ']', 'entry key must be a non-empty string');
      this.validate(pair[1], spec.of, locator + '[' + pair[0] + ']', domain);
    }
    this.leafCount++;
    return 'V';
  }

  validateFields(value, fields, locator, domain) {
    const nonVerbatim = {};
    for (const key of Object.keys(value)) {
      /* Own-property lookup: a source key named `constructor`/`prototype`/`__proto__` must not read an
       * inherited value and must not corrupt the spec object. */
      const spec = owned(fields, key) ? fields[key] : undefined;
      if (spec === undefined) { this.unknown(locator + '.' + key, value[key]); put(nonVerbatim, key, 'unclassified'); continue; }
      const code = this.validate(value[key], spec, locator + '.' + key, domain);
      if (code !== 'V') put(nonVerbatim, key, code);
    }
    return nonVerbatim;
  }

  validateObject(value, spec, locator, domain) {
    const fields = spec.fields || {};
    const nonVerbatim = this.validateFields(value, fields, locator, domain);
    /* Absent legacy fields stay absent: optional fields are reported as leaves, required ones fail. */
    for (const key of Object.keys(fields)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) continue;
      const fieldSpec = fields[key];
      if (typeof fieldSpec === 'object' && fieldSpec.optional === true) { this.leafCount++; continue; }
      this.fail('MISSING_REQUIRED_FIELD', locator + '.' + key, 'required source field absent');
    }
    return spec.disposition || 'V';
  }
}

/* ------------------------------------------------------------------ schema and rows */

function readSchema(db) {
  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const columnsCache = new Map();
  const describe = (name) => {
    if (!columnsCache.has(name)) {
      columnsCache.set(name, db.prepare('PRAGMA table_info(' + JSON.stringify(name) + ')').all()
        .map((row) => ({name: row.name, type: row.type || '', notnull: row.notnull, dflt: row.dflt_value, pk: row.pk})));
    }
    return columnsCache.get(name);
  };
  const byType = (type) => objects.filter((row) => row.type === type);
  const tableNames = byType('table').map((row) => row.name);
  const tableColumns = {};
  for (const name of tableNames) tableColumns[name] = describe(name);
  return {
    tables: byType('table').map((row) => ({name: row.name, sql: row.sql})),
    indexes: byType('index').map((row) => ({name: row.name, tbl_name: row.tbl_name, sql: row.sql})),
    triggers: byType('trigger').map((row) => ({name: row.name, tbl_name: row.tbl_name, sql: row.sql})),
    views: byType('view').map((row) => ({name: row.name, sql: row.sql})),
    tableNames,
    indexNames: byType('index').map((row) => row.name),
    triggerNames: byType('trigger').map((row) => row.name),
    viewNames: byType('view').map((row) => row.name),
    tableColumns
  };
}

function primaryKeyColumns(columns) {
  const pk = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
  return pk.length ? pk.map((column) => column.name) : null;
}

function locate(table, columns, row, index) {
  const pk = primaryKeyColumns(columns);
  if (!pk) return 'rowid=' + String(row.__rowid === undefined ? index : row.__rowid);
  return pk.map((name) => name + '=' + String(row[name])).join(',');
}

function tableHash(table, columns, rows) {
  const rowHashes = rows.map((row) => hash(row.values));
  rowHashes.sort();
  return hashText(table + '|' + columns.map((column) => column.name).join(',') + '|' + rows.length + '|' + rowHashes.join(','));
}

/* Structural type-drift guard: a declared integer-kind column holding a REAL/BLOB cannot be read
 * back as a JS number at all, and an INTEGER outside the JS safe range throws ERR_OUT_OF_RANGE while
 * the row is being materialized. Detect both with SQL — SQLite compares integer columns exactly
 * against integer literals — so the reader refuses an unrepresentable asset instead of rounding or
 * crashing. */
function guardColumns(spec) {
  const guards = [];
  for (const [name, typed] of Object.entries(spec.columns)) {
    const kind = typeof typed === 'string' ? typed : (typed && (typed.kind || typed.type));
    if (kind === 'uint' || kind === 'int' || kind === 'ms' || kind === 'hundredths') {
      const column = JSON.stringify(name);
      guards.push("typeof(" + column + ") NOT IN ('integer','null')");
      guards.push("typeof(" + column + ")='integer' AND (" + column + '>' + Number.MAX_SAFE_INTEGER + ' OR ' + column + '<' + (-Number.MAX_SAFE_INTEGER - 1) + ')');
    }
  }
  return guards;
}

function readDescribedTable(db, table, columns, validator) {
  const spec = MAPPING.tables[table];
  const names = columns.map((column) => column.name);
  for (const name of Object.keys(spec.columns)) {
    if (!names.includes(name)) {
      validator.fail('SOURCE_SCHEMA_MISSING_COLUMN', 'table:' + table + '.<schema>.' + name, 'mapped column absent from source schema');
    }
  }
  const guards = guardColumns(spec);
  if (guards.length) {
    const drifted = db.prepare('SELECT count(*) AS n FROM ' + JSON.stringify(table) + ' WHERE ' + guards.join(' OR ')).get().n;
    if (drifted) validator.fail('SOURCE_COLUMN_TYPE_DRIFT', 'table:' + table, drifted + ' row(s) hold a non-integer value in a declared integer column');
  }
  const rows = db.prepare('SELECT rowid AS __rowid, * FROM ' + JSON.stringify(table)).all();
  const out = [];
  for (let index = 0; index < rows.length; index++) {
    const raw = rows[index];
    const key = locate(table, columns, raw, index);
    const locator = table + '[' + key + ']';
    const values = {};
    for (const name of names) {
      const value = raw[name];
      const typed = owned(spec.columns, name) ? spec.columns[name] : undefined;
      if (value === null && typeof typed === 'string' && (typed === 'id' || typed === 'key')) {
        validator.fail('INVALID_FIELD_TYPE', locator + '.' + name, 'expected non-null identifier');
      }
      if (value === null) { values[name] = null; if (typed !== undefined) validator.leafCount++; continue; }
      if (typed !== undefined && !DEFERRED_ROOT_KINDS.has(typeof typed === 'string' ? typed : (typed && (typed.kind || typed.type)))) {
        validator.validate(value, typed, locator + '.' + name, 'table');
      } else if (typed !== undefined) {
        if (typeof value !== 'string') validator.fail('INVALID_FIELD_TYPE', locator + '.' + name, 'expected JSON text');
      } else {
        validator.unknown(locator + '.' + name, value);
      }
      values[name] = value;
    }
    out.push({key, values});
  }
  return {
    columns,
    rows: out,
    count: out.length,
    sha256: tableHash(table, columns, out),
    owner: spec.owner,
    disposition: spec.disposition,
    classification: 'described'
  };
}

/* A table the manifest does not describe is still read verbatim so no source row is discarded; it is
 * recorded as unclassified and therefore fails coverage unless an explicit rule accepts it. */
function readUndescribedTable(db, table, columns, validator) {
  const rows = db.prepare('SELECT rowid AS __rowid, * FROM ' + JSON.stringify(table)).all();
  const out = rows.map((raw, index) => {
    const key = locate(table, columns, raw, index);
    const values = {};
    for (const column of columns) {
      values[column.name] = raw[column.name];
      validator.unknown(table + '[' + key + '].' + column.name, raw[column.name]);
    }
    return {key, values};
  });
  const disposition = validator.ruleFor('table:' + table) ? 'unclassified-accepted' : 'unclassified';
  validator.unknown('table:' + table, table);
  return {columns, rows: out, count: out.length, sha256: tableHash(table, columns, out), owner: null, disposition, classification: 'undescribed'};
}

/* ------------------------------------------------------------------ JSON roots */

function validateState(validator, rawText) {
  const parsed = parseStrictJson(rawText).value;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) validator.fail('SOURCE_ROOT_INVALID', 'state.json', 'expected a JSON object');
  const roots = MAPPING.state.roots;
  for (const key of Object.keys(parsed)) if (!owned(roots, key)) validator.unknown('state.' + key, parsed[key]);
  for (const [name, spec] of Object.entries(roots)) {
    if (!Object.prototype.hasOwnProperty.call(parsed, name) && spec.required) validator.fail('MISSING_REQUIRED_ROOT', 'state.' + name, 'required serialized root absent');
  }
  for (const name of Object.keys(roots)) {
    if (!Object.prototype.hasOwnProperty.call(parsed, name)) continue;
    const spec = roots[name];
    if (name === 'burned') {
      const burned = parsed.burned;
      if (burned === null || typeof burned !== 'object' || Array.isArray(burned)) validator.fail('INVALID_FIELD_TYPE', 'state.burned', 'expected object');
      for (const key of Object.keys(burned)) {
        if (key !== 'coins' && key !== 'crowns') { validator.unknown('state.burned.' + key, burned[key]); continue; }
        validator.validate(burned[key], 'uint', 'state.burned.' + key, 'state');
      }
    } else if (name === 'journal') {
      validator.validate(parsed.journal, {type: 'array', of: namedType('journalEntry', 'state')}, 'state.journal', 'state');
    } else if (spec.kind === 'entries') {
      validator.validate(parsed[name], {type: 'entries', of: namedType(spec.of, 'state')}, 'state.' + name, 'state');
    } else if (spec.kind === 'map') {
      validator.validate(parsed[name], {type: 'map', of: namedType(spec.of, 'state')}, 'state.' + name, 'state');
    } else if (spec.kind === 'array') {
      validator.validate(parsed[name], {type: 'array', of: namedType(spec.of, 'state')}, 'state.' + name, 'state');
    } else if (spec.kind === 'nullable') {
      validator.validate(parsed[name], {type: 'nullable', of: spec.of}, 'state.' + name, 'state');
    } else {
      validator.fail('MAPPING_SPEC_INVALID', 'state.' + name, 'unsupported root kind ' + spec.kind);
    }
  }
  if (Array.isArray(parsed.accounts)) {
    for (const pair of parsed.accounts) {
      if (!Array.isArray(pair) || pair.length !== 2 || !pair[1] || typeof pair[1] !== 'object') continue;
      validator.actorId = pair[0];
      noteAccountNormalization(validator, pair[0], pair[1]);
      validator.actorId = null;
    }
  }
  return parsed;
}

/* Reported (never applied) deltas for the fields Authority.restore() would rewrite. src/authority.js:27-28.
 * A field the source defensively defaults is reported whether it is absent, null or malformed, because in
 * every one of those cases the source's own restore() replaces it. */
function noteAccountNormalization(validator, actor, account) {
  const absent = (key) => !Object.prototype.hasOwnProperty.call(account, key);
  const invalidPurchased = (key) => absent(key) || !Number.isSafeInteger(account[key]) || account[key] < 0;

  /* Exact src/authority.js:27 branch: a non-safe-integer or negative purchased value is zeroed AND
   * legacyCompetitionRestricted is set from !!purchaseInfluenced; otherwise purchased values are only
   * clamped down to coins/crowns and legacyCompetitionRestricted is !!legacyCompetitionRestricted. */
  if (invalidPurchased('purchasedCoins') || invalidPurchased('purchasedCrowns')) {
    validator.noteNormalization(actor, 'state.accounts[].purchasedCoins', 'purchased-invalid-or-clamped',
      {purchasedCoins: account.purchasedCoins === undefined ? null : account.purchasedCoins, purchasedCrowns: account.purchasedCrowns === undefined ? null : account.purchasedCrowns},
      {purchasedCoins: 0, purchasedCrowns: 0});
    validator.noteNormalization(actor, 'state.accounts[].legacyCompetitionRestricted', 'boolean-coercion',
      account.legacyCompetitionRestricted === undefined ? null : account.legacyCompetitionRestricted, !!account.purchaseInfluenced);
  } else {
    validator.noteNormalization(actor, 'state.accounts[].legacyCompetitionRestricted', 'boolean-coercion',
      account.legacyCompetitionRestricted, !!account.legacyCompetitionRestricted);
    if (Number.isSafeInteger(account.coins) && account.purchasedCoins > account.coins) {
      validator.noteNormalization(actor, 'state.accounts[].purchasedCoins', 'purchased-invalid-or-clamped', account.purchasedCoins, account.coins);
    }
    if (Number.isSafeInteger(account.crowns) && account.purchasedCrowns > account.crowns) {
      validator.noteNormalization(actor, 'state.accounts[].purchasedCrowns', 'purchased-invalid-or-clamped', account.purchasedCrowns, account.crowns);
    }
  }
  if (absent('casualRating') || typeof account.casualRating !== 'number' || !Number.isFinite(account.casualRating)) {
    validator.noteNormalization(actor, 'state.accounts[].casualRating', 'casual-rating-default', account.casualRating,
      Number.isFinite(account.games) && account.games >= 10 ? account.rating : 1000);
  }
  if (absent('casualGames') || !Number.isSafeInteger(account.casualGames)) {
    validator.noteNormalization(actor, 'state.accounts[].casualGames', 'casual-games-default', account.casualGames, 0);
  }
  if (absent('tournamentRecord')) {
    validator.noteNormalization(actor, 'state.accounts[].tournamentRecord', 'missing-default', null,
      {entered: 0, wins: 0, runnerUp: 0, top3: 0, top5: 0, bestFinish: null, finishSum: 0, premiumWins: 0});
  }
  if (absent('seasonHistory')) {
    validator.noteNormalization(actor, 'state.accounts[].seasonHistory', 'missing-default', null, []);
  }
  /* restore() calls _season(now), which creates the current quarter when the stored season is absent or
   * null and replaces + archives it when the stored quarter is not the capture clock's quarter. Nothing is
   * applied; the raw season is preserved exactly and the delta is reported. */
  const stale = !account.season || typeof account.season !== 'object' || account.season.id !== validator.currentQuarter;
  if (stale) {
    validator.noteNormalization(actor, 'state.accounts[].season', 'season-roll-or-create',
      account.season === undefined ? null : account.season,
      {id: validator.currentQuarter, created: true, archivedSeasonHistoryLength: Math.min(8, (Array.isArray(account.seasonHistory) ? account.seasonHistory.length : 0) + (account.season ? 1 : 0))});
  }
}

function validateRoom(validator, roomId, code, rawText) {
  const parsed = parseStrictJson(rawText).value;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) validator.fail('SOURCE_ROOT_INVALID', 'party_rooms[id=' + roomId + '].json', 'expected a JSON object');
  validator.validate(parsed, MAPPING.rooms.root, 'party_rooms[id=' + roomId + ']', 'rooms');
  if (typeof parsed.id === 'string' && parsed.id !== roomId) validator.fail('SOURCE_ROOT_INCONSISTENT', 'party_rooms[id=' + roomId + '].id', 'room json id differs from the row id');
  if (typeof parsed.code === 'string' && code !== null && parsed.code !== code) validator.fail('SOURCE_ROOT_INCONSISTENT', 'party_rooms[id=' + roomId + '].code', 'room json code differs from the row code');
  return parsed;
}

function validatePracticeSave(validator, actor, payload) {
  if (payload === null) return null;
  /* The practice archive is an opaque legacy payload (server/community-store.js allows arbitrary nested
   * data under a listed root), so its own root parse admits finite integral metadata beyond the safe
   * asset range and records each accepted path, exactly like the json-opaque column kind. Classified
   * money and counters inside `wallet` are still validated strictly below via the mapping specs. */
  const strict = parseStrictJson(payload, {allowUnsafeIntegralNumbers: true});
  for (const path of strict.unsafeNumbers) {
    validator.unsafeNumberPaths.push('profile_saves[actor=' + actor + '].payload' + path.slice(1));
  }
  const parsed = strict.value;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) validator.fail('SOURCE_ROOT_INVALID', 'profile_saves[actor=' + actor + '].payload', 'expected a JSON object');
  const roots = MAPPING.practiceSave.roots;
  for (const key of Object.keys(parsed)) {
    const spec = owned(roots, key) ? roots[key] : undefined;
    if (spec === undefined) { validator.unknown('profile_saves[actor=' + actor + '].payload.' + key, parsed[key]); continue; }
    validator.validate(parsed[key], spec, 'profile_saves[actor=' + actor + '].payload.' + key, 'state');
  }
  return parsed;
}

/* ------------------------------------------------------------------ root hashing */

function rootHashes(parsed) {
  const roots = MAPPING.state.roots;
  const out = newDictionary();
  const byKey = newDictionary();
  for (const [name, spec] of Object.entries(roots)) {
    if (!owned(parsed, name)) { put(out, name, {absent: true}); continue; }
    const value = parsed[name];
    const entry = {ordered: hash(value === null ? null : value)};
    if (spec.kind === 'entries') {
      const keys = newDictionary();
      const values = [];
      for (const pair of value) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        put(keys, pair[0], hash(pair[1]));
        values.push(pair[1]);
      }
      entry.set = hashSet(values);
      entry.byKey = keys;
      put(byKey, name, keys);
    } else if (spec.kind === 'map') {
      entry.set = hash(value);
    }
    put(out, name, entry);
  }
  return {stateRoots: out, byKey};
}

/* ------------------------------------------------------------------ file facts */

function hashFile(file) {
  const digest = crypto.createHash('sha256');
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 256);
    let read;
    do {
      read = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (read > 0) digest.update(buffer.subarray(0, read));
    } while (read > 0);
  } finally { fs.closeSync(handle); }
  return digest.digest('hex');
}

/* Reads the 100-byte SQLite header without touching the WAL machinery, so a WAL-mode file is refused
 * before a read-only open could create -shm/-wal side files next to an immutable snapshot. */
function sqliteHeader(file) {
  const handle = fs.openSync(file, 'r');
  let header;
  try {
    header = Buffer.alloc(100);
    const read = fs.readSync(handle, header, 0, 100, 0);
    if (read < 100) throw extractionError('SNAPSHOT_TRUNCATED', file, 'shorter than a SQLite header');
  } finally { fs.closeSync(handle); }
  return {
    magic: header.subarray(0, 16).toString('latin1'),
    pageSize: header.readUInt16BE(16),
    writeVersion: header[18],
    readVersion: header[19],
    wal: header[18] === 2 || header[19] === 2
  };
}

/* ------------------------------------------------------------------ public API */

function readSnapshot(file, options = {}) {
  if (typeof file !== 'string' || !file) throw extractionError('SNAPSHOT_PATH_REQUIRED', null);
  const resolved = path.resolve(file);
  const captureClockMs = options.captureClockMs;
  if (typeof captureClockMs !== 'number' || !Number.isFinite(captureClockMs) || captureClockMs < 0) {
    throw extractionError('CAPTURE_CLOCK_REQUIRED', 'capture', 'a fixed captureClockMs is required; the reader never reads a live clock');
  }
  if (!fs.existsSync(resolved)) throw extractionError('SNAPSHOT_MISSING', resolved);
  const header = sqliteHeader(resolved);
  if (header.magic !== 'SQLite format 3\u0000') throw extractionError('SNAPSHOT_NOT_SQLITE', resolved);
  if (header.wal) {
    throw extractionError('SNAPSHOT_JOURNAL_MODE_NOT_IMMUTABLE', resolved,
      'snapshot is journal_mode=wal; use capture.js which normalizes its own artifact to journal_mode=delete');
  }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (fs.existsSync(resolved + suffix)) throw extractionError('SNAPSHOT_NOT_IMMUTABLE', resolved + suffix, 'immutable snapshot must not have journal side files');
  }

  const bytes = fs.statSync(resolved).size;
  const fileSha256 = hashFile(resolved);
  if (options.expectedSha256 !== undefined && options.expectedSha256 !== fileSha256) {
    throw extractionError('FILE_SHA_MISMATCH', resolved, 'expected ' + options.expectedSha256 + ' got ' + fileSha256);
  }

  const validator = new Validator(options);
  /* The one clock: the capture clock. Derived classifications and reported normalization deltas use
   * it, and nothing is ever written back into a raw-copy field. */
  validator.currentQuarter = quarterOf(captureClockMs);
  const db = new DatabaseSync(resolved, {readOnly: true}); // the only handle; no persisting pragma
  let model;
  try {
    const integrity = readIntegrity(db, resolved);
    const schema = readSchema(db);
    assertSchemaShape(validator, schema);
    const schemaHead = readSchemaHead(db);

    const tables = {};
    const tableRoots = {};
    const tableCoverage = [];
    for (const name of schema.tableNames) {
      const result = owned(MAPPING.tables, name)
        ? readDescribedTable(db, name, schema.tableColumns[name], validator)
        : readUndescribedTable(db, name, schema.tableColumns[name], validator);
      tables[name] = result;
      tableRoots[name] = result.sha256;
      tableCoverage.push({table: name, rows: result.count, owner: result.owner, disposition: result.disposition, classification: result.classification});
    }

    const stateRow = db.prepare('SELECT json FROM state WHERE id=1').get();
    if (!stateRow || typeof stateRow.json !== 'string') throw extractionError('SOURCE_STATE_MISSING', 'state[id=1].json');
    const parsedState = validateState(validator, stateRow.json);

    const rooms = [];
    for (const row of tables.party_rooms.rows) {
      rooms.push({id: row.values.id, code: row.values.code, raw: row.values.json, parsed: validateRoom(validator, row.values.id, row.values.code, row.values.json)});
    }
    for (const row of tables.profile_saves.rows) validatePracticeSave(validator, row.values.actor, row.values.payload);

    const coverage = buildCoverage(validator, tableCoverage);
    /* Extraction fails on unclassified paths by default. Capture only *reports* them: the immutable
     * artifact preserves the raw value either way, so the coverage gate belongs to extraction, which
     * is where a recorded `--allow-unclassified` rule is supplied. */
    if (coverage.unclassified_count && !options.reportCoverageOnly) {
      const shown = coverage.unclassified.slice(0, MAX_LOCATORS_REPORTED).map((item) => item.locator);
      throw extractionError('COVERAGE_INCOMPLETE', shown[0], coverage.unclassified_count + ' locator(s) unclassified; ' + shown.join(', '));
    }

    const rootResult = rootHashes(parsedState);
    const actorHashes = newDictionary();
    const accountKeys = rootResult.byKey.accounts || {};
    for (const key of Object.keys(accountKeys).sort()) put(actorHashes, key, accountKeys[key]);
    const sourceFingerprint = hash({
      readerVersion: READER_VERSION,
      captureClockMs,
      fileSha256,
      bytes,
      schemaHead: schemaHead.maxId,
      stateRoots: rootResult.stateRoots,
      tableRoots,
      actorHashesRoot: hash(actorHashes)
    });

    model = {
      version: READER_VERSION,
      capture: {
        clockMs: captureClockMs,
        sourceSha: options.sourceRelease && options.sourceRelease.sha ? options.sourceRelease.sha : null,
        fileSha256,
        bytes,
        schemaHead,
        integrity,
        sourceRelease: options.sourceRelease || null,
        readerVersion: READER_VERSION
      },
      schema: {
        tables: schema.tables,
        indexes: schema.indexes,
        triggers: schema.triggers,
        views: schema.views,
        drift: schema.drift,
        expected: MAPPING.sourceRelease
      },
      tables,
      state: {raw: stateRow.json, parsed: parsedState},
      rooms,
      coverage,
      hashes: {
        stateRoots: rootResult.stateRoots,
        tableRoots,
        sourceFingerprint,
        actorHashesRoot: hash(actorHashes),
        actorHashes,
        normalization: validator.normalization,
        grammarDrift: validator.grammarDrift,
        opaqueUnsafeNumbers: validator.unsafeNumberPaths
      }
    };
  } finally {
    db.close();
  }
  return model;
}

function readIntegrity(db, resolved) {
  const integrity = {
    quickCheck: db.prepare('PRAGMA quick_check').get().quick_check,
    foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all().length,
    journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
    pageCount: db.prepare('PRAGMA page_count').get().page_count,
    freelistCount: db.prepare('PRAGMA freelist_count').get().freelist_count,
    userVersion: db.prepare('PRAGMA user_version').get().user_version,
    dataVersion: db.prepare('PRAGMA data_version').get().data_version,
    applicationId: db.prepare('PRAGMA application_id').get().application_id
  };
  if (integrity.quickCheck !== 'ok') throw extractionError('SOURCE_INTEGRITY_FAILED', resolved, String(integrity.quickCheck));
  if (integrity.foreignKeyViolations !== 0) throw extractionError('SOURCE_FOREIGN_KEY_VIOLATIONS', resolved, String(integrity.foreignKeyViolations));
  return integrity;
}

function assertSchemaShape(validator, schema) {
  const expected = MAPPING.sourceRelease;
  const drift = {
    missingTables: Object.keys(MAPPING.tables).filter((name) => !schema.tableNames.includes(name)),
    extraTables: schema.tableNames.filter((name) => !owned(MAPPING.tables, name)),
    missingIndexes: (expected.indexes || []).filter((name) => !schema.indexNames.includes(name)),
    extraIndexes: schema.indexNames.filter((name) => !(expected.indexes || []).includes(name)),
    missingTriggers: (expected.triggers || []).filter((name) => !schema.triggerNames.includes(name)),
    extraTriggers: schema.triggerNames.filter((name) => !(expected.triggers || []).includes(name)),
    views: schema.viewNames.slice()
  };
  schema.drift = drift;
  if (drift.missingTables.length) validator.fail('SOURCE_SCHEMA_MISSING_TABLE', 'table:' + drift.missingTables[0], drift.missingTables.join(','));
  if (drift.missingIndexes.length) validator.fail('SOURCE_SCHEMA_MISSING_INDEX', 'index:' + drift.missingIndexes[0], drift.missingIndexes.join(','));
  if (drift.extraIndexes.length) validator.unknown('index:' + drift.extraIndexes[0], null);
  if (drift.missingTriggers.length) validator.fail('SOURCE_SCHEMA_MISSING_TRIGGER', 'trigger:' + drift.missingTriggers[0], drift.missingTriggers.join(','));
  if (drift.extraTriggers.length) validator.unknown('trigger:' + drift.extraTriggers[0], null);
  if (drift.views.length) validator.unknown('view:' + drift.views[0], null);
}

function readSchemaHead(db) {
  const rows = db.prepare('SELECT id,name,checksum,applied_at FROM v4_schema ORDER BY id').all();
  const expected = SOURCE_MIGRATIONS.map((migration) => ({
    id: migration.id,
    name: migration.name,
    checksum: hashText(migration.name + '\n' + migration.sql) // server/production/migrations.js:126
  }));
  if (rows.length && !expected.length) throw extractionError('SOURCE_SCHEMA_CHAIN_UNAVAILABLE', 'v4_schema', 'frozen source migration chain could not be loaded');
  const migrations = rows.map((row) => {
    const match = expected.find((item) => item.id === row.id) || null;
    return {
      id: row.id,
      name: row.name,
      checksum: row.checksum,
      expectedName: match ? match.name : null,
      expectedChecksum: match ? match.checksum : null,
      match: !!match && match.name === row.name && match.checksum === row.checksum,
      appliedAt: row.applied_at
    };
  });
  const mismatch = migrations.find((migration) => !migration.match);
  if (mismatch) throw extractionError('SOURCE_SCHEMA_CHECKSUM_MISMATCH', 'v4_schema[id=' + mismatch.id + ']', 'name/checksum differ from the frozen source chain');
  return {count: rows.length, maxId: rows.length ? rows[rows.length - 1].id : 0, migrations, expectedCount: expected.length, allMatch: true};
}

function buildCoverage(validator, tableCoverage) {
  const byLocator = (a, b) => (a.locator < b.locator ? -1 : a.locator > b.locator ? 1 : 0);
  const unclassified = validator.unclassified.slice().sort(byLocator);
  const accepted = validator.accepted.slice().sort(byLocator);
  return {
    tables: tableCoverage,
    fields: {total: validator.leafCount, unclassified: unclassified.length, accepted: accepted.length},
    dispositions: validator.dispositionCounts,
    unclassified_count: unclassified.length,
    unclassified,
    accepted,
    policy: MAPPING.unclassifiedPolicy
  };
}

/* Structural facts about a source database: integrity, full schema inventory and the recomputed
 * v4_schema chain. Shared by readSnapshot and capture's clock-less structural validation so both
 * verify the same source-schema checksums with one implementation. */
function describeSource(db, resolved) {
  const integrity = readIntegrity(db, resolved);
  const schema = readSchema(db);
  const schemaHead = readSchemaHead(db);
  return {integrity, schema, schemaHead};
}

module.exports = {readSnapshot, describeSource, READER_VERSION, extractionError, hashFile, sqliteHeader};
