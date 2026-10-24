'use strict';

/* Inspect the SAME custom pg_dump bytes sent to the sealer. No database connection,
 * SQL execution, archive file, or recovery key is used here. The caller must also
 * require pg_dump exit=0 and successful sealing: TOC inspection alone does not
 * validate the archive's table-data blocks.
 *
 * pg_restore selectors are unqualified names. Use one reader per schema to avoid
 * the cross-product of several --schema and --table selectors, plus an unfiltered
 * TOC reader to detect unexpected sequences and large objects.
 */
const { spawn } = require('node:child_process');
const { Writable } = require('node:stream');
const { TextDecoder } = require('node:util');

const MAX_SEQUENCES = 256;
const MAX_SCHEMAS = 32;
const MAX_SQL_BYTES = 256 * 1024;
const MAX_TOC_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MIN_I64 = -(1n << 63n), MAX_I64 = (1n << 63n) - 1n;
const PIPE_CLOSED = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);
const failure = code => Error('P15_SEQUENCE_CAPTURE_FAILED: ' + code);
const key = (schema, name) => JSON.stringify([schema, name]);
const compareRows = (a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])) ||
  Buffer.compare(Buffer.from(a[1]), Buffer.from(b[1]));

function int64(value) {
  if (typeof value !== 'string' || !/^-?[0-9]+$/.test(value)) throw failure('INVALID_INTEGER');
  const n = BigInt(value);
  if (n < MIN_I64 || n > MAX_I64) throw failure('INTEGER_RANGE');
  return n.toString();
}

function expectedGroups(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_SEQUENCES) throw failure('INVALID_EXPECTED_SEQUENCES');
  const groups = new Map(), seen = new Set();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 4 || typeof row[3] !== 'boolean' ||
        !row.slice(0, 2).every(s => typeof s === 'string' && s.length &&
          !s.includes('\0') && Buffer.byteLength(s) <= 63)) throw failure('INVALID_EXPECTED_SEQUENCE');
    int64(row[2]);
    const id = key(row[0], row[1]);
    if (seen.has(id)) throw failure('DUPLICATE_EXPECTED_SEQUENCE');
    seen.add(id);
    if (!groups.has(row[0])) groups.set(row[0], []);
    groups.get(row[0]).push(row[1]);
  }
  if (groups.size > MAX_SCHEMAS) throw failure('TOO_MANY_SCHEMAS');
  return groups;
}

// Decode the qualified regclass spelling INSIDE the SQL string, including doubled
// double-quotes. Never split on dots inside a quoted identifier or evaluate SQL.
function qualifiedName(text) {
  let at = 0;
  function identifier() {
    let value = '';
    if (text[at] === '"') {
      at++;
      for (;;) {
        if (at >= text.length) throw failure('INVALID_SEQUENCE_NAME');
        const c = text[at++];
        if (c !== '"') value += c;
        else if (text[at] === '"') { value += '"'; at++; }
        else break;
      }
    } else {
      const found = /^[a-z_][a-z0-9_$]*/.exec(text.slice(at));
      if (!found) throw failure('INVALID_SEQUENCE_NAME');
      value = found[0]; at += value.length;
    }
    if (!value || value.includes('\0')) throw failure('INVALID_SEQUENCE_NAME');
    return value;
  }
  const schema = identifier();
  if (text[at++] !== '.') throw failure('UNQUALIFIED_SEQUENCE_NAME');
  const name = identifier();
  if (at !== text.length) throw failure('INVALID_SEQUENCE_NAME');
  return [schema, name];
}

// A deliberately small lexer for pg_restore's setup and SEQUENCE SET statements.
// Strings are tokens, so semicolons/comments/newlines inside names remain data.
function sqlTokens(text) {
  const out = [];
  let at = 0, restrict = null;
  while (at < text.length) {
    if (/\s/.test(text[at])) { at++; continue; }
    if (text.startsWith('--', at)) {
      const end = text.indexOf('\n', at); at = end < 0 ? text.length : end + 1; continue;
    }
    if (text[at] === '\\') {
      if (text.slice(text.lastIndexOf('\n', at - 1) + 1, at).trim()) throw failure('UNEXPECTED_META_COMMAND');
      const m = /^\\(restrict|unrestrict)[ \t]+([A-Za-z0-9]+)[ \t]*(?:\r?\n|$)/.exec(text.slice(at));
      if (!m || (m[1] === 'restrict' ? restrict !== null : restrict !== m[2])) throw failure('INVALID_RESTRICT');
      restrict = m[1] === 'restrict' ? m[2] : null;
      at += m[0].length; continue;
    }
    const escaped = (text[at] === 'E' || text[at] === 'e') && text[at + 1] === "'";
    if (text[at] === "'" || escaped) {
      at += escaped ? 2 : 1;
      let value = '', closed = false;
      while (at < text.length) {
        const c = text[at++];
        if (c === "'") {
          if (text[at] === "'") { value += "'"; at++; }
          else { closed = true; break; }
        } else if (c === '\\' && escaped) {
          if (at === text.length) throw failure('INVALID_STRING_ESCAPE');
          const e = text[at++], simple = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (Object.hasOwn(simple, e)) value += simple[e];
          else if (/[0-7]/.test(e)) {
            const m = /^[0-7]{0,2}/.exec(text.slice(at))[0]; at += m.length;
            value += String.fromCharCode(parseInt(e + m, 8));
          } else if (e === 'x' || e === 'u' || e === 'U') {
            const pattern = e === 'x' ? /^[a-fA-F0-9]{1,2}/ : e === 'u' ? /^[a-fA-F0-9]{4}/ : /^[a-fA-F0-9]{8}/;
            const m = pattern.exec(text.slice(at));
            if (!m) throw failure('INVALID_STRING_ESCAPE');
            at += m[0].length;
            const n = parseInt(m[0], 16);
            if (n > 0x10ffff || n >= 0xd800 && n <= 0xdfff) throw failure('INVALID_STRING_ESCAPE');
            value += String.fromCodePoint(n);
          } else value += e;
        } else value += c;
      }
      if (!closed || value.includes('\0')) throw failure('INVALID_SQL_STRING');
      out.push({ kind: 'string', value }); continue;
    }
    const number = /^-?[0-9]+/.exec(text.slice(at));
    if (number) { out.push({ kind: 'number', value: number[0] }); at += number[0].length; continue; }
    const word = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(text.slice(at));
    if (word) { out.push({ kind: 'word', value: word[0].toLowerCase() }); at += word[0].length; continue; }
    if ('().,=;'.includes(text[at])) { out.push({ kind: 'symbol', value: text[at++] }); continue; }
    throw failure('UNEXPECTED_SQL');
  }
  if (restrict !== null) throw failure('UNCLOSED_RESTRICT');
  return out;
}

function sequenceRows(text, schema, names) {
  const expected = new Set(names.map(name => key(schema, name))), actual = new Map();
  const setup = new Map(Object.entries({
    statement_timeout: '0', lock_timeout: '0', idle_in_transaction_session_timeout: '0',
    client_encoding: 'UTF8', standard_conforming_strings: 'on', check_function_bodies: 'false',
    xmloption: 'content', client_min_messages: 'warning', row_security: 'off'
  }));
  let statement = [], stringsOn = false;
  for (const token of sqlTokens(text)) {
    if (token.kind !== 'symbol' || token.value !== ';') { statement.push(token); continue; }
    const s = statement; statement = [];
    const v = s.map(t => t.value);
    if (v.length === 4 && v[0] === 'set' && v[2] === '=' && setup.get(v[1]) === v[3]) {
      if (v[1] === 'standard_conforming_strings') stringsOn = true;
      continue;
    }
    if (JSON.stringify(v) === JSON.stringify(['select', 'pg_catalog', '.', 'set_config', '(', 'search_path', ',', '', ',', 'false', ')'])) continue;
    if (!stringsOn || s.length !== 11 || v[0] !== 'select' || v[1] !== 'pg_catalog' || v[2] !== '.' ||
        v[3] !== 'setval' || v[4] !== '(' || s[5].kind !== 'string' || v[6] !== ',' ||
        s[7].kind !== 'number' || v[8] !== ',' || !['true', 'false'].includes(v[9]) || v[10] !== ')') throw failure('UNEXPECTED_SQL');
    const [ns, name] = qualifiedName(v[5]), id = key(ns, name);
    if (!expected.has(id) || actual.has(id)) throw failure('UNEXPECTED_OR_DUPLICATE_SEQUENCE');
    actual.set(id, [ns, name, int64(v[7]), v[9] === 'true']);
  }
  if (statement.length || actual.size !== expected.size) throw failure('INCOMPLETE_SEQUENCE_SQL');
  return [...actual.values()];
}

function tocMetadata(text, expectedCount) {
  if (!/^;[ \t]+Format:[ \t]+CUSTOM[ \t]*\r?$/m.test(text) ||
      !/^;[ \t]+Dumped by pg_dump version:[ \t]+16\.[0-9]+[^\r\n]*$/m.test(text)) throw failure('UNSUPPORTED_ARCHIVE');
  let sequences = 0, hasLargeObjects = false;
  const ids = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*;/.test(line)) continue;
    const m = /^([1-9][0-9]*);[ \t]+[0-9]+[ \t]+[0-9]+[ \t]+(.+)$/.exec(line);
    if (!m || ids.has(m[1])) throw failure('INVALID_TOC');
    ids.add(m[1]);
    if (/^SEQUENCE SET(?:\s|$)/.test(m[2])) sequences++;
    if (/^(?:BLOBS?|LARGE OBJECTS?)(?:\s|$)/.test(m[2])) hasLargeObjects = true;
  }
  if (sequences !== expectedCount) throw failure('ARCHIVE_SEQUENCE_SET_MISMATCH');
  return { hasLargeObjects };
}

function startCapture({ command = 'pg_restore', env = process.env, spawnCommand = spawn,
  expectedSequences, timeoutMs = 180000 } = {}) {
  const groups = expectedGroups(expectedSequences);
  if (typeof command !== 'string' || !command || command.includes('\0') || typeof spawnCommand !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900000) throw failure('INVALID_OPTIONS');
  const readers = [];
  let inputEnded = false, settled = false, error = null, timer, totalBytes = 0;
  let resolveResult, rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // A reader can fail while the caller is still awaiting its sealer.
  result.catch(() => {});

  function fail(code) {
    if (settled) return;
    settled = true; error = failure(code); clearTimeout(timer);
    for (const r of readers) {
      for (const done of [...r.pending]) done();
      r.child?.stdin?.destroy();
      if (!r.closed) { try { r.child?.kill('SIGKILL'); } catch {} }
    }
    input.destroy(error);
    rejectResult(error);
  }
  function complete() {
    if (settled || !inputEnded || readers.some(r => !r.closed)) return;
    settled = true; clearTimeout(timer);
    resolveResult({ sequences: readers.flatMap(r => r.rows || []).sort(compareRows),
      hasLargeObjects: readers[0].metadata.hasLargeObjects });
  }
  function writeTo(r, chunk) {
    if (r.closed || r.inputClosed || settled) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { r.pending.delete(done); resolve(); };
      r.pending.add(done);
      try {
        r.child.stdin.write(chunk, err => {
          if (err && !PIPE_CLOSED.has(err.code)) fail('INSPECTOR_INPUT_ERROR');
          if (err) r.inputClosed = true;
          done();
        });
      } catch (err) {
        if (!PIPE_CLOSED.has(err.code)) fail('INSPECTOR_INPUT_ERROR');
        r.inputClosed = true; done();
      }
    });
  }
  const input = new Writable({
    write(chunk, encoding, callback) {
      Promise.all(readers.map(r => writeTo(r, chunk))).then(() => callback(error || undefined), () => {
        fail('INPUT_ERROR'); callback(error);
      });
    },
    final(callback) {
      inputEnded = true;
      for (const r of readers) if (!r.closed && !r.inputClosed) r.child.stdin.end();
      callback(); complete();
    },
    destroy(err, callback) {
      if (!settled && (err || !inputEnded)) fail('INPUT_CANCELLED');
      callback(err);
    }
  });
  input.on('error', () => {}); // result is the authoritative error channel.

  function reader(args, parse, limit) {
    const r = { pending: new Set(), chunks: [], bytes: 0, closed: false, inputClosed: false };
    readers.push(r);
    try {
      r.child = spawnCommand(command, args, { env: { ...env, LC_ALL: 'C', LANG: 'C', PG_COLOR: 'never' },
        stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      if (!r.child?.stdin || !r.child.stdout || !r.child.stderr || typeof r.child.once !== 'function') throw failure('INVALID_INSPECTOR');
      r.child.stdin.on('error', err => {
        if (PIPE_CLOSED.has(err.code)) { r.inputClosed = true; for (const done of [...r.pending]) done(); }
        else fail('INSPECTOR_INPUT_ERROR');
      });
      r.child.stdout.on('error', () => fail('INSPECTOR_OUTPUT_ERROR'));
      r.child.stderr.on('error', () => fail('INSPECTOR_OUTPUT_ERROR'));
      let stderrBytes = 0, hasDiagnostic = false;
      r.child.stderr.on('data', chunk => {
        stderrBytes += chunk.length;
        if (/\S/.test(chunk.toString('utf8'))) hasDiagnostic = true;
        if (stderrBytes > 65536) fail('INSPECTOR_DIAGNOSTIC_LIMIT');
      });
      r.child.stdout.on('data', chunk => {
        r.bytes += chunk.length; totalBytes += chunk.length;
        if (r.bytes > limit || totalBytes > MAX_TOTAL_BYTES) { fail('INSPECTOR_OUTPUT_LIMIT'); return; }
        if (!settled) r.chunks.push(Buffer.from(chunk));
      });
      r.child.once('error', () => fail('INSPECTOR_PROCESS_ERROR'));
      r.child.once('close', (code, signal) => {
        r.closed = true;
        for (const done of [...r.pending]) done();
        if (settled) return;
        if (code !== 0 || signal || hasDiagnostic) { fail('INSPECTOR_PROCESS_FAILED'); return; }
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(r.chunks));
          const parsed = parse(text);
          if (Array.isArray(parsed)) r.rows = parsed; else r.metadata = parsed;
          r.chunks = [];
          complete();
        } catch { fail('INVALID_INSPECTOR_METADATA'); }
      });
    } catch { fail('INSPECTOR_START_FAILED'); }
  }
  reader(['--list'], text => tocMetadata(text, expectedSequences.length), MAX_TOC_BYTES);
  for (const [schema, names] of groups) {
    if (settled) break;
    reader(['--data-only', '--no-owner', '--no-acl', '--no-comments', '--no-security-labels',
      '--strict-names', '--schema=' + schema, ...names.map(name => '--table=' + name), '--file=-'],
    text => sequenceRows(text, schema, names), MAX_SQL_BYTES);
  }
  if (!settled) {
    timer = setTimeout(() => fail('INSPECTOR_TIMEOUT'), timeoutMs);
    timer.unref();
  }
  return { input, result, cancel: () => fail('CANCELLED') };
}

module.exports = { startCapture };
