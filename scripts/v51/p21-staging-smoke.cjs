#!/usr/bin/env node
'use strict';
/**
 * scripts/v51/p21-staging-smoke.cjs - V5.1 P21 Staging Acceptance & Provider Smoke Test.
 *
 * SCOPE & CONTRACT:
 * Proves real P21 account, protected profile, wallet, rank, leaderboard, friends,
 * matchmaking, and realtime flows on a private loopback actual API / Core service
 * against the safe isolated V5 staging Neon PostgreSQL 16 database and Upstash Redis.
 *
 * RESTRICTIONS:
 * - Direct read-only / programmatic credential handling: no passwords, tokens, cookies,
 *   emails, or raw player data ever reach stdout, stderr, or committed artifacts.
 * - Non-production staging only (lively-shadow-52629967 / mega_xo_v5_staging).
 * - Imported records are preserved by before/after SHA-256 hashes of every application table.
 *   Cleanup is transactional and restricted to exact, successfully created synthetic identities.
 * - Outbound providers disabled (no live SMTP, Google Play, Apple App Store, or AdMob network calls).
 * - Real loopback HTTP server provides same-origin static assets + actual protected API.
 * - Principle distinction: browser session cookies + CSRF vs native Bearer tokens.
 * - Least privilege: api_runtime cannot write economy tables (throws PostgreSQL 42501).
 *   All economic mutations must execute through Core authority.
 * - No dual SQLite: all queries target PostgreSQL 16.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const pg = require('pg');

const ROOT = path.resolve(__dirname, '..', '..');
const CREDENTIALS_PATH = '/Users/oculus/Downloads/Mega-XO-private-evidence/v5-neon-staging/credentials.json';
const CA_PATH = '/Users/oculus/Downloads/Mega-XO-private-evidence/v5-neon-staging/ca.pem';
const RUNTIME_ROLES_PATH = '/Users/oculus/Downloads/Mega-XO-private-evidence/v5-neon-staging/runtime-roles.json';
const UPSTASH_PATH = '/Users/oculus/Downloads/Mega-XO-private-evidence/p06-provider-credentials/upstash-staging.json';

const { createPgPool } = require(path.join(ROOT, 'packages/db/pg/pool.js'));
const { createAccountService } = require(path.join(ROOT, 'packages/services/accounts.js'));
const { createCoreService } = require(path.join(ROOT, 'packages/services/core.js'));
const { createAccessService } = require(path.join(ROOT, 'packages/services/access.js'));
const { createRefreshService } = require(path.join(ROOT, 'packages/services/refresh.js'));
const { createTicketIssuer, redeemRealtimeTicket } = require(path.join(ROOT, 'packages/services/tickets.js'));
const { createEphemeraService } = require(path.join(ROOT, 'packages/services/ephemera.js'));
const { createQueueService } = require(path.join(ROOT, 'packages/services/queue.js'));
const { createCoreGateway, createCoreServiceIngress } = require(path.join(ROOT, 'packages/services/core-gateway.js'));
const { createRealtimeTransport } = require(path.join(ROOT, 'packages/services/realtime-transport.js'));
const { createBrowserAuthHarness } = require(path.join(ROOT, 'packages/services/browser-harness.js'));
const { createApiHandler } = require(path.join(ROOT, 'apps/api/index.js'));
const security = require(path.join(ROOT, 'packages/services/security.js'));
const { resolveAuth } = require(path.join(ROOT, 'apps/api/routes/helpers.js'));
const { createCommerceService } = require(path.join(ROOT, 'packages/services/commerce.js'));

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
});

function tagFor(actor) {
  const hash = crypto.createHash('sha256').update(actor).digest('hex').toUpperCase();
  return `MEGA-${hash.slice(0, 10)}`;
}

async function requestHttp(url, options = {}) {
  const u = new URL(url);
  const method = (options.method || 'GET').toUpperCase();
  const headers = { ...(options.headers || {}) };
  let bodyData = options.body;

  if (bodyData && typeof bodyData === 'object' && !Buffer.isBuffer(bodyData)) {
    bodyData = JSON.stringify(bodyData);
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
  }

  if (bodyData) {
    headers['Content-Length'] = Buffer.byteLength(bodyData);
  }

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: parsed,
          body: raw,
        });
      });
    });

    req.setTimeout(60000, () => req.destroy(new Error('HTTP_REQUEST_TIMEOUT')));
    req.on('error', reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

/* Staging-only bounds. Neon staging compute can cold-start after autosuspend, so the harness gives
 * the Core gateway a generous budget, and a bounded drain for a Core commit that lands after the
 * gateway client aborted its own fetch (an abort does not cancel the loopback ingress work). */
const GATEWAY_TIMEOUT_MS = 30000;
const SETTLE_INTERVAL_MS = 1000;
const SETTLE_TIMEOUT_MS = 30000;
const quoteIdentifier = (value) => `"${value.replace(/"/g, '""')}"`;
const safeError = (error) => {
  const code = error?.code || error?.message?.split(':', 1)[0];
  return typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'SMOKE_ASSERTION_FAILED';
};

// Rows never leave this process: only sorted, length-delimited SHA-256 digests are retained.
async function snapshotTables(client, tables) {
  const snapshots = {};
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    for (const table of tables) {
      const name = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
      const hash = crypto.createHash('sha256');
      let count = 0;
      await client.query(`DECLARE smoke_rows NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS row FROM ${name} t ORDER BY row_to_json(t)::text COLLATE "C"`);
      for (;;) {
        const page = await client.query('FETCH 256 FROM smoke_rows');
        if (!page.rows.length) break;
        for (const { row } of page.rows) {
          hash.update(`${Buffer.byteLength(row)}:`);
          hash.update(row);
          count++;
        }
      }
      await client.query('CLOSE smoke_rows');
      snapshots[`${table.schema}.${table.name}`] = { count, sha256: hash.digest('hex') };
    }
    await client.query('COMMIT');
    return snapshots;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function openRealtime(url, sockets) {
  if (typeof globalThis.WebSocket !== 'function') throw new Error('WEBSOCKET_CLIENT_UNAVAILABLE');
  const socket = new WebSocket(url);
  sockets.add(socket);
  const frames = [];
  const waiters = new Set();
  socket.addEventListener('message', (event) => {
    let frame;
    try { frame = JSON.parse(String(event.data)); } catch { return; }
    frames.push(frame);
    for (const notify of waiters) notify();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('WEBSOCKET_OPEN_TIMEOUT')); }, 15000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WEBSOCKET_OPEN_FAILED')); }, { once: true });
  });
  return {
    socket,
    send: (message) => socket.send(JSON.stringify({ protocol: 'realtime/v1', ...message })),
    next: (predicate) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('REALTIME_FRAME_TIMEOUT')), 60000);
      const finish = (error, frame) => {
        clearTimeout(timer);
        waiters.delete(check);
        error ? reject(error) : resolve(frame);
      };
      const check = () => {
        const index = frames.findIndex((frame) => frame.operation === 'error' || predicate(frame));
        if (index < 0) return;
        const [frame] = frames.splice(index, 1);
        if (frame.operation === 'error') finish(new Error(frame.code || 'REALTIME_ERROR'));
        else finish(null, frame);
      };
      waiters.add(check);
      check();
    }),
  };
}

async function main() {
  const startTime = Date.now();
  const runId = crypto.randomBytes(12).toString('hex');
  const results = {
    tool: 'p21-staging-smoke',
    version: '5.1.0',
    runId,
    timestampUtc: new Date().toISOString(),
    ok: false,
    target: {},
    schemaVerification: {},
    rolesObserved: [],
    flows: [],
    providerPrerequisites: {},
    deviceInventory: {},
    baselineRowCounts: {},
    finalRowCounts: {},
    summary: { total: 0, passed: 0, failed: 0, durationMs: 0 },
    preservation: { baseline: {}, final: {}, verified: false, settle: null, settleAfter: null, residual: null, lateCommit: false },
    limitations: [
      'Private loopback composition, not a deployed V5 environment.',
      'Loopback HTTP/WS is not public HTTPS/WSS or a physical-device network proof; provider database/Redis TLS stays verified.',
      'Service-issued synthetic sessions; real provider sign-in and physical native hosts are not exercised.',
      'Provider approval, legal/consent approval and device execution remain unverified.',
    ],
  };

  const logStep = (name, status, details = {}) => {
    results.flows.push({ name, status, ...details, atMs: Date.now() - startTime });
    if (process.env.DEBUG || !process.argv.includes('--json')) {
      console.log(`[FLOW] ${name}: ${status}`);
    }
  };

  let apiPool = null;
  let corePool = null;
  let ownerClient = null;
  let ephemera = null;
  let loopbackServer = null;
  let realtimeTransport = null;
  let actorA = null;
  let actorB = null;
  let sessA = null;
  let sessB = null;
  let queue = null;
  let refresh = null;
  const ownedSessionIds = new Set();
  const serviceClosers = [];
  const tablesToProbe = [];
  const ownedActors = new Set();
  const ownedMatches = new Set();
  const sockets = new Set();
  const queueMatchId = `queue:p21_${runId}`;
  const queueOperation = `pair:${queueMatchId}`;
  let baselineCaptured = false;
  let ownedRedisNamespace = false;
  let ingressInFlight = 0;

  /* Bounded late-commit drain. The actor-scoped durable marker families must stop moving AND no
   * loopback ingress request of this run may still be in flight before anything is snapshotted. */
  const settleCommands = async () => {
    const startedAt = Date.now();
    const actors = [...ownedActors];
    const prefixes = actors.map((actor) => `core.command:${actor}:`);
    const markerSql =
      'SELECT (SELECT count(*) FROM economy.command_outcomes WHERE actor_id = ANY($1::text[]))'
      + ' + (SELECT count(*) FROM economy.wallet_operations WHERE actor_id = ANY($1::text[]))'
      + ' + (SELECT count(*) FROM economy.wallet_ledger_entries WHERE actor_id = ANY($1::text[]))'
      + ' + (SELECT count(*) FROM economy.ledger WHERE actor_id = ANY($1::text[]))'
      + ' + (SELECT count(*) FROM ops.outbox WHERE EXISTS (SELECT 1 FROM unnest($2::text[]) p WHERE left(outbox_id, length(p)) = p)) AS marker';
    let previous = null;
    let stable = 0;
    const deadline = startedAt + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_INTERVAL_MS));
      const marker = Number((await ownerClient.query(markerSql, [actors, prefixes])).rows[0].marker);
      stable = marker === previous ? stable + 1 : 0;
      previous = marker;
      if (ingressInFlight === 0 && stable >= 2) break;
    }
    return { settled: ingressInFlight === 0 && stable >= 2, waitedMs: Date.now() - startedAt, ingressInFlight, marker: previous };
  };

  /* Attributable but sanitized: table names, row counts, and how many residual rows belong to this
   * run's owned synthetic namespaces. No raw player identifier or row body is ever recorded. */
  const residualReport = async () => {
    const actors = [...ownedActors];
    const outboxPrefixes = actors.map((actor) => `core.command:${actor}:`);
    const noticeIds = [...ownedSessionIds].map((sessionId) => `security.session-revoked:session:${sessionId}`);
    const ratePrefixes = actors.flatMap((actor) => [`edit:${actor}:`, `social:${actor}:`]);
    const report = {};
    for (const [name, baseline] of Object.entries(results.preservation.baseline)) {
      const final = results.preservation.final[name];
      if (!final || final.count === baseline.count) continue;
      const table = tablesToProbe.find((entry) => `${entry.schema}.${entry.name}` === name);
      const entry = { baseline: baseline.count, final: final.count, delta: final.count - baseline.count, ownedRows: 0 };
      if (table && table.actorColumn && actors.length) {
        const owned = await ownerClient.query(
          `SELECT count(*)::int AS c FROM ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)} WHERE actor_id = ANY($1::text[])`,
          [actors]
        );
        entry.ownedRows = owned.rows[0].c;
      } else if (name === 'ops.outbox') {
        const owned = await ownerClient.query(
          'SELECT count(*)::int AS c FROM ops.outbox WHERE outbox_id = ANY($2::text[])'
          + ' OR EXISTS (SELECT 1 FROM unnest($1::text[]) p WHERE left(outbox_id, length(p)) = p)',
          [outboxPrefixes, noticeIds]
        );
        entry.ownedRows = owned.rows[0].c;
      } else if (name === 'ops.rate_buckets') {
        const owned = await ownerClient.query(
          'SELECT count(*)::int AS c FROM ops.rate_buckets WHERE EXISTS (SELECT 1 FROM unnest($1::text[]) p WHERE left(bucket_id, length(p)) = p)',
          [ratePrefixes]
        );
        entry.ownedRows = owned.rows[0].c;
      }
      entry.unexplainedRows = Math.max(0, entry.delta - entry.ownedRows);
      report[name] = entry;
    }
    return report;
  };

  const cleanup = async () => {
    const actors = [...ownedActors];
    if (!actors.length) return;
    // Redis is removed through the exact owned-version wipe after transport shutdown.
    await ownerClient.query('BEGIN');
    try {
      // A guessed/colliding name is never ownership. Refuse any mixed or imported match.
      for (const id of ownedMatches) {
        const seats = await ownerClient.query('SELECT actor_id FROM match.participants WHERE match_id = $1', [id]);
        const match = await ownerClient.query('SELECT 1 FROM match.matches WHERE match_id = $1', [id]);
        if ((match.rowCount && seats.rowCount !== 2) || seats.rows.some((row) => !ownedActors.has(row.actor_id))) throw new Error('CLEANUP_MATCH_OWNERSHIP_VIOLATION');
        await ownerClient.query('DELETE FROM match.matches WHERE match_id = $1', [id]);
      }
      if (ownedMatches.has(queueMatchId)) {
        await ownerClient.query('DELETE FROM economy.command_outcomes WHERE actor_id = $1 AND "key" = $2', ['matchmaker', JSON.stringify(queueOperation)]);
        await ownerClient.query('DELETE FROM ops.outbox WHERE outbox_id = $1', [`core.command:matchmaker:${queueOperation}`]);
      }
      await ownerClient.query('DELETE FROM social.friendships WHERE actor_a = ANY($1::text[]) AND actor_b = ANY($1::text[])', [actors]);
      await ownerClient.query('DELETE FROM social.friend_requests WHERE from_id = ANY($1::text[]) AND to_id = ANY($1::text[])', [actors]);
      await ownerClient.query('DELETE FROM social.blocks WHERE blocker_id = ANY($1::text[]) AND blocked_id = ANY($1::text[])', [actors]);
      for (const sessionId of ownedSessionIds) {
        await ownerClient.query('DELETE FROM ops.outbox WHERE outbox_id = $1', [`security.session-revoked:session:${sessionId}`]);
      }
      for (const actor of actors) {
        await ownerClient.query('DELETE FROM ops.outbox WHERE left(outbox_id, length($1)) = $1', [`core.command:${actor}:`]);
        for (const bucket of ['edit', 'social']) {
          await ownerClient.query('DELETE FROM ops.rate_buckets WHERE left(bucket_id, length($1)) = $1', [`${bucket}:${actor}:`]);
        }
      }
      // Include soft-reference economic/social outcomes as well as FK-owned actor rows.
      for (const table of tablesToProbe.filter((table) => table.actorColumn && table.name !== 'actors' && table.schema !== 'match')) {
        await ownerClient.query(`DELETE FROM ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)} WHERE actor_id = ANY($1::text[])`, [actors]);
      }
      await ownerClient.query('DELETE FROM identity.actors WHERE actor_id = ANY($1::text[])', [actors]);
      await ownerClient.query('COMMIT');
    } catch (error) {
      await ownerClient.query('ROLLBACK');
      throw error;
    }
  };

  try {
    // =========================================================================
    if (process.env.MEGA_V51_STAGING_SMOKE !== 'lively-shadow-52629967/mega_xo_v5_staging') {
      throw new Error('EXPLICIT_STAGING_SMOKE_OPT_IN_REQUIRED');
    }
    if (!fs.existsSync(CREDENTIALS_PATH)) throw new Error('MISSING_STAGING_CREDENTIALS');
    if (!fs.existsSync(CA_PATH)) throw new Error('MISSING_STAGING_CA');
    if (!fs.existsSync(RUNTIME_ROLES_PATH)) throw new Error('MISSING_RUNTIME_ROLES');

    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const caPem = fs.readFileSync(CA_PATH, 'utf8');
    const runtimeRoles = JSON.parse(fs.readFileSync(RUNTIME_ROLES_PATH, 'utf8'));

    results.target = {
      project: creds.project,
      branch: creds.branch,
      database: creds.database,
      host: runtimeRoles.host,
      environment: 'staging',
      nonserving: true,
      tlsVerified: true,
      channelBinding: 'SCRAM-SHA-256-PLUS',
    };

    const targetFile = path.join(ROOT, 'docs/v5/environments/staging.json');
    const target = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    const migrationUrl = new URL(creds.migration_url);
    if (target.projectId !== 'lively-shadow-52629967' || target.database !== 'mega_xo_v5_staging' ||
        target.environment !== 'staging' || target.nonserving !== true ||
        creds.project !== target.projectId || creds.branch !== target.branchId || creds.database !== target.database ||
        runtimeRoles.host !== target.host || runtimeRoles.database !== target.database ||
        migrationUrl.hostname !== target.host || migrationUrl.pathname !== `/${target.database}` ||
        Number(migrationUrl.port || 5432) !== 5432 ||
        Object.values(target.outbound || {}).length !== 3 ||
        Object.values(target.outbound).some((value) => value !== 'disabled')) {
      throw new Error('REFUSED_STAGING_TARGET_BINDING');
    }
    results.rolesObserved = [];
    logStep('1_inventory_target_credentials', 'PASSED', { target: results.target.database });

    // =========================================================================
    // Phase 2: Connect DB Pools & Conformance Read-Only Probe
    // =========================================================================
    ownerClient = new pg.Client({
      host: migrationUrl.hostname,
      port: Number(migrationUrl.port || 5432),
      user: migrationUrl.username,
      password: decodeURIComponent(migrationUrl.password),
      database: migrationUrl.pathname.slice(1),
      ssl: { ca: [caPem], rejectUnauthorized: true },
      channel_binding: 'require',
    });
    await ownerClient.connect();
    const observed = (await ownerClient.query('SELECT current_database() AS database, current_user AS role, current_setting(\'server_version_num\')::int AS version')).rows[0];
    if (observed.database !== target.database || Math.floor(observed.version / 10000) !== 16) throw new Error('REFUSED_OBSERVED_DATABASE');

    // Verify migrations in meta.migrations
    const ledgerRes = await ownerClient.query('SELECT count(*)::int as count FROM meta.migrations');
    const appliedCount = ledgerRes.rows[0].count;
    results.schemaVerification = {
      appliedMigrationsCount: appliedCount,
      minimumRequired: 43,
      conformancePassed: appliedCount >= 43,
    };
    if (appliedCount < 43) {
      throw new Error(`INCOMPLETE_MIGRATIONS: expected >= 43, found ${appliedCount}`);
    }

    const catalog = await ownerClient.query(
      `SELECT t.table_schema AS schema, t.table_name AS name,
              EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'actor_id') AS "actorColumn"
         FROM information_schema.tables t
        WHERE t.table_type = 'BASE TABLE'
          AND t.table_schema = ANY($1::text[])
        ORDER BY t.table_schema, t.table_name`,
      [['meta', 'identity', 'profile', 'social', 'economy', 'core', 'match', 'tournament', 'monetization', 'cosmetics', 'season', 'privacy', 'audit', 'support', 'runtime', 'ops']]
    );
    tablesToProbe.push(...catalog.rows);
    if (!tablesToProbe.some((table) => table.schema === 'identity' && table.name === 'actors')) throw new Error('PRESERVATION_TABLES_ABSENT');
    results.preservation.baseline = await snapshotTables(ownerClient, tablesToProbe);
    baselineCaptured = true;
    for (const [name, value] of Object.entries(results.preservation.baseline)) results.baselineRowCounts[name] = value.count;
    logStep('2_probe_schema_and_baseline', 'PASSED', { appliedMigrations: appliedCount });
    const budget = Object.freeze({
      totalConnections: 30,
      roleConnections: Object.freeze({
        api_runtime: 16,
        core_runtime: 8,
        worker_runtime: 4,
      }),
    });

    apiPool = createPgPool({
      host: runtimeRoles.host,
      port: 5432,
      database: runtimeRoles.database,
      user: 'api_runtime',
      password: runtimeRoles.roles.api_runtime.password,
      role: 'api_runtime',
      label: 'staging',
      service: 'v51-staging-smoke',
      revision: 'v51-smoke',
      ssl: { ca: caPem, rejectUnauthorized: true },
      sslRootCertPath: CA_PATH,
      channel_binding: 'require',
      targetFile,
      budget,
      pool: { max: 4, idleTimeoutMillis: 5000, connectionTimeoutMillis: 15000 },
      lockTimeoutMs: 15000,
      statementTimeoutMs: 30000,
      idleInTransactionTimeoutMs: 15000,
    });

    corePool = createPgPool({
      host: runtimeRoles.host,
      port: 5432,
      database: runtimeRoles.database,
      user: 'core_runtime',
      password: runtimeRoles.roles.core_runtime.password,
      role: 'core_runtime',
      label: 'staging',
      service: 'v51-staging-smoke',
      revision: 'v51-smoke',
      ssl: { ca: caPem, rejectUnauthorized: true },
      sslRootCertPath: CA_PATH,
      channel_binding: 'require',
      targetFile,
      budget,
      pool: { max: 4, idleTimeoutMillis: 5000, connectionTimeoutMillis: 15000 },
      lockTimeoutMs: 15000,
      statementTimeoutMs: 30000,
      idleInTransactionTimeoutMs: 15000,
    });
    for (const [pool, role] of [[apiPool, 'api_runtime'], [corePool, 'core_runtime']]) {
      const observedRole = (await pool.query('SELECT current_user AS role, current_database() AS database')).rows[0];
      if (observedRole.role !== role || observedRole.database !== target.database) throw new Error('RUNTIME_ROLE_BINDING_FAILED');
      results.rolesObserved.push(observedRole.role);
    }
    if (!fs.existsSync(UPSTASH_PATH)) throw new Error('UPSTASH_STAGING_CREDENTIALS_REQUIRED');
    const redisTarget = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/v5/environments/redis-staging.json'), 'utf8'));
    const upstashCred = JSON.parse(fs.readFileSync(UPSTASH_PATH, 'utf8'));
    const redisUrl = new URL(upstashCred.url);
    if (redisTarget.environment !== 'staging' || redisTarget.redis.nonserving !== true ||
        redisTarget.redis.provider !== 'upstash' || redisTarget.redis.host !== 'humble-duckling-214728.upstash.io' ||
        redisUrl.protocol !== 'rediss:' || redisUrl.hostname !== redisTarget.redis.host ||
        Number(redisUrl.port || 6379) !== redisTarget.redis.port) throw new Error('REFUSED_UPSTASH_STAGING_TARGET');
    ephemera = await createEphemeraService({
      url: upstashCred.url, environment: 'stg', keyVersion: `s${runId.slice(0, 7)}`, socket: { connectTimeout: 5000 },
    });
    const ephemeraHealthy = await ephemera.healthy();
    if (!ephemeraHealthy) throw new Error('UPSTASH_STAGING_UNHEALTHY');
    let namespaceCursor = '0';
    do {
      const reply = await ephemera.client.scan(namespaceCursor, { MATCH: `mx:stg:${ephemera.keyVersion}:*`, COUNT: 1000 });
      namespaceCursor = String(Array.isArray(reply) ? reply[0] : reply.cursor);
      if ((Array.isArray(reply) ? reply[1] : reply.keys).length) throw new Error('OWNED_REDIS_NAMESPACE_NOT_EMPTY');
    } while (namespaceCursor !== '0');
    ownedRedisNamespace = true;
    results.providerPrerequisites.upstash = { status: 'HEALTHY', isolatedNamespace: true };
    const OTP_SECRET = crypto.randomBytes(32).toString('hex');
    const GATEWAY_SECRET = crypto.randomBytes(32).toString('hex');
    const clock = () => Date.now();

    const keyFile = path.join(path.dirname(CREDENTIALS_PATH), 'keys.sealed.json');
    if (!fs.existsSync(keyFile)) throw new Error('EXISTING_SIGNING_KEY_CUSTODY_REQUIRED');
    const activeKeys = await apiPool.query("SELECT kid FROM identity.signing_keys WHERE environment = 'stg' AND state = 'active'");
    if (activeKeys.rows.length !== 1) throw new Error('EXISTING_ACTIVE_SIGNING_KEY_REQUIRED');
    const accounts = await createAccountService(apiPool, {
      now: clock,
      otpSecret: OTP_SECRET,
      ephemera: ephemeraHealthy ? ephemera : null,
      deletionPolicy: { enabled: true, policyVersion: 'p21-staging-smoke' },
      onSessionRevoked: async (ids) => {
        for (const id of ids) {
          if (!ownedSessionIds.has(id)) throw new Error('REVOCATION_SESSION_OWNERSHIP_VIOLATION');
          await refresh.revokeForSession(id);
        }
      },
    });
    serviceClosers.push(accounts);

    const core = await createCoreService(corePool, {
      now: clock,
      ephemera: ephemeraHealthy ? ephemera : null,
    });
    serviceClosers.push(core);

    const access = await createAccessService(apiPool, {
      now: clock,
      issuer: 'https://api.megaxo.online',
      environment: 'stg',
      keyFile,
      playerAudiences: ['mega-browser', 'mega-android', 'mega-ios'],
      serviceAudiences: ['mega-core'],
    });
    serviceClosers.push(access);

    // Access uses existing custody only; refresh rows belong exclusively to this run's actors.
    const nativeGrants = new Map();
    refresh = await createRefreshService(apiPool, {
      now: clock,
      mintAccess: ({ actor, sessionId, generation }) => {
        const grant = nativeGrants.get(sessionId);
        if (!grant || grant.actor !== actor) throw new Error('OWNED_NATIVE_GRANT_REQUIRED');
        return access.issue({ actor, sessionId, generation, amr: ['pwd'], authAt: grant.authAt, audience: 'mega-android' });
      },
    });
    serviceClosers.push(refresh);

    const ticketIssuer = await createTicketIssuer(apiPool, {
      now: clock,
      environment: 'stg',
      audience: 'mega-core',
    });
    serviceClosers.push(ticketIssuer);

    queue = createQueueService({
      ephemera,
      core,
      pool: corePool,
      now: clock,
    });
    serviceClosers.push(queue);

    const coreIngress = createCoreServiceIngress({
      coreService: core,
      ticketIssuer,
      queue,
      secret: GATEWAY_SECRET,
      now: clock,
    });

    logStep('3_setup_service_factories', 'PASSED', { ephemeraHealthy });

    // =========================================================================
    // Phase 4: Start Loopback Same-Origin HTTP Server
    // =========================================================================
    let serverPort = 0;
    let loopbackBaseUrl = '';
    let coreGateway = null;
    let apiHandler = null;

    const authenticateHttpForRealtime = async (req) => {
      security.validateCredentials({
        cookie: req.headers.cookie, authorization: req.headers.authorization,
        method: req.method, allowedOrigins: [loopbackBaseUrl],
      });
      const { actor } = await resolveAuth({ accounts, access, nativeAudiences: ['mega-ios', 'mega-android'] }, req);
      if (!actor) throw new Error('AUTH_REQUIRED');
      return { actor };
    };

    loopbackServer = http.createServer(async (req, res) => {
      try {
        const parsedUrl = new URL(req.url || '/', loopbackBaseUrl || 'http://127.0.0.1');
        const pathname = parsedUrl.pathname;
        // The transport owns these asynchronous reads; the co-host must not answer them.
        if (pathname === '/realtime/v1/snapshot' || pathname === '/realtime/v1/snapshot/' ||
            pathname.startsWith('/realtime/v1/match/')) return;

        // 1. Core Ingress path
        if (pathname.startsWith('/ingress/')) {
          ingressInFlight += 1;
          try {
            await coreIngress(req, res);
          } finally {
            ingressInFlight -= 1;
          }
          return;
        }

        // 3. API & Auth paths
        if (pathname.startsWith('/api/') || pathname.startsWith('/auth/') || pathname.startsWith('/.well-known/')) {
          await apiHandler(req, res);
          return;
        }

        // 4. Static P21 Web Assets (apps/web)
        const webRoot = path.join(ROOT, 'apps/web');
        let filePath = path.resolve(webRoot, pathname === '/' ? 'index.html' : pathname.replace(/^\//, ''));
        if (!filePath.startsWith(webRoot + path.sep)) throw new Error('STATIC_PATH_REJECTED');
        if (!fs.existsSync(filePath) && fs.existsSync(filePath + '.html')) {
          filePath = filePath + '.html';
        }

        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath).toLowerCase();
          const contentType = MIME_TYPES[ext] || 'application/octet-stream';
          res.statusCode = 200;
          res.setHeader('Content-Type', contentType);
          res.setHeader('X-Robots-Tag', 'noindex, nofollow');
          fs.createReadStream(filePath).pipe(res);
          return;
        }

        // Fallback SPA index
        const indexPath = path.join(ROOT, 'apps/web/index.html');
        if (fs.existsSync(indexPath)) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('X-Robots-Tag', 'noindex, nofollow');
          fs.createReadStream(indexPath).pipe(res);
          return;
        }

        res.statusCode = 404;
        res.end('Not Found');
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: safeError(err) }));
      }
    });

    await new Promise((resolve) => {
      loopbackServer.listen(0, '127.0.0.1', () => {
        serverPort = loopbackServer.address().port;
        loopbackBaseUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });

    // Mount realtime transport (RFC 6455 WebSockets + HTTP fallback snapshot)
    realtimeTransport = createRealtimeTransport({
      server: loopbackServer,
      pool: corePool,
      core,
      ephemera: ephemeraHealthy ? ephemera : null,
      now: clock,
      environment: 'stg',
      audience: 'mega-core',
      authenticateHttp: authenticateHttpForRealtime,
    });

    coreGateway = createCoreGateway({
      coreUrl: loopbackBaseUrl,
      secret: GATEWAY_SECRET,
      now: clock,
      // Staging-only generous budget: Neon compute may cold-start after autosuspend.
      timeoutMs: GATEWAY_TIMEOUT_MS,
    });

    apiHandler = createApiHandler({
      pool: apiPool,
      accounts,
      coreGateway,
      access,
      nativeAudiences: ['mega-ios', 'mega-android'],
      queue: coreGateway,
      now: clock,
      otpSecret: OTP_SECRET,
      allowedOrigins: ['https://megaxo.online', 'https://play.antimatterinnovations.com', loopbackBaseUrl],
    });

    logStep('4_start_loopback_server', 'PASSED', { port: serverPort });

    // Verify static serving
    const staticRes = await requestHttp(`${loopbackBaseUrl}/`);
    if (staticRes.status !== 200 || !staticRes.body.includes('mx-web-shell')) {
      throw new Error(`STATIC_PAGE_FETCH_FAILED: status ${staticRes.status}`);
    }
    logStep('4b_static_web_serving', 'PASSED');

    // =========================================================================
    // Phase 5: Seed Distinct Synthetic Actors
    // =========================================================================
    actorA = `p21_smoke_${runId}_alice`;
    actorB = `p21_smoke_${runId}_bob`;
    const pastDate = new Date(Date.now() - 86400000).toISOString();

    for (const act of [actorA, actorB]) {
      // apiPool inserts identity
      await apiPool.query(
        'INSERT INTO identity.actors (actor_id, region, wealth_public, created_at) VALUES ($1, $2, false, $3)',
        [act, JSON.stringify('Test'), pastDate]
      );
      ownedActors.add(act);
      await apiPool.query(
        'INSERT INTO identity.eligibility (actor_id, verified, suspended, security_hold) VALUES ($1, true, false, false)',
        [act]
      );
      await apiPool.query(
        'INSERT INTO identity.session_generations (actor_id, generation, updated_at) VALUES ($1, 1, $2)',
        [act, new Date(clock())]
      );
      const uname = `u_${runId.slice(0, 6)}_${act === actorA ? 'a' : 'b'}`.toLowerCase();
      await apiPool.query(
        'INSERT INTO identity.profiles (actor_id, tag, username, display_name, created_at, stats_visibility) VALUES ($1, $2, $3, $4, $5, $6)',
        [act, tagFor(act), uname, `Smoke ${act === actorA ? 'Alice' : 'Bob'} ${runId.slice(0, 8)}`, pastDate, 'public']
      );
      // corePool inserts economy
      await corePool.query(
        'INSERT INTO economy.wallets (actor_id, coins, crowns) VALUES ($1, $2, $3)',
        [act, 1000, 100]
      );
      await corePool.query(
        'INSERT INTO economy.ratings (actor_id, rating, peak, casual_rating, games, tier) VALUES ($1, $2, $2, $2, $3, $4)',
        [act, 1500, 10, 'gold']
      );
      await corePool.query(
        'INSERT INTO economy.ledger (entry_id, actor_id, currency, amount, reason, source, at) VALUES ($1, $2, \'coins\', $3, \'Opening balance\', \'provisioning\', $4)',
        [`open:${act}:${runId}`, act, 1000, pastDate]
      );
    }

    logStep('5_seed_synthetic_actors', 'PASSED', { actorCount: 2 });

    // =========================================================================
    // Phase 6: Principal Distinction & Session Identity Cross-Clients
    // =========================================================================
    // 6.1 Browser Session
    const browserA = createBrowserAuthHarness({
      apiBaseUrl: loopbackBaseUrl,
      origin: 'https://megaxo.online',
    });
    const authA = await browserA.loginAs(actorA, accounts);
    sessA = authA.session;
    if (!sessA?.token || !sessA.csrf) throw new Error('REAL_BROWSER_SESSION_REQUIRED');
    const sessionIdA = (await accounts.sessions(sessA.token)).find((session) => session.current)?.id;
    ownedSessionIds.add(sessionIdA);
    if (!sessionIdA) throw new Error('CANONICAL_SESSION_ID_REQUIRED');

    const profBrowser = await browserA.getProfile();
    if (profBrowser.status !== 200 || (profBrowser.id !== actorA && profBrowser.data?.id !== actorA)) {
      throw new Error(`BROWSER_PROFILE_MISMATCH: expected ${actorA}, status ${profBrowser.status}`);
    }

    // 6.2 Real P05 JWT bound to a DISTINCT durable native session/family/device, same permanent actor.
    const nativeSession = await accounts.issue(actorA, clock());
    const nativeSessionId = (await accounts.sessions(nativeSession.token)).find((session) => session.current)?.id;
    if (!nativeSessionId) throw new Error('CANONICAL_NATIVE_SESSION_REQUIRED');
    ownedSessionIds.add(nativeSessionId);
    nativeGrants.set(nativeSessionId, { actor: actorA, authAt: nativeSession.authAt });
    const deviceId = `p21_android_${runId}`;
    await refresh.registerDevice({ actor: actorA, platform: 'android', deviceId });
    const nativeFamily = await refresh.startFamily({ actor: actorA, sessionId: nativeSessionId, deviceId });
    const nativeGrant = await refresh.rotate({ refreshSecret: nativeFamily.refreshSecret });
    const nativeToken = nativeGrant.accessToken;
    const nativeRes = await requestHttp(`${loopbackBaseUrl}/api/account/profile`, {
      headers: { Authorization: `Bearer ${nativeToken}` },
    });
    logStep('6_native_p05_jwt_profile', nativeRes.status === 200 && nativeRes.data?.id === actorA ? 'PASSED' : 'FAILED', {
      status: nativeRes.status,
      note: 'Real P05 JWT against actual API resolver, without mapping it to a browser credential.',
    });
    const verifiedJwt = await access.verify(nativeToken, { audience: 'mega-android' });
    if (verifiedJwt.sub !== actorA || verifiedJwt.sid !== nativeSessionId || verifiedJwt.gen !== 1) throw new Error('P05_ACCESS_CLAIMS_MISMATCH');
    logStep('6_p05_access_signature_and_durable_native_family', 'PASSED', { physicalNativeHostAcceptance: false });

    // 6.3 Ambiguous Credentials Rejection (Cookie + Bearer together)
    const hybridRes = await requestHttp(`${loopbackBaseUrl}/api/account/profile`, {
      headers: {
        'Cookie': `mega_dev_session=${sessA.token}`,
        'Authorization': `Bearer ${nativeToken}`,
      },
    });
    if (hybridRes.status !== 401 || hybridRes.data.error !== 'AMBIGUOUS_CREDENTIAL') {
      throw new Error(`AMBIGUOUS_CREDENTIAL_FAILED: status ${hybridRes.status}, error: ${hybridRes.data?.error}`);
    }
    // 6.4 CSRF Origin Enforcement (Mutating POST with illegal origin)
    const csrfTamperedRes = await requestHttp(`${loopbackBaseUrl}/api/account/profile`, {
      method: 'POST',
      headers: {
        'Cookie': `mega_dev_session=${sessA.token}`,
        'X-CSRF-Token': sessA.csrf,
        'Origin': 'https://attacker.evil.com',
      },
      body: { displayName: 'Hacked' },
    });
    if (csrfTamperedRes.status !== 403) {
      throw new Error(`CSRF_PROTECTION_FAILED: expected 403, got ${csrfTamperedRes.status}`);
    }

    logStep('6_principal_distinction_and_csrf', 'PASSED');

    // =========================================================================
    // Phase 7: Protected Profile Read & Update
    // =========================================================================
    const updatedName = `Alice Smoke ${runId.slice(0, 8)}`;
    const updateRes = await browserA.updateProfile({ displayName: updatedName, avatar: 'crown' });
    if (updateRes.status !== 200) {
      throw new Error('PROFILE_UPDATE_FAILED');
    }
    // Read back through /api/account/profile and /api/v1/profile
    const readBack = await browserA.getProfile();
    if (readBack.displayName !== updatedName && readBack.data?.displayName !== updatedName) {
      throw new Error('PROFILE_READBACK_MISMATCH');
    }

    const legacyProfileRes = await requestHttp(`${loopbackBaseUrl}/api/v1/profile`, {
      headers: {
        'Cookie': `mega_dev_session=${sessA.token}`,
      },
    });
    if (legacyProfileRes.status !== 200 || legacyProfileRes.data.displayName !== updatedName) {
      throw new Error(`LEGACY_PROFILE_MISMATCH: status ${legacyProfileRes.status}`);
    }

    logStep('7_protected_profile_read_update', 'PASSED');

    // =========================================================================
    // Phase 8: Economic Reads vs Core-Only Writes (Least Privilege 42501)
    // =========================================================================
    // 8.1 Attempt direct write to economy.wallets from apiPool -> MUST throw 42501
    let apiWriteDenied = false;
    try {
      await apiPool.query('UPDATE economy.wallets SET coins = coins + 50 WHERE actor_id = $1', [actorA]);
    } catch (e) {
      if (e.code === '42501') {
        apiWriteDenied = true;
      }
    }
    if (!apiWriteDenied) {
      throw new Error('LEAST_PRIVILEGE_BREACH: api_runtime was able to write economy.wallets!');
    }

    // 8.2 Authorized Core Transaction via Core Gateway (/api/v1/convert)
    const opKeyConvert = `op_convert_${runId}_1`;
    const convertRes = await requestHttp(`${loopbackBaseUrl}/api/v1/convert`, {
      method: 'POST',
      headers: {
        'Cookie': `mega_dev_session=${sessA.token}`,
        'X-CSRF-Token': sessA.csrf,
        'Origin': 'https://megaxo.online',
        'Idempotency-Key': opKeyConvert,
      },
      body: { from: 'coins', amount: 100 },
    });
    if (convertRes.status !== 200) {
      throw Object.assign(new Error('CORE_CONVERT_FAILED'), {
        status: convertRes.status, serviceCode: safeError({ message: convertRes.data?.error }),
      });
    }

    // 8.3 Verify updated wallet in PostgreSQL and via /api/v1/profile
    const walletQuery = await corePool.query('SELECT coins, crowns FROM economy.wallets WHERE actor_id = $1', [actorA]);
    const walletRow = walletQuery.rows[0];
    if (Number(walletRow.coins) !== 900 || Number(walletRow.crowns) !== 101) {
      throw new Error(`WALLET_BALANCE_UNEXPECTED: coins ${walletRow.coins}, crowns ${walletRow.crowns}`);
    }

    const legacyProfAfter = await requestHttp(`${loopbackBaseUrl}/api/v1/profile`, {
      headers: {
        'Cookie': `mega_dev_session=${sessA.token}`,
      },
    });
    if (legacyProfAfter.data.wallet.coins !== 900 || legacyProfAfter.data.wallet.crowns !== 101) {
      throw new Error('ECONOMIC_READ_PROJECTION_MISMATCH');
    }

    logStep('8_economic_reads_core_writes_privilege', 'PASSED');

    // =========================================================================
    // Phase 9: Rank & Leaderboard
    // =========================================================================
    const leaderboardRes = await requestHttp(`${loopbackBaseUrl}/api/v1/leaderboard`, {
      headers: { Cookie: `mega_dev_session=${sessA.token}` },
    });
    if (leaderboardRes.status !== 200 || !Array.isArray(leaderboardRes.data) ||
        ![actorA, actorB].every((actor) => leaderboardRes.data.some((entry) => (entry.id || entry.actorId || entry.actor) === actor && Number(entry.rating ?? entry.value) === 1500))) {
      throw new Error('LEADERBOARD_SYNTHETIC_RANK_PROJECTION_FAILED');
    }
    if (Number(profBrowser.data?.rating ?? profBrowser.rating) !== 1500) throw new Error('PROTECTED_RANK_MISMATCH');
    logStep('9_rank_leaderboard', 'PASSED', { entriesCount: leaderboardRes.data.length });

    // =========================================================================
    // Phase 10: Friends & Social Graph
    // =========================================================================
    const browserB = createBrowserAuthHarness({
      apiBaseUrl: loopbackBaseUrl,
      origin: 'https://megaxo.online',
    });
    const authB = await browserB.loginAs(actorB, accounts);
    sessB = authB.session;
    if (!sessB?.token || !sessB.csrf) throw new Error('REAL_SECOND_SESSION_REQUIRED');
    const sessionIdB = (await accounts.sessions(sessB.token)).find((session) => session.current)?.id;
    if (!sessionIdB) throw new Error('CANONICAL_SECOND_SESSION_REQUIRED');
    ownedSessionIds.add(sessionIdB);

    // Actor A requests Actor B
    const friendReqRes = await requestHttp(`${loopbackBaseUrl}/api/community/friend`, {
      method: 'POST',
      headers: {
        'Cookie': `mega_dev_session=${sessA.token}`,
        'X-CSRF-Token': sessA.csrf,
        'Origin': 'https://megaxo.online',
      },
      body: { action: 'request', target: actorB },
    });
    if (friendReqRes.status !== 200) {
      throw new Error(`FRIEND_REQUEST_FAILED: status ${friendReqRes.status}`);
    }

    // Actor B accepts Actor A
    const friendAccRes = await requestHttp(`${loopbackBaseUrl}/api/community/friend`, {
      method: 'POST',
      headers: {
        'Cookie': `mega_dev_session=${sessB.token}`,
        'X-CSRF-Token': sessB.csrf,
        'Origin': 'https://megaxo.online',
      },
      body: { action: 'accept', target: actorA },
    });
    if (friendAccRes.status !== 200) {
      throw new Error(`FRIEND_ACCEPT_FAILED: status ${friendAccRes.status}`);
    }

    // Verify symmetric friendship in /api/community/friends
    const friendsListA = await requestHttp(`${loopbackBaseUrl}/api/community/friends`, {
      headers: { 'Cookie': `mega_dev_session=${sessA.token}` },
    });
    const friendsListB = await requestHttp(`${loopbackBaseUrl}/api/community/friends`, {
      headers: { 'Cookie': `mega_dev_session=${sessB.token}` },
    });

    const isFriendInA = (friendsListA.data?.friends || []).some((f) => f.id === actorB || f.actor === actorB);
    const isFriendInB = (friendsListB.data?.friends || []).some((f) => f.id === actorA || f.actor === actorA);
    if (friendsListA.status !== 200 || friendsListB.status !== 200 || !isFriendInA || !isFriendInB) {
      throw new Error('FRIENDSHIP_SYMMETRY_NOT_CONFIRMED');
    }

    logStep('10_friends_social_graph', 'PASSED');
    const nativeWalletRank = await requestHttp(`${loopbackBaseUrl}/api/v1/profile`, {
      headers: { Authorization: `Bearer ${nativeToken}`, 'X-Actor-ID': actorB },
    });
    logStep('10_native_protected_wallet_rank_and_actor_fencing',
      nativeWalletRank.status === 200 && nativeWalletRank.data?.id === actorA &&
      nativeWalletRank.data?.displayName === updatedName &&
      nativeWalletRank.data?.wallet?.coins === 900 && nativeWalletRank.data?.wallet?.crowns === 101 &&
      Number(nativeWalletRank.data?.rating) === 1500 ? 'PASSED' : 'FAILED',
      { status: nativeWalletRank.status });
    const nativeFriends = await requestHttp(`${loopbackBaseUrl}/api/community/friends`, {
      headers: { Authorization: `Bearer ${nativeToken}` },
    });
    logStep('10_native_protected_friends',
      nativeFriends.status === 200 && nativeFriends.data?.friends?.some((friend) => friend.id === actorB) ? 'PASSED' : 'FAILED',
      { status: nativeFriends.status });
    const nativeLeaderboard = await requestHttp(`${loopbackBaseUrl}/api/v1/leaderboard`, {
      headers: { Authorization: `Bearer ${nativeToken}` },
    });
    logStep('10_native_leaderboard_projection',
      nativeLeaderboard.status === 200 && Array.isArray(nativeLeaderboard.data) &&
      nativeLeaderboard.data.some((entry) => entry.id === actorA && Number(entry.rating) === 1500) ? 'PASSED' : 'FAILED',
      { status: nativeLeaderboard.status });

    // =========================================================================
    // Phase 11: Matchmaking Queue (2 Actors)
    // =========================================================================
    // Native admission/cancellation must independently traverse actual Bearer API + signed Core ingress.
    const nativeAdmission = await requestHttp(`${loopbackBaseUrl}/api/v1/queue`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${nativeToken}`, 'Idempotency-Key': `q_native_join_${runId}` },
      body: { mode: 'casual', region: 'us-east', latencyMs: 20 },
    });
    logStep('11_native_http_queue_admission',
      nativeAdmission.status === 200 && nativeAdmission.data?.state === 'searching' ? 'PASSED' : 'FAILED',
      { status: nativeAdmission.status });
    const nativeSearching = await requestHttp(`${loopbackBaseUrl}/api/v1/queue`, {
      headers: { Authorization: `Bearer ${nativeToken}` },
    });
    logStep('11_native_http_queue_searching_status',
      nativeSearching.status === 200 && nativeSearching.data?.state === 'searching' ? 'PASSED' : 'FAILED',
      { status: nativeSearching.status });
    const nativeCancellation = await requestHttp(`${loopbackBaseUrl}/api/v1/cancel-queue`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${nativeToken}`, 'Idempotency-Key': `q_native_cancel_${runId}` },
      body: {},
    });
    logStep('11_native_http_queue_cancellation',
      nativeCancellation.status === 200 && nativeCancellation.data?.state === 'cancelled' ? 'PASSED' : 'FAILED',
      { status: nativeCancellation.status });
    const nativeIdle = await requestHttp(`${loopbackBaseUrl}/api/v1/queue`, {
      headers: { Authorization: `Bearer ${nativeToken}` },
    });
    logStep('11_native_http_queue_idle_after_cancellation',
      nativeIdle.status === 200 && nativeIdle.data?.state === 'idle' ? 'PASSED' : 'FAILED',
      { status: nativeIdle.status });
    for (const [actor, session, opKey, latencyMs] of [
      [actorA, sessA, `q_a_${runId}`, 20], [actorB, sessB, `q_b_${runId}`, 22],
    ]) {
      const admission = await requestHttp(`${loopbackBaseUrl}/api/v1/queue`, {
        method: 'POST',
        headers: { Cookie: `mega_dev_session=${session.token}`, 'X-CSRF-Token': session.csrf, Origin: 'https://megaxo.online', 'Idempotency-Key': opKey },
        body: { mode: 'casual', region: 'us-east', latencyMs },
      });
      const admitted = admission.status === 200 && admission.data?.state === 'searching';
      logStep(`11_advertised_http_queue_admission_${actor === actorA ? 'a' : 'b'}`, admitted ? 'PASSED' : 'FAILED', {
        status: admission.status, ...(admission.data?.error ? { code: safeError({ message: admission.data.error }) } : {}),
      });
      // A failed advertised route remains FAILED; separately exercise the actual queue worker boundary.
      if (!admitted) await queue.join({ actor, mode: 'casual', opKey, region: 'us-east', latencyMs });
    }
    for (const actor of [actorA, actorB]) {
      if ((await queue.status(actor)).state !== 'searching') throw new Error('QUEUE_SEARCHING_REQUIRED');
    }
    const existingMatch = await ownerClient.query('SELECT 1 FROM match.matches WHERE match_id = $1', [queueMatchId]);
    const existingOperation = await ownerClient.query('SELECT 1 FROM economy.command_outcomes WHERE actor_id = $1 AND "key" = $2', ['matchmaker', JSON.stringify(queueOperation)]);
    if (existingMatch.rowCount || existingOperation.rowCount) throw new Error('SYNTHETIC_MATCH_ID_COLLISION');
    ownedMatches.add(queueMatchId);
    const tickResult = await queue.matchTick({
      mode: 'casual', matcherId: `matcher_${runId}`, limit: 2, now: clock, makeId: () => `p21_${runId}`,
    });
    if (tickResult.matched !== 1 || tickResult.pairings.length !== 1 ||
        tickResult.pairings[0].matchId !== queueMatchId ||
        ![tickResult.pairings[0].a, tickResult.pairings[0].b].every((actor) => ownedActors.has(actor))) throw new Error('MATCHMAKING_PAIRING_FAILED');
    for (const session of [sessA, sessB]) {
      const status = await requestHttp(`${loopbackBaseUrl}/api/v1/queue`, { headers: { Cookie: `mega_dev_session=${session.token}` } });
      if (status.status !== 200 || status.data?.state !== 'matched' || status.data?.matchId !== queueMatchId) throw new Error('API_QUEUE_MATCHED_PROJECTION_FAILED');
    }
    logStep('11_actual_queue_service_and_api_status', 'PASSED');

    // =========================================================================
    // Phase 12: Realtime Ticket, Committed Moves & HTTP Fallback
    // =========================================================================
    const matchId = queueMatchId;
    const pairing = tickResult.pairings[0];
    for (const [actor, session] of [[actorA, sessA], [actorB, sessB]]) {
      const accepted = await requestHttp(`${loopbackBaseUrl}/api/v1/accept`, {
        method: 'POST',
        headers: { Cookie: `mega_dev_session=${session.token}`, 'X-CSRF-Token': session.csrf, Origin: 'https://megaxo.online', 'Idempotency-Key': `accept_${actor}_${runId}` },
        body: { id: matchId, termsHash: pairing.termsHash },
      });
      if (accepted.status !== 200) throw new Error('QUEUE_ACCEPT_GATEWAY_FAILED');
    }
    const matchView = await core.readMatch(actorA, matchId);
    if (matchView.status !== 'PLAYING' || matchView.revision !== 0) throw new Error('QUEUE_MATCH_NOT_PLAYING');
    const sessionByActor = new Map([[actorA, sessA], [actorB, sessB]]);
    const issueWireTicket = async (actor, native = false) => {
      const session = sessionByActor.get(actor);
      const response = await requestHttp(`${loopbackBaseUrl}/api/v1/ticket`, {
        method: 'POST',
        headers: native
          ? { Authorization: `Bearer ${nativeToken}` }
          : { Cookie: `mega_dev_session=${session.token}`, 'X-CSRF-Token': session.csrf, Origin: 'https://megaxo.online' },
        body: { matchScope: matchId },
      });
      if (response.status !== 200 || typeof response.data?.ticket !== 'string') throw new Error('GATEWAY_REALTIME_TICKET_FAILED');
      return response.data.ticket;
    };
    const nativeObserver = await openRealtime(loopbackBaseUrl.replace('http:', 'ws:') + '/realtime/v1', sockets);
    const nativeTicket = await issueWireTicket(actorA, true);
    nativeObserver.send({ operation: 'ticket.redeem', ticket: nativeTicket });
    await nativeObserver.next((frame) => frame.operation === 'ack' && frame.ack_revision === 0);
    const nativeTicketRow = (await apiPool.query(
      'SELECT actor_id, session_id, generation, connection_class, environment, audience, match_scope, redeemed_at FROM identity.realtime_tickets WHERE ticket_hash = $1',
      [crypto.createHash('sha256').update(nativeTicket).digest('hex')]
    )).rows[0];
    if (nativeTicketRow?.actor_id !== actorA || nativeTicketRow.session_id !== nativeSessionId ||
        Number(nativeTicketRow.generation) !== 1 || nativeTicketRow.connection_class !== 'android' ||
        nativeTicketRow.environment !== 'stg' || nativeTicketRow.audience !== 'mega-core' ||
        nativeTicketRow.match_scope !== matchId || !nativeTicketRow.redeemed_at) throw new Error('NATIVE_TICKET_DURABLE_AUTHORITY_BINDING_FAILED');
    nativeObserver.send({ operation: 'subscribe', match_id: matchId });
    await nativeObserver.next((frame) => frame.operation === 'snapshot' && frame.expected_revision === 0);
    logStep('12_native_bearer_ticket_public_session_generation_and_wire_redemption', 'PASSED');
    const mover = matchView.symbols.X;
    if (!ownedActors.has(mover)) throw new Error('MATCH_SYMBOL_ACTOR_MISMATCH');
    const wire = await openRealtime(loopbackBaseUrl.replace('http:', 'ws:') + '/realtime/v1', sockets);
    const ticket = await issueWireTicket(mover);
    wire.send({ operation: 'ticket.redeem', ticket });
    await wire.next((frame) => frame.operation === 'ack' && frame.ack_revision === 0);
    let replayRejected = false;
    try {
      await redeemRealtimeTicket(corePool, { ticket, connectionId: `replay_${runId}`, node: 'smoke', now: clock, environment: 'stg', audience: 'mega-core' });
    } catch (error) { replayRejected = error.message === 'TICKET_REDEEMED'; }
    if (!replayRejected) throw new Error('TICKET_REPLAY_REJECTION_FAILED');
    wire.send({ operation: 'subscribe', match_id: matchId });
    await wire.next((frame) => frame.operation === 'snapshot' && frame.expected_revision === 0);
    const operationId = `move_${runId}`;
    wire.send({ operation: 'command', operation_id: operationId, match_id: matchId, expected_revision: 0, command: { type: 'move', move: { b: 0, c: 0 } } });
    await wire.next((frame) => frame.operation === 'ack' && frame.ack_revision === 1);
    const committed = await wire.next((frame) => frame.operation === 'snapshot' && frame.expected_revision === 1);
    const durable = await corePool.query('SELECT revision FROM match.matches WHERE match_id = $1', [matchId]);
    const outcomes = await corePool.query('SELECT 1 FROM match.move_outcomes WHERE match_id = $1 AND "key" = $2', [matchId, operationId]);
    if (Number(durable.rows[0]?.revision) !== 1 || outcomes.rowCount !== 1 || committed.snapshot?.state?.moves?.length !== 1) throw new Error('COMMITTED_WIRE_MOVE_NOT_DURABLE');
    const nativeObserved = await nativeObserver.next((frame) => frame.operation === 'snapshot' && frame.expected_revision === 1);
    if (nativeObserved.snapshot?.state?.moves?.length !== 1) throw new Error('NATIVE_REALTIME_COMMITTED_MOVE_FANOUT_FAILED');
    nativeObserver.socket.close();
    wire.socket.close();
    const reconnect = await openRealtime(loopbackBaseUrl.replace('http:', 'ws:') + '/realtime/v1', sockets);
    reconnect.send({ operation: 'ticket.redeem', ticket: await issueWireTicket(mover) });
    await reconnect.next((frame) => frame.operation === 'ack');
    reconnect.send({ operation: 'resume', match_id: matchId, ack_revision: 0 });
    const recovered = await reconnect.next((frame) => ['delta', 'snapshot'].includes(frame.operation) && frame.expected_revision === 1);
    if (recovered.operation === 'delta' && recovered.delta?.moves?.length !== 1) throw new Error('REALTIME_RECONNECT_MOVE_MISMATCH');
    reconnect.socket.close();

    // 12.3 Reconnect & HTTP Snapshot Fallback
    const snapRes = await requestHttp(`${loopbackBaseUrl}/realtime/v1/snapshot?match_id=${matchId}&actor=${actorA}`, {
      headers: {
        'Cookie': `mega_dev_session=${sessA.token}`,
      },
    });
    if (snapRes.status !== 200 || snapRes.data.expected_revision !== 1) {
      throw new Error(`HTTP_SNAPSHOT_FALLBACK_FAILED: status ${snapRes.status}`);
    }

    // Unauthenticated snapshot read MUST fail with 401 AUTH_REQUIRED
    const snapAnon = await requestHttp(`${loopbackBaseUrl}/realtime/v1/snapshot?match_id=${matchId}&actor=${actorA}`);
    if (snapAnon.status !== 401) {
      throw new Error(`UNAUTHENTICATED_SNAPSHOT_NOT_REJECTED: status ${snapAnon.status}`);
    }
    const actorSpoof = await requestHttp(`${loopbackBaseUrl}/realtime/v1/snapshot?match_id=${matchId}&actor=${actorB}`, {
      headers: { Cookie: `mega_dev_session=${sessA.token}` },
    });
    if (actorSpoof.status !== 403) throw new Error('REALTIME_ACTOR_FENCING_FAILED');
    const nativeSnapshot = await requestHttp(`${loopbackBaseUrl}/realtime/v1/snapshot?match_id=${matchId}`, {
      headers: { Authorization: `Bearer ${nativeToken}` },
    });
    logStep('12_native_authenticated_http_snapshot',
      nativeSnapshot.status === 200 && nativeSnapshot.data?.expected_revision === 1 ? 'PASSED' : 'FAILED',
      { status: nativeSnapshot.status });

    logStep('12_realtime_ticket_move_snapshot_fallback', 'PASSED');

    // =========================================================================
    // Phase 13: Actor Fencing & Logout Revocation
    // =========================================================================
    const logoutRes = await requestHttp(`${loopbackBaseUrl}/api/account/logout`, {
      method: 'POST',
      headers: {
        'Cookie': `mega_dev_session=${sessA.token}`,
        'X-CSRF-Token': sessA.csrf,
        'Origin': 'https://megaxo.online',
      },
      body: {},
    });
    const httpLogoutPassed = logoutRes.status === 200 && logoutRes.data?.signedOut === true;
    logStep('13_advertised_http_logout', httpLogoutPassed ? 'PASSED' : 'FAILED', {
      status: logoutRes.status, code: safeError({ message: logoutRes.data?.error }),
    });
    if (!httpLogoutPassed) {
      const serviceLogout = await accounts.logout(sessA.token, false);
      if (serviceLogout.signedOut !== true) throw new Error('SERVICE_LOGOUT_FAILED');
    }

    // Verify subsequent protected request with that cookie fails with 401
    const postLogoutReq = await requestHttp(`${loopbackBaseUrl}/api/account/profile`, {
      headers: {
        'Cookie': `mega_dev_session=${sessA.token}`,
      },
    });
    if (postLogoutReq.status !== 401) {
      throw new Error(`LOGOUT_REVOCATION_NOT_ENFORCED: status ${postLogoutReq.status}`);
    }

    logStep('13_service_logout_and_cookie_revocation', 'PASSED', { advertisedHttpLogoutPassed: httpLogoutPassed });
    const nativeAfterBrowserLogout = await requestHttp(`${loopbackBaseUrl}/api/account/profile`, {
      headers: { Authorization: `Bearer ${nativeToken}` },
    });
    logStep('13_distinct_native_session_survives_browser_logout',
      nativeAfterBrowserLogout.status === 200 && nativeAfterBrowserLogout.data?.id === actorA ? 'PASSED' : 'FAILED',
      { status: nativeAfterBrowserLogout.status });
    const nativeLogout = await requestHttp(`${loopbackBaseUrl}/api/account/logout`, {
      method: 'POST', headers: { Authorization: `Bearer ${nativeToken}` }, body: {},
    });
    logStep('13_native_bearer_http_logout',
      nativeLogout.status === 200 && nativeLogout.data?.signedOut === true && !nativeLogout.headers['set-cookie'] ? 'PASSED' : 'FAILED',
      { status: nativeLogout.status });
    const revokedNative = await requestHttp(`${loopbackBaseUrl}/api/account/profile`, {
      headers: { Authorization: `Bearer ${nativeToken}` },
    });
    const familyState = await apiPool.query('SELECT state FROM identity.refresh_families WHERE family_id = $1', [nativeFamily.familyId]);
    logStep('13_native_session_family_and_access_revocation',
      revokedNative.status === 401 && familyState.rows[0]?.state === 'revoked' ? 'PASSED' : 'FAILED',
      { status: revokedNative.status });

    // =========================================================================
    // Phase 14: Provider & Device Prerequisites Inventory
    // =========================================================================
    const commerce = await createCommerceService(corePool, { now: clock });
    try {
      const capability = await commerce.status(actorA);
      if (capability.purchasesAvailable !== false || capability.adMode !== 'off' ||
          capability.stores.length !== 0 || capability.adPlatforms.length !== 0 || capability.storeContext !== null) throw new Error('PROVIDER_DISABLED_CAPABILITY_MISMATCH');
      results.providerPrerequisites.commerce = {
        status: 'ACTUAL_SERVICE_DISABLED', purchasesAvailable: capability.purchasesAvailable,
        adMode: capability.adMode, stores: capability.stores, adPlatforms: capability.adPlatforms,
        sandboxPurchaseVerified: false, sandboxRestoreVerified: false, ssvVerified: false,
      };
    } finally { commerce.close(); }
    results.providerPrerequisites.identity = { google: 'NOT_CONFIGURED_IN_COMPOSITION', apple: 'NOT_CONFIGURED_IN_COMPOSITION', realProviderSignInVerified: false };
    results.providerPrerequisites.email = { status: 'OUTBOUND_DISABLED', deliveryVerified: false };
    results.providerPrerequisites.approval = { paidResources: 'NOT_AUTHORIZED', legal: 'NOT_VERIFIED', storeSandbox: 'NOT_EXERCISED', adsConsent: 'NOT_EXERCISED' };
    results.deviceInventory = { status: 'NOT_PROBED', physicalNativeHostAcceptance: false };
    logStep('14_actual_disabled_provider_capabilities', 'PASSED', { providerApproval: false, deviceAcceptance: false });

  } catch (err) {
    results.error = {
      message: safeError(err),
      ...(Number.isInteger(err.status) ? { status: err.status } : {}),
      ...(err.serviceCode ? { serviceCode: safeError({ message: err.serviceCode }) } : {}),
    };
    logStep('FAILURE_TERMINATION', 'FAILED', { error: safeError(err) });
  } finally {
    // Teardown connections cleanly
    for (const socket of sockets) { try { socket.close(); } catch {} }
    if (realtimeTransport) {
      try { await realtimeTransport.close(); } catch {}
    }
    if (loopbackServer) {
      try { await new Promise((r) => loopbackServer.close(r)); } catch {}
    }
    for (const service of serviceClosers) {
      try { await service.close(); } catch (error) { logStep('SERVICE_TEARDOWN', 'FAILED', { error: safeError(error) }); }
    }
    if (ownerClient && baselineCaptured) {
      try {
        results.preservation.settle = await settleCommands();
        await cleanup();
        results.preservation.final = await snapshotTables(ownerClient, tablesToProbe);
        for (const [name, value] of Object.entries(results.preservation.final)) results.finalRowCounts[name] = value.count;
        results.preservation.verified = JSON.stringify(results.preservation.baseline) === JSON.stringify(results.preservation.final);
        if (!results.preservation.verified) {
          // The only difference we may still remove is owned work that committed after the snapshot.
          // Settle again, delete owned rows AGAIN, and re-verify without widening the delete scope.
          results.preservation.settleAfter = await settleCommands();
          await cleanup();
          results.preservation.final = await snapshotTables(ownerClient, tablesToProbe);
          for (const [name, value] of Object.entries(results.preservation.final)) results.finalRowCounts[name] = value.count;
          results.preservation.verified = JSON.stringify(results.preservation.baseline) === JSON.stringify(results.preservation.final);
        }
        if (!results.preservation.verified) {
          results.preservation.residual = await residualReport();
          const unexplained = Object.values(results.preservation.residual).some((entry) => entry.unexplainedRows > 0);
          results.preservation.lateCommit = !unexplained;
          throw new Error(unexplained ? 'DATA_PRESERVATION_HASH_VIOLATION' : 'LATE_COMMIT_AFTER_CLEANUP');
        }
        logStep('15_owned_cleanup_and_all_table_hash_preservation', 'PASSED');
      } catch (error) {
        results.cleanupError = safeError(error);
        logStep('15_owned_cleanup_and_all_table_hash_preservation', 'FAILED', { error: safeError(error) });
      }
    }
    if (ephemera && ownedRedisNamespace) {
      try {
        const wiped = await ephemera.wipeNamespace();
        if (!wiped.available) throw new Error('OWNED_REDIS_CLEANUP_FAILED');
      } catch (error) { logStep('15_owned_redis_cleanup', 'FAILED', { error: safeError(error) }); }
    }
    if (ephemera) {
      try { await ephemera.close(); } catch {}
    }
    if (apiPool) {
      try { await apiPool.end(); } catch {}
    }
    if (corePool) {
      try { await corePool.end(); } catch {}
    }
    if (ownerClient) {
      try { await ownerClient.end(); } catch {}
    }
  }
  results.summary.passed = results.flows.filter((flow) => flow.status === 'PASSED').length;
  results.summary.failed = results.flows.filter((flow) => flow.status === 'FAILED').length;
  results.summary.total = results.flows.length;
  results.summary.durationMs = Date.now() - startTime;
  results.ok = results.summary.failed === 0 && results.preservation.verified;

  // Write artifact evidence
  const artifactDir = path.join(ROOT, '.artifacts', 'v51');
  if (!fs.existsSync(artifactDir)) {
    fs.mkdirSync(artifactDir, { recursive: true });
  }
  const artifactPath = path.join(artifactDir, 'p21-staging-smoke-result.json');
  fs.writeFileSync(artifactPath, JSON.stringify(results, null, 2), 'utf8');

  // Also write to .artifacts/p21-staging-smoke-result.json
  fs.writeFileSync(path.join(ROOT, '.artifacts', 'p21-staging-smoke-result.json'), JSON.stringify(results, null, 2), 'utf8');

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`\n=== P21 V5.1 STAGING SMOKE RESULT ===`);
    console.log(`Status: ${results.ok ? 'SUCCESS (PASS)' : 'FAILED'}`);
    console.log(`Target DB: ${results.target.database || 'unknown'}`);
    console.log(`Total Flows: ${results.summary.total}, Passed: ${results.summary.passed}, Failed: ${results.summary.failed}`);
    console.log(`Duration: ${results.summary.durationMs}ms`);
    console.log(`Evidence Artifact: ${artifactPath}`);
    if (!results.ok && results.error) {
      console.error(`Error: ${results.error.message}`);
    }
  }

  process.exit(results.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { main };
