#!/usr/bin/env node
'use strict';

/**
 * Shared V5 R2 client: credential derivation, curl --aws-sigv4 transport,
 * S3 object PUT/HEAD/GET/List on the V5-only bucket.
 *
 * The Cloudflare R2 rule is applied here once: S3 Access Key ID = token `id`,
 * S3 Secret Access Key = sha256 hex of the token value. Credentials are passed
 * to curl through a private config file, never on a command line, and the file
 * is removed before the call returns.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function refuse(why) { throw Error('V5_R2_REFUSED: ' + why); }
function privateFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) refuse('absolute path required');
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) refuse('not a regular non-symlink file: ' + file);
  if ((st.mode & 0o077) !== 0) refuse('permissions unsafe, mode 0600 required: ' + file);
  return file;
}
function readJson(file) {
  privateFile(file);
  if (fs.statSync(file).size > 4096) refuse('config file too large: ' + file);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { refuse('invalid JSON: ' + file); }
}
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function credentials(file) {
  const doc = readJson(file);
  const out = {};
  for (const role of ['writer', 'reader']) {
    const c = doc?.[role];
    if (!c || typeof c.token !== 'string' || typeof c.tokenId !== 'string' ||
        typeof c.bucket !== 'string' || typeof c.endpoint !== 'string') {
      refuse('credential document must carry writer and reader {tokenId,token,bucket,endpoint}');
    }
    out[role] = {
      keyId: c.tokenId,
      secret: crypto.createHash('sha256').update(c.token).digest('hex'),
      bucket: c.bucket,
      endpoint: c.endpoint.replace(/\/+$/, '')
    };
    if (!/^[0-9a-f]{32}$/.test(out[role].keyId) || !/^[0-9a-f]{64}$/.test(out[role].secret)) {
      refuse(role + ' credential does not derive a valid R2 access key/secret pair');
    }
  }
  if (out.writer.keyId === out.reader.keyId) refuse('writer and reader must be distinct credentials');
  return out;
}

/** One signed request. Returns raw stdout; throws on transport or HTTP failure. */
function request(cred, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '.v5-r2-'));
  fs.chmodSync(dir, 0o700);
  const cfg = path.join(dir, 'curlrc');
  try {
    fs.writeFileSync(cfg,
      'user = "' + cred.keyId + ':' + cred.secret + '"\n' +
      'aws-sigv4 = "aws:amz:auto:s3"\n' +
      'silent\nshow-error\nfail-with-body\nmax-time = 900\n', { mode: 0o600 });
    const result = spawnSync('curl', ['--config', cfg, ...args], {
      encoding: null, timeout: 920000, maxBuffer: 32 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', HOME: '/', LANG: 'C', LC_ALL: 'C' }
    });
    if (result.error) refuse('curl transport error: ' + result.error.code);
    const body = (result.stdout || Buffer.alloc(0)).toString('utf8');
    if (result.status !== 0) {
      refuse('R2 API rejected the request (curl status ' + result.status + ')' +
        (body ? ' :: ' + body.replace(/[\r\n]+/g, ' ').slice(0, 300) : ''));
    }
    return body;
  } finally {
    try { fs.unlinkSync(cfg); } catch {}
    try { fs.rmdirSync(dir); } catch {}
  }
}
function headersOf(raw) {
  const end = raw.indexOf('\r\n\r\n');
  if (end < 0) refuse('R2 response had no header terminator');
  const lines = raw.slice(0, end).split('\r\n');
  const status = lines.shift() || '';
  if (!/^HTTP\/\d\.\d 2\d\d\b/.test(status)) refuse('unexpected HTTP status line from R2: ' + status);
  const headers = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}
function url(cred, key) {
  return cred.endpoint + '/' + cred.bucket + '/' + key.split('/').map(encodeURIComponent).join('/');
}

const Client = {
  refuse,
  privateFile,
  readJson,
  sha256File,
  credentials,
  request,
  headersOf,
  url,
  /** PUT if absent (If-None-Match: *) with a sha256 metadata stamp. */
  put(cred, key, file, mime, sha256) {
    return this.headersOf(this.request(cred, ['--request', 'PUT', '--upload-file', file,
      '--header', 'If-None-Match: *', '--header', 'Content-Type: ' + mime,
      '--header', 'x-amz-meta-sha256: ' + sha256,
      '--dump-header', '-', '--output', '/dev/null', this.url(cred, key)]));
  },
  head(cred, key) {
    return this.headersOf(this.request(cred, ['--head', '--dump-header', '-',
      '--output', '/dev/null', this.url(cred, key)]));
  },
  get(cred, key, dest) {
    return this.headersOf(this.request(cred, ['--dump-header', '-', '--output', dest,
      this.url(cred, key)]));
  },
  /** Pure ListObjectsV2 page parser (offline-testable): {entries, truncated, nextToken}. */
  parseListPage(body) {
    if (!/<ListBucketResult/.test(body)) refuse('list response was not an S3 listing');
    const entries = [];
    const re = /<Contents>([\s\S]*?)<\/Contents>/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      const block = m[1];
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(block);
      const lm = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block);
      const size = /<Size>([\s\S]*?)<\/Size>/.exec(block);
      if (!key || !lm || !size) refuse('list response entry unparsable');
      entries.push({
        key: key[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
        lastModified: lm[1],
        size: Number(size[1])
      });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(body);
    const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(body);
    return { entries, truncated, nextToken: truncated && token ? token[1] : null };
  },
  /**
   * Paginated ListObjectsV2 for one prefix; returns [{key,lastModified,size}] in S3 key order.
   *
   * PAGINATION IS LOAD-BEARING (LR05 fix, 2026-10-16): a single max-keys=1000 page silently
   * truncated once the backup prefix grew past 500 backups (2 objects each). S3 pages are
   * KEY-ordered and the backup keys embed a timestamp, so the truncated page contained only
   * the OLDEST backups - the freshness check then red-lettered /opsz and failed its unit while
   * the backup pipeline was healthy and uploading every 5 minutes. Follow continuation tokens
   * to completion, and fail closed instead of silently returning partial evidence.
   */
  collectPages(fetchPage, prefix) {
    const MAX_PAGES = 100; /* 100k objects; retention prunes far below this. */
    const out = [];
    let continuation = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = '?list-type=2&prefix=' + encodeURIComponent(prefix) + '&max-keys=1000' +
        (continuation ? '&continuation-token=' + encodeURIComponent(continuation) : '');
      const { entries, truncated, nextToken } = this.parseListPage(fetchPage(query));
      out.push(...entries);
      if (!truncated) return out;
      if (!nextToken) refuse('list response truncated without a continuation token');
      continuation = nextToken;
    }
    refuse('list exceeded the ' + MAX_PAGES + '-page safety cap; the prefix needs retention pruning');
  },
  list(cred, prefix) {
    return this.collectPages((query) => this.request(cred, [cred.endpoint + '/' + cred.bucket + query]), prefix);
  }
};
module.exports = Client;
