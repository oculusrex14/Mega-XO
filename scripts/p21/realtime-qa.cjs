'use strict';

// Synthetic browser acceptance for P21 read-only realtime. This runner never
// builds or guesses an artifact: it verifies every payload byte, copies that
// exact artifact to an immutable snapshot, then serves only on loopback.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { ROOT, MANIFEST } = require('./build-web.js');
const { createPreviewServer } = require('./serve-web.js');
const game = require('../../src/game.js');

const ENGINES = new Set(['chromium', 'firefox', 'webkit']);
const PROTOCOL = 'realtime/v1';
const LOOPBACK = '127.0.0.1';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";

function refuse(message) { throw new Error('P21_REALTIME_QA_REFUSED: ' + message); }

function parseArgs(argv) {
  const values = {};
  const names = new Set(['--bundle', '--expect-source', '--expect-bundle', '--browser', '--output-root']);
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (!names.has(name) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      refuse('usage: node scripts/p21/realtime-qa.cjs --bundle STATIC-ARTIFACT --expect-source COMMIT --expect-bundle SHA256 [--browser chromium|firefox|webkit] [--output-root PATH]');
    }
    values[name.slice(2)] = argv[++i];
  }
  for (const name of ['bundle', 'expect-source', 'expect-bundle']) if (!values[name]) refuse('--' + name + ' is required; the runner never builds or guesses an artifact');
  values.browser ||= 'chromium';
  if (!ENGINES.has(values.browser)) refuse('--browser must be chromium, firefox, or webkit');
  if (!/^[a-f\d]{40}$/i.test(values['expect-source'])) refuse('--expect-source must be a full 40-character commit SHA');
  if (!/^[a-f\d]{64}$/i.test(values['expect-bundle'])) refuse('--expect-bundle must be a full SHA-256 digest');
  return values;
}

function safePayloadPath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\')) refuse('manifest contains an unsafe payload path');
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) refuse('manifest path escapes the artifact');
  return target;
}

function verifyArtifact(bundleArgument, sourceCommit, bundleDigest) {
  const bundle = path.resolve(bundleArgument);
  if (!fs.existsSync(bundle) || fs.realpathSync(bundle) !== bundle || !fs.lstatSync(bundle).isDirectory()) refuse('--bundle must be an existing, unlinked artifact directory');
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, MANIFEST), 'utf8'));
  if (manifest.generator !== 'scripts/p21/build-web.js' || !Array.isArray(manifest.files)) refuse('unrecognized P21 build manifest');
  if (manifest.source_commit !== sourceCommit || manifest.bundle_sha256 !== bundleDigest) refuse('artifact identity does not match the explicit expected commit and digest');
  if (manifest.api?.configured !== false || manifest.api?.preview_read_seam !== 'explicit P21_READ_API_ORIGIN only; GET /api/v1/leaderboard; no credential forwarding') refuse('artifact must declare all account/game APIs unconfigured');
  const seen = new Set(), rows = [];
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !/^[a-f\d]{64}$/i.test(file.sha256) || !Number.isSafeInteger(file.bytes)) refuse('artifact inventory is malformed');
    if (seen.has(file.path)) refuse('artifact inventory contains a duplicate path');
    seen.add(file.path);
    const target = safePayloadPath(bundle, file.path);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) refuse('artifact payload is missing or linked');
    const bytes = fs.readFileSync(target);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) refuse('artifact payload checksum mismatch: ' + file.path);
    rows.push(file.path + '\0' + file.bytes + '\0' + file.sha256);
  }
  const inventory = new Set([...seen, MANIFEST]);
  const actualFiles = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) refuse('artifact contains a linked entry');
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) actualFiles.push(path.relative(bundle, target).split(path.sep).join('/'));
      else refuse('artifact contains a non-file entry');
    }
  };
  visit(bundle);
  if (actualFiles.length !== inventory.size || actualFiles.some(file => !inventory.has(file))) refuse('artifact contains files outside its exact manifest inventory');
  if (sha256(Buffer.from(rows.join('\0'))) !== bundleDigest) refuse('recomputed build digest does not match');
  return { bundle, manifest, manifestSha256: sha256(fs.readFileSync(path.join(bundle, MANIFEST))), payloadFiles: actualFiles.length - 1, payloadBytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) };
}

function copySnapshot(artifact, destination) {
  for (const file of artifact.manifest.files) {
    const source = safePayloadPath(artifact.bundle, file.path);
    const target = safePayloadPath(destination, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const bytes = fs.readFileSync(source);
    fs.writeFileSync(target, bytes, { flag: 'wx' });
    const copied = fs.readFileSync(target);
    if (copied.length !== file.bytes || sha256(copied) !== file.sha256) refuse('snapshot copy differs from verified payload: ' + file.path);
  }
  fs.writeFileSync(path.join(destination, MANIFEST), JSON.stringify(artifact.manifest, null, 2) + '\n', { flag: 'wx' });
  const rows = artifact.manifest.files.map(file => file.path + '\0' + file.bytes + '\0' + sha256(fs.readFileSync(safePayloadPath(destination, file.path))));
  if (sha256(Buffer.from(rows.join('\0'))) !== artifact.manifest.bundle_sha256) refuse('copied snapshot digest differs from the requested bundle');
}

function check(report, id, passed, evidence = {}) {
  const row = { id, result: passed ? 'PASS' : 'FAIL', ...evidence };
  report.checks.push(row);
  if (!passed) report.failures.push(row);
  return passed;
}

function skip(report, id, reason) {
  report.checks.push({ id, result: 'SKIP', reason });
}

function assertCheck(report, id, passed, evidence = {}) {
  check(report, id, passed, evidence);
  if (!passed) throw new Error('acceptance check failed: ' + id);
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function snapshotFor(id, state = game.create(), status = 'PLAYING', receipt = null) {
  return {
    id, status, symbols: { X: 'fixture-actor-one', O: 'fixture-actor-two' },
    state: clone(state), revision: state.moves.length,
    players: ['fixture-actor-one', 'fixture-actor-two'],
    playerNames: { X: 'Fixture Player One', O: 'Fixture Player Two' },
    quote: { rated: false }, terms: { source: 'queue' }, receipt,
  };
}

function jsonReply(route, status, body) {
  return route.fulfill({
    status, contentType: 'application/json',
    headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function makeSocketFixture(servers) {
  const attachedServers = new Set();
  const tickets = new Map();
  const clients = new Set();
  const stats = {
    upgrade_attempts: 0, upgrade_denials: 0, successful_handshakes: 0,
    ticket_redeem_attempts: 0, ticket_redeem_successes: 0,
    protocol_operations: Object.create(null), resume_acks: [],
  };
  let denyNextUpgrades = 0;

  function writeFrame(socket, opcode, payload) {
    if (socket.destroyed || !socket.writable) return;
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
    let header;
    if (bytes.length < 126) { header = Buffer.from([0x80 | opcode, bytes.length]); }
    else if (bytes.length <= 65535) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(bytes.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(bytes.length), 2); }
    socket.write(Buffer.concat([header, bytes]));
  }

  const sendJSON = (client, value) => writeFrame(client.socket, 1, JSON.stringify({ protocol: PROTOCOL, ...value }));

  function remove(client) { clients.delete(client); client.closed = true; }

  function protocolMessage(client, raw) {
    let message;
    try { message = JSON.parse(raw); } catch { writeFrame(client.socket, 8, Buffer.from([3, 232])); client.socket.end(); return; }
    const operation = typeof message?.operation === 'string' ? message.operation : 'invalid';
    stats.protocol_operations[operation] = (stats.protocol_operations[operation] || 0) + 1;
    if (message?.protocol !== PROTOCOL) { sendJSON(client, { operation: 'error', code: 'INVALID_PROTOCOL' }); return; }
    if (operation === 'ticket.redeem') {
      stats.ticket_redeem_attempts++;
      const grant = typeof message.ticket === 'string' ? tickets.get(message.ticket) : null;
      if (!grant || grant.expiresAt <= Date.now()) {
        if (grant) tickets.delete(message.ticket);
        sendJSON(client, { operation: 'error', code: 'AUTH_REQUIRED' });
        return;
      }
      tickets.delete(message.ticket);
      client.actorId = grant.actorId;
      client.matchId = grant.matchId;
      client.room = grant.room;
      stats.ticket_redeem_successes++;
      sendJSON(client, { operation: 'ack', match_id: grant.matchId, ack_revision: 0 });
      return;
    }
    if (operation === 'ping' && client.room) {
      sendJSON(client, { operation: 'pong', server_now: Date.now() });
      return;
    }
    if (!client.room || message.match_id !== client.matchId) return;
    if (operation === 'subscribe') {
      client.subscribed = true;
      client.room.socketSubscriptions++;
      sendJSON(client, snapshotFrame(client.room));
      return;
    }
    if (operation === 'resume') {
      const revision = Number.isSafeInteger(message.ack_revision) ? message.ack_revision : -1;
      const current = clone(client.room.match);
      const evidence = {
        actorId: client.actorId,
        ack_revision: revision,
        snapshot_revision: current.revision,
      };
      client.room.resumeEvidence.push(evidence);
      stats.resume_acks.push({ actorId: client.actorId, ack_revision: revision, snapshot_revision: current.revision });
      if (revision === current.revision) {
        sendJSON(client, { operation: 'ack', match_id: client.matchId, ack_revision: current.revision });
      } else {
        if (revision >= 0 && revision < current.revision && current.state.moves.length === current.revision && current.revision - revision <= 32) {
          sendJSON(client, {
            operation: 'delta', match_id: client.matchId, expected_revision: current.revision,
            delta: { from: revision, to: current.revision, moves: current.state.moves.slice(revision) }, server_now: Date.now(),
          });
        }
        sendJSON(client, { operation: 'snapshot', match_id: client.matchId, expected_revision: current.revision, snapshot: current });
      }
      return;
    }
    if (operation === 'close') { writeFrame(client.socket, 8, Buffer.from([3, 232])); client.socket.end(); }
  }

  function parseFrames(client, chunk) {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    while (client.buffer.length >= 2) {
      const first = client.buffer[0], second = client.buffer[1];
      const opcode = first & 0x0f, masked = (second & 0x80) !== 0;
      let size = second & 0x7f, offset = 2;
      if (size === 126) { if (client.buffer.length < 4) return; size = client.buffer.readUInt16BE(2); offset = 4; }
      else if (size === 127) {
        if (client.buffer.length < 10) return;
        const big = client.buffer.readBigUInt64BE(2);
        if (big > 270000n) { client.socket.destroy(); remove(client); return; }
        size = Number(big); offset = 10;
      }
      if (!masked || size > 270000) { client.socket.destroy(); remove(client); return; }
      if (client.buffer.length < offset + 4 + size) return;
      const mask = client.buffer.subarray(offset, offset + 4), body = Buffer.from(client.buffer.subarray(offset + 4, offset + 4 + size));
      for (let index = 0; index < body.length; index++) body[index] ^= mask[index % 4];
      client.buffer = client.buffer.subarray(offset + 4 + size);
      if ((first & 0x80) === 0) { client.socket.destroy(); remove(client); return; }
      if (opcode === 8) { writeFrame(client.socket, 8, body.subarray(0, 125)); client.socket.end(); remove(client); return; }
      if (opcode === 9) { writeFrame(client.socket, 10, body.subarray(0, 125)); continue; }
      if (opcode === 1) protocolMessage(client, body.toString('utf8'));
      else if (opcode !== 10) { client.socket.destroy(); remove(client); return; }
    }
  }

  function handleUpgrade(request, socket, head) {
    stats.upgrade_attempts++;
    const host = String(request.headers.host || '');
    let origin;
    try { origin = new URL(request.headers.origin || ''); } catch { origin = null; }
    if (denyNextUpgrades > 0) {
      denyNextUpgrades--;
      stats.upgrade_denials++;
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (request.url !== '/realtime/v1' || !/^127\.0\.0\.1:\d+$/.test(host) || !origin || origin.hostname !== LOOPBACK || origin.host !== host ||
        request.headers['sec-websocket-version'] !== '13' || typeof request.headers['sec-websocket-key'] !== 'string') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const client = { socket, buffer: Buffer.alloc(0), room: null, actorId: null, matchId: null, subscribed: false, closed: false };
    clients.add(client);
    stats.successful_handshakes++;
    socket.on('data', chunk => parseFrames(client, chunk));
    socket.on('close', () => remove(client));
    socket.on('error', () => remove(client));
    if (head?.length) parseFrames(client, head);
  }

  function attach(server) {
    if (attachedServers.has(server)) return;
    attachedServers.add(server);
    server.on('upgrade', handleUpgrade);
  }
  for (const server of servers) attach(server);

  return {
    stats,
    issueTicket(room, actorId, matchId, denySocket = false) {
      const ticket = crypto.randomBytes(32).toString('base64url');
      tickets.set(ticket, { room, actorId, matchId, expiresAt: Date.now() + 60000 });
      if (denySocket) denyNextUpgrades++;
      return { ok: true, ticket, expiresAt: Date.now() + 60000 };
    },
    broadcast(room, message) {
      for (const client of clients) if (!client.closed && client.subscribed && client.room === room && client.matchId === message.match_id) sendJSON(client, message);
    },
    closeMatch(matchId, code = 1001) {
      for (const client of [...clients]) if (!client.closed && client.matchId === matchId) {
        writeFrame(client.socket, 8, Buffer.from([code >> 8, code & 255]));
        client.socket.end();
        remove(client);
      }
    },
    activeCount(matchId) { return [...clients].filter(client => !client.closed && (!matchId || client.matchId === matchId)).length; },
    attach,
    detach() { for (const server of attachedServers) server.off('upgrade', handleUpgrade); for (const client of clients) client.socket.destroy(); clients.clear(); tickets.clear(); },
  };
}

function makeRoom(matchId) {
  return {
    match: snapshotFor(matchId),
    socketSubscriptions: 0,
    resumeEvidence: [],
    profileReadsByActor: Object.create(null),
    mutationPaths: [],
  };
}

function makeApiFixture({ room, actorId, sockets, denySocket = false }) {
  const fixture = {
    actorId,
    events: [],
    currentActor: actorId,
    profileStalls: [],
    profileStallWaiters: [],
    profileStallStartedAt: 0,
    stallNextProfileReads: 0,
    matchReads: 0,
    snapshotReads: 0,
    snapshotResponses: 0,
    snapshotResponseRevisions: [],
    ticketReads: 0,
    requestFailures: [],
  };

  fixture.profile = () => ({
    id: fixture.currentActor,
    username: fixture.currentActor === 'fixture-actor-one' ? 'fixture_one' : fixture.currentActor === 'fixture-actor-two' ? 'fixture_two' : 'fixture_outsider',
    name: fixture.currentActor === 'fixture-actor-one' ? 'Fixture Player One' : fixture.currentActor === 'fixture-actor-two' ? 'Fixture Player Two' : 'Fixture Outsider',
    displayName: fixture.currentActor === 'fixture-actor-one' ? 'Fixture Player One' : fixture.currentActor === 'fixture-actor-two' ? 'Fixture Player Two' : 'Fixture Outsider',
    activeMatch: room.match.players.includes(fixture.currentActor) ? room.match.id : null,
    rating: 900, tier: 'wood', games: 0, region: 'IN', wallet: { coins: 90, crowns: 0 },
  });

  fixture.releaseProfileStalls = () => {
    const stalled = fixture.profileStalls.splice(0);
    for (const item of stalled) jsonReply(item.route, 200, fixture.profile());
  };
  fixture.waitForProfileStall = () => fixture.profileStalls.length
    ? Promise.resolve()
    : new Promise(resolve => fixture.profileStallWaiters.push(resolve));

  fixture.handle = async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const pathname = url.pathname;
    const headers = request.headers();
    let body;
    try { if (request.postData()) body = JSON.parse(request.postData()); } catch {}
    const event = {
      method, path: pathname,
      field_names: body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort() : [],
      csrf_header_present: Boolean(headers['x-csrf-token']),
      idempotency_header_present: Boolean(headers['idempotency-key']),
      cache_control: 'private, no-store',
    };
    fixture.events.push(event);

    if (method === 'GET' && pathname === '/api/account/session') {
      return jsonReply(route, 200, { csrf: 'synthetic-csrf-' + fixture.currentActor, linked: true, providers: {} });
    }
    if (method === 'GET' && pathname === '/api/v1/profile') {
      room.profileReadsByActor[fixture.currentActor] = (room.profileReadsByActor[fixture.currentActor] || 0) + 1;
      if (fixture.stallNextProfileReads > 0) {
        fixture.stallNextProfileReads--;
        fixture.profileStallStartedAt ||= Date.now();
        fixture.profileStalls.push({ route });
        fixture.profileStallWaiters.shift()?.();
        return;
      }
      return jsonReply(route, 200, fixture.profile());
    }
    if (method === 'GET' && pathname === '/api/account/profile') {
      return jsonReply(route, 200, { ...fixture.profile(), statsVisibility: 'private', presenceVisibility: 'hidden' });
    }
    if (method === 'GET' && pathname === '/api/v1/match/' + encodeURIComponent(room.match.id)) {
      fixture.matchReads++;
      return jsonReply(route, 200, clone(room.match));
    }
    if (method === 'GET' && pathname === '/realtime/v1/snapshot') {
      fixture.snapshotReads++;
      const matchId = url.searchParams.get('match_id');
      if (matchId !== room.match.id) return jsonReply(route, 404, { error: 'MATCH_NOT_FOUND' });
      const snapshot = clone(room.match);
      await jsonReply(route, 200, { protocol: PROTOCOL, operation: 'snapshot', match_id: room.match.id, expected_revision: snapshot.revision, snapshot });
      fixture.snapshotResponses++;
      fixture.snapshotResponseRevisions.push({ expected_revision: snapshot.revision, snapshot_revision: snapshot.revision });
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/ticket') {
      fixture.ticketReads++;
      const matchId = body?.matchScope;
      if (!headers['x-csrf-token'] || !headers['idempotency-key'] || matchId !== room.match.id || !room.match.players.includes(fixture.currentActor)) {
        return jsonReply(route, 403, { error: 'AUTH_REQUIRED' });
      }
      return jsonReply(route, 200, sockets.issueTicket(room, fixture.currentActor, matchId, denySocket));
    }
    if (method === 'POST' && pathname === '/api/v1/move') {
      room.mutationPaths.push(pathname);
      if (!headers['x-csrf-token'] || !headers['idempotency-key'] || body?.id !== room.match.id || body?.revision !== room.match.revision ||
          room.match.status !== 'PLAYING' || room.match.symbols[room.match.state.turn] !== fixture.currentActor) {
        return jsonReply(route, 409, { error: 'STALE_OR_UNAUTHORIZED_MOVE' });
      }
      try { room.match = snapshotFor(room.match.id, game.apply(room.match.state, body.move), 'PLAYING'); }
      catch { return jsonReply(route, 400, { error: 'INVALID_MOVE' }); }
      return jsonReply(route, 200, { ok: true });
    }
    if (method === 'POST' && pathname === '/api/v1/resign') {
      room.mutationPaths.push(pathname);
      if (!headers['x-csrf-token'] || !headers['idempotency-key'] || body?.id !== room.match.id || room.match.status !== 'PLAYING' || !room.match.players.includes(fixture.currentActor)) {
        return jsonReply(route, 409, { error: 'STALE_OR_UNAUTHORIZED_RESIGN' });
      }
      const ownSymbol = room.match.symbols.X === fixture.currentActor ? 'X' : 'O';
      room.match = snapshotFor(room.match.id, room.match.state, 'FINISHED', { winner: ownSymbol === 'X' ? 'O' : 'X', reason: 'RESIGNATION' });
      return jsonReply(route, 200, { ok: true });
    }
    if (method === 'POST' && pathname === '/api/account/logout') return jsonReply(route, 200, { ok: true });
    return jsonReply(route, 503, { error: 'WEB_API_NOT_CONFIGURED' });
  };
  return fixture;
}

async function routeContext(context, origin, fixture) {
  await context.route('**/*', async route => {
    let url;
    try { url = new URL(route.request().url()); } catch { return route.abort('failed'); }
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (url.pathname.startsWith('/api/') || url.pathname === '/realtime/v1/snapshot') return fixture.handle(route);
    return route.continue();
  });
  await context.addInitScript(() => {
    window.__p21Hidden = true;
    try { Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__p21Hidden === true }); } catch {}
    const audit = { cspConnect: [], storageWrites: [] };
    Object.defineProperty(window, '__p21RealtimeAudit', { value: audit, configurable: false });
    document.addEventListener('securitypolicyviolation', event => {
      if (event.effectiveDirective === 'connect-src') audit.cspConnect.push({ directive: event.effectiveDirective, blockedScheme: (() => { try { return new URL(event.blockedURI).protocol; } catch { return ''; } })() });
    });
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (this === window.localStorage) audit.storageWrites.push(String(key));
      return originalSet.call(this, key, value);
    };
  });
}

async function newPage(browser, origin, room, sockets, actorId, options = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: options.ignoreHTTPSErrors === true, viewport: { width: 1280, height: 900 } });
  const fixture = makeApiFixture({ room, actorId, sockets, denySocket: options.denySocket === true });
  await routeContext(context, origin, fixture);
  const page = await context.newPage();
  const errors = { pageErrors: 0, consoleErrors: 0 };
  page.on('pageerror', error => { errors.pageErrors++; });
  page.on('console', message => { if (message.type() === 'error') errors.consoleErrors++; });
  return { context, page, fixture, errors };
}

async function waitForMatch(page, timeout = 9000) {
  await page.locator('#main [data-board-host]').waitFor({ state: 'visible', timeout });
  await page.waitForFunction(() => document.querySelector('[data-gb-stage][aria-label="Online Mega XOXO match"]'), null, { timeout });
}

async function waitForConnected(page, timeout = 9000) {
  await page.waitForFunction(() => document.querySelector('.mx-online-message')?.textContent.includes('Live updates connected.'), null, { timeout });
}

async function navigateByHistory(page, href) {
  await page.evaluate(pathname => {
    history.pushState({}, '', pathname);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }, href);
}

async function clickAsForegroundTab(page, locator) {
  await page.evaluate(() => { window.__p21Hidden = false; });
  try { await locator.click(); }
  finally { await page.evaluate(() => { window.__p21Hidden = true; }); }
}

async function boardMetrics(page) {
  return page.evaluate(() => {
    const board = document.querySelector('.gb-grid');
    const rect = board?.getBoundingClientRect();
    return {
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      boardLeft: rect ? Math.round(rect.left) : null,
      boardRight: rect ? Math.round(rect.right) : null,
      boardWidth: rect ? Math.round(rect.width) : null,
      moveText: document.querySelector('.gb-match-note span')?.textContent?.trim() || '',
    };
  });
}

async function waitForCondition(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('synthetic fixture condition did not settle before its deadline');
}

function snapshotFrame(room, operation = 'snapshot') {
  const snapshot = clone(room.match);
  return { protocol: PROTOCOL, operation, match_id: snapshot.id, expected_revision: snapshot.revision, snapshot };
}

async function createTlsMaterial(ignoredOutput) {
  fs.mkdirSync(ignoredOutput, { recursive: true });
  const directory = fs.mkdtempSync(path.join(ignoredOutput, '.p21-realtime-tls-'));
  const keyPath = path.join(directory, 'private-key.pem');
  const certPath = path.join(directory, 'certificate.pem');
  try {
    const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-keyout', keyPath, '-out', certPath,
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-days', '1'], { stdio: 'ignore', timeout: 20000 });
    if (result.error || result.status !== 0) return null;
    const material = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    return material;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let playwright;
  try { playwright = require('playwright'); }
  catch { refuse('Playwright is unavailable; set NODE_PATH to the installed runtime node_modules directory'); }
  let playwrightVersion = 'unknown';
  try { playwrightVersion = require('playwright/package.json').version || 'unknown'; } catch {}

  const artifact = verifyArtifact(args.bundle, args['expect-source'], args['expect-bundle']);
  const outputBase = path.resolve(args['output-root'] || path.join(ROOT, 'tests-output/p21-web'));
  fs.mkdirSync(outputBase, { recursive: true });
  const runStamp = new Date().toISOString().replace(/[^0-9]/g, '') + '-' + process.pid;
  const output = path.join(outputBase, artifact.manifest.bundle_sha256.slice(0, 12), 'realtime-' + args.browser, runStamp);
  fs.mkdirSync(output, { recursive: true });
  const snapshot = fs.mkdtempSync(path.join(ROOT, '.artifacts/.p21-realtime-qa-'));
  let browser, preview, tlsServer, sockets, tlsMaterial;
  const report = {
    schema_version: 1,
    checked_at: new Date().toISOString(),
    source_commit: artifact.manifest.source_commit,
    bundle_sha256: artifact.manifest.bundle_sha256,
    browser_engine: args.browser,
    runtime_version: process.version,
    playwright_version: playwrightVersion,
    command: 'env -u NODE_OPTIONS ' + (process.env.PLAYWRIGHT_BROWSERS_PATH ? 'PLAYWRIGHT_BROWSERS_PATH=' + shellQuote(process.env.PLAYWRIGHT_BROWSERS_PATH) + ' ' : '') + 'NODE_PATH=' + shellQuote(process.env.NODE_PATH || '') + ' ' + shellQuote(process.execPath) + ' scripts/p21/realtime-qa.cjs --bundle ' + shellQuote(args.bundle) + ' --expect-source ' + args['expect-source'] + ' --expect-bundle ' + args['expect-bundle'] + ' --browser ' + args.browser + ' --output-root ' + shellQuote(outputBase),
    qa_script_sha256: sha256(fs.readFileSync(__filename)),
    environment: 'Local loopback HTTP and isolated self-signed HTTPS only; checksum-verified immutable artifact snapshot; all foreign browser origins blocked; Playwright browser cache: ' + (process.env.PLAYWRIGHT_BROWSERS_PATH ? 'task-local isolated cache' : 'host default cache') + '.',
    fixture_boundary: 'Synthetic linked actors, account session, CSRF values, ticket grants, match DTOs and HTTP endpoints exist only in test memory. No user account, provider, production API or authenticated staging service was contacted.',
    isolated_payload_snapshot: true,
    target: 'Synthetic browser fixture served from loopback only; HTTP and isolated self-signed HTTPS/WSS when OpenSSL is available.',
    artifact_manifest_sha256: artifact.manifestSha256,
    verified_payload_files: artifact.payloadFiles,
    verified_payload_bytes: artifact.payloadBytes,
    rollback: 'No API or production target writes. Temporary browser servers, contexts, verified snapshot, and local TLS key files are removed at exit; report remains in the selected output directory.',
    checks: [],
    failures: [],
    api_fixture_summary: null,
    websocket_fixture_summary: null,
    screenshots: [],
    limitations: ['Synthetic software/browser acceptance only; it does not establish authenticated staging, physical-device, provider, production or release acceptance.'],
  };
  const contexts = [];
  const apiFixtures = [];
  const rooms = [];
  const pageErrors = [];

  try {
    copySnapshot(artifact, snapshot);
    preview = createPreviewServer({ directory: snapshot, readApiOrigin: null });
    preview.listen(0, LOOPBACK);
    await once(preview, 'listening');
    const origin = 'http://' + LOOPBACK + ':' + preview.address().port;
    sockets = makeSocketFixture([preview]);
    browser = await playwright[args.browser].launch({ headless: true });
    report.browser_version = browser.version();

    // Two isolated contexts share one synthetic match authority and separate
    // in-memory account/session fixtures. Neither context polls while hidden.
    const pushRoom = makeRoom('fixture-push-match');
    rooms.push(pushRoom);
    const first = await newPage(browser, origin, pushRoom, sockets, 'fixture-actor-one');
    const second = await newPage(browser, origin, pushRoom, sockets, 'fixture-actor-two');
    contexts.push(first.context, second.context);
    apiFixtures.push(first.fixture, second.fixture);
    pageErrors.push(first.errors, second.errors);
    const firstResponse = await first.page.goto(origin + '/game', { waitUntil: 'domcontentloaded' });
    const secondResponse = await second.page.goto(origin + '/game', { waitUntil: 'domcontentloaded' });
    await Promise.all([waitForMatch(first.page), waitForMatch(second.page), waitForConnected(first.page), waitForConnected(second.page)]);
    const firstCsp = firstResponse?.headers()['content-security-policy'] || '';
    const secondCsp = secondResponse?.headers()['content-security-policy'] || '';
    assertCheck(report, 'P21-REALTIME-LOOPBACK-CSP-AND-SAME-ORIGIN', firstCsp.includes("connect-src 'self'") && secondCsp.includes("connect-src 'self'") && !/connect-src[^;]*\*/.test(firstCsp + secondCsp), {
      csp_connect_src: "'self'", broad_connect_wildcard: false, browser_engines_tested: args.browser,
    });
    assertCheck(report, 'P21-REALTIME-ACTUAL-LOCAL-WEBSOCKET-HANDSHAKE', sockets.stats.successful_handshakes >= 2 && sockets.stats.ticket_redeem_successes >= 2, {
      successful_handshakes: sockets.stats.successful_handshakes, ticket_redeems: sockets.stats.ticket_redeem_successes,
    });
    await waitForCondition(() => first.fixture.snapshotResponses >= 1 && second.fixture.snapshotResponses >= 1);

    // Ack and delta metadata cannot paint a revision; the client recovers only
    // the complete server snapshot, which remains revision zero here.
    const beforeHint = await boardMetrics(first.page);
    const readsBeforeHints = first.fixture.snapshotResponses;
    sockets.broadcast(pushRoom, { protocol: PROTOCOL, operation: 'ack', match_id: pushRoom.match.id, ack_revision: 23 });
    await waitForCondition(() => first.fixture.snapshotResponses >= readsBeforeHints + 1);
    await new Promise(resolve => setTimeout(resolve, 50));
    sockets.broadcast(pushRoom, { protocol: PROTOCOL, operation: 'delta', match_id: pushRoom.match.id, revision: 24, delta: { move: { b: 4, c: 4, player: 'X' } } });
    await waitForCondition(() => first.fixture.snapshotResponses >= readsBeforeHints + 2);
    const afterHint = await boardMetrics(first.page);
    assertCheck(report, 'P21-REALTIME-ACK-DELTA-DO-NOT-ADVANCE', beforeHint.moveText === afterHint.moveText && afterHint.moveText.startsWith('0 moves played') && first.fixture.snapshotResponses >= readsBeforeHints + 2, {
      displayed_move_count_before: beforeHint.moveText, displayed_move_count_after: afterHint.moveText,
      complete_snapshot_recoveries: first.fixture.snapshotResponses - readsBeforeHints,
    });

    // A real UI move must issue the only state-changing request over HTTP.
    const moveButton = first.page.locator('[data-gb-cell="4:4"]');
    await clickAsForegroundTab(first.page, moveButton);
    await first.page.getByText('1 move played', { exact: false }).waitFor({ timeout: 6000 });
    const movePost = first.fixture.events.find(event => event.method === 'POST' && event.path === '/api/v1/move');
    assertCheck(report, 'P21-REALTIME-HTTP-ONLY-MUTATION', Boolean(movePost) && movePost.csrf_header_present && movePost.idempotency_header_present && !Object.keys(sockets.stats.protocol_operations).some(operation => ['move', 'resign', 'mutate', 'settle'].includes(operation)), {
      http_move_post_seen: Boolean(movePost), csrf_header_present: Boolean(movePost?.csrf_header_present), idempotency_header_present: Boolean(movePost?.idempotency_header_present),
      websocket_mutation_operations: Object.keys(sockets.stats.protocol_operations).filter(operation => ['move', 'resign', 'mutate', 'settle'].includes(operation)).length,
    });
    const matchGetsBeforePush = second.fixture.matchReads;
    sockets.broadcast(pushRoom, snapshotFrame(pushRoom));
    await Promise.all([
      first.page.getByText('1 move played', { exact: false }).waitFor({ timeout: 3500 }),
      second.page.getByText('1 move played', { exact: false }).waitFor({ timeout: 3500 }),
    ]);
    // Simulate the other actor's accepted move, with no HTTP action in either
    // open page. Both boards must follow the subscribed socket before polling.
    pushRoom.match = snapshotFor(pushRoom.match.id, game.apply(pushRoom.match.state, { b: 4, c: 0 }), 'PLAYING');
    const pushStarted = Date.now();
    sockets.broadcast(pushRoom, snapshotFrame(pushRoom));
    await Promise.all([
      first.page.getByText('2 moves played', { exact: false }).waitFor({ timeout: 2200 }),
      second.page.getByText('2 moves played', { exact: false }).waitFor({ timeout: 2200 }),
    ]);
    const pushLatencyMs = Date.now() - pushStarted;
    assertCheck(report, 'P21-REALTIME-TWO-CONTEXT-PUSH-WITHOUT-POLL', pushLatencyMs < 2200 && second.fixture.matchReads === matchGetsBeforePush, {
      contexts_updated: 2, push_latency_ms: pushLatencyMs, second_context_match_http_reads_during_push: second.fixture.matchReads - matchGetsBeforePush,
      polling_hidden_in_test_contexts: await first.page.evaluate(() => document.hidden && window.__p21Hidden === true),
    });

    // Mobile board geometry at two narrow common widths.
    for (const width of [320, 390]) {
      await first.page.setViewportSize({ width, height: width === 320 ? 740 : 844 });
      const metrics = await boardMetrics(first.page);
      assertCheck(report, 'P21-REALTIME-BOARD-REFLOW-' + width, metrics.width <= width + 1 && metrics.scrollWidth <= width + 1 && metrics.boardLeft >= 0 && metrics.boardRight <= width + 1, {
        viewport_width: width, scroll_width: metrics.scrollWidth, board_left: metrics.boardLeft, board_right: metrics.boardRight, board_width: metrics.boardWidth,
      });
    }
    await first.page.setViewportSize({ width: 1280, height: 900 });

    // Drop both sockets and make the clients get new one-use grants. Resume
    // must name the known revision and return a complete matching snapshot.
    const ticketsBeforeReconnect = first.fixture.ticketReads + second.fixture.ticketReads;
    const resumesBeforeReconnect = pushRoom.resumeEvidence.length;
    const firstSnapshotsBeforeReconnect = first.fixture.snapshotResponseRevisions.length;
    const secondSnapshotsBeforeReconnect = second.fixture.snapshotResponseRevisions.length;
    sockets.closeMatch(pushRoom.match.id);
    await first.page.waitForFunction(() => window.__p21RealtimeAudit && document.querySelector('.mx-online-message'), null, { timeout: 3500 });
    await first.page.waitForFunction(() => document.querySelector('.mx-online-message')?.textContent.includes('Live updates connected.'), null, { timeout: 6500 });
    await second.page.waitForFunction(() => document.querySelector('.mx-online-message')?.textContent.includes('Live updates connected.'), null, { timeout: 6500 });
    await Promise.all([
      waitForCondition(() => first.fixture.snapshotResponseRevisions.length > firstSnapshotsBeforeReconnect),
      waitForCondition(() => second.fixture.snapshotResponseRevisions.length > secondSnapshotsBeforeReconnect),
    ]);
    const newTickets = first.fixture.ticketReads + second.fixture.ticketReads - ticketsBeforeReconnect;
    const resumeRows = pushRoom.resumeEvidence.slice(resumesBeforeReconnect);
    const resumedHttpSnapshots = [
      ...first.fixture.snapshotResponseRevisions.slice(firstSnapshotsBeforeReconnect).map(row => ({ actorId: 'fixture-actor-one', ...row })),
      ...second.fixture.snapshotResponseRevisions.slice(secondSnapshotsBeforeReconnect).map(row => ({ actorId: 'fixture-actor-two', ...row })),
    ];
    const eachResumeHasEqualFullSnapshot = resumeRows.every(row => row.ack_revision === row.snapshot_revision && resumedHttpSnapshots.some(snapshot => snapshot.actorId === row.actorId && snapshot.expected_revision === row.ack_revision && snapshot.snapshot_revision === row.ack_revision));
    assertCheck(report, 'P21-REALTIME-RECONNECT-FRESH-TICKET-RESUME', newTickets >= 2 && resumeRows.length >= 2 && resumeRows.every(row => row.ack_revision === pushRoom.match.revision && row.snapshot_revision === row.ack_revision) && eachResumeHasEqualFullSnapshot, {
      fresh_grants_issued: newTickets, resumed_contexts: resumeRows.length,
      ack_and_full_snapshot_revisions_equal: resumeRows.every(row => row.ack_revision === row.snapshot_revision),
      resumed_http_full_snapshots_match_ack: eachResumeHasEqualFullSnapshot,
      resumed_http_full_snapshot_responses: resumedHttpSnapshots.length,
    });

    // Navigate one context away while its socket is live; a later frame must
    // not recreate the old match view. Then sign the other actor out and fence
    // its account-bound socket before delivering the same stale frame.
    const firstTicketsBeforeRoute = first.fixture.ticketReads;
    await navigateByHistory(first.page, '/play');
    await first.page.locator('#main h1').waitFor({ state: 'visible' });
    sockets.broadcast(pushRoom, snapshotFrame(pushRoom));
    await first.page.waitForTimeout(120);
    assertCheck(report, 'P21-REALTIME-ROUTE-FENCE', first.page.url().endsWith('/play') && !(await first.page.locator('#main [data-board-host]').count()) && first.fixture.ticketReads === firstTicketsBeforeRoute, {
      route_after_stale_frame: new URL(first.page.url()).pathname, stale_match_view_recreated: false, tickets_after_route_exit: first.fixture.ticketReads - firstTicketsBeforeRoute,
    });

    await navigateByHistory(second.page, '/account');
    await second.page.locator('[data-account-action="logout"]').waitFor({ state: 'visible' });
    const ticketsBeforeLogout = second.fixture.ticketReads;
    await second.page.locator('[data-account-action="logout"]').click();
    await second.page.getByText('You are signed out.', { exact: true }).waitFor({ timeout: 5000 });
    sockets.broadcast(pushRoom, snapshotFrame(pushRoom));
    await navigateByHistory(second.page, '/game');
    await second.page.waitForFunction(() => document.querySelector('.mx-online-controls')?.textContent.includes('Sign in to play online'));
    const signedOutText = await second.page.locator('#main').innerText();
    assertCheck(report, 'P21-REALTIME-LOGOUT-SESSION-FENCE', !/Fixture Player One|Fixture Player Two|fixture-push-match/.test(signedOutText) && second.fixture.ticketReads === ticketsBeforeLogout, {
      signed_out_game_has_no_prior_match_identity: !/Fixture Player One|Fixture Player Two|fixture-push-match/.test(signedOutText), tickets_after_logout: second.fixture.ticketReads - ticketsBeforeLogout,
    });

    // Change the linked actor during an in-flight profile refresh. The old
    // match callback must not paint private state into the new account view.
    const fencedRoom = makeRoom('fixture-actor-fence-match');
    rooms.push(fencedRoom);
    const fenced = await newPage(browser, origin, fencedRoom, sockets, 'fixture-actor-one');
    contexts.push(fenced.context); apiFixtures.push(fenced.fixture); pageErrors.push(fenced.errors);
    await fenced.page.goto(origin + '/game', { waitUntil: 'domcontentloaded' });
    await Promise.all([waitForMatch(fenced.page), waitForConnected(fenced.page)]);
    fenced.fixture.stallNextProfileReads = 1;
    // Hold the focus-triggered refresh while changing the synthetic actor.
    await fenced.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await fenced.fixture.waitForProfileStall();
    fenced.fixture.currentActor = 'fixture-actor-outsider';
    fenced.fixture.releaseProfileStalls();
    await fenced.page.waitForFunction(() => document.querySelector('.mx-online-controls')?.textContent.includes('Sign in to play online') || !document.querySelector('[data-gb-stage][aria-label="Online Mega XOXO match"]'), null, { timeout: 5000 });
    const fencedText = await fenced.page.locator('#main').innerText();
    assertCheck(report, 'P21-REALTIME-ACTOR-SESSION-FENCE', !/Fixture Player One|fixture-actor-fence-match/.test(fencedText), {
      old_actor_match_hidden: !/Fixture Player One|fixture-actor-fence-match/.test(fencedText), profile_reads: fenced.fixture.events.filter(event => event.path === '/api/v1/profile').length,
    });

    // Same-revision resignation arrives through HTTP and settles once per
    // actual profile reader. The other terminal forms arrive as full socket
    // snapshots and must lock the online input surface just as firmly.
    const resignRoom = makeRoom('fixture-resign-terminal');
    rooms.push(resignRoom);
    const resignPage = await newPage(browser, origin, resignRoom, sockets, 'fixture-actor-one');
    contexts.push(resignPage.context); apiFixtures.push(resignPage.fixture); pageErrors.push(resignPage.errors);
    await resignPage.page.goto(origin + '/game', { waitUntil: 'domcontentloaded' });
    await Promise.all([waitForMatch(resignPage.page), waitForConnected(resignPage.page)]);
    const resignInitialRevision = resignRoom.match.revision;
    const resignProfileReads = resignRoom.profileReadsByActor['fixture-actor-one'] || 0;
    resignPage.page.once('dialog', dialog => dialog.accept());
    await clickAsForegroundTab(resignPage.page, resignPage.page.locator('[data-gb-action="resign"]'));
    await resignPage.page.getByText('Match finished', { exact: false }).waitFor({ timeout: 6000 });
    await resignPage.page.waitForFunction(() => document.querySelector('[data-gb-stage][aria-label="Online Mega XOXO match"]')?.querySelectorAll('[data-gb-cell][aria-disabled="true"]').length === 81);
    await resignPage.page.waitForFunction(() => window.__p21RealtimeAudit && document.querySelector('.mx-online-controls')?.textContent.includes('Choose your next match'));
    await waitForCondition(() => (resignRoom.profileReadsByActor['fixture-actor-one'] || 0) >= resignProfileReads + 1);
    const resignSettledReads = resignRoom.profileReadsByActor['fixture-actor-one'] || 0;
    const resignPost = resignPage.fixture.events.find(event => event.method === 'POST' && event.path === '/api/v1/resign');
    assertCheck(report, 'P21-REALTIME-SAME-REVISION-RESIGNATION-LOCK-AND-REFRESH', resignRoom.match.status === 'FINISHED' && resignRoom.match.revision === resignInitialRevision && resignRoom.match.receipt?.reason === 'RESIGNATION' && Boolean(resignPost) && resignSettledReads === resignProfileReads + 1, {
      status: resignRoom.match.status, revision_unchanged: resignRoom.match.revision === resignInitialRevision,
      all_cells_disabled: true, csrf_header_present: Boolean(resignPost?.csrf_header_present), profile_refreshes_after_terminal: resignSettledReads - resignProfileReads,
    });

    for (const terminal of [
      { id: 'timeout', status: 'FINISHED', reason: 'TURN_TIMEOUT' },
      { id: 'void', status: 'VOID', reason: 'VOID' },
    ]) {
      const room = makeRoom('fixture-' + terminal.id + '-terminal');
      rooms.push(room);
      const linked = await newPage(browser, origin, room, sockets, 'fixture-actor-one');
      contexts.push(linked.context); apiFixtures.push(linked.fixture); pageErrors.push(linked.errors);
      await linked.page.goto(origin + '/game', { waitUntil: 'domcontentloaded' });
      await Promise.all([waitForMatch(linked.page), waitForConnected(linked.page)]);
      const startingRevision = room.match.revision;
      const startingProfileReads = room.profileReadsByActor['fixture-actor-one'] || 0;
      const winner = terminal.status === 'VOID' ? null : 'O';
      room.match = snapshotFor(room.match.id, room.match.state, terminal.status, { winner, reason: terminal.reason });
      sockets.broadcast(room, snapshotFrame(room));
      await linked.page.waitForFunction(() => document.querySelector('[data-gb-stage][aria-label="Online Mega XOXO match"]')?.querySelectorAll('[data-gb-cell][aria-disabled="true"]').length === 81, null, { timeout: 5000 });
      await linked.page.waitForFunction(() => document.querySelector('.mx-online-controls')?.textContent.includes('Choose your next match'), null, { timeout: 5000 });
      await waitForCondition(() => (room.profileReadsByActor['fixture-actor-one'] || 0) >= startingProfileReads + 1);
      const terminalReads = room.profileReadsByActor['fixture-actor-one'] || 0;
      assertCheck(report, 'P21-REALTIME-SAME-REVISION-' + terminal.id.toUpperCase() + '-LOCK-AND-REFRESH', room.match.status === terminal.status && room.match.revision === startingRevision && room.match.receipt?.reason === terminal.reason && terminalReads === startingProfileReads + 1, {
        status: room.match.status, revision_unchanged: room.match.revision === startingRevision, all_cells_disabled: true,
        actual_profile_refreshes_after_terminal: terminalReads - startingProfileReads,
      });
      await linked.context.close();
    }

    // If a socket upgrade is denied, the app must keep its HTTP match check
    // path usable. This room rejects every ticket's next loopback upgrade.
    const fallbackRoom = makeRoom('fixture-http-fallback');
    rooms.push(fallbackRoom);
    const fallback = await newPage(browser, origin, fallbackRoom, sockets, 'fixture-actor-one', { denySocket: true });
    contexts.push(fallback.context); apiFixtures.push(fallback.fixture); pageErrors.push(fallback.errors);
    const deniedBefore = sockets.stats.upgrade_denials;
    await fallback.page.goto(origin + '/game', { waitUntil: 'domcontentloaded' });
    await waitForMatch(fallback.page);
    await fallback.page.waitForFunction(() => document.querySelector('.mx-online-message')?.textContent.includes('Live updates interrupted.') || document.querySelector('.mx-online-message')?.textContent.includes('Match checks continue.'), null, { timeout: 7000 });
    const getsBeforeFallback = fallback.fixture.matchReads;
    fallbackRoom.match = snapshotFor(fallbackRoom.match.id, game.apply(fallbackRoom.match.state, { b: 4, c: 4 }), 'PLAYING');
    await fallback.page.evaluate(() => { window.__p21Hidden = false; window.dispatchEvent(new Event('online')); });
    await fallback.page.getByText('1 move played', { exact: false }).waitFor({ timeout: 4500 });
    assertCheck(report, 'P21-REALTIME-SOCKET-DENIED-HTTP-FALLBACK', sockets.stats.upgrade_denials > deniedBefore && fallback.fixture.matchReads > getsBeforeFallback, {
      denied_loopback_upgrades: sockets.stats.upgrade_denials - deniedBefore, http_match_reads_after_denial: fallback.fixture.matchReads - getsBeforeFallback,
      match_updated_over_http: true,
    });

    // An account restoration read that never settles is bounded by the
    // existing eight-second client deadline; retry then confirms the session.
    const restoreRoom = makeRoom('fixture-account-restore');
    rooms.push(restoreRoom);
    const restore = await newPage(browser, origin, restoreRoom, sockets, 'fixture-actor-one');
    contexts.push(restore.context); apiFixtures.push(restore.fixture); pageErrors.push(restore.errors);
    restore.fixture.stallNextProfileReads = 1;
    const restoreStarted = Date.now();
    await restore.page.goto(origin + '/profile', { waitUntil: 'domcontentloaded' });
    await restore.fixture.waitForProfileStall();
    await restore.page.locator('#profile-editor [data-account-action="retry"]').waitFor({ state: 'visible', timeout: 9000 });
    const restorePageToRetryMs = Date.now() - restoreStarted;
    const restoreTimeoutMs = Date.now() - restore.fixture.profileStallStartedAt;
    restore.fixture.releaseProfileStalls();
    assertCheck(report, 'P21-REALTIME-ACCOUNT-RESTORE-DEADLINE', restoreTimeoutMs >= 7000 && restoreTimeoutMs <= 8500, { request_to_retry_ms: restoreTimeoutMs, page_navigation_to_retry_ms: restorePageToRetryMs, configured_deadline_ms: 8000, tolerance_ms: 500 });
    await restore.page.locator('#profile-editor [data-account-action="retry"]').click();
    await restore.page.locator('#profile-editor [data-profile-form]').waitFor({ state: 'visible', timeout: 6000 });
    const profileReadsBeforeBfcache = restore.fixture.events.filter(event => event.method === 'GET' && event.path === '/api/v1/profile').length;
    await restore.page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await restore.page.locator('#profile-editor [data-profile-form]').waitFor({ state: 'visible', timeout: 6000 });
    const profileReadsAfterBfcache = restore.fixture.events.filter(event => event.method === 'GET' && event.path === '/api/v1/profile').length;
    assertCheck(report, 'P21-REALTIME-BFCACHE-RESTORE-RECHECK', profileReadsAfterBfcache > profileReadsBeforeBfcache, {
      lifecycle: 'synthetic persisted pagehide/pageshow pair', profile_rechecks_after_restore: profileReadsAfterBfcache - profileReadsBeforeBfcache,
    });

    // A separate TLS origin verifies actual WSS handshake under the shipped
    // connect-src policy. Key and certificate files are deleted immediately
    // after loading; ignoreHTTPSErrors is enabled only on this local context.
    tlsMaterial = await createTlsMaterial(path.join(ROOT, '.artifacts'));
    if (!tlsMaterial) {
      skip(report, 'P21-REALTIME-WSS-CSP-LOOPBACK', 'OpenSSL self-signed certificate generation was unavailable on this host.');
    } else {
      const tlsStatic = createPreviewServer({ directory: snapshot, readApiOrigin: null });
      const tlsHandler = tlsStatic.listeners('request');
      tlsServer = https.createServer({ key: tlsMaterial.key, cert: tlsMaterial.cert, minVersion: 'TLSv1.2' });
      for (const handler of tlsHandler) tlsServer.on('request', handler);
      sockets.attach(tlsServer);
      tlsServer.listen(0, LOOPBACK);
      await once(tlsServer, 'listening');
      const secureOrigin = 'https://' + LOOPBACK + ':' + tlsServer.address().port;
      const secureRoom = makeRoom('fixture-wss-csp');
      rooms.push(secureRoom);
      const secure = await newPage(browser, secureOrigin, secureRoom, sockets, 'fixture-actor-one', { ignoreHTTPSErrors: true });
      contexts.push(secure.context); apiFixtures.push(secure.fixture); pageErrors.push(secure.errors);
      const secureResponse = await secure.page.goto(secureOrigin + '/game', { waitUntil: 'domcontentloaded' });
      await Promise.all([waitForMatch(secure.page), waitForConnected(secure.page)]);
      const secureCsp = secureResponse?.headers()['content-security-policy'] || '';
      const secureAudit = await secure.page.evaluate(() => ({ connectViolations: window.__p21RealtimeAudit.cspConnect.length, directives: window.__p21RealtimeAudit.cspConnect.map(row => row.directive) }));
      assertCheck(report, 'P21-REALTIME-WSS-CSP-LOOPBACK', secureCsp.includes("connect-src 'self'") && secureAudit.connectViolations === 0 && sockets.stats.successful_handshakes >= 3, {
        secure_transport: 'WSS on same-origin loopback TLS', csp_connect_src: "'self'", connect_src_violations: secureAudit.connectViolations,
        successful_handshake_observed: sockets.stats.successful_handshakes >= 3,
      });
    }

    const privateStore = await first.page.evaluate(() => ({
      writes: window.__p21RealtimeAudit.storageWrites,
      keys: Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)),
    }));
    const forbiddenStorage = [...privateStore.writes, ...privateStore.keys].filter(key => /ticket|csrf|session|auth|token|match|actor|player/i.test(key));
    assertCheck(report, 'P21-REALTIME-NO-TICKET-OR-SESSION-STORAGE', forbiddenStorage.length === 0, {
      forbidden_storage_key_count: forbiddenStorage.length,
      local_storage_write_count: privateStore.writes.length,
    });

    const mutationEvents = apiFixtures.flatMap(fixture => fixture.events).filter(event => event.method === 'POST' && /^\/api\/(?:v1\/(?:move|resign)|account\/logout)$/.test(event.path));
    const websocketMutationOps = Object.keys(sockets.stats.protocol_operations).filter(operation => ['move', 'resign', 'mutate', 'settle', 'logout'].includes(operation));
    assertCheck(report, 'P21-REALTIME-ALL-MUTATIONS-STAY-HTTP', mutationEvents.length > 0 && mutationEvents.every(event => event.csrf_header_present && event.idempotency_header_present) && websocketMutationOps.length === 0, {
      observed_http_mutations: mutationEvents.length, all_with_csrf_and_idempotency: mutationEvents.every(event => event.csrf_header_present && event.idempotency_header_present),
      websocket_mutation_operations: websocketMutationOps.length,
    });

    const allErrors = pageErrors.reduce((sum, entry) => sum + entry.pageErrors, 0);
    assertCheck(report, 'P21-REALTIME-JAVASCRIPT-ERRORS', allErrors === 0, { page_error_count: allErrors });
    report.api_fixture_summary = {
      synthetic_api_requests: apiFixtures.reduce((sum, fixture) => sum + fixture.events.length, 0),
      http_mutation_requests: mutationEvents.length,
      http_mutation_paths: [...new Set(mutationEvents.map(event => event.path))].sort(),
      csrf_and_idempotency_headers_present: mutationEvents.every(event => event.csrf_header_present && event.idempotency_header_present),
      full_snapshot_recovery_requests: apiFixtures.reduce((sum, fixture) => sum + fixture.snapshotReads, 0),
      full_snapshot_recovery_responses: apiFixtures.reduce((sum, fixture) => sum + fixture.snapshotResponses, 0),
      match_poll_requests: apiFixtures.reduce((sum, fixture) => sum + fixture.matchReads, 0),
      terminal_profile_reads: rooms.filter(room => room.match.status === 'FINISHED' || room.match.status === 'VOID').map(room => ({ status: room.match.status, reads: room.profileReadsByActor['fixture-actor-one'] || 0 })),
      secrets_recorded: false,
    };
    report.websocket_fixture_summary = {
      transport: 'real RFC 6455 loopback handshake and browser/server frames; WSS probe uses temporary local TLS certificate when available',
      upgrade_attempts: sockets.stats.upgrade_attempts,
      upgrade_denials: sockets.stats.upgrade_denials,
      successful_handshakes: sockets.stats.successful_handshakes,
      ticket_redeem_attempts: sockets.stats.ticket_redeem_attempts,
      successful_one_use_ticket_redeems: sockets.stats.ticket_redeem_successes,
      protocol_operations: sockets.stats.protocol_operations,
      resume_revision_matches_snapshot: rooms.flatMap(room => room.resumeEvidence).every(row => row.ack_revision === row.snapshot_revision),
      raw_ticket_or_session_material_recorded: false,
    };
  } catch (error) {
    report.failures.push({ id: 'P21-REALTIME-RUNNER-ERROR', result: 'FAIL', error_name: error?.name || 'Error', message: String(error?.message || 'Runner failed without a message').slice(0, 240) });
    report.fixture_diagnostics = {
      api_requests: apiFixtures.flatMap(fixture => fixture.events.map(event => ({ method: event.method, path: event.path, field_names: event.field_names, csrf_header_present: event.csrf_header_present, idempotency_header_present: event.idempotency_header_present }))),
      socket_operation_counts: sockets?.stats.protocol_operations || {},
      room_heads: rooms.map(room => ({ status: room.match.status, revision: room.match.revision, socket_subscriptions: room.socketSubscriptions, profile_reads: room.profileReadsByActor })),
      secret_values_recorded: false,
    };
  } finally {
    for (const fixture of apiFixtures) fixture.releaseProfileStalls?.();
    for (const context of contexts) { try { await context.close(); } catch {} }
    if (browser) { try { await browser.close(); } catch {} }
    if (sockets) sockets.detach();
    for (const server of [tlsServer, preview]) if (server?.listening) await new Promise(resolve => server.close(() => resolve()));
    if (tlsMaterial) { tlsMaterial.key.fill(0); tlsMaterial.cert.fill(0); tlsMaterial = null; }
    fs.rmSync(snapshot, { recursive: true, force: true });
    report.finished_at = new Date().toISOString();
    report.result = report.failures.length ? 'FAIL' : 'PASS';
    const target = path.join(output, 'report.json');
    report.output_directory = output;
    fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(JSON.stringify({ result: report.result, report: target, check_count: report.checks.length, failure_count: report.failures.length }) + '\n');
  }
  if (report.failures.length) process.exitCode = 1;
}

if (require.main === module) {
  try { main().catch(error => { process.stderr.write((error?.message || String(error)) + '\n'); process.exitCode = 1; }); }
  catch (error) { process.stderr.write((error?.message || String(error)) + '\n'); process.exitCode = 1; }
}

module.exports = { parseArgs, verifyArtifact, copySnapshot, makeSocketFixture, makeApiFixture };
