'use strict';
/* tools/v5-migration/canonical.js - deterministic canonical serialization and strict JSON reading.
 *
 * Owned by the P03 source-side slice (SourceRead). No runtime/store/provider imports: this module
 * depends on node:crypto only and never reads a database.
 *
 * Why not structuredClone/JSON.parse:
 *  - JSON.parse silently overwrites a duplicated source key, so a corrupted or hand-edited
 *    `state.json` would lose data without any signal. parseStrictJson scans the raw text and refuses
 *    a repeated key BEFORE the first value can be overwritten.
 *  - JSON.stringify sorts nothing, so two logically identical maps serialize differently. canonical()
 *    sorts object keys by UTF-16 code unit order, preserves every array in source order, and refuses
 *    values that would silently change (undefined, non-finite, -0, BigInt, unsafe integers,
 *    class instances). Money/counter semantics are checked per field by the reader's mapping, not by
 *    rounding here.
 *
 * Data keys named `__proto__`, `constructor` or `prototype` are LEGITIMATE source data (conversion
 * operation keys, snapshot/audit payloads, opaque practice archives). They are preserved as plain own
 * data properties — never rejected and never allowed to mutate a prototype — via defineProperty on an
 * ordinary object, so `Object.getPrototypeOf(parsed)` stays Object.prototype and no pollution occurs.
 *
 * API (frozen by local://v5-p03-source-contract.md):
 *   canonical(value) -> deterministic JSON text
 *   hash(value)      -> sha256 hex of the UTF-8 canonical text
 *   hashSet(values)  -> order-agnostic hash of a semantically unordered collection
 *   hashText(text)   -> sha256 hex of a raw string (table-level hashing)
 *   parseStrictJson(text, options) -> { value, unsafeNumbers }
 * Errors carry `code` (upper snake case, safe for console) and `locator` (a structural JSON path,
 * never a data value) so callers can report actionable, sanitized failures.
 */

const crypto = require('node:crypto');


function fail(code, locator) {
  const error = new Error(locator ? code + ':' + locator : code);
  error.code = code;
  error.locator = locator || null;
  return error;
}

/* Own-property assignment: a key named `__proto__` becomes a data property instead of reassigning the
 * object's prototype, and `constructor`/`prototype` never shadow inherited lookups. */
function assignOwn(object, key, value) {
  Object.defineProperty(object, key, {value, writable: true, enumerable: true, configurable: true});
}

function writeNumber(value, path, out) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw fail('CANONICAL_NON_FINITE', path);
  if (Object.is(value, -0)) throw fail('CANONICAL_NEGATIVE_ZERO', path);
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw fail('CANONICAL_UNSAFE_INTEGER', path);
  out.push(JSON.stringify(value));
}

function writeValue(value, path, out) {
  if (value === null) { out.push('null'); return; }
  const type = typeof value;
  if (type === 'boolean') { out.push(value ? 'true' : 'false'); return; }
  if (type === 'string') { out.push(JSON.stringify(value)); return; }
  if (type === 'number') { writeNumber(value, path, out); return; }
  if (type === 'undefined') throw fail('CANONICAL_UNDEFINED', path);
  if (type === 'bigint') throw fail('CANONICAL_UNSAFE_INTEGER', path);
  if (type !== 'object') throw fail('CANONICAL_UNSUPPORTED', path);
  if (Array.isArray(value)) {
    out.push('[');
    for (let index = 0; index < value.length; index++) {
      if (index) out.push(',');
      if (value[index] === undefined) throw fail('CANONICAL_UNDEFINED', path + '[' + index + ']');
      writeValue(value[index], path + '[' + index + ']', out);
    }
    out.push(']');
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw fail('CANONICAL_UNSUPPORTED', path);
  const keys = Object.keys(value);
  keys.sort(); // default comparison = UTF-16 code unit order, as the contract requires
  out.push('{');
  let first = true;
  for (const key of keys) {
    const entry = value[key];
    if (entry === undefined) throw fail('CANONICAL_UNDEFINED', path + '.' + key);
    if (!first) out.push(',');
    first = false;
    out.push(JSON.stringify(key), ':');
    writeValue(entry, path + '.' + key, out);
  }
  out.push('}');
}

function canonical(value) {
  const out = [];
  writeValue(value, '$', out);
  return out.join('');
}

function hash(value) {
  return crypto.createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function hashText(text) {
  if (typeof text !== 'string') throw fail('HASH_TEXT_REQUIRED');
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/* Deterministic order-agnostic hash of a collection of values (set/map semantics). */
function hashSet(values) {
  const hashes = new Array(values.length);
  for (let index = 0; index < values.length; index++) hashes[index] = hash(values[index]);
  hashes.sort();
  return hashText(hashes.join(','));
}

/* Minimal strict JSON reader: full grammar, exact number fidelity, duplicate keys refused.
 *
 * Options:
 *   allowUnsafeIntegralNumbers (default false)
 *     - false: an integral literal outside the safe range (e.g. 9007199254740993) is refused, which is
 *       correct for classified money/counter fields.
 *     - true: used for OPAQUE text payloads (practice archives, command responses, audit detail) where
 *       a legacy counter such as `importedTicks: 1e20` is legitimate metadata. The literal's exact
 *       text remains authoritative in the preserved raw string; each accepted unsafe path is returned
 *       in `unsafeNumbers` so the precision boundary is visible rather than silent.
 *     Non-finite results (1e400 -> Infinity) and -0 are refused in both modes.
 */
function parseStrictJson(text, options = {}) {
  if (typeof text !== 'string') throw fail('JSON_TEXT_REQUIRED');
  const allowUnsafe = options.allowUnsafeIntegralNumbers === true;
  const source = text;
  const unsafeNumbers = [];
  let at = 0;

  const error = (code, path) => fail(code, path + '@' + at);
  const skipSpace = () => {
    while (at < source.length) {
      const code = source[at];
      if (code === ' ' || code === '\t' || code === '\n' || code === '\r') at++;
      else break;
    }
  };
  const expectLiteral = (literal) => {
    if (source.slice(at, at + literal.length) !== literal) throw error('JSON_UNEXPECTED_TOKEN', '$');
    at += literal.length;
  };
  const parseString = (path) => {
    const start = at;
    at++; // opening quote
    for (;;) {
      if (at >= source.length) throw error('JSON_UNTERMINATED_STRING', path);
      const code = source.charCodeAt(at);
      const char = source[at];
      if (char === '"') { at++; break; }
      if (char === '\\') {
        const escape = source[at + 1];
        if (escape === undefined) throw error('JSON_UNTERMINATED_STRING', path);
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(at + 2, at + 6))) throw error('JSON_INVALID_ESCAPE', path);
          at += 6;
        } else if ('"\\/bfnrt'.includes(escape)) at += 2;
        else throw error('JSON_INVALID_ESCAPE', path);
        continue;
      }
      if (code < 0x20) throw error('JSON_CONTROL_CHARACTER', path);
      at++;
    }
    return JSON.parse(source.slice(start, at));
  };
  const parseNumber = (path) => {
    const start = at;
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(at));
    if (!match) throw error('JSON_INVALID_NUMBER', path);
    at += match[0].length;
    const value = Number(source.slice(start, at));
    if (!Number.isFinite(value)) throw fail('JSON_NON_FINITE_NUMBER', path);
    if (Object.is(value, -0)) throw fail('JSON_NEGATIVE_ZERO', path);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!allowUnsafe) throw fail('JSON_UNSAFE_INTEGER', path);
      unsafeNumbers.push(path);
    }
    return value;
  };
  const parseObject = (path) => {
    at++;
    const object = {};
    const seen = new Set();
    skipSpace();
    if (source[at] === '}') { at++; return object; }
    for (;;) {
      skipSpace();
      if (source[at] !== '"') throw error('JSON_EXPECTED_KEY', path);
      const key = parseString(path);
      const keyPath = path + '.' + key;
      if (seen.has(key)) throw fail('JSON_DUPLICATE_KEY', keyPath);
      seen.add(key);
      skipSpace();
      if (source[at] !== ':') throw error('JSON_EXPECTED_COLON', path);
      at++;
      assignOwn(object, key, parseValue(keyPath));
      skipSpace();
      if (source[at] === ',') { at++; continue; }
      if (source[at] === '}') { at++; return object; }
      throw error('JSON_EXPECTED_SEPARATOR', path);
    }
  };
  const parseArray = (path) => {
    at++;
    const array = [];
    skipSpace();
    if (source[at] === ']') { at++; return array; }
    for (;;) {
      array.push(parseValue(path + '[]'));
      skipSpace();
      if (source[at] === ',') { at++; continue; }
      if (source[at] === ']') { at++; return array; }
      throw error('JSON_EXPECTED_SEPARATOR', path);
    }
  };
  const parseValue = (path) => {
    skipSpace();
    if (at >= source.length) throw error('JSON_UNEXPECTED_END', path);
    const lead = source[at];
    if (lead === '{') return parseObject(path);
    if (lead === '[') return parseArray(path);
    if (lead === '"') return parseString(path);
    if (lead === 't') { expectLiteral('true'); return true; }
    if (lead === 'f') { expectLiteral('false'); return false; }
    if (lead === 'n') { expectLiteral('null'); return null; }
    if (lead === '-' || (lead >= '0' && lead <= '9')) return parseNumber(path);
    throw error('JSON_UNEXPECTED_TOKEN', path);
  };

  const value = parseValue('$');
  skipSpace();
  if (at !== source.length) throw fail('JSON_TRAILING_DATA', '$');
  return {value, unsafeNumbers};
}

module.exports = {canonical, hash, hashSet, hashText, parseStrictJson};
