'use strict';

// Live P21 staging browser acceptance. This runner targets only the isolated
// tailnet staging deployment. Account secrets come from a private 0600 file;
// OTPs arrive only over stdin from the Oracle operator bridge. Reports contain
// sanitized booleans, counts, revisions, and economy aggregates only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const dns = require('node:dns').promises;
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const game = require('../../src/game.js');

const ROOT = path.resolve(__dirname, '../..');
const ORIGIN = 'https://command.tail95c48c.ts.net';
const WS_URL = 'wss://command.tail95c48c.ts.net/realtime/v1';
const SERVER_ENTRY = path.join(ROOT, 'scripts/v51/p21-staging-server.cjs');
const SAFE_FAILURES = new Set([
  'ARGUMENTS_INVALID', 'PRIVATE_INPUT_INVALID', 'RECEIPT_INVALID',
  'TARGET_IDENTITY_MISMATCH', 'DEPLOYMENT_PREFLIGHT_FAILED',
  'PLAYWRIGHT_UNAVAILABLE', 'BROWSER_LAUNCH_FAILED', 'ACCOUNT_FLOW_FAILED',
  'OTP_BRIDGE_FAILED', 'PROFILE_FLOW_FAILED', 'FRIEND_FLOW_FAILED',
  'QUEUE_FLOW_FAILED', 'REALTIME_FLOW_FAILED', 'MATCH_FLOW_FAILED',
  'ECONOMY_ASSERTION_FAILED', 'EXTERNAL_REQUEST_BLOCKED',
  'TIMEOUT', 'STEP_FAILED',
]);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class SafeFailure extends Error {
  constructor(code) { super(code); this.code = SAFE_FAILURES.has(code) ? code : 'STEP_FAILED'; }
}

function refuse(code) { throw new SafeFailure(code); }

function parseArgs(argv) {
  const values = Object.create(null);
  const accepted = new Set([
    '--actors-file', '--process-receipt', '--expect-server-source',
    '--expect-web-source', '--expect-bundle', '--browser', '--output-root',
    '--timeout-ms',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!accepted.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--') || values[key]) refuse('ARGUMENTS_INVALID');
    values[key] = argv[++i];
  }
  for (const key of [
    '--actors-file', '--process-receipt', '--expect-server-source',
    '--expect-web-source', '--expect-bundle', '--output-root',
  ]) if (!values[key]) refuse('ARGUMENTS_INVALID');
  values['--browser'] ||= 'chromium';
  values['--timeout-ms'] ||= '180000';
  if (!['chromium', 'firefox', 'webkit'].includes(values['--browser'])) refuse('ARGUMENTS_INVALID');
  if (!/^[a-f\d]{40}$/i.test(values['--expect-server-source']) ||
      !/^[a-f\d]{40}$/i.test(values['--expect-web-source']) ||
      !/^[a-f\d]{64}$/i.test(values['--expect-bundle'])) refuse('ARGUMENTS_INVALID');
  if (!/^\d{4,7}$/.test(values['--timeout-ms'])) refuse('ARGUMENTS_INVALID');
  values.timeoutMs = Number(values['--timeout-ms']);
  if (values.timeoutMs < 30000 || values.timeoutMs > 600000) refuse('ARGUMENTS_INVALID');
  return values;
}

function assertOutsideRepo(file) {
  const absolute = path.resolve(file);
  const relative = path.relative(ROOT, absolute);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    refuse('PRIVATE_INPUT_INVALID');
  }
  return absolute;
}

function readPrivateJson(file, maxBytes = 65536) {
  const absolute = assertOutsideRepo(file);
  let stat;
  try {
    if (fs.lstatSync(absolute).isSymbolicLink()) refuse('PRIVATE_INPUT_INVALID');
    stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(absolute) !== absolute ||
        (stat.mode & 0o077) !== 0 || stat.size <= 0 || stat.size > maxBytes ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) refuse('PRIVATE_INPUT_INVALID');
    const text = fs.readFileSync(absolute, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SafeFailure) throw error;
    refuse('PRIVATE_INPUT_INVALID');
  }
}

function persistActors(file, actors) {
  const absolute = assertOutsideRepo(file);
  const parent = path.dirname(absolute);
  let current;
  try {
    const parentStat = fs.lstatSync(parent);
    current = fs.lstatSync(absolute);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || fs.realpathSync(parent) !== parent ||
        current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 ||
        fs.realpathSync(absolute) !== absolute || (current.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && current.uid !== process.getuid())) refuse('PRIVATE_INPUT_INVALID');
  } catch (error) {
    if (error instanceof SafeFailure) throw error;
    refuse('PRIVATE_INPUT_INVALID');
  }
  const rows = ['A', 'B'].map(actor => {
    const value = actors.get(actor);
    if (!value || typeof value.email !== 'string' || typeof value.password !== 'string' || !value.password) refuse('PRIVATE_INPUT_INVALID');
    return { actor, email: value.email, password: value.password };
  });
  const temp = absolute + '.tmp-' + crypto.randomBytes(12).toString('hex');
  let fd = null;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ schema_version: 1, actors: rows }) + '\n', 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(temp, 0o600);
    const latest = fs.lstatSync(absolute);
    if (latest.isSymbolicLink() || !latest.isFile() || latest.ino !== current.ino || latest.dev !== current.dev) refuse('PRIVATE_INPUT_INVALID');
    fs.renameSync(temp, absolute);
    fs.chmodSync(absolute, 0o600);
  } catch (error) {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
    if (error instanceof SafeFailure) throw error;
    refuse('PRIVATE_INPUT_INVALID');
  }
}

function loadActors(file) {
  const data = readPrivateJson(file);
  if (!data || data.schema_version !== 1 || !Array.isArray(data.actors) || data.actors.length !== 2) refuse('PRIVATE_INPUT_INVALID');
  const expected = new Set(['A', 'B']);
  const actors = new Map();
  for (const row of data.actors) {
    if (!row || !expected.has(row.actor) || actors.has(row.actor) ||
        typeof row.email !== 'string' || typeof row.password !== 'string' ||
        row.email.length > 254 || row.password.length < 10 || row.password.length > 256 ||
        !/[a-z]/i.test(row.password) || !/\d/.test(row.password)) refuse('PRIVATE_INPUT_INVALID');
    const email = row.email.trim().toLowerCase();
    const pieces = email.split('@');
    if (pieces.length !== 2 || !pieces[0] || !pieces[1].endsWith('.invalid') ||
        !/^[^\s@]+$/.test(pieces[0]) || !/^[a-z0-9.-]+$/.test(pieces[1])) refuse('PRIVATE_INPUT_INVALID');
    actors.set(row.actor, { actor: row.actor, email, password: row.password });
    expected.delete(row.actor);
  }
  if (expected.size) refuse('PRIVATE_INPUT_INVALID');
  const [a, b] = [actors.get('A').email, actors.get('B').email];
  if (a === b) refuse('PRIVATE_INPUT_INVALID');
  return actors;
}

function readReceipt(file, args) {
  const receipt = readPrivateJson(file, 32768);
  const expectedKeys = [
    'schema_version', 'environment', 'origin', 'source_commit', 'server_entry_sha256',
    'pid', 'boot_time_utc', 'observed_at_utc', 'frontend', 'outbound_disabled', 'bind',
  ];
  if (!receipt || receipt.schema_version !== 1 || expectedKeys.some(key => !(key in receipt)) ||
      receipt.environment !== 'staging' || receipt.origin !== ORIGIN ||
      receipt.source_commit !== args['--expect-server-source'] ||
      !/^[a-f\d]{64}$/i.test(receipt.server_entry_sha256 || '') ||
      receipt.server_entry_sha256 !== sha256(fs.readFileSync(SERVER_ENTRY)) ||
      !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0 ||
      !Number.isFinite(Date.parse(receipt.boot_time_utc)) ||
      !Number.isFinite(Date.parse(receipt.observed_at_utc)) ||
      Date.parse(receipt.boot_time_utc) > Date.now() + 60000 ||
      Date.now() - Date.parse(receipt.observed_at_utc) > 5 * 60 * 1000 ||
      Date.parse(receipt.observed_at_utc) > Date.now() + 60000 ||
      receipt.outbound_disabled !== true ||
      !receipt.bind || receipt.bind.host !== '127.0.0.1' || receipt.bind.port !== 8085 ||
      !receipt.frontend || receipt.frontend.source_commit !== args['--expect-web-source'] ||
      receipt.frontend.bundle_sha256 !== args['--expect-bundle'] ||
      !Number.isSafeInteger(receipt.frontend.file_count) || receipt.frontend.file_count < 1 ||
      !Number.isSafeInteger(receipt.frontend.total_bytes) || receipt.frontend.total_bytes < 1) refuse('RECEIPT_INVALID');
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (head !== args['--expect-server-source']) refuse('TARGET_IDENTITY_MISMATCH');
  } catch (error) {
    if (error instanceof SafeFailure) throw error;
    refuse('TARGET_IDENTITY_MISMATCH');
  }
  return receipt;
}

async function fetchBounded(url, maxBytes, timeoutMs = 20000) {
  let parsed;
  try { parsed = new URL(url); } catch { refuse('DEPLOYMENT_PREFLIGHT_FAILED'); }
  if (parsed.origin !== ORIGIN || parsed.username || parsed.password || parsed.hash) refuse('DEPLOYMENT_PREFLIGHT_FAILED');
  let response;
  try {
    response = await fetch(parsed.href, {
      method: 'GET', redirect: 'manual',
      headers: { accept: 'application/json, text/plain;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { refuse('DEPLOYMENT_PREFLIGHT_FAILED'); }
  if (response.status < 200 || response.status >= 300 || response.headers.get('location')) refuse('DEPLOYMENT_PREFLIGHT_FAILED');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) refuse('DEPLOYMENT_PREFLIGHT_FAILED');
  return { response, buffer };
}

function isTailnetAddress(address) {
  if (net.isIPv4(address)) {
    const octets = address.split('.').map(Number);
    return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  }
  if (!net.isIPv6(address)) return false;
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized.startsWith('::ffff:')) return isTailnetAddress(normalized.slice('::ffff:'.length));
  const halves = normalized.split('::');
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return false;
  const words = [...left, ...Array(missing).fill('0'), ...right].map(part => parseInt(part || '0', 16));
  if (words.length !== 8 || words.some(word => !Number.isFinite(word))) return false;
  const prefix48 = (BigInt(words[0]) << 32n) | (BigInt(words[1]) << 16n) | BigInt(words[2]);
  return prefix48 === 0xfd7a115ca1e0n;
}

async function verifyTailnetResolution() {
  const hostname = new URL(ORIGIN).hostname;
  let addresses;
  try { addresses = await dns.lookup(hostname, { all: true, verbatim: true }); } catch { refuse('DEPLOYMENT_PREFLIGHT_FAILED'); }
  if (!Array.isArray(addresses) || addresses.length === 0 || !addresses.every(row => isTailnetAddress(row.address))) {
    refuse('DEPLOYMENT_PREFLIGHT_FAILED');
  }
  return addresses.length;
}

function safeManifestPath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.includes('%') ||
      value.split('/').some(part => !part || part === '.' || part === '..') ||
      !/^[A-Za-z0-9._/-]+$/.test(value)) refuse('DEPLOYMENT_PREFLIGHT_FAILED');
  return '/' + value.split('/').map(encodeURIComponent).join('/');
}

async function verifyDeployment(receipt, args) {
  const live = await fetchBounded(ORIGIN + '/livez', 4096);
  const ready = await fetchBounded(ORIGIN + '/readyz', 4096);
  if (!live.buffer.toString('utf8').includes('ok') || !ready.buffer.toString('utf8').includes('ok')) refuse('DEPLOYMENT_PREFLIGHT_FAILED');
  const downloaded = await fetchBounded(ORIGIN + '/web-build.manifest.json', 512 * 1024);
  let manifest;
  try { manifest = JSON.parse(downloaded.buffer.toString('utf8')); } catch { refuse('DEPLOYMENT_PREFLIGHT_FAILED'); }
  if (!manifest || manifest.schema_version !== 1 || manifest.generator !== 'scripts/p21/build-web.js' ||
      manifest.source_commit !== args['--expect-web-source'] ||
      manifest.bundle_sha256 !== args['--expect-bundle'] ||
      !Array.isArray(manifest.files) || manifest.file_count !== manifest.files.length ||
      manifest.file_count !== receipt.frontend.file_count ||
      manifest.total_bytes !== receipt.frontend.total_bytes) refuse('TARGET_IDENTITY_MISMATCH');
  const seen = new Set();
  let total = 0;
  const rows = [];
  if (manifest.files.length < 1 || manifest.files.length > 700 || manifest.total_bytes > 32 * 1024 * 1024) refuse('DEPLOYMENT_PREFLIGHT_FAILED');
  for (const file of manifest.files) {
    if (!file || !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
        !/^[a-f\d]{64}$/i.test(file.sha256 || '') ||
        (file.source_sha256 !== undefined && !/^[a-f\d]{64}$/i.test(file.source_sha256)) ||
        file.bytes > 16 * 1024 * 1024 ||
        seen.has(file.path)) refuse('DEPLOYMENT_PREFLIGHT_FAILED');
    seen.add(file.path);
    total += file.bytes;
    rows.push(file.path + '\0' + file.bytes + '\0' + file.sha256);
  }
  const computedBundle = sha256(Buffer.from(rows.join('\0')));
  if (computedBundle !== manifest.bundle_sha256 || total !== manifest.total_bytes) refuse('TARGET_IDENTITY_MISMATCH');
  let cursor = 0;
  const worker = async () => {
    while (cursor < manifest.files.length) {
      const index = cursor++;
      const file = manifest.files[index];
      const asset = await fetchBounded(ORIGIN + safeManifestPath(file.path), Math.max(1, file.bytes + 1), 30000);
      if (asset.buffer.length !== file.bytes || sha256(asset.buffer) !== file.sha256) refuse('TARGET_IDENTITY_MISMATCH');
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, manifest.files.length) }, worker));
  const again = await fetchBounded(ORIGIN + '/web-build.manifest.json', 512 * 1024);
  let finalManifest;
  try { finalManifest = JSON.parse(again.buffer.toString('utf8')); } catch { refuse('DEPLOYMENT_PREFLIGHT_FAILED'); }
  if (finalManifest.bundle_sha256 !== manifest.bundle_sha256 || finalManifest.source_commit !== manifest.source_commit) refuse('TARGET_IDENTITY_MISMATCH');
  return {
    source_commit: manifest.source_commit,
    bundle_sha256: manifest.bundle_sha256,
    file_count: manifest.file_count,
    total_bytes: manifest.total_bytes,
    manifest_bytes_verified: manifest.files.length,
    server_pid: receipt.pid,
    server_entry_sha256: receipt.server_entry_sha256,
    server_source_commit: receipt.source_commit,
  };
}

function createOtpInbox() {
  const queued = new Map();
  const waiting = new Map();
  const readyWaiters = new Set();
  let ended = false;
  let failed = false;
  let readySeen = false;
  const keyFor = (actor, purpose) => actor + ':' + purpose;
  const failInbox = () => {
    failed = true;
    queued.clear();
    for (const waiter of waiting.values()) waiter.reject(new SafeFailure('OTP_BRIDGE_FAILED'));
    waiting.clear();
    for (const waiter of readyWaiters) waiter.reject(new SafeFailure('OTP_BRIDGE_FAILED'));
    readyWaiters.clear();
  };
  if (process.stdin.isTTY) refuse('OTP_BRIDGE_FAILED');
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  rl.on('line', line => {
    if (line.length > 2048 || failed) { line = ''; failInbox(); return; }
    let item;
    try { item = JSON.parse(line); } catch { line = ''; failInbox(); return; }
    line = '';
    if (item?.type === 'operator.ready' && item.schema_version === 1 &&
        Object.keys(item).length === 2 && !readySeen) {
      readySeen = true;
      for (const waiter of readyWaiters) waiter.resolve(true);
      readyWaiters.clear();
      return;
    }
    if (!readySeen || !item || !['A', 'B'].includes(item.actor) ||
        !['signup', 'recovery'].includes(item.purpose) || !/^\d{6}$/.test(item.code || '') ||
        Object.keys(item).some(key => !['actor', 'purpose', 'code'].includes(key))) {
      if (item && typeof item.code === 'string') item.code = '';
      failInbox();
      return;
    }
    const key = keyFor(item.actor, item.purpose);
    const code = item.code;
    item.code = '';
    const waiter = waiting.get(key);
    if (waiter) {
      waiting.delete(key);
      waiter.resolve(code);
    } else {
      if (queued.has(key)) { failInbox(); return; }
      queued.set(key, code);
    }
  });
  rl.on('close', () => { ended = true; queued.clear(); failInbox(); });
  return {
    ready(timeoutMs) {
      if (failed || ended) return Promise.reject(new SafeFailure('OTP_BRIDGE_FAILED'));
      if (readySeen) return Promise.resolve(true);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          readyWaiters.delete(waiter);
          reject(new SafeFailure('OTP_BRIDGE_FAILED'));
        }, timeoutMs);
        const waiter = {
          resolve: value => { clearTimeout(timer); resolve(value); },
          reject: error => { clearTimeout(timer); reject(error); },
        };
        readyWaiters.add(waiter);
      });
    },
    take(actor, purpose, timeoutMs) {
      const key = keyFor(actor, purpose);
      if (failed) return Promise.reject(new SafeFailure('OTP_BRIDGE_FAILED'));
      if (queued.has(key)) {
        const value = queued.get(key);
        queued.delete(key);
        return Promise.resolve(value);
      }
      if (ended) return Promise.reject(new SafeFailure('OTP_BRIDGE_FAILED'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(key);
          reject(new SafeFailure('OTP_BRIDGE_FAILED'));
        }, timeoutMs);
        waiting.set(key, {
          resolve: value => { clearTimeout(timer); resolve(value); },
          reject: error => { clearTimeout(timer); reject(error); },
        });
      });
    },
    close() { queued.clear(); rl.close(); },
  };
}

function routeName(request) {
  let url;
  try { url = new URL(request.url()); } catch { return 'other'; }
  if (url.origin !== ORIGIN) return 'external';
  const p = url.pathname;
  if (p === '/api/account/session') return 'account_session';
  if (p === '/api/account/email') return 'account_email';
  if (p === '/api/account/profile') return 'account_profile';
  if (p === '/api/account/logout') return 'account_logout';
  if (p === '/api/v1/profile') return 'v1_profile';
  if (p === '/realtime/v1/snapshot') return 'realtime_snapshot';
  if (p === '/api/v1/friend') return 'v1_friend';
  if (p === '/api/v1/search') return 'v1_search';
  if (p === '/api/v1/queue') return 'v1_queue';
  if (p === '/api/v1/cancel-queue') return 'v1_cancel_queue';
  if (p === '/api/v1/ticket') return 'v1_ticket';
  if (p === '/api/v1/accept') return 'v1_accept';
  if (p === '/api/v1/decline') return 'v1_decline';
  if (/^\/api\/v1\/match\/[^/]+$/.test(p)) return 'v1_match';
  if (p === '/api/v1/move') return 'v1_move';
  if (p === '/api/v1/resign') return 'v1_resign';
  if (/^\/api\/v1\/friend/.test(p)) return 'v1_friend';
  if (/^\/api\/community\/(search|friend|friends)/.test(p)) return 'community';
  return 'same_origin_other';
}

function addCounter(record, key) { record[key] = (record[key] || 0) + 1; }

function newActor(label, credentials) {
  return {
    label, credentials, context: null, page: null,
    requests: Object.create(null), responses: Object.create(null),
    profileReads: [], latestMatch: null, websocketConnections: 0,
    websocketFrames: [], resumeAcks: [], ticketRequests: 0,
    socketMutationOperations: 0, mutationMethods: Object.create(null),
    successfulEmailActionResponses: 0,
    cspBlocked: false, externalRequests: 0, externalWebSockets: 0,
    routedWebSocketConnections: 0,
    blockMatchReads: false, blockedStateReads: 0, successfulStateReads: 0,
    successfulApiMatchReads: 0, successfulRealtimeSnapshotReads: 0,
    stateReadRequestsInFlight: 0,
    currentMatchId: null, stateReadErrors: 0, actorId: null,
    terminalMatchId: null, terminalObservedAt: null,
    profileRequestsInFlight: 0,
  };
}

function captureMatch(actor, value) {
  if (!value || typeof value !== 'object') return;
  const snapshot = value.snapshot && typeof value.snapshot === 'object' ? value.snapshot : value;
  if (typeof snapshot.id === 'string' && Array.isArray(snapshot.players) && snapshot.state && Number.isSafeInteger(snapshot.revision)) {
    actor.latestMatch = snapshot;
    actor.currentMatchId = snapshot.id;
    if (['FINISHED', 'VOID'].includes(snapshot.status) && actor.terminalMatchId !== snapshot.id) {
      actor.terminalMatchId = snapshot.id;
      actor.terminalObservedAt = Date.now();
    }
  }
}

function safeWallet(profile) {
  const wallet = profile && profile.wallet;
  if (!wallet) return null;
  const ints = ['coins', 'crowns', 'reservedCoins', 'reservedCrowns'];
  if (!ints.every(key => Number.isSafeInteger(wallet[key]) && wallet[key] >= 0)) return null;
  return {
    coins: wallet.coins, crowns: wallet.crowns,
    reservedCoins: wallet.reservedCoins, reservedCrowns: wallet.reservedCrowns,
    rating: Number.isSafeInteger(profile.rating) ? profile.rating : null,
    games: Number.isSafeInteger(profile.games) ? profile.games : null,
    ledgerCount: Array.isArray(wallet.ledger) ? wallet.ledger.length : null,
  };
}

function stableJson(value) {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
}

function installObservers(actor) {
  const context = actor.context, page = actor.page;
  if (typeof context.routeWebSocket !== 'function') refuse('PLAYWRIGHT_UNAVAILABLE');
  context.routeWebSocket('**/*', socketRoute => {
    let url;
    try { url = new URL(socketRoute.url()); } catch {
      actor.externalWebSockets += 1;
      return socketRoute.close({ code: 1008, reason: 'blocked' });
    }
    if (url.href !== WS_URL) {
      actor.externalWebSockets += 1;
      return socketRoute.close({ code: 1008, reason: 'blocked' });
    }
    actor.routedWebSocketConnections += 1;
    socketRoute.connectToServer();
  });
  context.route('**/*', async route => {
    let url;
    try { url = new URL(route.request().url()); } catch { actor.externalRequests += 1; await route.abort(); return; }
    if (url.origin !== ORIGIN) { actor.externalRequests += 1; await route.abort(); return; }
    const name = routeName(route.request());
    if (actor.blockMatchReads && route.request().method() === 'GET' && ['v1_match', 'realtime_snapshot'].includes(name)) {
      actor.blockedStateReads += 1;
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"SERVICE_UNAVAILABLE"}' });
      return;
    }
    await route.continue();
  });
  page.on('request', request => {
    const name = routeName(request);
    addCounter(actor.requests, name);
    if (name === 'external') actor.externalRequests += 1;
    if (name === 'v1_ticket') actor.ticketRequests += 1;
    if (name === 'v1_profile') actor.profileRequestsInFlight += 1;
    if (['v1_match', 'realtime_snapshot'].includes(name)) actor.stateReadRequestsInFlight += 1;
    if (['v1_queue', 'v1_accept', 'v1_move', 'v1_resign'].includes(name)) {
      addCounter(actor.mutationMethods, name + '_' + request.method());
    }
  });
  const profileRequestDone = request => {
    if (routeName(request) === 'v1_profile') actor.profileRequestsInFlight = Math.max(0, actor.profileRequestsInFlight - 1);
    if (['v1_match', 'realtime_snapshot'].includes(routeName(request))) {
      actor.stateReadRequestsInFlight = Math.max(0, actor.stateReadRequestsInFlight - 1);
    }
  };
  page.on('requestfinished', profileRequestDone);
  page.on('requestfailed', profileRequestDone);
  page.on('response', response => {
    const request = response.request();
    const name = routeName(request);
    addCounter(actor.responses, name + '_' + response.status());
    if (name === 'account_email' && response.status() >= 200 && response.status() < 300) {
      actor.successfulEmailActionResponses += 1;
    }
    if (['v1_match', 'realtime_snapshot'].includes(name)) {
      if (response.status() >= 200 && response.status() < 300) {
        actor.successfulStateReads += 1;
        if (name === 'v1_match') actor.successfulApiMatchReads += 1;
        if (name === 'realtime_snapshot') actor.successfulRealtimeSnapshotReads += 1;
      } else actor.stateReadErrors += 1;
      response.json().then(value => captureMatch(actor, value)).catch(() => {});
    }
    if (['v1_accept', 'v1_move', 'v1_resign'].includes(name) && response.status() >= 200 && response.status() < 300) {
      response.json().then(value => captureMatch(actor, value)).catch(() => {});
    }
    if (name === 'v1_profile' && response.status() === 200) {
      response.json().then(value => {
        if (typeof value?.id === 'string') actor.actorId = value.id;
        const wallet = safeWallet(value);
        if (wallet) {
          actor.profileReads.push({ ...wallet, at: Date.now() });
          if (actor.profileReads.length > 300) actor.profileReads.shift();
        }
      }).catch(() => {});
    }
  });
  page.on('websocket', socket => {
    let url;
    try { url = new URL(socket.url()); } catch { actor.externalWebSockets += 1; return; }
    if (url.href !== WS_URL) { actor.externalWebSockets += 1; return; }
    actor.websocketConnections += 1;
    socket.on('framereceived', payload => {
      let raw = typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : '';
      if (!raw || raw.length > 270000) { raw = ''; return; }
      let frame;
      try { frame = JSON.parse(raw); } catch { raw = ''; return; }
      raw = '';
      if (!frame || frame.protocol !== 'realtime/v1' || frame.match_id !== actor.currentMatchId) { frame = null; return; }
      const operation = typeof frame.operation === 'string' ? frame.operation : '';
      const revision = Number.isSafeInteger(frame.ack_revision) ? frame.ack_revision :
        Number.isSafeInteger(frame.expected_revision) ? frame.expected_revision :
          Number.isSafeInteger(frame.snapshot?.revision) ? frame.snapshot.revision : null;
      if (operation === 'snapshot' && frame.snapshot) captureMatch(actor, frame.snapshot);
      if (operation && actor.websocketFrames.length < 600) actor.websocketFrames.push({ operation, revision, at: Date.now() });
      frame = null;
    });
    socket.on('framesent', payload => {
      const raw = typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : '';
      if (!raw || raw.length > 270000) return;
      if (raw.includes('"operation":"ticket.redeem"')) return;
      if (!/"operation":"(resume|move|resign|queue|accept|decline|cancel|purchase)"/.test(raw)) return;
      let outbound;
      try { outbound = JSON.parse(raw); } catch { return; }
      if (['move', 'resign', 'queue', 'accept', 'decline', 'cancel', 'purchase'].includes(outbound?.operation)) {
        actor.socketMutationOperations += 1;
      }
      if (outbound?.protocol === 'realtime/v1' && outbound.operation === 'resume' &&
          Number.isSafeInteger(outbound.ack_revision) && actor.resumeAcks.length < 100) {
        actor.resumeAcks.push({ revision: outbound.ack_revision, at: Date.now() });
      }
      outbound = null;
    });
  });
  page.on('console', message => {
    if (message.type() === 'error' && /content security policy|connect-src/i.test(message.text())) actor.cspBlocked = true;
  });
}

async function createBrowserActor(browser, label, credentials) {
  const actor = newActor(label, credentials);
  actor.context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    serviceWorkers: 'block',
    acceptDownloads: false,
    ignoreHTTPSErrors: false,
    colorScheme: 'light',
  });
  actor.page = await actor.context.newPage();
  installObservers(actor);
  return actor;
}

async function waitForCount(predicate, timeoutMs, intervalMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await delay(intervalMs);
  }
  return Boolean(await predicate());
}

async function waitForProfile(actor, previousCount, timeoutMs) {
  return waitForCount(() => actor.profileReads.length > previousCount, timeoutMs);
}

async function waitForProfileQuiet(actors, timeoutMs = 15000) {
  let stableSince = Date.now();
  let counts = actors.map(actor => actor.profileReads.length).join(',');
  while (Date.now() - stableSince < timeoutMs) {
    await delay(100);
    const current = actors.map(actor => actor.profileReads.length).join(',');
    if (actors.some(actor => actor.profileRequestsInFlight > 0) || current !== counts) {
      counts = current;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 500) return;
  }
}

async function waitForMatchRevision(actor, revision, timeoutMs) {
  return waitForCount(() => actor.latestMatch && actor.latestMatch.revision >= revision, timeoutMs);
}

async function uiLogin(actor, password, timeoutMs) {
  const page = actor.page;
  await page.goto(ORIGIN + '/account', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const form = page.locator('form[data-account-form="email"]');
  await form.waitFor({ state: 'visible', timeout: timeoutMs });
  await form.locator('input[name="email"]').fill(actor.credentials.email);
  await form.locator('input[name="password"]').fill(password);
  const profileBefore = actor.profileReads.length;
  await form.locator('button[type="submit"]').click();
  await page.locator('.pg-account-tag').waitFor({ state: 'visible', timeout: timeoutMs });
  await page.waitForFunction(() => document.querySelector('.pg-account-tag')?.textContent?.trim().length > 0, null, { timeout: timeoutMs });
  const tag = (await page.locator('.pg-account-tag').textContent())?.trim();
  if (!tag || tag.length > 80) refuse('ACCOUNT_FLOW_FAILED');
  const ready = await waitForProfile(actor, profileBefore, timeoutMs);
  return { tag, linkedUi: true, profileAvailable: ready };
}

async function uiEnsureAccount(actor, otpInbox, timeoutMs) {
  const page = actor.page;
  await page.goto(ORIGIN + '/account', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const form = page.locator('form[data-account-form="email"]');
  await form.waitFor({ state: 'visible', timeout: timeoutMs });
  await form.locator('input[name="email"]').fill(actor.credentials.email);
  await form.locator('input[name="password"]').fill(actor.credentials.password);
  const profileBefore = actor.profileReads.length;
  await form.locator('button[type="submit"]').click();
  await page.waitForFunction(() => {
    const visible = node => node && node.getClientRects().length > 0;
    return visible(document.querySelector('.pg-account-tag')) ||
      visible(document.querySelector('form[data-account-form="verify"]'));
  }, null, { timeout: timeoutMs });
  let verifiedNow = false;
  const verify = page.locator('form[data-account-form="verify"]');
  if (await verify.isVisible().catch(() => false)) {
    let code = await otpInbox.take(actor.label, 'signup', Math.min(120000, timeoutMs));
    await verify.locator('input[name="code"]').fill(code);
    code = '';
    await verify.locator('button[type="submit"]').click();
    verifiedNow = true;
  }
  await page.locator('.pg-account-tag').waitFor({ state: 'visible', timeout: timeoutMs });
  const tag = (await page.locator('.pg-account-tag').textContent())?.trim();
  if (!tag || tag.length > 80) refuse('ACCOUNT_FLOW_FAILED');
  const profileAvailable = await waitForProfile(actor, profileBefore, timeoutMs);
  return { tag, verifiedNow, signedIn: true, profileAvailable };
}

async function uiRecover(actor, otpInbox, timeoutMs, persistCredentials) {
  const page = actor.page;
  await page.goto(ORIGIN + '/account', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.locator('form[data-account-form="email"]').waitFor({ state: 'visible', timeout: timeoutMs });
  await page.locator('button[data-account-action="view"][data-account-view="recover"]').click();
  const recover = page.locator('form[data-account-form="recover"]');
  await recover.waitFor({ state: 'visible', timeout: timeoutMs });
  await recover.locator('input[name="email"]').fill(actor.credentials.email);
  await recover.locator('button[type="submit"]').click();
  let code = await otpInbox.take(actor.label, 'recovery', Math.min(120000, timeoutMs));
  const resetPassword = 'P21-' + crypto.randomBytes(18).toString('base64url') + 'A9x';
  const reset = page.locator('form[data-account-form="reset"]');
  await reset.waitFor({ state: 'visible', timeout: timeoutMs });
  await reset.locator('input[name="code"]').fill(code);
  code = '';
  await reset.locator('input[name="password"]').fill(resetPassword);
  await reset.locator('input[name="confirmPassword"]').fill(resetPassword);
  const resetSuccessBaseline = actor.successfulEmailActionResponses;
  await reset.locator('button[type="submit"]').click();
  const resetAccepted = await waitForCount(() => actor.successfulEmailActionResponses >= resetSuccessBaseline + 2, timeoutMs, 100);
  if (!resetAccepted) refuse('ACCOUNT_FLOW_FAILED');
  await reset.locator('input[name="code"]').fill('');
  actor.credentials.password = resetPassword;
  persistCredentials();
  await page.locator('button[data-account-action="view"][data-account-view="email"]').waitFor({ state: 'visible', timeout: timeoutMs });
  await page.locator('button[data-account-action="view"][data-account-view="email"]').click();
  const login = await uiLogin(actor, resetPassword, timeoutMs);
  return { recoveryCompleted: true, signedInAfterReset: true, tag: login.tag, profileAvailable: login.profileAvailable };
}

async function uiEditProfile(actor, label, timeoutMs) {
  const page = actor.page;
  await page.goto(ORIGIN + '/profile', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const form = page.locator('form[data-profile-form]');
  await form.waitFor({ state: 'visible', timeout: timeoutMs });
  const profileBefore = actor.profileReads.length;
  await form.locator('input[name="displayName"]').fill('Staging QA ' + label);
  await form.locator('button[type="submit"]').click();
  await page.locator('[data-profile-message]').filter({ hasText: 'Your profile changes are saved.' }).waitFor({ state: 'visible', timeout: timeoutMs });
  await waitForProfile(actor, profileBefore, timeoutMs);
  return { saved: true, profileReadCount: actor.profileReads.length };
}

async function uiReloadSessionRestore(actor, timeoutMs) {
  const started = Date.now();
  const beforeProfiles = actor.profileReads.length;
  const bounded = Math.min(8000, timeoutMs);
  await actor.page.reload({ waitUntil: 'domcontentloaded', timeout: bounded });
  await actor.page.locator('.pg-account-tag').waitFor({ state: 'visible', timeout: bounded });
  const profileAvailable = await waitForProfile(actor, beforeProfiles, bounded);
  const elapsed = Date.now() - started;
  return { restored: profileAvailable && elapsed <= 8000, profile_available: profileAvailable, elapsed_ms: elapsed };
}

async function uiBfCacheRestore(actor, timeoutMs) {
  const bounded = Math.min(8000, timeoutMs);
  await actor.page.addInitScript(() => {
    window.__p21BfCacheRestored = false;
    window.addEventListener('pageshow', event => { if (event.persisted) window.__p21BfCacheRestored = true; });
  });
  await actor.page.goto(ORIGIN + '/account?codex-lifecycle=1', { waitUntil: 'domcontentloaded', timeout: bounded });
  await actor.page.locator('.pg-account-tag').waitFor({ state: 'visible', timeout: bounded });
  await actor.page.goto(ORIGIN + '/profile?codex-lifecycle=1', { waitUntil: 'domcontentloaded', timeout: bounded });
  await actor.page.locator('form[data-profile-form]').waitFor({ state: 'visible', timeout: bounded });
  const profileBefore = actor.profileReads.length;
  await actor.page.goBack({ waitUntil: 'domcontentloaded', timeout: bounded });
  await actor.page.locator('.pg-account-tag').waitFor({ state: 'visible', timeout: bounded });
  const profileAvailable = await waitForProfile(actor, profileBefore, bounded);
  const bfcacheRestored = await actor.page.evaluate(() => window.__p21BfCacheRestored === true);
  return { bfcache_restored: bfcacheRestored, session_profile_restored: profileAvailable };
}

async function uiLogoutAndFence(actor, timeoutMs) {
  const page = actor.page;
  await page.goto(ORIGIN + '/account', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.locator('button[data-account-action="logout"]').waitFor({ state: 'visible', timeout: timeoutMs });
  await page.locator('button[data-account-action="logout"]').click();
  await page.getByText('You are signed out.').waitFor({ state: 'visible', timeout: timeoutMs });
  const unauthorizedBefore = actor.responses.v1_profile_401 || 0;
  await page.goto(ORIGIN + '/profile', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.getByText('Sign in to load and edit your profile details.').waitFor({ state: 'visible', timeout: timeoutMs });
  const unauthorized = await waitForCount(() => (actor.responses.v1_profile_401 || 0) > unauthorizedBefore, timeoutMs);
  return { signed_out_ui: true, protected_profile_denied: unauthorized };
}

async function uiAuthenticatedProfileProbe(actor, expectedActorId, timeoutMs) {
  const before = actor.profileReads.length;
  await actor.page.goto(ORIGIN + '/profile', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await actor.page.locator('form[data-profile-form]').waitFor({ state: 'visible', timeout: timeoutMs });
  const profileRead = await waitForProfile(actor, before, timeoutMs);
  return {
    authenticated_profile_visible: profileRead,
    same_actor_identity: Boolean(expectedActorId && actor.actorId === expectedActorId),
  };
}

async function uiFriendPair(actorA, actorB, tagA, tagB, timeoutMs) {
  await actorA.page.goto(ORIGIN + '/friends', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const searchA = actorA.page.locator('form[data-friends-search]');
  await searchA.waitFor({ state: 'visible', timeout: timeoutMs });
  await searchA.locator('input[name="query"]').fill(tagB);
  await searchA.locator('button[type="submit"]').click();
  const resultA = actorA.page.locator('#friend-search-results').getByRole('button', { name: /Add friend/ });
  await resultA.first().waitFor({ state: 'visible', timeout: timeoutMs });
  await resultA.first().click();
  await actorA.page.locator('#friend-outgoing .pg-friend-row').waitFor({ state: 'visible', timeout: timeoutMs });

  await actorB.page.goto(ORIGIN + '/friends', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const requestB = actorB.page.locator('#friend-requests .pg-friend-row');
  await requestB.waitFor({ state: 'visible', timeout: timeoutMs });
  await requestB.locator('button[data-friend-action="accept"]').first().click();
  await actorB.page.locator('#friend-list .pg-friend-row').waitFor({ state: 'visible', timeout: timeoutMs });

  const refresh = actorA.page.locator('button[data-friend-action="refresh"]');
  await refresh.click();
  await actorA.page.locator('#friend-list .pg-friend-row').waitFor({ state: 'visible', timeout: timeoutMs });
  const confirmed = await waitForCount(async () => {
    const [a, b] = await Promise.all([
      actorA.page.locator('#friend-list .pg-friend-row code').allTextContents(),
      actorB.page.locator('#friend-list .pg-friend-row code').allTextContents(),
    ]);
    return a.includes(tagB) && b.includes(tagA);
  }, timeoutMs, 200);
  return { requestCreated: true, requestAccepted: true, mutualFriendUi: confirmed };
}

async function queuePair(actorA, actorB, mode, timeoutMs) {
  if (!['ranked', 'casual'].includes(mode)) refuse('QUEUE_FLOW_FAILED');
  const actors = [actorA, actorB];
  for (const actor of actors) {
    await actor.page.goto(ORIGIN + '/game', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await actor.page.locator('button[data-online-action="' + mode + '"]').waitFor({ state: 'visible', timeout: timeoutMs });
  }
  await Promise.all(actors.map(actor => actor.page.locator('button[data-online-action="' + mode + '"]').click()));
  await Promise.all(actors.map(actor => actor.page.locator('button[data-online-action="accept"]').waitFor({ state: 'visible', timeout: timeoutMs })));
  await Promise.all(actors.map(actor => actor.page.locator('button[data-online-action="accept"]').click()));
  const playing = async actor => {
    await actor.page.locator('.gb-stage[aria-label="Online Mega XOXO match"]').waitFor({ state: 'visible', timeout: timeoutMs });
    const ready = await waitForCount(() => actor.latestMatch?.status === 'PLAYING' &&
      Array.isArray(actor.latestMatch.players) && actor.latestMatch.players.length === 2 &&
      actor.latestMatch.players.includes(actor.actorId), timeoutMs, 100);
    if (!ready) refuse('QUEUE_FLOW_FAILED');
  };
  await Promise.all(actors.map(playing));
  const a = actorA.latestMatch, b = actorB.latestMatch;
  if (!a || !b || a.id !== b.id || a.status !== 'PLAYING' || b.status !== 'PLAYING' ||
      a.quote?.rated !== (mode === 'ranked') || b.quote?.rated !== (mode === 'ranked') ||
      a.revision !== b.revision || a.revision !== 0) refuse('QUEUE_FLOW_FAILED');
  return a;
}

async function assertMobileBoardFits(actor, width, height, timeoutMs) {
  await actor.page.setViewportSize({ width, height });
  await actor.page.locator('.gb-stage[aria-label="Online Mega XOXO match"]').waitFor({ state: 'visible', timeout: timeoutMs });
  const layout = await actor.page.evaluate(() => {
    const stage = document.querySelector('.gb-stage[aria-label="Online Mega XOXO match"]');
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    return {
      viewport_width: window.innerWidth,
      document_width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
      stage_left: Math.round(rect.left * 100) / 100,
      stage_right: Math.round(rect.right * 100) / 100,
      stage_width: Math.round(rect.width * 100) / 100,
    };
  });
  if (!layout) return { fits: false, requested_viewport_width: width };
  const fits = layout.viewport_width === width && layout.document_width <= width + 1 &&
    layout.stage_left >= -1 && layout.stage_right <= width + 1;
  return { ...layout, fits };
}

function deterministicRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function actorForTurn(snapshot, actors) {
  const actorId = snapshot?.symbols?.[snapshot.state?.turn];
  return actors.find(actor => actor.actorId === actorId) || null;
}

async function moveCountOnPage(actor) {
  return actor.page.locator('.gb-match-note > span').evaluate(node => {
    const match = /^(\d+)/.exec(node.textContent || '');
    return match ? Number(match[1]) : -1;
  });
}

async function placeLegalMove(actor, move, expectedRevision, timeoutMs) {
  const cell = actor.page.locator('button[data-gb-cell="' + move.b + ':' + move.c + '"]');
  await cell.waitFor({ state: 'visible', timeout: timeoutMs });
  if (await cell.getAttribute('aria-disabled') !== 'false') refuse('MATCH_FLOW_FAILED');
  await cell.click();
  const advanced = await waitForMatchRevision(actor, expectedRevision + 1, timeoutMs);
  if (!advanced || actor.latestMatch.revision !== expectedRevision + 1) refuse('MATCH_FLOW_FAILED');
  const canonical = actor.latestMatch.state;
  if (!canonical || canonical.moves.length !== expectedRevision + 1 ||
      canonical.moves[expectedRevision]?.b !== move.b || canonical.moves[expectedRevision]?.c !== move.c) refuse('MATCH_FLOW_FAILED');
  return actor.latestMatch;
}

async function assertReceiverPushWithoutMatchRead(sender, receiver, timeoutMs) {
  const starting = sender.latestMatch;
  if (!starting || starting.status !== 'PLAYING') refuse('REALTIME_FLOW_FAILED');
  receiver.blockMatchReads = true;
  const blocked = await waitForCount(() => receiver.blockedStateReads > 0, Math.min(timeoutMs, 5000), 100);
  if (!blocked) { receiver.blockMatchReads = false; refuse('REALTIME_FLOW_FAILED'); }
  const quiet = await waitForCount(() => receiver.stateReadRequestsInFlight === 0, Math.min(timeoutMs, 5000), 50);
  if (!quiet) { receiver.blockMatchReads = false; refuse('REALTIME_FLOW_FAILED'); }
  const receiverReads = receiver.successfulStateReads;
  const blockedCount = receiver.blockedStateReads;
  const move = game.choose(starting.state, 'Beginner', deterministicRandom(0x21a51)) || game.legal(starting.state)[0];
  if (!move) { receiver.blockMatchReads = false; refuse('REALTIME_FLOW_FAILED'); }
  const frameCount = receiver.websocketFrames.length;
  const next = await placeLegalMove(sender, move, starting.revision, timeoutMs);
  const pushed = await waitForCount(() => receiver.latestMatch?.id === starting.id &&
    receiver.latestMatch.revision === next.revision &&
    receiver.websocketFrames.slice(frameCount).some(frame => frame.operation === 'snapshot' && frame.revision === next.revision), timeoutMs, 100);
  const uiRevision = await waitForCount(async () => await moveCountOnPage(receiver) === next.revision, timeoutMs, 100);
  const noSuccessfulHttpSnapshot = receiver.successfulStateReads === receiverReads;
  const blockedHttpReads = receiver.blockedStateReads - blockedCount;
  receiver.blockMatchReads = false;
  if (!pushed || !uiRevision || !noSuccessfulHttpSnapshot) refuse('REALTIME_FLOW_FAILED');
  return {
    pushed_revision: next.revision,
    receiver_successful_state_reads_during_push: receiver.successfulStateReads - receiverReads,
    receiver_blocked_state_reads_during_push: blockedHttpReads,
    receiver_ui_revision: next.revision,
    wss_snapshot_received: true,
  };
}

async function reconnectAndResume(actor, timeoutMs) {
  const beforeRevision = actor.latestMatch?.revision;
  const beforeTickets = actor.ticketRequests;
  const beforeSockets = actor.websocketConnections;
  const beforeAcks = actor.resumeAcks.length;
  const beforeFrames = actor.websocketFrames.length;
  const beforeRecoveryReads = actor.successfulRealtimeSnapshotReads;
  if (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1) refuse('REALTIME_FLOW_FAILED');
  try {
    await actor.context.setOffline(true);
    await delay(500);
    await actor.context.setOffline(false);
  } catch { refuse('REALTIME_FLOW_FAILED'); }
  const waitMs = Math.min(timeoutMs, 45000);
  const reconnected = await waitForCount(() => actor.ticketRequests > beforeTickets &&
    actor.websocketConnections > beforeSockets, waitMs, 100);
  const resumed = await waitForCount(() => actor.resumeAcks.slice(beforeAcks).some(row => row.revision === beforeRevision), waitMs, 100);
  const serverAck = await waitForCount(() => actor.websocketFrames.slice(beforeFrames)
    .some(frame => frame.operation === 'ack' && frame.revision === beforeRevision), waitMs, 100);
  const websocketSnapshot = await waitForCount(() => actor.websocketFrames.slice(beforeFrames)
    .some(frame => frame.operation === 'snapshot' && frame.revision === beforeRevision), waitMs, 100);
  const fullSnapshot = await waitForCount(() => actor.successfulRealtimeSnapshotReads > beforeRecoveryReads &&
    actor.latestMatch?.revision === beforeRevision &&
    actor.latestMatch?.status === 'PLAYING', waitMs, 100);
  if (!reconnected || !resumed || !serverAck || !websocketSnapshot || !fullSnapshot) refuse('REALTIME_FLOW_FAILED');
  return {
    fresh_ticket_requests: actor.ticketRequests - beforeTickets,
    fresh_websocket_connections: actor.websocketConnections - beforeSockets,
    resume_ack_revision: beforeRevision,
    recovered_snapshot_revision: actor.latestMatch.revision,
    server_ack_received: serverAck,
    server_full_snapshot_received: websocketSnapshot,
    full_snapshot_http_reads: actor.successfulRealtimeSnapshotReads - beforeRecoveryReads,
    ack_matches_full_snapshot: true,
  };
}

async function assertTerminalBoardDisabled(actor, timeoutMs) {
  const cells = actor.page.locator('button[data-gb-cell]');
  await actor.page.locator('.gb-stage[aria-label="Online Mega XOXO match"]').waitFor({ state: 'visible', timeout: timeoutMs });
  const count = await cells.count();
  if (count !== 81) return false;
  const disabled = await cells.evaluateAll(nodes => nodes.every(node => node.getAttribute('aria-disabled') === 'true'));
  return disabled;
}

async function playToTerminal(actors, timeoutMs, seed) {
  let snapshot = actors[0].latestMatch;
  if (!snapshot || snapshot.status !== 'PLAYING') refuse('MATCH_FLOW_FAILED');
  let state = snapshot.state;
  let steps = 0;
  let terminalProfileBaseline = null;
  const random = deterministicRandom(seed);
  while (state.winner === null && steps < 81) {
    const actor = actorForTurn(snapshot, actors);
    const move = game.choose(state, 'Beginner', random) || game.legal(state)[0];
    if (!actor || !move || !game.legal(state).some(item => item.b === move.b && item.c === move.c)) refuse('MATCH_FLOW_FAILED');
    const expected = game.apply(state, move);
    const before = snapshot.revision;
    if (expected.winner !== null) {
      await actor.page.bringToFront();
      await waitForProfileQuiet(actors);
      terminalProfileBaseline = actors.map(item => item.profileReads.length);
    }
    snapshot = await placeLegalMove(actor, move, before, timeoutMs);
    if (stableJson(snapshot.state) !== stableJson(expected)) refuse('MATCH_FLOW_FAILED');
    state = expected;
    steps += 1;
    for (const other of actors) {
      const synchronized = await waitForCount(async () => {
        if (other.latestMatch?.id === snapshot.id && other.latestMatch.revision === snapshot.revision) return true;
        return (await moveCountOnPage(other)) === snapshot.revision;
      }, Math.min(timeoutMs, 15000), 100);
      if (!synchronized) refuse('REALTIME_FLOW_FAILED');
    }
  }
  if (state.winner === null || steps < 1 || steps > 81) refuse('MATCH_FLOW_FAILED');
  const terminal = await waitForCount(() => actors.every(actor =>
    actor.latestMatch?.id === snapshot.id && ['FINISHED', 'VOID'].includes(actor.latestMatch.status) &&
    actor.latestMatch.state?.winner !== null), timeoutMs, 100);
  if (!terminal || actors.some(actor => actor.latestMatch.status !== 'FINISHED')) refuse('MATCH_FLOW_FAILED');
  await Promise.all(actors.map(actor => actor.page.locator('button[data-online-action="new"]').waitFor({ state: 'visible', timeout: timeoutMs })));
  const disabledBoards = await Promise.all(actors.map(actor => assertTerminalBoardDisabled(actor, timeoutMs)));
  if (!disabledBoards.every(Boolean)) refuse('MATCH_FLOW_FAILED');
  if (!terminalProfileBaseline) refuse('MATCH_FLOW_FAILED');
  const refreshes = await Promise.all(actors.map((actor, index) =>
    waitForProfile(actor, terminalProfileBaseline[index], timeoutMs)));
  if (!refreshes.every(Boolean)) refuse('ECONOMY_ASSERTION_FAILED');
  return {
    id: snapshot.id, revision: snapshot.revision, moves: steps, winner: state.winner,
    profileRefreshCounts: actors.map((actor, index) => actor.profileReads.length - terminalProfileBaseline[index]),
    disabled_boards: disabledBoards.filter(Boolean).length,
  };
}

async function resignMatch(actors, timeoutMs) {
  const snapshot = actors[0].latestMatch;
  if (!snapshot || snapshot.status !== 'PLAYING') refuse('MATCH_FLOW_FAILED');
  const actor = actors[1];
  const revision = snapshot.revision;
  await actor.page.bringToFront();
  await actor.page.locator('button[data-gb-action="resign"]').waitFor({ state: 'visible', timeout: timeoutMs });
  await waitForProfileQuiet(actors);
  const baselineProfiles = actors.map(item => item.profileReads.length);
  actor.page.once('dialog', dialog => dialog.accept());
  await actor.page.locator('button[data-gb-action="resign"]').click();
  const completed = await waitForCount(() => actors.every(item =>
    item.latestMatch?.id === snapshot.id && item.latestMatch.status === 'FINISHED' &&
    item.latestMatch.revision === revision), timeoutMs, 100);
  if (!completed) refuse('MATCH_FLOW_FAILED');
  const terminal = actors[0].latestMatch;
  if (terminal.state?.winner == null) refuse('MATCH_FLOW_FAILED');
  await Promise.all(actors.map(item => item.page.locator('button[data-online-action="new"]').waitFor({ state: 'visible', timeout: timeoutMs })));
  const disabledBoards = await Promise.all(actors.map(item => assertTerminalBoardDisabled(item, timeoutMs)));
  if (!disabledBoards.every(Boolean)) refuse('MATCH_FLOW_FAILED');
  const refreshed = await Promise.all(actors.map((item, index) =>
    waitForProfile(item, baselineProfiles[index], timeoutMs)));
  if (!refreshed.every(Boolean)) refuse('ECONOMY_ASSERTION_FAILED');
  return {
    revision: terminal.revision,
    terminal_status: terminal.status,
    receipt_present: Boolean(terminal.receipt),
    disabled_boards: disabledBoards.filter(Boolean).length,
    profile_refresh_counts: actors.map((item, index) => item.profileReads.length - baselineProfiles[index]),
  };
}

function prepareOutput(rootArg) {
  const absolute = assertOutsideRepo(rootArg);
  const parts = absolute.split(path.sep).filter(Boolean);
  let cursor = path.parse(absolute).root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(cursor) !== cursor) refuse('PRIVATE_INPUT_INVALID');
    } else {
      fs.mkdirSync(cursor, { mode: 0o700 });
    }
  }
  try {
    const rootStat = fs.lstatSync(absolute);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || fs.realpathSync(absolute) !== absolute ||
        (rootStat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && rootStat.uid !== process.getuid())) refuse('PRIVATE_INPUT_INVALID');
  } catch (error) {
    if (error instanceof SafeFailure) throw error;
    refuse('PRIVATE_INPUT_INVALID');
  }
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex');
  const runDir = path.join(absolute, 'staging-browser-' + runId);
  try { fs.mkdirSync(runDir, { mode: 0o700 }); } catch { refuse('PRIVATE_INPUT_INVALID'); }
  return runDir;
}

function check(report, id, passed, evidence = {}) {
  const row = { id, result: passed ? 'PASS' : 'FAIL', ...evidence };
  report.checks.push(row);
  if (!passed) report.failures.push(row);
  if (!passed) refuse('STEP_FAILED');
  return row;
}

function writeReport(directory, report) {
  if (!directory) return;
  try {
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch { /* preserve the sanitized stdout result if an evidence write fails */ }
}

function scrubActor(actor) {
  if (!actor) return;
  if (actor.credentials) {
    actor.credentials.email = '';
    actor.credentials.password = '';
  }
  actor.actorId = null;
  actor.currentMatchId = null;
  actor.latestMatch = null;
  actor.profileReads.length = 0;
  actor.websocketFrames.length = 0;
  actor.resumeAcks.length = 0;
}

function aggregate(wallets, key) {
  if (!wallets.every(wallet => wallet && Number.isSafeInteger(wallet[key]))) return null;
  return wallets.reduce((sum, wallet) => sum + wallet[key], 0);
}

async function run(argv) {
  let args, outputDir = null, report = null, browser = null, otpInbox = null, credentials = null;
  let phase = 'arguments';
  const actors = [];
  let exitCode = 1;
  try {
    args = parseArgs(argv);
    outputDir = prepareOutput(args['--output-root']);
    report = {
      schema_version: 1,
      test: 'P21_ACTUAL_STAGING_BROWSER_E2E',
      result: 'RUNNING',
      target: { environment: 'staging', origin: ORIGIN, bind_host: '127.0.0.1', bind_port: 8085 },
      command: 'node scripts/p21/staging-browser-qa.cjs --browser=' + args['--browser'] + ' (private paths and credential values redacted)',
      expected: {
        server_source_commit: args['--expect-server-source'],
        web_source_commit: args['--expect-web-source'],
        bundle_sha256: args['--expect-bundle'],
      },
      checks: [], failures: [], evidence: {}, metrics: {},
      started_at_utc: new Date().toISOString(),
    };
    phase = 'receipt';
    const receipt = readReceipt(args['--process-receipt'], args);
    phase = 'tailnet_dns_allowlist';
    const tailnetAddressCount = await verifyTailnetResolution();
    phase = 'remote_deployment_preflight';
    const deployment = await verifyDeployment(receipt, args);
    report.evidence = {
      ...deployment,
      browser: args['--browser'],
      tailnet_dns_addresses_verified: tailnetAddressCount,
      operator_receipt_boot_time_utc: receipt.boot_time_utc,
      operator_receipt_observed_at_utc: receipt.observed_at_utc,
    };
    check(report, 'fresh_process_receipt_matches_target', true, { process_receipt: 'verified', outbound_disabled: true });
    check(report, 'https_staging_manifest_and_all_payload_bytes_match', true, {
      file_count: deployment.file_count, total_bytes: deployment.total_bytes,
      verified_payload_files: deployment.manifest_bytes_verified,
    });

    phase = 'private_actor_file';
    credentials = loadActors(args['--actors-file']);
    let playwright;
    try { playwright = require('playwright'); } catch {
      try { playwright = require('playwright-core'); } catch { refuse('PLAYWRIGHT_UNAVAILABLE'); }
    }
    phase = 'browser_launch';
    try { browser = await playwright[args['--browser']].launch({ headless: true }); } catch { refuse('BROWSER_LAUNCH_FAILED'); }
    report.evidence.browser_version = browser.version();
    report.metrics.browser_contexts = 2;
    otpInbox = createOtpInbox();
    phase = 'otp_bridge_ready';
    await otpInbox.ready(Math.min(args.timeoutMs, 15000));
    check(report, 'private_otp_bridge_ready_before_account_requests', true, { operator_bridge_ready: true });

    const actorA = await createBrowserActor(browser, 'A', credentials.get('A'));
    actors.push(actorA);
    const actorB = await createBrowserActor(browser, 'B', credentials.get('B'));
    actors.push(actorB);
    actorA.page.setDefaultTimeout(args.timeoutMs);
    actorB.page.setDefaultTimeout(args.timeoutMs);
    const freshA = (await actorA.context.cookies()).length === 0;
    const freshB = (await actorB.context.cookies()).length === 0;
    check(report, 'two_fresh_isolated_browser_contexts', freshA && freshB, { context_count: 2, empty_initial_cookie_jars: freshA && freshB });

    phase = 'account_signup_and_verification';
    const setupA = await uiEnsureAccount(actorA, otpInbox, args.timeoutMs);
    const setupB = await uiEnsureAccount(actorB, otpInbox, args.timeoutMs);
    check(report, 'two_fictional_email_accounts_created_or_resumed_through_ui', setupA.signedIn && setupB.signedIn,
      { accounts_ready: 2, invalid_mail_domain_only: true });
    check(report, 'email_account_verification_and_login_through_ui', setupA.signedIn && setupB.signedIn,
      { verified_this_run: Number(setupA.verifiedNow) + Number(setupB.verifiedNow), verified_accounts: 2,
        existing_verified_accounts_reused: Number(!setupA.verifiedNow) + Number(!setupB.verifiedNow) });
    const logoutSignupA = await uiLogoutAndFence(actorA, args.timeoutMs);
    const identityA = actorA.actorId;
    const identityB = actorB.actorId;
    const actorIsolation = identityA && identityB && identityA !== identityB;
    const bUnaffectedByALogout = await uiAuthenticatedProfileProbe(actorB, identityB, args.timeoutMs);
    const logoutSignupB = await uiLogoutAndFence(actorB, args.timeoutMs);
    check(report, 'initial_logout_and_protected_session_fencing', logoutSignupA.signed_out_ui && logoutSignupB.signed_out_ui &&
      logoutSignupA.protected_profile_denied && logoutSignupB.protected_profile_denied && actorIsolation,
      { actors_logged_out: 2, protected_profile_denied: 2, distinct_account_identities: Boolean(actorIsolation) });
    check(report, 'one_actor_logout_does_not_end_other_actor_session', bUnaffectedByALogout.authenticated_profile_visible &&
      bUnaffectedByALogout.same_actor_identity,
      { other_actor_session_remained_authenticated: bUnaffectedByALogout.authenticated_profile_visible,
        other_actor_identity_unchanged: bUnaffectedByALogout.same_actor_identity });

    phase = 'account_recovery_and_login';
    const recoveredB = await uiRecover(actorB, otpInbox, args.timeoutMs,
      () => persistActors(args['--actors-file'], credentials));
    const loginA = await uiLogin(actorA, actorA.credentials.password, args.timeoutMs);
    check(report, 'account_recovery_and_ui_login', recoveredB.recoveryCompleted && recoveredB.signedInAfterReset &&
      loginA.linkedUi && Boolean(recoveredB.tag), { recovery_completed: true, actors_signed_in: 2 });
    const restoreA = await uiReloadSessionRestore(actorA, args.timeoutMs);
    const restoreB = await uiReloadSessionRestore(actorB, args.timeoutMs);
    check(report, 'session_restored_after_reload_within_eight_seconds', restoreA.restored && restoreB.restored,
      { actors_restored: Number(restoreA.restored) + Number(restoreB.restored), elapsed_ms: [restoreA.elapsed_ms, restoreB.elapsed_ms] });
    const bfcacheA = await uiBfCacheRestore(actorA, args.timeoutMs);
    const bfcacheB = await uiBfCacheRestore(actorB, args.timeoutMs);
    report.metrics.lifecycle_bfcache = {
      actors_with_bfcache_restore: Number(bfcacheA.bfcache_restored) + Number(bfcacheB.bfcache_restored),
      actors_with_session_and_profile_restored: Number(bfcacheA.session_profile_restored) + Number(bfcacheB.session_profile_restored),
      browser_back_forward_cache_available: bfcacheA.bfcache_restored || bfcacheB.bfcache_restored,
    };
    check(report, 'both_linked_profiles_and_wallet_views', Boolean(actorA.actorId && actorB.actorId &&
      loginA.profileAvailable && recoveredB.profileAvailable && actorA.profileReads.length > 0 && actorB.profileReads.length > 0),
    { linked_actors: 2, wallet_profiles_available: actorA.profileReads.length > 0 && actorB.profileReads.length > 0 });

    phase = 'profile_ui';
    const profileA = await uiEditProfile(actorA, 'A', args.timeoutMs);
    const profileB = await uiEditProfile(actorB, 'B', args.timeoutMs);
    check(report, 'profile_edits_saved_through_ui', profileA.saved && profileB.saved,
      { saved_profiles: Number(profileA.saved) + Number(profileB.saved) });

    phase = 'friend_ui';
    const mutual = await uiFriendPair(actorA, actorB, loginA.tag, recoveredB.tag, args.timeoutMs);
    check(report, 'friend_request_and_acceptance_through_ui', mutual.requestCreated && mutual.requestAccepted && mutual.mutualFriendUi,
      { requests_created: 1, requests_accepted: 1, mutual_friend_lists: mutual.mutualFriendUi });

    const testActors = [actorA, actorB];
    const initialWallets = testActors.map(actor => actor.profileReads.at(-1));
    if (!initialWallets.every(wallet => wallet && Number.isSafeInteger(wallet.coins) &&
        Number.isSafeInteger(wallet.crowns) && Number.isSafeInteger(wallet.games) &&
        Number.isSafeInteger(wallet.ledgerCount))) refuse('ECONOMY_ASSERTION_FAILED');
    const startGames = aggregate(initialWallets, 'games');
    const startCoins = aggregate(initialWallets, 'coins');
    const startCrowns = aggregate(initialWallets, 'crowns');
    const startLedger = aggregate(initialWallets, 'ledgerCount');

    phase = 'ranked_match_one';
    let match = await queuePair(actorA, actorB, 'ranked', args.timeoutMs);
    check(report, 'ranked_match_queue_and_acceptance', match.status === 'PLAYING' && match.quote?.rated === true,
      { ranked: true, match_status: match.status, initial_revision: match.revision });
    phase = 'mobile_layout';
    const mobileA = await assertMobileBoardFits(actorA, 320, 800, args.timeoutMs);
    const mobileB = await assertMobileBoardFits(actorB, 390, 844, args.timeoutMs);
    report.metrics.mobile_layout = {
      viewports_checked: 2,
      widths: [mobileA.viewport_width || mobileA.requested_viewport_width, mobileB.viewport_width || mobileB.requested_viewport_width],
      document_widths: [mobileA.document_width ?? null, mobileB.document_width ?? null],
      stage_widths: [mobileA.stage_width ?? null, mobileB.stage_width ?? null],
    };
    check(report, 'ranked_board_fits_mobile_viewports_without_horizontal_overflow', mobileA.fits && mobileB.fits,
      report.metrics.mobile_layout);
    const wssReady = testActors.every(actor => actor.ticketRequests > 0 && actor.websocketConnections > 0);
    check(report, 'real_wss_ticket_handshakes', wssReady && testActors.every(actor => !actor.cspBlocked),
      { contexts_with_ticket: testActors.filter(actor => actor.ticketRequests > 0).length,
        contexts_with_wss: testActors.filter(actor => actor.websocketConnections > 0).length,
        csp_blocked: testActors.some(actor => actor.cspBlocked) });
    if (testActors.some(actor => actor.externalRequests > 0 || actor.externalWebSockets > 0)) refuse('EXTERNAL_REQUEST_BLOCKED');
    check(report, 'no_external_provider_or_third_party_requests', true, { external_requests: 0, external_websockets: 0 });

    phase = 'wss_push';
    const sender = actorForTurn(match, testActors);
    const receiver = testActors.find(actor => actor !== sender);
    if (!sender || !receiver) refuse('REALTIME_FLOW_FAILED');
    const pushEvidence = await assertReceiverPushWithoutMatchRead(sender, receiver, args.timeoutMs);
    check(report, 'opponent_board_updated_by_wss_while_http_snapshot_reads_are_blocked', true, pushEvidence);
    phase = 'wss_reconnect';
    const resumeEvidence = await reconnectAndResume(receiver, args.timeoutMs);
    check(report, 'fresh_ticket_reconnect_and_ack_snapshot_recovery', true, resumeEvidence);

    phase = 'completed_game';
    const fullGame = await playToTerminal(testActors, args.timeoutMs, 0x13a5);
    const fullRefreshes = testActors.map((actor, index) => ({
      count: fullGame.profileRefreshCounts[index],
      wallet: actor.profileReads.at(-1) || null,
    }));
    if (!fullRefreshes.every(row => row.count > 0 && row.wallet)) refuse('ECONOMY_ASSERTION_FAILED');
    check(report, 'ranked_game_completed_and_terminal_profile_refreshed', fullGame.moves > 0 &&
      fullGame.moves <= 81 && testActors.every(actor => actor.latestMatch.status === 'FINISHED'),
      { status: 'FINISHED', revision: fullGame.revision, legal_moves: fullGame.moves,
        terminal_profile_refresh_counts: fullRefreshes.map(row => row.count), disabled_boards: fullGame.disabled_boards });

    phase = 'casual_match_two';
    match = await queuePair(actorA, actorB, 'casual', args.timeoutMs);
    check(report, 'casual_match_queue_and_acceptance', match.status === 'PLAYING' && match.quote?.rated === false,
      { casual: true, match_status: match.status, initial_revision: match.revision });
    const secondSender = actorForTurn(match, testActors);
    if (!secondSender) refuse('MATCH_FLOW_FAILED');
    const firstMove = game.legal(match.state)[0];
    if (!firstMove) refuse('MATCH_FLOW_FAILED');
    const afterFirstMove = await placeLegalMove(secondSender, firstMove, match.revision, args.timeoutMs);
    const synchronized = await waitForCount(() => testActors.every(actor =>
      actor.latestMatch?.id === afterFirstMove.id && actor.latestMatch.revision === afterFirstMove.revision), args.timeoutMs, 100);
    if (!synchronized) refuse('REALTIME_FLOW_FAILED');
    phase = 'resignation';
    const resignEvidence = await resignMatch(testActors, args.timeoutMs);
    check(report, 'resignation_settled_as_terminal_match', resignEvidence.terminal_status === 'FINISHED',
      { ...resignEvidence });
    phase = 'wallet_settlement';
    const finalWallets = testActors.map(actor => actor.profileReads.at(-1) || null);
    if (!finalWallets.every(Boolean)) refuse('ECONOMY_ASSERTION_FAILED');
    const finalGames = aggregate(finalWallets, 'games');
    const finalCoins = aggregate(finalWallets, 'coins');
    const finalCrowns = aggregate(finalWallets, 'crowns');
    const finalLedger = aggregate(finalWallets, 'ledgerCount');
    const finalReserved = aggregate(finalWallets, 'reservedCoins') + aggregate(finalWallets, 'reservedCrowns');
    const gameDelta = finalGames - startGames;
    const coinDelta = finalCoins - startCoins;
    const crownDelta = finalCrowns - startCrowns;
    const ledgerDelta = finalLedger - startLedger;
    const reservedAfter = testActors.map(actor => actor.profileReads.at(-1));
    if (gameDelta < 2 || ledgerDelta < 2 || finalReserved !== 0 ||
        !reservedAfter.every(wallet => wallet && wallet.reservedCoins === 0 && wallet.reservedCrowns === 0)) {
      refuse('ECONOMY_ASSERTION_FAILED');
    }
    const mutationTotals = Object.create(null);
    for (const actor of testActors) for (const [key, count] of Object.entries(actor.mutationMethods)) {
      mutationTotals[key] = (mutationTotals[key] || 0) + count;
    }
    const requiredHttpWrites = ['v1_queue_POST', 'v1_accept_POST', 'v1_move_POST', 'v1_resign_POST'];
    const mutationsViaHttp = requiredHttpWrites.every(key => mutationTotals[key] > 0) &&
      testActors.every(actor => actor.socketMutationOperations === 0);
    if (!mutationsViaHttp) refuse('MATCH_FLOW_FAILED');
    report.metrics = {
      ...report.metrics,
      ranked_matches: 1,
      casual_matches: 1,
      completed_game_moves: fullGame.moves,
      resignation_terminal_revision: resignEvidence.revision,
      terminal_profile_refresh_counts: {
        completed_game: fullRefreshes.map(row => row.count),
        resignation: resignEvidence.profile_refresh_counts,
      },
      economy_aggregate: {
        actors: 2,
        ranked_games_delta: gameDelta,
        coins_delta: coinDelta,
        crowns_delta: crownDelta,
        wallet_ledger_rows_delta: ledgerDelta,
        reserved_balance_after: finalReserved,
      },
      websocket: {
        contexts_with_ticket: testActors.filter(actor => actor.ticketRequests > 0).length,
        total_handshakes: testActors.reduce((sum, actor) => sum + actor.websocketConnections, 0),
        reconnect_ticket_delta: resumeEvidence.fresh_ticket_requests,
        resume_ack_revision: resumeEvidence.resume_ack_revision,
      },
      mutation_channel: {
        http_mutation_methods: mutationTotals,
        websocket_mutation_operations: testActors.reduce((sum, actor) => sum + actor.socketMutationOperations, 0),
      },
    };
    check(report, 'ranked_and_casual_wallet_settlement_and_no_stale_reservations', gameDelta >= 2 &&
      ledgerDelta >= 2 && finalReserved === 0, report.metrics.economy_aggregate);
    check(report, 'http_only_game_mutations', mutationsViaHttp,
      report.metrics.mutation_channel);
    check(report, 'no_csp_or_cross_origin_socket_failures', testActors.every(actor =>
      !actor.cspBlocked && actor.externalRequests === 0 && actor.externalWebSockets === 0),
      { csp_blocked: false, external_requests: 0, external_websockets: 0 });
    phase = 'logout_session_fencing';
    const logoutA = await uiLogoutAndFence(actorA, args.timeoutMs);
    const logoutB = await uiLogoutAndFence(actorB, args.timeoutMs);
    check(report, 'logout_revokes_protected_profile_ui', logoutA.signed_out_ui && logoutB.signed_out_ui &&
      logoutA.protected_profile_denied && logoutB.protected_profile_denied,
      { actors_logged_out: 2, protected_profile_denied: 2 });
    report.result = 'PASS';
    exitCode = 0;
  } catch (error) {
    const code = error instanceof SafeFailure ? error.code : 'STEP_FAILED';
    if (report) {
      report.result = 'FAIL';
      report.failure_code = code;
      report.failure_phase = phase;
      if (!report.failures.some(row => row.id === phase)) report.failures.push({ id: phase, result: 'FAIL', code });
    }
  } finally {
    if (otpInbox) otpInbox.close();
    for (const actor of actors) {
      try { await actor.context?.close(); } catch {}
      scrubActor(actor);
    }
    if (credentials) {
      for (const actor of credentials.values()) { actor.email = ''; actor.password = ''; }
      credentials.clear();
    }
    try { await browser?.close(); } catch {}
    if (report) {
      report.finished_at_utc = new Date().toISOString();
      report.elapsed_ms = Date.parse(report.finished_at_utc) - Date.parse(report.started_at_utc);
      writeReport(outputDir, report);
      const summary = {
        result: report.result,
        failure_code: report.failure_code || null,
        test: report.test,
        target: report.target,
        evidence: report.evidence,
        checks: report.checks,
        failures: report.failures,
        metrics: report.metrics,
        report_file: outputDir ? path.join(outputDir, 'report.json') : null,
      };
      process.stdout.write(JSON.stringify(summary) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ result: 'REFUSED', code: 'ARGUMENTS_INVALID' }) + '\n');
    }
  }
  return exitCode;
}

if (require.main === module) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    process.stdout.write(JSON.stringify({ result: 'FAIL', code: 'STEP_FAILED' }) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs, safeManifestPath, routeName, safeWallet,
  isTailnetAddress, loadActors, persistActors, verifyDeployment,
};

