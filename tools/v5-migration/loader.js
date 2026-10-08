'use strict';
/* tools/v5-migration/loader.js - V5 P03 (V5-03-03/05) deterministic model -> PostgreSQL importer.
 *
 * Input: the frozen reader model (tools/v5-migration/reader.js readSnapshot). Output: the durable
 * target families plus the v5_migration bookkeeping rows (run, target_guard, batch, row_ledger,
 * coverage). The source snapshot is never touched and no pooled runtime path is used: the caller
 * hands in a direct client (or a URL that goes through scripts/v5/migrate.js parseAndGuardUrl) and
 * every transaction assumes v5_owner exactly like scripts/v5/migrate.js:runMigration.
 *
 * Determinism contract (design section 3.5):
 *   - batches are fixed-size chunks of a kind's rows in canonical source-key order; `cursor` is the
 *     last committed canonical key, never an offset, so a resume re-derives the identical row set;
 *   - definition_hash = sha256(canon({kind, source_locator, filter, order_by, batchSize}));
 *   - a reused run id with a different source_fingerprint or extractor_release is refused;
 *   - an unknown target (no target_guard row) is refused unless the caller explicitly adopts it;
 *   - writes are INSERT ... ON CONFLICT DO NOTHING followed by a hash comparison against the
 *     existing row, so a previously committed row is verified, never overwritten;
 *   - row_hash / target_pk_hash are computed BY POSTGRES from its own stored row (to_jsonb), so a
 *     resumed run verifies the database's canonical rendering against the ledger it wrote;
 *   - no destructive statement exists anywhere in this module.
 *
 * Every value written is either a source value or one of a small, explicitly recorded set of
 * derived determinisms (the bookkeeping clocks, the singleton `updated_at`, the rate/burn/claim
 * defaults the target DDL itself declares, `store_notifications.next_at` = the source `received_at`
 * and `core.actor_occupancy.claimed_at` = the referenced aggregate's own `created`). They are
 * counted in `counters.derived`; nothing else is invented.
 */

const {hash, canonical} = require('./canonical.js');
const ledger = require('./ledger.js');
const {
  rowHash: ledgerRowHash, pkHash: ledgerPkHash, normalizeRow: ledgerNormalizeRow,
  locatorOf: ledgerLocatorOf, tableParts: ledgerTableParts
} = ledger;

const LOADER_VERSION = 1;
const DEFAULT_BATCH_SIZE = 500;
const HEX64 = /^[0-9a-f]{64}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/* Durable families in foreign-key-safe order. identity.actors is first because everything else
 * references it; match.matches precedes its children; tournament.rooms precedes its children;
 * monetization.reward_tickets precedes monetization.ad_ticket_context. */
const KIND_ORDER = [
  'identity.actors', 'identity.eligibility', 'identity.profiles', 'identity.identities',
  'identity.email_credentials', 'profile.profile_saves',
  'social.friendships', 'social.friend_requests', 'social.blocks', 'social.command_outcomes',
  'economy.wallets', 'economy.ratings', 'economy.wallet_operations', 'economy.wallet_ledger_entries',
  'economy.daily_progress', 'economy.season_state', 'economy.season_history',
  'economy.tournament_records', 'economy.match_history', 'economy.actor_legacy_extra',
  'economy.command_outcomes', 'core.actor_occupancy',
  'match.matches', 'match.participants', 'match.escrow_contributions', 'match.move_outcomes',
  'tournament.rooms', 'tournament.room_players', 'tournament.escrow_contributions',
  'tournament.fixtures', 'tournament.command_outcomes',
  'monetization.credits', 'monetization.redeemed_frames', 'monetization.boosts',
  'monetization.reward_daily', 'monetization.command_outcomes', 'monetization.reward_tickets',
  'monetization.casual_rewards', 'monetization.reward_events', 'monetization.ad_ticket_context',
  'monetization.receipts', 'monetization.store_bindings', 'monetization.store_revocations',
  'monetization.store_finalize', 'monetization.store_notifications',
  'cosmetics.owned_items', 'season.day_snapshots', 'season.league_week', 'season.weekly_payouts',
  'economy.system_burns', 'privacy.reports', 'privacy.requests', 'privacy.deletion_receipts',
  'support.events', 'audit.operator_audit', 'runtime.controls', 'runtime.state',
  'ops.rate_buckets#community_limits', 'ops.rate_buckets#v4_limits', 'ops.outbox',
  'economy.ledger'
];

/* Source tables whose rows are deliberately NOT materialised, with the recorded policy. Each still
 * gets one coverage row per source row (count + hash + policy), never a silent drop. */
const EPHEMERAL_TABLES = {
  account_sessions: {policy: 'expire', rule: 'ephemeral-expiry-policy'},
  signin_attempts: {policy: 'expire', rule: 'ephemeral-expiry-policy'},
  session_presence: {policy: 'rebuild', rule: 'ephemeral-rebuild-recorded'},
  email_challenges: {policy: 'expire', rule: 'ephemeral-expiry-policy'},
  v4_email_versions: {policy: 'expire', rule: 'ephemeral-expiry-policy'},
  party_guests: {policy: 'quarantine', rule: 'lan-guest-quarantine'}
};

/* Source tables that are recorded as provenance, never materialised: the source `v4_schema` rows
 * are migration-owner history and `meta.migrations` is explicitly NOT an import destination. */
const PROVENANCE_TABLES = {
  v4_schema: {
    rule: 'source-provenance-only',
    note: 'source schema history; recorded as provenance, never written as target history'
  }
};

/* Source tables projected into a destination family. */
const PROJECTED_TABLES = new Set([
  'state', 'commands', 'party_rooms', 'party_commands', 'profiles', 'identities',
  'email_credentials', 'profile_saves', 'social_operations', 'community_limits', 'v4_limits',
  'v41_reports', 'v41_privacy_requests', 'v41_deletion_receipts', 'v41_operator_audit',
  'v35_commands', 'v35_tickets', 'v35_casual', 'v35_events', 'v41_ad_ticket_context',
  'v41_store_bindings', 'v41_store_revocations', 'v41_store_finalize', 'v41_store_notifications',
  'v41_support_events', 'v4_controls', 'v4_runtime', 'v4_outbox'
]);

/* `name` (CommunityStore.ensureProfile) and `friendCode` are dropped as authoritative copies:
 * identity.profiles is canonical for tag/username/display name (design 5.4), verified by the
 * reconciliation pass. Every other account key has a destination column. */
const ACCOUNT_KEYS_DROPPED = new Set(['name', 'friendCode']);
const ACCOUNT_KEYS_CONSUMED = new Set([
  'id', 'name', 'friendCode', 'createdAt', 'region', 'wealthPublic', 'verified', 'suspended', 'hold',
  'coins', 'crowns', 'reservedCoins', 'reservedCrowns', 'purchasedCoins', 'purchasedCrowns',
  'purchaseInfluenced', 'legacyCompetitionRestricted',
  'rating', 'peak', 'casualRating', 'casualGames', 'games', 'tier', 'reachedAt', 'lastRatedAt',
  'friends', 'friendRequests', 'blocked', 'operations', 'ledger', 'activeMatch', 'daily', 'history',
  'season', 'seasonHistory', 'tournamentRecord', 'monetization', 'owned'
]);

const MATCH_MAPPED_KEYS = new Set(['id', 'players', 'terms', 'quote', 'termsHash', 'accepted',
  'created', 'expires', 'status', 'state', 'symbols', 'revision', 'commands', 'escrow', 'settled',
  'riskFlags', 'started', '_lastMoveAt', '_moveTimings', 'preRatings', 'preTiers', 'deadline',
  'receipt', '_riskActors', '_pendingReason']);
const ROOM_MAPPED_KEYS = new Set(['version', 'id', 'code', 'owner', 'name', 'format', 'table',
  'sequential', 'quote', 'clock', 'increment', 'capacity', 'rulesVersion', 'players', 'status',
  'created', 'expires', 'fixtures', 'groups', 'ranking', 'finalRefs', 'started', 'revision',
  'roundDelay', 'seed', 'deadline', 'ended', 'reason', 'pausedAt', 'drawGame', 'escrow', 'settled',
  'contributions', 'receipt', 'riskFlags', '_riskActors']);
const FIXTURE_MAPPED_KEYS = new Set(['id', 'slots', 'label', 'round', 'group', 'decisive', 'status',
  'players', 'ready', 'state', 'winner', 'attempt', 'mini', 'history', 'opens', 'expires',
  'readyDeadline', 'banks', 'turnAt', '_lastMoveAt', '_moveTimings', 'reason', 'finished']);

/* ------------------------------------------------------------------ helpers */

function fail(code, detail) {
  const error = new Error(detail ? code + ': ' + detail : code);
  error.code = code;
  error.detail = detail === undefined ? null : detail;
  return error;
}
function q(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
/* The canonical locator form for an INDEX/ORDINAL component: zero-padded to 6 digits, so a locator
 * is byte-identical between the loader and any independent reader (reconcile.js binds to the same
 * rule). Applied uniformly to every index-derived key part. */
function ordinalKey(index) { return String(index).padStart(6, '0'); }
function present(object, key) { return object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key); }
function pick(object, key, fallback) { return present(object, key) ? object[key] : fallback; }

/* Epoch milliseconds -> timestamptz text with full precision. An integral clock yields a plain ISO
 * string; a fractional clock (legal for the injected source clock) keeps microsecond precision
 * instead of being rounded through a JS Date. */
function timestamptz(ms, what) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw fail('TIMESTAMP_INVALID', what);
  const whole = Math.floor(ms / 1000);
  const date = new Date(whole * 1000);
  if (ms === whole * 1000) return date.toISOString();
  const micros = String(Math.round((ms - whole * 1000) * 1000)).padStart(6, '0');
  return date.toISOString().slice(0, 19) + '.' + micros + 'Z';
}
function timestamptzOrNull(ms, what) {
  return ms === null || ms === undefined ? null : timestamptz(ms, what);
}
/* JSONB-typed columns take the canonical text of the source value. */
function jsonColumn(value, what) {
  if (value === undefined) throw fail('JSON_VALUE_MISSING', what);
  return value === null ? null : canonical(value);
}
/* A JSON-typed column (0034) that accepts ANY JSON value: scalars keep their JSON literal, the two
 * container shapes take the canonical text. */
function jsonAny(value, what) {
  if (value === undefined) throw fail('JSON_VALUE_MISSING', what);
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  return canonical(value);
}
function textArray(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw fail('TEXT_ARRAY_INVALID', String(value));
  return value.map((item) => String(item));
}
function numericArray(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw fail('NUMERIC_ARRAY_INVALID', String(value));
  return value.map((item) => String(item));
}
function asBoolean(value) { return value === true || value === 1; }

/* ------------------------------------------------------------------ SQL builders */

function columnList(columns) { return columns.map(q).join(', '); }
function placeholderList(columns) { return columns.map((_, index) => '$' + (index + 1)).join(', '); }
/* The output column list, built through ledger.js's `selectExpression` so a `date` column is
 * rendered by SQL as 'YYYY-MM-DD' instead of the driver's local-midnight Date (which would make the
 * row hash depend on the session TimeZone). It covers EVERY destination column, so the Node-side
 * hash is computed over exactly the column set an independent reader hashes. */
function outputList(columns) {
  return columns.map((column) => `${ledger.selectExpression(column)}`).join(', ');
}
function pkWhere(pkColumns, alias, firstParam) {
  return pkColumns.map((column, index) => `${alias}.${q(column)} = $${firstParam + index}`).join(' AND ');
}

/* The row_hash / target_pk_hash are computed in NODE (ledger.js) from the stored row - never
 * Postgres-side from `to_jsonb(t)`, whose timestamptz rendering depends on the session TimeZone and
 * would make the same committed row hash differently under a different session. */
function insertSql(spec, columns) {
  return [
    `INSERT INTO ${spec.table} AS t (${columnList(spec.columns)})`,
    spec.overridingSystemValue ? 'OVERRIDING SYSTEM VALUE' : null,
    `VALUES (${placeholderList(spec.columns)})`,
    `ON CONFLICT (${columnList(spec.pk)}) ${spec.singleton
      ? 'DO UPDATE SET ' + spec.columns.map((column) => `${q(column)} = EXCLUDED.${q(column)}`).join(', ')
      : 'DO NOTHING'}`,
    `RETURNING ${outputList(columns)}`
  ].filter(Boolean).join('\n');
}
function selectSql(spec, columns) {
  return `SELECT ${outputList(columns)} FROM ${spec.table} AS t WHERE ${pkWhere(spec.pk, 't', 1)}`;
}
/* monetization.store_finalize carries no unique constraint in the frozen destination DDL (a real
 * finding: the source PK (store,transaction_id) has no target counterpart), so ON CONFLICT cannot
 * arbitrate. For that table the write is a row-scoped existence check plus the run's own
 * row_ledger, which is the same "verify, never overwrite" contract under the run's advisory lock. */
function insertPlainSql(spec, columns) {
  return `INSERT INTO ${spec.table} AS t (${columnList(spec.columns)}) VALUES (${placeholderList(spec.columns)}) `
    + `RETURNING ${outputList(columns)}`;
}

/* The destination column metadata (data_type/udt_name) ledger.js needs to normalize a row. Read once
 * per table from information_schema and cached: this is schema metadata, not row data. */
const columnMetadataCache = new Map();
async function columnMetadata(client, table) {
  if (columnMetadataCache.has(table)) return columnMetadataCache.get(table);
  const {schema, table: name} = ledgerTableParts(table);
  const columns = (await client.query(
    `SELECT column_name, data_type, udt_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, name])).rows;
  if (!columns.length) throw fail('TARGET_TABLE_MISSING', table);
  columnMetadataCache.set(table, columns);
  return columns;
}
/* Every column of the destination table, in ordinal order. The row hash MUST cover the same column
 * set an independent reader (ledger.readHashedTable, and therefore reconcile.js) hashes, otherwise
 * the ledger hash is a hash over a SUBSET and every comparison is a false mismatch. The loader
 * writes only `spec.columns`; the remaining columns take their frozen DDL defaults and are included
 * in the hash here exactly as the target stored them. */
async function specColumns(client, spec) {
  const metadata = await columnMetadata(client, spec.table);
  const present = new Set(metadata.map((column) => column.column_name));
  for (const name of spec.columns) {
    if (!present.has(name)) throw fail('TARGET_COLUMN_MISSING', spec.table + '.' + name);
  }
  return metadata;
}
function rowHashes(spec, columns, raw) {
  const row = {};
  for (const column of columns) row[column.column_name] = raw[column.column_name];
  return {
    row_hash: ledgerRowHash(columns, row),
    target_pk_hash: ledgerPkHash(spec.pk, ledgerNormalizeRow(columns, row))
  };
}

/* ------------------------------------------------------------------ plan */

const MATCH_COLUMNS = [
  'match_id', 'source', 'mode', 'kind', 'rated', 'amount', 'currency', 'turn_seconds', 'from_tier',
  'to_tier', 'terms_ratings', 'terms_json', 'terms_hash', 'quote_json', 'pool', 'contribution_a',
  'contribution_b', 'accepted_count', 'status', 'created_at', 'expires_at', 'state_json', 'revision',
  'symbol_x', 'symbol_y', 'escrow', 'settled', 'started_at', 'last_move_at', 'deadline',
  'move_timings', 'pre_ratings', 'pre_tiers', 'receipt_json', 'receipt_at', 'receipt_reason',
  'receipt_payout', 'receipt_burn', 'receipt_bonus', 'receipt_refunded', 'risk_flags', 'risk_actors',
  'extra'
];
const ROOM_COLUMNS = [
  'room_id', 'code', 'owner_id', 'name', 'format', 'table_kind', 'sequential', 'quote_json',
  'quote_currency', 'entry', 'pool', 'burn', 'clock_seconds', 'increment_seconds', 'capacity',
  'rules_version', 'status', 'created_at', 'expires_at', 'started_at', 'ended_at', 'deadline',
  'paused_at', 'reason', 'draw_game', 'revision', 'round_delay_ms', 'groups_json', 'final_refs_json',
  'seed_json', 'ranking', 'receipt_json', 'risk_flags', 'risk_actors', 'escrow', 'settled',
  'shape_version', 'extra'
];
const FIXTURE_COLUMNS = [
  'room_id', 'fixture_id', 'label', 'round', 'group_id', 'decisive', 'slots_json', 'players',
  'ready', 'status', 'state_json', 'mini_json', 'winner', 'attempt', 'opens_at', 'expires_at',
  'ready_deadline', 'turn_at', 'finished_at', 'banks_json', 'last_move_at', 'move_timings',
  'reason', 'history_json', 'revision', 'extra'
];

function accountEntries(ctx) { return ctx.parsed.accounts; }
function matchEntries(ctx) { return ctx.parsed.matches; }

function findRoom(ctx, roomId) {
  for (const room of ctx.model.rooms) if (String(room.id) === String(roomId)) return room.parsed;
  return null;
}

/* `id = JSON.stringify([actor,key])` (economy) is parsed and the actor column is verified to agree;
 * the logical key text is written ONCE, canonicalized as a JSON string (0034). */
function parseOperationPair(id, actorColumn, table) {
  let parsed;
  try { parsed = JSON.parse(String(id)); } catch { throw fail('OPERATION_ID_INVALID', table + ':' + String(id)); }
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
    throw fail('OPERATION_ID_INVALID', table + ':' + String(id));
  }
  if (actorColumn !== null && actorColumn !== undefined && parsed[0] !== actorColumn) {
    throw fail('OPERATION_ACTOR_MISMATCH', table + ':' + String(id));
  }
  return {actor: parsed[0], key: parsed[1]};
}

function matchValue(ctx, matchId, match) {
  const terms = match.terms || {};
  const quote = match.quote || {};
  const contributions = quote.contributions || [];
  const receipt = present(match, 'receipt') ? match.receipt : null;
  const symbols = present(match, 'symbols') ? match.symbols : null;
  const extra = {};
  for (const key of Object.keys(match)) if (!MATCH_MAPPED_KEYS.has(key)) extra[key] = match[key];
  /* receipt_reason is JSON-typed (0034): the source void flow stores strings, objects and null. */
  return {
    match_id: matchId,
    source: terms.source,
    mode: terms.mode,
    kind: JSON.stringify(terms.kind),
    rated: terms.rated === true,
    amount: pick(terms, 'amount', null),
    currency: pick(terms, 'currency', null),
    turn_seconds: pick(terms, 'turnSeconds', null),
    from_tier: pick(terms, 'from', null),
    to_tier: pick(terms, 'to', null),
    terms_ratings: numericArray(pick(terms, 'ratings', null)),
    terms_json: jsonColumn(terms, 'terms'),
    terms_hash: match.termsHash,
    quote_json: jsonColumn(quote, 'quote'),
    pool: pick(quote, 'pool', 0),
    contribution_a: contributions.length ? contributions[0] : 0,
    contribution_b: contributions.length > 1 ? contributions[1] : 0,
    accepted_count: (match.accepted || []).length,
    status: match.status,
    created_at: timestamptz(match.created, 'matches.created'),
    expires_at: timestamptz(match.expires, 'matches.expires'),
    state_json: jsonColumn(match.state, 'state'),
    revision: pick(match, 'revision', 0),
    symbol_x: symbols ? symbols.X : null,
    symbol_y: symbols ? symbols.O : null,
    escrow: pick(match, 'escrow', 0),
    settled: match.settled === true,
    started_at: timestamptzOrNull(pick(match, 'started', null), 'matches.started'),
    last_move_at: timestamptzOrNull(pick(match, '_lastMoveAt', null), 'matches._lastMoveAt'),
    deadline: timestamptzOrNull(pick(match, 'deadline', null), 'matches.deadline'),
    move_timings: jsonColumn(pick(match, '_moveTimings', null), 'matches._moveTimings'),
    pre_ratings: numericArray(pick(match, 'preRatings', null)),
    pre_tiers: textArray(pick(match, 'preTiers', null)),
    receipt_json: jsonColumn(receipt, 'matches.receipt'),
    receipt_at: receipt ? timestamptzOrNull(pick(receipt, 'at', null), 'receipt.at') : null,
    receipt_reason: receipt ? jsonAny(pick(receipt, 'reason', null), 'receipt.reason') : null,
    receipt_payout: receipt ? pick(receipt, 'payout', null) : null,
    receipt_burn: receipt ? pick(receipt, 'burn', null) : null,
    receipt_bonus: receipt ? pick(receipt, 'bonus', null) : null,
    receipt_refunded: receipt ? pick(receipt, 'refunded', null) : null,
    risk_flags: textArray(pick(match, 'riskFlags', null)) || [],
    risk_actors: jsonColumn(pick(match, '_riskActors', {}), 'matches._riskActors'),
    extra: Object.keys(extra).length ? jsonColumn(extra, 'matches.extra') : null
  };
}

function roomValues(ctx, room) {
  const parsed = room.parsed;
  const quote = present(parsed, 'quote') ? parsed.quote : null;
  const extra = {};
  for (const key of Object.keys(parsed)) if (!ROOM_MAPPED_KEYS.has(key)) extra[key] = parsed[key];
  return {
    room_id: String(parsed.id),
    code: parsed.code,
    owner_id: parsed.owner,
    name: parsed.name === undefined ? null : JSON.stringify(parsed.name),
    format: pick(parsed, 'format', null),
    table_kind: pick(parsed, 'table', null),
    sequential: parsed.sequential === true,
    quote_json: jsonColumn(quote, 'rooms.quote'),
    quote_currency: quote ? quote.currency : null,
    entry: quote ? quote.entry : null,
    pool: quote ? quote.pool : null,
    burn: quote ? quote.burn : null,
    clock_seconds: pick(parsed, 'clock', null),
    increment_seconds: pick(parsed, 'increment', null),
    capacity: pick(parsed, 'capacity', null),
    rules_version: pick(parsed, 'rulesVersion', null),
    status: parsed.status,
    created_at: timestamptz(parsed.created, 'rooms.created'),
    expires_at: timestamptzOrNull(pick(parsed, 'expires', null), 'rooms.expires'),
    started_at: timestamptzOrNull(pick(parsed, 'started', null), 'rooms.started'),
    ended_at: timestamptzOrNull(pick(parsed, 'ended', null), 'rooms.ended'),
    deadline: timestamptzOrNull(pick(parsed, 'deadline', null), 'rooms.deadline'),
    paused_at: timestamptzOrNull(pick(parsed, 'pausedAt', null), 'rooms.pausedAt'),
    reason: pick(parsed, 'reason', null),
    draw_game: pick(parsed, 'drawGame', null),
    revision: pick(parsed, 'revision', 0),
    round_delay_ms: pick(parsed, 'roundDelay', null),
    groups_json: jsonColumn(pick(parsed, 'groups', []), 'rooms.groups'),
    final_refs_json: jsonColumn(pick(parsed, 'finalRefs', null), 'rooms.finalRefs'),
    seed_json: jsonColumn(pick(parsed, 'seed', null), 'rooms.seed'),
    ranking: textArray(pick(parsed, 'ranking', null)) || [],
    receipt_json: jsonColumn(pick(parsed, 'receipt', null), 'rooms.receipt'),
    risk_flags: textArray(pick(parsed, 'riskFlags', null)) || [],
    risk_actors: jsonColumn(pick(parsed, '_riskActors', {}), 'rooms._riskActors'),
    escrow: pick(parsed, 'escrow', 0),
    settled: parsed.settled === true,
    /* 0031: per-room shape discriminator, verbatim. */
    shape_version: pick(parsed, 'version', null),
    extra: Object.keys(extra).length ? jsonColumn(extra, 'rooms.extra') : null
  };
}

function fixtureValues(room, fixture) {
  const extra = {};
  for (const key of Object.keys(fixture)) if (!FIXTURE_MAPPED_KEYS.has(key)) extra[key] = fixture[key];
  return {
    room_id: String(room.id),
    fixture_id: String(fixture.id),
    label: pick(fixture, 'label', null),
    round: pick(fixture, 'round', null),
    group_id: pick(fixture, 'group', null),
    decisive: fixture.decisive === true,
    slots_json: jsonColumn(fixture.slots, 'fixture.slots'),
    players: textArray(pick(fixture, 'players', null)) || [],
    ready: textArray(pick(fixture, 'ready', null)) || [],
    status: fixture.status,
    state_json: jsonColumn(pick(fixture, 'state', null), 'fixture.state'),
    mini_json: jsonColumn(pick(fixture, 'mini', null), 'fixture.mini'),
    winner: pick(fixture, 'winner', null),
    attempt: pick(fixture, 'attempt', null),
    opens_at: timestamptzOrNull(pick(fixture, 'opens', null), 'fixture.opens'),
    expires_at: timestamptzOrNull(pick(fixture, 'expires', null), 'fixture.expires'),
    ready_deadline: timestamptzOrNull(pick(fixture, 'readyDeadline', null), 'fixture.readyDeadline'),
    turn_at: timestamptzOrNull(pick(fixture, 'turnAt', null), 'fixture.turnAt'),
    finished_at: timestamptzOrNull(pick(fixture, 'finished', null), 'fixture.finished'),
    banks_json: jsonColumn(pick(fixture, 'banks', null), 'fixture.banks'),
    last_move_at: timestamptzOrNull(pick(fixture, '_lastMoveAt', null), 'fixture._lastMoveAt'),
    move_timings: jsonColumn(pick(fixture, '_moveTimings', null), 'fixture._moveTimings'),
    reason: pick(fixture, 'reason', null),
    history_json: jsonColumn(pick(fixture, 'history', null), 'fixture.history'),
    revision: 0,
    extra: Object.keys(extra).length ? jsonColumn(extra, 'fixture.extra') : null
  };
}

/* ------------------------------------------------------------------ plan construction */

function buildPlan(ctx) {
  const plan = [];
  const derived = ctx.derived;
  const note = (what) => { derived[what] = (derived[what] || 0) + 1; };

  function add(meta) {
    const columns = new Set(meta.columns);
    const rows = meta.rows.slice().sort((a, b) => cmp(a.key, b.key));
    const seenKey = new Set();
    for (const row of rows) {
      if (seenKey.has(row.key)) throw fail('LOADER_DUPLICATE_KEY', meta.table + ':' + row.key);
      seenKey.add(row.key);
      for (const column of meta.columns) {
        if (!present(row.values, column)) throw fail('LOADER_VALUE_MISSING', meta.table + '.' + column + ' for ' + row.key);
      }
      for (const key of Object.keys(row.values)) {
        if (!columns.has(key)) throw fail('LOADER_VALUE_UNKNOWN', meta.table + '.' + key + ' for ' + row.key);
      }
      for (const column of meta.pk) {
        const value = row.values[column];
        if (value === null || value === undefined) throw fail('LOADER_PK_NULL', meta.table + '.' + column + ' for ' + row.key);
      }
    }
    plan.push({...meta, rows});
  }

  const each = (values, builder) => {
    const rows = [];
    for (const value of values) {
      const built = builder(value);
      if (built) rows.push(built);
    }
    return rows;
  };

  /* ---- identity ---------------------------------------------------------- */

  add({
    kind: 'identity.actors', source: 'state.accounts', table: 'identity.actors', pk: ['actor_id'],
    columns: ['actor_id', 'region', 'wealth_public', 'created_at'],
    filter: 'every state.accounts entry', order: 'canonical(actor id)',
    rows: each(accountEntries(ctx), (pair) => {
      const account = pair[1];
      if (!present(account, 'region')) note('identity.actors.region');
      return {key: String(pair[0]), values: {
        actor_id: String(pair[0]),
        region: JSON.stringify(present(account, 'region') ? account.region : ''),
        wealth_public: account.wealthPublic === true,
        created_at: timestamptz(account.createdAt, 'createdAt')
      }};
    })
  });

  add({
    kind: 'identity.eligibility', source: 'state.accounts', table: 'identity.eligibility', pk: ['actor_id'],
    columns: ['actor_id', 'verified', 'suspended', 'security_hold'],
    filter: 'every state.accounts entry', order: 'canonical(actor id)',
    rows: each(accountEntries(ctx), (pair) => {
      const account = pair[1];
      return {key: String(pair[0]), values: {
        actor_id: String(pair[0]),
        verified: account.verified === true,
        suspended: account.suspended === true,
        security_hold: account.hold === true
      }};
    })
  });

  add({
    kind: 'identity.profiles', source: 'table:profiles', table: 'identity.profiles', pk: ['actor_id'],
    columns: ['actor_id', 'tag', 'username', 'display_name', 'avatar', 'stats_visibility', 'presence_visibility', 'created_at', 'username_changed', 'version'],
    filter: 'every profiles row', order: 'canonical(actor)',
    rows: each(ctx.model.tables.profiles.rows, (row) => {
      const v = row.values;
      return {key: String(v.actor), values: {
        actor_id: v.actor, tag: v.tag, username: v.username, display_name: v.display_name,
        avatar: v.avatar, stats_visibility: v.stats_visibility, presence_visibility: v.presence_visibility,
        created_at: timestamptz(v.created, 'profiles.created'),
        username_changed: timestamptzOrNull(v.username_changed, 'profiles.username_changed'),
        version: v.version
      }};
    })
  });

  add({
    kind: 'identity.identities', source: 'table:identities', table: 'identity.identities', pk: ['provider', 'subject'],
    columns: ['provider', 'subject', 'actor_id', 'created_at'],
    filter: 'every identities row', order: 'canonical(provider,subject)',
    rows: each(ctx.model.tables.identities.rows, (row) => {
      const v = row.values;
      return {key: v.provider + '\u001f' + v.subject, values: {
        provider: v.provider, subject: v.subject, actor_id: v.actor,
        created_at: timestamptz(v.created, 'identities.created')
      }};
    })
  });

  add({
    kind: 'identity.email_credentials', source: 'table:email_credentials', table: 'identity.email_credentials', pk: ['email'],
    columns: ['email', 'actor_id', 'salt', 'password_hash', 'created_at', 'verified_at'],
    filter: 'every email_credentials row', order: 'canonical(email)',
    rows: each(ctx.model.tables.email_credentials.rows, (row) => {
      const v = row.values;
      return {key: String(v.email), values: {
        email: v.email, actor_id: v.actor, salt: v.salt, password_hash: v.password_hash,
        created_at: timestamptz(v.created, 'email_credentials.created'),
        verified_at: timestamptzOrNull(v.verified_at, 'email_credentials.verified_at')
      }};
    })
  });

  add({
    kind: 'profile.profile_saves', source: 'table:profile_saves', table: 'profile.profile_saves', pk: ['actor_id'],
    columns: ['actor_id', 'revision', 'payload_text', 'updated_at'],
    filter: 'every profile_saves row', order: 'canonical(actor)',
    rows: each(ctx.model.tables.profile_saves.rows, (row) => {
      const v = row.values;
      return {key: String(v.actor), values: {
        actor_id: v.actor, revision: v.revision,
        /* 0033: payload_text is the ONLY authoritative document - the exact original source
         * string, never re-serialized. */
        payload_text: v.payload,
        updated_at: timestamptz(v.updated, 'profile_saves.updated')
      }};
    })
  });

  /* ---- social ------------------------------------------------------------ */

  function socialRows(field, family) {
    const seen = new Map();
    for (const pair of accountEntries(ctx)) {
      const actor = String(pair[0]);
      for (const other of pair[1][field] || []) {
        const target = String(other);
        if (target === actor) throw fail('SOCIAL_SELF_REFERENCE', family + ':' + actor);
        if (family === 'friendships') {
          const a = actor < target ? actor : target;
          const b = actor < target ? target : actor;
          seen.set(a + '\u001f' + b, {actor_a: a, actor_b: b});
        } else if (family === 'friend_requests') {
          seen.set(actor + '\u001f' + target, {from_id: actor, to_id: target});
        } else {
          seen.set(actor + '\u001f' + target, {blocker_id: actor, blocked_id: target});
        }
      }
    }
    const rows = [];
    for (const [key, values] of seen) rows.push({key, values});
    return rows;
  }

  add({
    kind: 'social.friendships', source: 'state.accounts#friends', table: 'social.friendships',
    pk: ['actor_a', 'actor_b'], columns: ['actor_a', 'actor_b'],
    filter: 'every symmetric friendship edge, one canonical pair', order: 'canonical(pair)',
    rows: socialRows('friends', 'friendships')
  });
  add({
    kind: 'social.friend_requests', source: 'state.accounts#friendRequests', table: 'social.friend_requests',
    pk: ['from_id', 'to_id'], columns: ['from_id', 'to_id'],
    filter: 'every directional friend request', order: 'canonical(pair)',
    rows: socialRows('friendRequests', 'friend_requests')
  });
  add({
    kind: 'social.blocks', source: 'state.accounts#blocked', table: 'social.blocks',
    pk: ['blocker_id', 'blocked_id'], columns: ['blocker_id', 'blocked_id'],
    filter: 'every directional block', order: 'canonical(pair)',
    rows: socialRows('blocked', 'blocks')
  });

  add({
    kind: 'social.command_outcomes', source: 'table:social_operations', table: 'social.command_outcomes',
    pk: ['actor_id', 'key'], columns: ['actor_id', 'key', 'fingerprint', 'result', 'committed_at'],
    filter: 'every social_operations row', order: 'canonical(actor,key)',
    rows: each(ctx.model.tables.social_operations.rows, (row) => {
      const v = row.values;
      const text = String(v.id);
      const cut = text.indexOf(':');
      if (cut <= 0) throw fail('SOCIAL_ID_UNSPLITTABLE', text);
      const actor = text.slice(0, cut);
      const key = text.slice(cut + 1);
      return {key: actor + '\u001f' + key, values: {
        actor_id: actor, key, fingerprint: v.fingerprint, result: v.result, committed_at: null
      }};
    })
  });

  /* ---- economy: wallets / ratings / operations / ledger ------------------- */

  add({
    kind: 'economy.wallets', source: 'state.accounts', table: 'economy.wallets', pk: ['actor_id'],
    columns: ['actor_id', 'coins', 'crowns', 'reserved_coins', 'reserved_crowns', 'purchased_coins', 'purchased_crowns', 'purchase_influenced', 'legacy_competition_restricted'],
    filter: 'every state.accounts entry', order: 'canonical(actor id)',
    rows: each(accountEntries(ctx), (pair) => {
      const account = pair[1];
      /* A field Authority.restore() defensively defaults (or clamps) is NOT applied here: the raw
       * value is written and the delta is reported by the reader. Only a genuinely absent raw
       * value falls back to the column's own SQL default. */
      if (!present(account, 'purchasedCoins')) note('economy.wallets.purchased_coins');
      if (!present(account, 'purchasedCrowns')) note('economy.wallets.purchased_crowns');
      return {key: String(pair[0]), values: {
        actor_id: String(pair[0]),
        coins: account.coins, crowns: account.crowns,
        reserved_coins: account.reservedCoins, reserved_crowns: account.reservedCrowns,
        purchased_coins: pick(account, 'purchasedCoins', 0),
        purchased_crowns: pick(account, 'purchasedCrowns', 0),
        purchase_influenced: account.purchaseInfluenced === true,
        legacy_competition_restricted: account.legacyCompetitionRestricted === true
      }};
    })
  });

  add({
    kind: 'economy.ratings', source: 'state.accounts', table: 'economy.ratings', pk: ['actor_id'],
    columns: ['actor_id', 'rating', 'peak', 'casual_rating', 'games', 'casual_games', 'tier', 'reached_at', 'last_rated_at'],
    filter: 'every state.accounts entry', order: 'canonical(actor id)',
    rows: each(accountEntries(ctx), (pair) => {
      const account = pair[1];
      if (!present(account, 'casualRating')) note('economy.ratings.casual_rating');
      if (!present(account, 'casualGames')) note('economy.ratings.casual_games');
      return {key: String(pair[0]), values: {
        actor_id: String(pair[0]),
        rating: String(account.rating), peak: String(account.peak),
        casual_rating: String(pick(account, 'casualRating', account.games >= 10 ? account.rating : 1000)),
        games: account.games,
        casual_games: pick(account, 'casualGames', 0),
        tier: account.tier,
        reached_at: timestamptzOrNull(pick(account, 'reachedAt', null), 'reachedAt'),
        last_rated_at: timestamptzOrNull(pick(account, 'lastRatedAt', null), 'lastRatedAt')
      }};
    })
  });

  add({
    kind: 'economy.wallet_operations', source: 'state.accounts#operations', table: 'economy.wallet_operations',
    pk: ['actor_id', 'key'], columns: ['actor_id', 'key', 'fingerprint', 'result', 'committed_at'],
    filter: 'every account.operations entry', order: 'canonical(actor,key)',
    rows: (() => {
      const rows = [];
      for (const pair of accountEntries(ctx)) {
        const actor = String(pair[0]);
        const map = pair[1].operations || {};
        for (const key of Object.keys(map)) {
          rows.push({key: actor + '\u001f' + key, values: {
            actor_id: actor, key,
            /* SOURCE TRUTH (0009): the fingerprint is the exact conversion-quote TEXT, compared
             * byte-for-byte by the source for idempotency, so the bytes are preserved verbatim. */
            fingerprint: map[key].fingerprint,
            result: jsonColumn(map[key].result, 'operations.result'),
            committed_at: null
          }});
        }
      }
      return rows;
    })()
  });

  add({
    kind: 'economy.wallet_ledger_entries', source: 'state.accounts#ledger', table: 'economy.wallet_ledger_entries',
    pk: ['actor_id', 'entry_id'],
    columns: ['actor_id', 'entry_id', 'operation_id', 'currency', 'amount', 'reason', 'at'],
    filter: 'every account.ledger entry', order: 'canonical(actor,entry id)',
    rows: (() => {
      const rows = [];
      for (const pair of accountEntries(ctx)) {
        const actor = String(pair[0]);
        for (const entry of pair[1].ledger || []) {
          rows.push({key: actor + '\u001f' + String(entry.id), values: {
            actor_id: actor, entry_id: entry.id, operation_id: entry.operation,
            currency: entry.currency, amount: entry.amount, reason: entry.reason,
            at: timestamptz(entry.at, 'ledger.at')
          }});
        }
      }
      return rows;
    })()
  });

  add({
    kind: 'economy.daily_progress', source: 'state.accounts#daily', table: 'economy.daily_progress',
    pk: ['actor_id', 'day'],
    columns: ['actor_id', 'day', 'finished', 'seconds', 'boards', 'casual', 'friend', 'ranked', 'ranked_bonus', 'claimed'],
    filter: 'every account.daily bucket', order: 'canonical(actor,day)',
    rows: (() => {
      const rows = [];
      for (const pair of accountEntries(ctx)) {
        const actor = String(pair[0]);
        const map = pair[1].daily || {};
        for (const day of Object.keys(map)) {
          const bucket = map[day];
          rows.push({key: actor + '\u001f' + day, values: {
            actor_id: actor, day, finished: bucket.finished,
            /* SOURCE CORRECTION: `seconds` is fractional; bare numeric stores it exactly. */
            seconds: String(bucket.seconds), boards: bucket.boards, casual: bucket.casual,
            friend: bucket.friend, ranked: bucket.ranked, ranked_bonus: bucket.rankedBonus,
            claimed: textArray(pick(bucket, 'claimed', null)) || []
          }});
        }
      }
      return rows;
    })()
  });

  add({
    kind: 'economy.season_state', source: 'state.accounts#season', table: 'economy.season_state', pk: ['actor_id'],
    columns: ['actor_id', 'season_id', 'started_at', 'games', 'queue_games', 'opponents', 'wins', 'losses', 'draws', 'peak_rating', 'last_rated_at', 'qualified_at'],
    filter: 'accounts whose raw season is present', order: 'canonical(actor id)',
    rows: each(accountEntries(ctx), (pair) => {
      const season = pair[1].season;
      if (!season) return null;
      return {key: String(pair[0]), values: {
        actor_id: String(pair[0]), season_id: season.id,
        started_at: timestamptz(season.startedAt, 'season.startedAt'),
        games: season.games, queue_games: season.queueGames,
        opponents: textArray(pick(season, 'opponents', null)) || [],
        wins: season.wins, losses: season.losses, draws: season.draws,
        peak_rating: pick(season, 'peakRating', null) === null ? null : String(season.peakRating),
        last_rated_at: timestamptzOrNull(pick(season, 'lastRatedAt', null), 'season.lastRatedAt'),
        qualified_at: timestamptzOrNull(pick(season, 'qualifiedAt', null), 'season.qualifiedAt')
      }};
    })
  });

  add({
    kind: 'economy.season_history', source: 'state.accounts#seasonHistory', table: 'economy.season_history',
    pk: ['actor_id', 'seq'],
    columns: ['actor_id', 'seq', 'season_id', 'started_at', 'games', 'queue_games', 'opponents', 'wins', 'losses', 'draws', 'peak_rating', 'last_rated_at', 'qualified_at', 'finish_rating', 'finish_tier', 'ended_at'],
    filter: 'every raw seasonHistory entry, never truncated by the import', order: 'canonical(actor,0-based index)',
    rows: (() => {
      const rows = [];
      for (const pair of accountEntries(ctx)) {
        const actor = String(pair[0]);
        const history = pair[1].seasonHistory || [];
        for (let index = 0; index < history.length; index++) {
          const entry = history[index];
          rows.push({key: actor + '\u001f' + ordinalKey(index), values: {
            actor_id: actor, seq: index, season_id: entry.id,
            started_at: timestamptz(entry.startedAt, 'seasonHistory.startedAt'),
            games: entry.games, queue_games: entry.queueGames,
            opponents: textArray(pick(entry, 'opponents', null)) || [],
            wins: entry.wins, losses: entry.losses, draws: entry.draws,
            peak_rating: pick(entry, 'peakRating', null) === null ? null : String(entry.peakRating),
            last_rated_at: timestamptzOrNull(pick(entry, 'lastRatedAt', null), 'seasonHistory.lastRatedAt'),
            qualified_at: timestamptzOrNull(pick(entry, 'qualifiedAt', null), 'seasonHistory.qualifiedAt'),
            finish_rating: pick(entry, 'finishRating', null) === null ? null : String(entry.finishRating),
            finish_tier: pick(entry, 'finishTier', null),
            ended_at: timestamptzOrNull(pick(entry, 'endedAt', null), 'seasonHistory.endedAt')
          }});
        }
      }
      return rows;
    })()
  });

  add({
    kind: 'economy.tournament_records', source: 'state.accounts#tournamentRecord', table: 'economy.tournament_records',
    pk: ['actor_id'],
    columns: ['actor_id', 'entered', 'wins', 'runner_up', 'top3', 'top5', 'best_finish', 'finish_sum', 'premium_wins'],
    filter: 'accounts whose raw tournamentRecord is present', order: 'canonical(actor id)',
    rows: each(accountEntries(ctx), (pair) => {
      const record = pair[1].tournamentRecord;
      if (!record) return null;
      if (pick(record, 'bestFinish', null) !== null) note('economy.tournament_records.best_finish');
      return {key: String(pair[0]), values: {
        actor_id: String(pair[0]), entered: record.entered, wins: record.wins,
        runner_up: record.runnerUp, top3: record.top3, top5: record.top5,
        best_finish: pick(record, 'bestFinish', null),
        finish_sum: record.finishSum, premium_wins: record.premiumWins
      }};
    })
  });

  add({
    kind: 'economy.match_history', source: 'state.accounts#history', table: 'economy.match_history',
    pk: ['actor_id', 'seq'],
    columns: ['actor_id', 'seq', 'match_id', 'at', 'opponent', 'mode', 'queue', 'symbol', 'rated', 'qualified', 'activity_qualified', 'result', 'reason', 'active_seconds', 'rating_delta', 'casual_delta'],
    filter: 'every account.history entry, source order preserved', order: 'canonical(actor,0-based index)',
    rows: (() => {
      const rows = [];
      for (const pair of accountEntries(ctx)) {
        const actor = String(pair[0]);
        const history = pair[1].history || [];
        for (let index = 0; index < history.length; index++) {
          const entry = history[index];
          if (!present(entry, 'activeSeconds')) note('economy.match_history.active_seconds');
          if (!present(entry, 'ratingDelta')) note('economy.match_history.rating_delta');
          if (!present(entry, 'casualDelta')) note('economy.match_history.casual_delta');
          if (!present(entry, 'activityQualified')) note('economy.match_history.activity_qualified');
          if (!present(entry, 'reason')) note('economy.match_history.reason');
          rows.push({key: actor + '\u001f' + ordinalKey(index), values: {
            actor_id: actor, seq: index, match_id: entry.id,
            at: timestamptz(entry.at, 'history.at'), opponent: entry.opponent, mode: entry.mode,
            queue: entry.queue === true, symbol: entry.symbol, rated: entry.rated === true,
            qualified: entry.qualified === true, activity_qualified: entry.activityQualified === true,
            result: entry.result, reason: pick(entry, 'reason', null),
            active_seconds: pick(entry, 'activeSeconds', null),
            rating_delta: pick(entry, 'ratingDelta', null) === null ? null : String(entry.ratingDelta),
            casual_delta: pick(entry, 'casualDelta', null) === null ? null : String(entry.casualDelta)
          }});
        }
      }
      return rows;
    })()
  });

  add({
    kind: 'economy.actor_legacy_extra', source: 'state.accounts#unmapped', table: 'economy.actor_legacy_extra',
    pk: ['actor_id'], columns: ['actor_id', 'extra'],
    filter: 'accounts carrying a key with no destination column', order: 'canonical(actor id)',
    rows: each(accountEntries(ctx), (pair) => {
      const account = pair[1];
      const extra = {};
      for (const key of Object.keys(account)) if (!ACCOUNT_KEYS_CONSUMED.has(key)) extra[key] = account[key];
      if (!Object.keys(extra).length) return null;
      note('economy.actor_legacy_extra.rows');
      return {key: String(pair[0]), values: {actor_id: String(pair[0]), extra: jsonColumn(extra, 'actor_legacy_extra.extra')}};
    })
  });

  add({
    kind: 'economy.command_outcomes', source: 'table:commands', table: 'economy.command_outcomes',
    pk: ['actor_id', 'key'], columns: ['actor_id', 'key', 'fingerprint', 'response', 'committed_at'],
    filter: 'every commands row', order: 'canonical(actor,key)',
    rows: each(ctx.model.tables.commands.rows, (row) => {
      const v = row.values;
      const logical = parseOperationPair(v.id, v.actor, 'commands');
      return {key: logical.actor + '\u001f' + logical.key, values: {
        actor_id: logical.actor,
        /* 0034: the canonical JSON string text of the logical key, encoded exactly once. */
        key: jsonColumn(logical.key, 'commands.key'),
        fingerprint: v.fingerprint, response: v.response, committed_at: null
      }};
    })
  });

  add({
    kind: 'core.actor_occupancy', source: 'state.accounts#activeMatch', table: 'core.actor_occupancy',
    pk: ['actor_id'], columns: ['actor_id', 'kind', 'ref_id', 'claimed_at'],
    filter: 'accounts whose activeMatch is a claimed aggregate', order: 'canonical(actor id)',
    rows: each(accountEntries(ctx), (pair) => {
      const active = pick(pair[1], 'activeMatch', null);
      if (active === null) return null;
      const text = String(active);
      const tournament = text.startsWith('tournament:');
      const refId = tournament ? text.slice('tournament:'.length) : text;
      const aggregate = tournament ? findRoom(ctx, refId) : ctx.matches.get(refId);
      if (!aggregate) throw fail('OCCUPANCY_REF_UNKNOWN', text);
      note('core.actor_occupancy.claimed_at');
      return {key: String(pair[0]), values: {
        actor_id: String(pair[0]), kind: tournament ? 'tournament' : 'match', ref_id: refId,
        /* No source column records the claim time; the only source-recorded instant for the claim
         * is the referenced aggregate's own `created`. */
        claimed_at: timestamptz(aggregate.created, 'occupancy.claimed_at')
      }};
    })
  });

  /* ---- match ------------------------------------------------------------- */

  add({
    kind: 'match.matches', source: 'state.matches', table: 'match.matches', pk: ['match_id'],
    columns: MATCH_COLUMNS, filter: 'every state.matches entry', order: 'canonical(match id)',
    rows: each(matchEntries(ctx), (pair) => ({
      key: String(pair[0]), values: matchValue(ctx, String(pair[0]), pair[1])
    }))
  });

  add({
    kind: 'match.participants', source: 'state.matches#players', table: 'match.participants',
    pk: ['match_id', 'seat'], columns: ['match_id', 'seat', 'actor_id', 'accepted'],
    filter: 'every state.matches[].players seat', order: 'canonical(match id,seat)',
    rows: (() => {
      const rows = [];
      for (const pair of matchEntries(ctx)) {
        const matchId = String(pair[0]);
        const accepted = pair[1].accepted || [];
        (pair[1].players || []).forEach((actor, seat) => {
          rows.push({key: matchId + '\u001f' + ordinalKey(seat), values: {
            match_id: matchId, seat, actor_id: String(actor), accepted: accepted.includes(actor)
          }});
        });
      }
      return rows;
    })()
  });

  add({
    kind: 'match.escrow_contributions', source: 'state.matches#quote.contributions', table: 'match.escrow_contributions',
    pk: ['match_id', 'actor_id'], columns: ['match_id', 'actor_id', 'amount'],
    filter: 'quote.contributions[i] > 0 for players[i] (index-parallel)', order: 'canonical(match id,seat)',
    rows: (() => {
      const rows = [];
      for (const pair of matchEntries(ctx)) {
        const matchId = String(pair[0]);
        const players = pair[1].players || [];
        const contributions = (pair[1].quote || {}).contributions || [];
        for (let seat = 0; seat < players.length && seat < contributions.length; seat++) {
          if (!(contributions[seat] > 0)) continue;
          rows.push({key: matchId + '\u001f' + ordinalKey(seat), values: {
            match_id: matchId, actor_id: String(players[seat]), amount: contributions[seat]
          }});
        }
      }
      return rows;
    })()
  });

  add({
    kind: 'match.move_outcomes', source: 'state.matches#commands', table: 'match.move_outcomes',
    pk: ['match_id', 'key'], columns: ['match_id', 'key', 'fingerprint', 'result', 'committed_at'],
    filter: 'every state.matches[].commands entry', order: 'canonical(match id,key)',
    rows: (() => {
      const rows = [];
      for (const pair of matchEntries(ctx)) {
        const matchId = String(pair[0]);
        for (const entry of pair[1].commands || []) {
          const key = String(entry[0]);
          if (!/^[A-Za-z0-9:_-]{1,160}$/.test(key)) throw fail('MOVE_KEY_GRAMMAR', matchId + ':' + key);
          rows.push({key: matchId + '\u001f' + key, values: {
            match_id: matchId, key, fingerprint: entry[1].fingerprint,
            result: jsonColumn(entry[1].result, 'move.result'), committed_at: null
          }});
        }
      }
      return rows;
    })()
  });

  /* ---- tournament -------------------------------------------------------- */

  add({
    kind: 'tournament.rooms', source: 'party_rooms', table: 'tournament.rooms', pk: ['room_id'],
    columns: ROOM_COLUMNS, filter: 'every party_rooms row', order: 'canonical(room id)',
    rows: each(ctx.model.rooms, (room) => ({key: String(room.id), values: roomValues(ctx, room)}))
  });

  add({
    kind: 'tournament.room_players', source: 'party_rooms#players', table: 'tournament.room_players',
    pk: ['room_id', 'actor_id'], columns: ['room_id', 'actor_id', 'name', 'ready', 'withdrawn', 'joined_at', 'ordinal'],
    filter: 'every party_rooms[].players entry', order: 'canonical(room id,array index)',
    rows: (() => {
      const rows = [];
      for (const room of ctx.model.rooms) {
        (room.parsed.players || []).forEach((player, ordinal) => {
          rows.push({key: String(room.id) + '\u001f' + ordinalKey(ordinal), values: {
            room_id: String(room.id), actor_id: String(player.id),
            name: player.name === undefined ? null : JSON.stringify(player.name),
            ready: player.ready === true, withdrawn: player.withdrawn === true,
            /* The source records no join time, and membership is a soft reference (0028), so a
             * guest or tombstoned principal imports verbatim. */
            joined_at: null, ordinal
          }});
        });
      }
      return rows;
    })()
  });

  add({
    kind: 'tournament.escrow_contributions', source: 'party_rooms#contributions', table: 'tournament.escrow_contributions',
    pk: ['room_id', 'actor_id'], columns: ['room_id', 'actor_id', 'amount'],
    filter: 'amount > 0 contributions', order: 'canonical(room id,array index)',
    rows: (() => {
      const rows = [];
      for (const room of ctx.model.rooms) {
        (room.parsed.contributions || []).forEach((item, index) => {
          rows.push({key: String(room.id) + '\u001f' + ordinalKey(index), values: {
            room_id: String(room.id), actor_id: String(item.id), amount: item.amount
          }});
        });
      }
      return rows;
    })()
  });

  add({
    kind: 'tournament.fixtures', source: 'party_rooms#fixtures', table: 'tournament.fixtures',
    pk: ['room_id', 'fixture_id'], columns: FIXTURE_COLUMNS,
    filter: 'every party_rooms[].fixtures entry', order: 'canonical(room id,fixture id)',
    rows: (() => {
      const rows = [];
      for (const room of ctx.model.rooms) {
        for (const fixture of room.parsed.fixtures || []) {
          rows.push({key: String(room.id) + '\u001f' + String(fixture.id), values: fixtureValues(room, fixture)});
        }
      }
      return rows;
    })()
  });

  add({
    kind: 'tournament.command_outcomes', source: 'table:party_commands', table: 'tournament.command_outcomes',
    pk: ['actor_id', 'key'], columns: ['actor_id', 'key', 'room_id', 'fingerprint', 'response', 'committed_at'],
    filter: 'every party_commands row', order: 'canonical(actor,key)',
    rows: each(ctx.model.tables.party_commands.rows, (row) => {
      const v = row.values;
      const logical = parseOperationPair(v.id, null, 'party_commands');
      let roomId = null;
      try {
        const parsed = JSON.parse(v.response);
        if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') roomId = parsed.id;
      } catch { roomId = null; }
      return {key: logical.actor + '\u001f' + logical.key, values: {
        actor_id: logical.actor,
        key: jsonColumn(logical.key, 'party_commands.key'),
        room_id: roomId, fingerprint: v.fingerprint, response: v.response, committed_at: null
      }};
    })
  });

  /* ---- monetization ------------------------------------------------------ */

  add({
    kind: 'monetization.credits', source: 'state.accounts#monetization', table: 'monetization.credits',
    pk: ['actor_id'], columns: ['actor_id', 'credit_balance', 'equipped_frame', 'last_ad_at', 'last_reward_start', 'extra'],
    filter: 'accounts whose raw monetization root is present', order: 'canonical(actor id)',
    rows: each(accountEntries(ctx), (pair) => {
      const root = pair[1].monetization;
      if (!root) return null;
      return {key: String(pair[0]), values: {
        actor_id: String(pair[0]), credit_balance: root.credits,
        equipped_frame: pick(root, 'equipped', null),
        last_ad_at: timestamptzOrNull(pick(root, 'lastAdAt', null), 'monetization.lastAdAt'),
        last_reward_start: timestamptzOrNull(pick(root, 'lastRewardStart', null), 'monetization.lastRewardStart'),
        extra: null
      }};
    })
  });

  add({
    kind: 'monetization.redeemed_frames', source: 'state.accounts#monetization.redeemed', table: 'monetization.redeemed_frames',
    pk: ['actor_id', 'frame'], columns: ['actor_id', 'frame', 'redeemed_at'],
    filter: 'every redeemed frame id (archived ids preserved)', order: 'canonical(actor,frame)',
    rows: (() => {
      const rows = [];
      for (const pair of accountEntries(ctx)) {
        const actor = String(pair[0]);
        for (const frame of (pair[1].monetization || {}).redeemed || []) {
          rows.push({key: actor + '\u001f' + String(frame), values: {actor_id: actor, frame: String(frame), redeemed_at: null}});
        }
      }
      return rows;
    })()
  });

  add({
    kind: 'monetization.boosts', source: 'state.accounts#monetization.boosts', table: 'monetization.boosts',
    pk: ['actor_id', 'boost_seq'], columns: ['actor_id', 'boost_seq', 'started_at', 'ends_at'],
    filter: 'every boosts entry, source order preserved', order: 'canonical(actor,0-based index)',
    rows: (() => {
      const rows = [];
      for (const pair of accountEntries(ctx)) {
        const actor = String(pair[0]);
        const boosts = (pair[1].monetization || {}).boosts || [];
        boosts.forEach((boost, index) => {
          rows.push({key: actor + '\u001f' + ordinalKey(index), values: {
            actor_id: actor, boost_seq: index,
            started_at: timestamptz(boost.startedAt, 'boosts.startedAt'),
            ends_at: timestamptz(boost.endsAt, 'boosts.endsAt')
          }});
        });
      }
      return rows;
    })()
  });

  add({
    kind: 'monetization.reward_daily', source: 'state.accounts#monetization.daily', table: 'monetization.reward_daily',
    pk: ['actor_id', 'day'], columns: ['actor_id', 'day', 'base', 'bonus', 'automatic'],
    filter: 'every monetization daily bucket', order: 'canonical(actor,day)',
    rows: (() => {
      const rows = [];
      for (const pair of accountEntries(ctx)) {
        const actor = String(pair[0]);
        const map = (pair[1].monetization || {}).daily || {};
        for (const day of Object.keys(map)) {
          rows.push({key: actor + '\u001f' + day, values: {
            actor_id: actor, day, base: map[day].base, bonus: map[day].bonus, automatic: map[day].automatic
          }});
        }
      }
      return rows;
    })()
  });

  add({
    kind: 'monetization.command_outcomes', source: 'table:v35_commands', table: 'monetization.command_outcomes',
    pk: ['actor_id', 'key'], columns: ['actor_id', 'key', 'fingerprint', 'response', 'committed_at'],
    filter: 'every v35_commands row', order: 'canonical(actor,key)',
    rows: each(ctx.model.tables.v35_commands.rows, (row) => {
      const v = row.values;
      return {key: String(v.actor) + '\u001f' + String(v.key), values: {
        actor_id: v.actor, key: v.key, fingerprint: v.fingerprint, response: v.response, committed_at: null
      }};
    })
  });

  add({
    kind: 'monetization.reward_tickets', source: 'table:v35_tickets', table: 'monetization.reward_tickets',
    pk: ['ticket_id'], columns: ['ticket_id', 'actor_id', 'kind', 'issued_at', 'expires_at', 'day', 'settled', 'transaction_id'],
    filter: 'every v35_tickets row', order: 'canonical(ticket id)',
    rows: each(ctx.model.tables.v35_tickets.rows, (row) => {
      const v = row.values;
      return {key: String(v.id), values: {
        ticket_id: v.id, actor_id: v.actor, kind: v.kind,
        issued_at: timestamptz(v.issued, 'v35_tickets.issued'),
        expires_at: timestamptz(v.expires, 'v35_tickets.expires'),
        day: v.day, settled: asBoolean(v.settled), transaction_id: pick(v, 'transaction_id', null)
      }};
    })
  });

  add({
    kind: 'monetization.casual_rewards', source: 'table:v35_casual', table: 'monetization.casual_rewards',
    pk: ['actor_id', 'match_id'], columns: ['actor_id', 'match_id', 'base', 'bonus'],
    filter: 'every v35_casual row', order: 'canonical(actor,match)',
    rows: each(ctx.model.tables.v35_casual.rows, (row) => {
      const v = row.values;
      return {key: String(v.actor) + '\u001f' + String(v.match_id), values: {
        actor_id: v.actor, match_id: v.match_id, base: v.base, bonus: v.bonus
      }};
    })
  });

  add({
    kind: 'monetization.reward_events', source: 'table:v35_events', table: 'monetization.reward_events',
    pk: ['event_id'], columns: ['event_id', 'actor_id', 'kind', 'at', 'value'],
    /* event_id is GENERATED ALWAYS: the source identity values are restored explicitly. */
    overridingSystemValue: true,
    filter: 'every v35_events row', order: 'canonical(event id)',
    rows: each(ctx.model.tables.v35_events.rows, (row) => {
      const v = row.values;
      return {key: String(v.id), values: {
        event_id: v.id, actor_id: v.actor, kind: v.kind,
        at: timestamptz(v.at, 'v35_events.at'), value: v.value
      }};
    })
  });

  add({
    kind: 'monetization.ad_ticket_context', source: 'table:v41_ad_ticket_context', table: 'monetization.ad_ticket_context',
    pk: ['ticket_id'], columns: ['ticket_id', 'platform', 'ad_unit'],
    filter: 'every v41_ad_ticket_context row', order: 'canonical(ticket id)',
    rows: each(ctx.model.tables.v41_ad_ticket_context.rows, (row) => {
      const v = row.values;
      return {key: String(v.ticket), values: {ticket_id: v.ticket, platform: v.platform, ad_unit: v.ad_unit}};
    })
  });

  add({
    kind: 'monetization.receipts', source: 'state.receipts', table: 'monetization.receipts',
    pk: ['store', 'transaction_id'],
    columns: ['store', 'transaction_id', 'actor_id', 'product_id', 'crowns', 'refunded', 'purchased_at'],
    filter: 'every state.receipts entry', order: 'canonical(store,transaction id)',
    rows: each(ctx.parsed.receipts, (pair) => {
      const key = String(pair[0]);
      const cut = key.indexOf(':');
      if (cut <= 0) throw fail('RECEIPT_KEY_UNSPLITTABLE', key);
      const store = key.slice(0, cut);
      const transactionId = key.slice(cut + 1);
      const receipt = pair[1];
      return {key: store + '\u001f' + transactionId, values: {
        store, transaction_id: transactionId, actor_id: receipt.actor, product_id: receipt.productId,
        crowns: receipt.crowns, refunded: receipt.refunded === true,
        purchased_at: timestamptz(receipt.at, 'receipt.at')
      }};
    })
  });

  add({
    kind: 'monetization.store_bindings', source: 'table:v41_store_bindings', table: 'monetization.store_bindings',
    pk: ['actor_id'], columns: ['actor_id', 'google_id', 'apple_token', 'created_at'],
    filter: 'every v41_store_bindings row (provider ids copied byte-for-byte)', order: 'canonical(actor)',
    rows: each(ctx.model.tables.v41_store_bindings.rows, (row) => {
      const v = row.values;
      return {key: String(v.actor), values: {
        actor_id: v.actor, google_id: v.google_id, apple_token: v.apple_token,
        created_at: timestamptz(v.created, 'store_bindings.created')
      }};
    })
  });

  add({
    kind: 'monetization.store_revocations', source: 'table:v41_store_revocations', table: 'monetization.store_revocations',
    pk: ['store', 'transaction_id'], columns: ['store', 'transaction_id', 'product_id', 'occurred_at', 'reason'],
    filter: 'every v41_store_revocations row (imported even without a matching receipt)',
    order: 'canonical(store,transaction id)',
    rows: each(ctx.model.tables.v41_store_revocations.rows, (row) => {
      const v = row.values;
      return {key: String(v.store) + '\u001f' + String(v.transaction_id), values: {
        store: v.store, transaction_id: v.transaction_id, product_id: v.product_id,
        occurred_at: timestamptz(v.occurred_at, 'store_revocations.occurred_at'), reason: v.reason
      }};
    })
  });

  add({
    kind: 'monetization.store_finalize', source: 'table:v41_store_finalize', table: 'monetization.store_finalize',
    pk: ['store', 'transaction_id'], uniqueKey: false,
    columns: ['store', 'transaction_id', 'product_id', 'purchase_token', 'kind', 'state', 'attempts', 'next_at', 'created_at', 'updated_at'],
    filter: 'every v41_store_finalize row', order: 'canonical(store,transaction id)',
    rows: each(ctx.model.tables.v41_store_finalize.rows, (row) => {
      const v = row.values;
      return {key: String(v.store) + '\u001f' + String(v.transaction_id), values: {
        store: v.store, transaction_id: v.transaction_id, product_id: v.product_id,
        purchase_token: v.purchase_token, kind: v.kind, state: v.state, attempts: v.attempts,
        next_at: timestamptz(v.next_at, 'store_finalize.next_at'),
        created_at: timestamptz(v.created, 'store_finalize.created'),
        updated_at: timestamptz(v.updated, 'store_finalize.updated')
      }};
    })
  });

  add({
    kind: 'monetization.store_notifications', source: 'table:v41_store_notifications', table: 'monetization.store_notifications',
    pk: ['store', 'notification_id'],
    columns: ['store', 'notification_id', 'received_at', 'state', 'attempts', 'next_at'],
    filter: 'every v41_store_notifications row (dedupe state only)', order: 'canonical(store,notification id)',
    rows: each(ctx.model.tables.v41_store_notifications.rows, (row) => {
      const v = row.values;
      note('monetization.store_notifications.next_at');
      return {key: String(v.store) + '\u001f' + String(v.id), values: {
        store: v.store, notification_id: v.id,
        received_at: timestamptz(v.received_at, 'store_notifications.received_at'),
        /* The source records only the receipt; the unprocessed dedupe row starts pending with the
         * claim window opening at receipt. */
        state: 'pending', attempts: 0, next_at: timestamptz(v.received_at, 'store_notifications.next_at')
      }};
    })
  });

  /* ---- cosmetics --------------------------------------------------------- */

  add({
    kind: 'cosmetics.owned_items', source: 'state.accounts#owned', table: 'cosmetics.owned_items',
    pk: ['actor_id', 'item'], columns: ['actor_id', 'item', 'acquired_at'],
    filter: 'every owned cosmetic name (archived names preserved verbatim)', order: 'canonical(actor,item)',
    rows: (() => {
      const rows = [];
      for (const pair of accountEntries(ctx)) {
        const actor = String(pair[0]);
        for (const item of pair[1].owned || []) {
          rows.push({key: actor + '\u001f' + String(item), values: {actor_id: actor, item: String(item), acquired_at: null}});
        }
      }
      return rows;
    })()
  });

  /* ---- season ------------------------------------------------------------ */

  add({
    kind: 'season.day_snapshots', source: 'state.snapshots', table: 'season.day_snapshots',
    pk: ['day', 'actor_id'], columns: ['day', 'actor_id', 'tier'],
    filter: 'every state.snapshots date -> {actor:tier} entry', order: 'canonical(day,actor)',
    rows: (() => {
      const rows = [];
      for (const pair of ctx.parsed.snapshots) {
        const day = String(pair[0]);
        for (const actor of Object.keys(pair[1] || {})) {
          rows.push({key: day + '\u001f' + actor, values: {day, actor_id: actor, tier: pair[1][actor]}});
        }
      }
      return rows;
    })()
  });

  add({
    kind: 'season.league_week', source: 'state.leagueWeek', table: 'season.league_week',
    pk: ['id'], singleton: true, columns: ['id', 'week', 'published_at'],
    filter: 'the single state.leagueWeek value', order: 'singleton',
    rows: ctx.parsed.leagueWeek === null || ctx.parsed.leagueWeek === undefined ? [] : [{
      key: '1', values: {id: 1, week: ctx.parsed.leagueWeek, published_at: null}
    }]
  });

  add({
    kind: 'season.weekly_payouts', source: 'state.weeklyPaid', table: 'season.weekly_payouts',
    pk: ['payout_id'], columns: ['payout_id', 'week', 'actor_id', 'amount', 'tier', 'eligible', 'days', 'created_at'],
    filter: 'every state.weeklyPaid entry', order: 'canonical(payout id)',
    rows: each(ctx.parsed.weeklyPaid, (pair) => {
      const payment = pair[1];
      return {key: String(pair[0]), values: {
        payout_id: payment.id, week: payment.week, actor_id: payment.account, amount: payment.amount,
        tier: payment.tier, eligible: payment.eligible === true,
        days: pick(payment, 'days', null), created_at: null
      }};
    })
  });

  add({
    kind: 'economy.system_burns', source: 'state.burned', table: 'economy.system_burns',
    pk: ['id'], singleton: true, columns: ['id', 'coins', 'crowns', 'updated_at'],
    filter: 'the single state.burned map', order: 'singleton',
    rows: [{
      key: '1', values: {
        id: 1, coins: ctx.parsed.burned.coins, crowns: ctx.parsed.burned.crowns,
        /* The source burned map carries no clock; the capture clock is the only deterministic
         * instant available. */
        updated_at: timestamptz(ctx.clockMs, 'system_burns.updated_at')
      }
    }]
  });

  /* ---- privacy / support / audit ----------------------------------------- */

  add({
    kind: 'privacy.reports', source: 'table:v41_reports', table: 'privacy.reports',
    pk: ['report_id'],
    columns: ['report_id', 'reporter_id', 'target_id', 'category', 'detail', 'created_at', 'state', 'reviewed_at', 'reviewed_by', 'outcome'],
    filter: 'every v41_reports row', order: 'canonical(report id)',
    rows: each(ctx.model.tables.v41_reports.rows, (row) => {
      const v = row.values;
      return {key: String(v.id), values: {
        report_id: v.id, reporter_id: v.reporter, target_id: v.target, category: v.category,
        detail: pick(v, 'detail', ''), created_at: timestamptz(v.created, 'reports.created'),
        state: v.state, reviewed_at: timestamptzOrNull(pick(v, 'reviewed_at', null), 'reports.reviewed_at'),
        reviewed_by: pick(v, 'reviewed_by', null), outcome: pick(v, 'outcome', null)
      }};
    })
  });

  add({
    kind: 'privacy.requests', source: 'table:v41_privacy_requests', table: 'privacy.requests',
    pk: ['request_id'],
    columns: ['request_id', 'actor_id', 'kind', 'state', 'requested_at', 'updated_at', 'completed_at', 'policy_version', 'note'],
    filter: 'every v41_privacy_requests row', order: 'canonical(request id)',
    rows: each(ctx.model.tables.v41_privacy_requests.rows, (row) => {
      const v = row.values;
      return {key: String(v.id), values: {
        request_id: v.id, actor_id: v.actor, kind: v.kind, state: v.state,
        requested_at: timestamptz(v.requested_at, 'requests.requested_at'),
        updated_at: timestamptz(v.updated_at, 'requests.updated_at'),
        completed_at: timestamptzOrNull(pick(v, 'completed_at', null), 'requests.completed_at'),
        policy_version: v.policy_version, note: pick(v, 'note', '')
      }};
    })
  });

  add({
    kind: 'privacy.deletion_receipts', source: 'table:v41_deletion_receipts', table: 'privacy.deletion_receipts',
    pk: ['receipt_id'], columns: ['receipt_id', 'actor_hash', 'tombstone', 'completed_at', 'policy_version', 'retained'],
    filter: 'every v41_deletion_receipts row', order: 'canonical(receipt id)',
    rows: each(ctx.model.tables.v41_deletion_receipts.rows, (row) => {
      const v = row.values;
      return {key: String(v.id), values: {
        receipt_id: v.id, actor_hash: v.actor_hash, tombstone: v.tombstone,
        completed_at: timestamptz(v.completed_at, 'deletion_receipts.completed_at'),
        policy_version: v.policy_version, retained: v.retained
      }};
    })
  });

  add({
    kind: 'support.events', source: 'table:v41_support_events', table: 'support.events',
    pk: ['event_id'], columns: ['event_id', 'at', 'method', 'route', 'status', 'code'],
    filter: 'every v41_support_events row (retention DELETE belongs to the runtime)',
    order: 'canonical(event id)',
    rows: each(ctx.model.tables.v41_support_events.rows, (row) => {
      const v = row.values;
      return {key: String(v.id), values: {
        event_id: v.id, at: timestamptz(v.at, 'support_events.at'),
        method: pick(v, 'method', ''), route: pick(v, 'route', ''), status: v.status,
        code: pick(v, 'code', '')
      }};
    })
  });

  add({
    kind: 'audit.operator_audit', source: 'table:v41_operator_audit', table: 'audit.operator_audit',
    pk: ['audit_id'],
    columns: ['audit_id', 'at', 'operator', 'action', 'actor_id', 'reason', 'detail', 'prev_hash', 'entry_hash'],
    filter: 'every v41_operator_audit row (hash chain preserved verbatim, never recomputed)',
    order: 'canonical(audit id)',
    rows: each(ctx.model.tables.v41_operator_audit.rows, (row) => {
      const v = row.values;
      return {key: String(v.id), values: {
        audit_id: v.id, at: timestamptz(v.at, 'operator_audit.at'), operator: v.operator,
        action: v.action, actor_id: pick(v, 'actor', null), reason: v.reason, detail: v.detail,
        prev_hash: v.prev_hash, entry_hash: v.entry_hash
      }};
    })
  });

  /* ---- runtime / ops ----------------------------------------------------- */

  add({
    kind: 'runtime.controls', source: 'table:v4_controls', table: 'runtime.controls',
    pk: ['id'], singleton: true, columns: ['id', 'maintenance', 'updated_at'],
    filter: 'every v4_controls row (inert control continuity)', order: 'canonical(id)',
    rows: each(ctx.model.tables.v4_controls.rows, (row) => {
      const v = row.values;
      return {key: String(v.id), values: {
        id: v.id, maintenance: asBoolean(v.maintenance),
        /* Seeded singleton (0024) updated in place; no source clock exists for it. */
        updated_at: timestamptz(ctx.clockMs, 'controls.updated_at')
      }};
    })
  });

  add({
    kind: 'runtime.state', source: 'table:v4_runtime', table: 'runtime.state', pk: ['key'],
    columns: ['key', 'value'], filter: 'every v4_runtime row', order: 'canonical(key)',
    rows: each(ctx.model.tables.v4_runtime.rows, (row) => {
      const v = row.values;
      return {key: String(v.key), values: {key: v.key, value: v.value}};
    })
  });

  add({
    kind: 'ops.rate_buckets#community_limits', source: 'table:community_limits', table: 'ops.rate_buckets',
    pk: ['bucket_id'], columns: ['bucket_id', 'hits', 'expires_at'],
    filter: 'every community_limits row', order: 'canonical(bucket id)',
    rows: each(ctx.model.tables.community_limits.rows, (row) => {
      const v = row.values;
      return {key: String(v.id), values: {bucket_id: v.id, hits: v.hits, expires_at: null}};
    })
  });

  add({
    kind: 'ops.rate_buckets#v4_limits', source: 'table:v4_limits', table: 'ops.rate_buckets',
    pk: ['bucket_id'], columns: ['bucket_id', 'hits', 'expires_at'],
    filter: 'every v4_limits row, split by id prefix (mail-budget: durable, abuse:* ephemeral)',
    order: 'canonical(bucket id)',
    rows: each(ctx.model.tables.v4_limits.rows, (row) => {
      const v = row.values;
      return {key: String(v.id), values: {
        bucket_id: v.id, hits: v.hits,
        expires_at: timestamptz(v.expires, 'v4_limits.expires')
      }};
    })
  });

  add({
    kind: 'ops.outbox', source: 'table:v4_outbox', table: 'ops.outbox',
    pk: ['outbox_id'],
    columns: ['outbox_id', 'payload', 'kind', 'state', 'created_at', 'expires_at', 'next_at', 'lease_until', 'attempts'],
    filter: 'every v4_outbox row (ciphertext preserved verbatim, never re-sent)',
    order: 'canonical(outbox id)',
    rows: each(ctx.model.tables.v4_outbox.rows, (row) => {
      const v = row.values;
      /* Recorded policy `drained` (mapping.ephemeral.v4_outbox) as the frozen 0018 DDL makes
       * structural: the sealed ciphertext survives only while a row is still queued or sending,
       * because the source's own tick() NULLs it on the sent/expired/failed transition
       * (server/production/mail-outbox.js:69,74) and 0027's cancelled state requires payload NULL.
       * A terminal source row that still carries a payload is a state the current producer cannot
       * create; the drained representation is recorded per row, never silently. */
      const sealed = v.state === 'queued' || v.state === 'sending';
      if (!sealed && v.payload !== null && v.payload !== undefined) {
        note('ops.outbox.drained_payload');
        ctx.outboxDrained = (ctx.outboxDrained || 0) + 1;
      }
      return {key: String(v.id), values: {
        outbox_id: v.id, payload: sealed ? pick(v, 'payload', null) : null, kind: v.kind, state: v.state,
        created_at: timestamptz(v.created, 'outbox.created'),
        expires_at: timestamptz(v.expires, 'outbox.expires'),
        next_at: timestamptz(v.next_at, 'outbox.next_at'),
        lease_until: timestamptz(v.lease_until, 'outbox.lease_until'),
        attempts: v.attempts
      }};
    })
  });

  /* ---- journal (last: nothing references it, and its actors are soft) ---- */

  add({
    kind: 'economy.ledger', source: 'state.journal', table: 'economy.ledger', pk: ['entry_id'],
    columns: ['entry_id', 'actor_id', 'currency', 'amount', 'reason', 'source', 'at'],
    filter: 'every state.journal entry, source order preserved', order: 'canonical(entry id)',
    rows: each(ctx.parsed.journal, (entry) => ({
      key: String(entry.id), values: {
        entry_id: entry.id, actor_id: entry.actor, currency: entry.currency, amount: entry.amount,
        reason: entry.reason, source: entry.source, at: timestamptz(entry.at, 'journal.at')
      }
    }))
  });

  return plan;
}

/* ------------------------------------------------------------------ coverage */

/* One coverage row per source locator the run saw. Locators are unique by (kind,name,key); the
 * projection writes several target rows for one source locator, so coverage is emitted here from
 * the model rather than from the write loop. */
function buildCoverage(model) {
  const rows = [];
  const push = (locatorKind, name, key, classification, ruleId, note) =>
    rows.push({locatorKind, name, key, classification, ruleId, note});
  for (const [name, table] of Object.entries(model.tables)) {
    const ephemeral = EPHEMERAL_TABLES[name];
    const provenance = PROVENANCE_TABLES[name];
    const projected = PROJECTED_TABLES.has(name);
    for (const row of table.rows) {
      if (ephemeral) push('table', name, String(row.key), 'E', ephemeral.rule, ephemeral.policy);
      else if (provenance) push('table', name, String(row.key), 'V', provenance.rule, provenance.note);
      else if (projected) push('table', name, String(row.key), 'V', null, null);
      else push('table', name, String(row.key), 'unclassified', null, 'table not projected by this importer');
    }
  }
  for (const pair of model.state.parsed.accounts) push('root', 'state.accounts', String(pair[0]), 'V', null, null);
  for (const pair of model.state.parsed.matches) push('root', 'state.matches', String(pair[0]), 'O', null, null);
  for (const pair of model.state.parsed.receipts) push('root', 'state.receipts', String(pair[0]), 'V', null, null);
  for (const pair of model.state.parsed.snapshots) {
    for (const actor of Object.keys(pair[1] || {})) push('root', 'state.snapshots', String(pair[0]) + '#' + actor, 'V', null, null);
  }
  for (const pair of model.state.parsed.weeklyPaid) push('root', 'state.weeklyPaid', String(pair[0]), 'V', null, null);
  for (const entry of model.state.parsed.journal) push('root', 'state.journal', String(entry.id), 'V', null, null);
  push('root', 'state.burned', '*', 'V', null, null);
  push('root', 'state.leagueWeek', '*', 'V', null, null);
  return rows;
}

/* Every source locator must be classified; an unclassified locator fails the run unless an explicit
 * accepted rule was supplied at extraction time (mapping.unclassifiedPolicy). */
function assertCoverage(model) {
  if (model.coverage && model.coverage.unclassified_count) throw fail('COVERAGE_INCOMPLETE');
  for (const name of Object.keys(model.tables)) {
    if (PROJECTED_TABLES.has(name) || EPHEMERAL_TABLES[name] || PROVENANCE_TABLES[name]) continue;
    throw fail('COVERAGE_INCOMPLETE', 'table:' + name);
  }
  const accepted = (model.coverage && model.coverage.accepted) || [];
  for (const item of accepted) {
    if (!item.ruleId) throw fail('COVERAGE_RULE_MISSING', item.locator);
  }
  return {accepted: accepted.length};
}

/* ------------------------------------------------------------------ batching */

function chunk(rows, batchSize) {
  const out = [];
  for (let at = 0; at < rows.length; at += batchSize) out.push(rows.slice(at, at + batchSize));
  return out.length ? out : [[]];
}

function buildBatchPlan(plan, batchSize) {
  const batches = [];
  let ordinal = 0;
  for (const spec of plan) {
    const definitionHash = hash({
      kind: spec.kind, source_locator: spec.source, filter: spec.filter,
      order_by: spec.order, batchSize
    });
    for (const rows of chunk(spec.rows, batchSize)) {
      batches.push({
        ordinal, spec, definitionHash, rows,
        cursor: rows.length ? rows[rows.length - 1].key : null
      });
      ordinal += 1;
    }
  }
  return batches;
}

/* ------------------------------------------------------------------ database I/O */

function parameterValues(spec, row) { return spec.columns.map((column) => row.values[column]); }


/* One transaction per batch, exactly like scripts/v5/migrate.js:runMigration. Two identities are
 * needed inside it: the data namespaces are owned by v5_owner (reached with SET LOCAL ROLE), while
 * the v5_migration bookkeeping namespace is owned by the trusted runner that applied 0036 (reached
 * by RESET ROLE back to the session identity). Both phases commit or roll back as one unit. */
async function withTransaction(client, fn, options = {}) {
  const initial = options.role === undefined ? null : options.role;
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '300s'");
    await client.query("SET LOCAL lock_timeout = '30s'");
    await client.query('SET LOCAL search_path = pg_catalog, pg_temp');
    let current = null;
    if (initial) { await client.query(`SET LOCAL ROLE ${initial}`); current = initial; }
    const result = await fn({
      async data() {
        if (current === 'v5_owner') return;
        await client.query('SET LOCAL ROLE v5_owner');
        current = 'v5_owner';
      },
      async runner() {
        if (current === null) return;
        await client.query('RESET ROLE');
        current = null;
      }
    });
    if (current !== null) await client.query('RESET ROLE');
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* aborted */ }
    throw error;
  }
}

/* The import binds to the checksummed P02 chain: refuse loudly, with one clear code, when the
 * target has not been migrated (or is missing a table this run writes) instead of letting the
 * first statement surface a bare 42P01 halfway through the run. */
const REQUIRED_TABLES = [
  'v5_migration.run', 'v5_migration.target_guard', 'v5_migration.batch', 'v5_migration.row_ledger',
  'v5_migration.coverage', 'identity.actors'
];
async function assertTargetSchema(client) {
  const missing = [];
  for (const table of REQUIRED_TABLES) {
    const rows = (await client.query('SELECT to_regclass($1) AS t', [table])).rows;
    if (!rows[0].t) missing.push(table);
  }
  if (missing.length) throw fail('TARGET_SCHEMA_NOT_MIGRATED', missing.join(', '));
  const head = (await client.query('SELECT COALESCE(max(schema_version), 0)::int AS h FROM meta.migrations')).rows;
  return head[0].h;
}

async function load(options = {}) {
  const {
    model, runId, extractorRelease, target, batchSize: rawBatchSize, onBatch
  } = options;
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw fail('RUN_ID_INVALID', String(runId));
  if (!HEX64.test(String(extractorRelease))) throw fail('EXTRACTOR_RELEASE_INVALID', String(extractorRelease));
  if (!target || typeof target !== 'object') throw fail('TARGET_REQUIRED');
  const environment = String(target.environment || '');
  if (!environment) throw fail('TARGET_ENVIRONMENT_REQUIRED');
  const adopt = target.adoptExisting === true || target.adopt === true;
  const batchSize = rawBatchSize === undefined || rawBatchSize === null ? DEFAULT_BATCH_SIZE : Number(rawBatchSize);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000) throw fail('BATCH_SIZE_INVALID', String(rawBatchSize));

  const ctx = {
    model,
    clockMs: model.capture.clockMs,
    parsed: model.state.parsed,
    matches: new Map(model.state.parsed.matches),
    derived: {}
  };
  assertCoverage(model);
  const plan = buildPlan(ctx);
  const batches = buildBatchPlan(plan, batchSize);
  const coverageRows = buildCoverage(model);
  const sourceFingerprint = model.hashes.sourceFingerprint;

  let client = options.client || options.connection || null;
  let owned = false;
  if (!client) {
    const url = options.connection || options.databaseUrl;
    if (!url) throw fail('CONNECTION_REQUIRED');
    const migrate = require('../../scripts/v5/migrate.js');
    const {Client} = require('pg');
    let looksProduction = false;
    try { looksProduction = migrate.classifyTarget(url, null).kind === 'production'; } catch { looksProduction = false; }
    const cfg = migrate.parseAndGuardUrl(url, {production: looksProduction});
    client = new Client({
      host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, password: cfg.password,
      ssl: cfg.ssl === false ? false : (cfg.ssl || undefined),
      application_name: 'v5-migration-load',
      connectionTimeoutMillis: 15000, statement_timeout: 300000,
      enableChannelBinding: cfg.channelBinding === 'require' || cfg.channelBinding === 'prefer'
    });
    await client.connect();
    owned = true;
  }

  try {
    /* Session advisory lock, same key as the migration runner (design 3.5 rule 4). */
    const locked = (await client.query('SELECT pg_try_advisory_lock($1) AS got', [migrateAdvisoryKey()])).rows[0].got;
    if (locked !== true) throw fail('IMPORT_BUSY', 'another migration or import holds the advisory lock');

    try {
      await assertTargetSchema(client);
      const bookkeeping = await bookkeepingStage(client, {
        runId, sourceFingerprint, extractorRelease, environment, model, adopt
      });

      const committed = await runBatches(client, {
        runId, batches, sourceFingerprint, onBatch
      });

      const coverageCounts = await writeCoverage(client, runId, coverageRows);
      await fixIdentitySequence(client);
      const finalised = await finaliseRun(client, {
        runId, model, batches: committed, coverageCounts,
        guard: bookkeeping.targetGuard, derived: ctx.derived
      });
      return {
        runId, sourceFingerprint, extractorRelease,
        schemaHead: model.capture.schemaHead.maxId,
        batches: committed.map((batch) => ({
          ordinal: batch.ordinal, kind: batch.kind, definitionHash: batch.definitionHash,
          status: batch.status, rowsWritten: batch.rowsWritten, attemptCount: batch.attemptCount,
          cursor: batch.cursor, committedRowHash: batch.committedRowHash,
          verified: batch.verified === true
        })),
        counters: finalised.counters,
        coverageCounts: finalised.coverageCounts,
        targetGuard: finalised.targetGuard
      };
    } finally {
      try { await client.query('SELECT pg_advisory_unlock($1)', [migrateAdvisoryKey()]); } catch { /* session gone */ }
    }
  } finally {
    if (owned) { try { await client.end(); } catch { /* closed */ } }
  }
}

function migrateAdvisoryKey() {
  // The same stable cluster-wide mutex the migration runner uses: no import may race a migration.
  try { return require('../../scripts/v5/migrate.js').ADVISORY_LOCK_KEY; } catch { return 7202050231; }
}

/* ------------------------------------------------------------------ stage 1: bookkeeping */

async function bookkeepingStage(client, args) {
  const {runId, sourceFingerprint, extractorRelease, environment, model, adopt} = args;
  const database = (await client.query('SELECT current_database() AS db')).rows[0];
  /* System-identifier-equivalent identity: prefer the real cluster identifier, fall back to the
   * database name when the control function is not readable by this session. */
  let systemId = null;
  try {
    systemId = (await client.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
  } catch { systemId = null; }
  const targetSystemId = systemId ? systemId + '/' + database.db : database.db;

  /* Rule 1: an unknown target is refused, never implicitly created. */
  const guard = (await client.query(
    'SELECT target_system_id, target_environment, target_database, schema_head, created_by_run, adopted_existing_tables FROM v5_migration.target_guard WHERE target_system_id = $1',
    [targetSystemId])).rows[0] || null;

  const existingRun = (await client.query(
    'SELECT run_id, source_fingerprint, extractor_release, status, schema_head, counters FROM v5_migration.run WHERE run_id = $1',
    [runId])).rows[0] || null;

  if (existingRun) {
    /* Rule 2: a reused run id with a different fingerprint or release is refused. */
    if (existingRun.source_fingerprint !== sourceFingerprint) throw fail('RUN_FINGERPRINT_CONFLICT', runId);
    if (existingRun.extractor_release !== extractorRelease) throw fail('RUN_RELEASE_CONFLICT', runId);
  }

  if (!guard && !adopt) throw fail('TARGET_UNKNOWN', database.db + ' (' + environment + ')');

  const guardRow = await withTransaction(client, async (phase) => {
    await phase.runner();
    const now = new Date().toISOString();
    const run = (await client.query(
      'SELECT run_id, status, started_at FROM v5_migration.run WHERE run_id = $1 FOR UPDATE', [runId])).rows[0] || null;
    if (!run) {
      await client.query(
        `INSERT INTO v5_migration.run (run_id, source_fingerprint, extractor_release, source_release_sha,
           target_environment, target_database, target_system_identifier, schema_head, capture_clock_ms,
           status, started_at, counters)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'running', $10, '{}'::jsonb)`,
        [runId, sourceFingerprint, extractorRelease,
          (model.capture.sourceRelease && model.capture.sourceRelease.sha) || null,
          environment, database.db, targetSystemId, model.capture.schemaHead.maxId,
          model.capture.clockMs, now]);
    }
    const declared = (await client.query(
      'SELECT target_system_id, target_environment, target_database, schema_head, created_by_run, adopted_existing_tables FROM v5_migration.target_guard WHERE target_system_id = $1 FOR UPDATE',
      [targetSystemId])).rows[0] || null;
    if (!declared) {
      const adopted = adopt ? ['identity.actors'] : [];
      await client.query(
        `INSERT INTO v5_migration.target_guard (target_system_id, target_environment, target_database,
           schema_head, created_by_run, adopted_existing_tables, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [targetSystemId, environment, database.db, model.capture.schemaHead.maxId, runId, adopted, now]);
      return {targetSystemId, environment, database: database.db,
        schemaHead: model.capture.schemaHead.maxId, createdByRun: runId, adoptedExistingTables: adopted};
    }
    if (declared.target_environment !== environment) {
      throw fail('TARGET_ENVIRONMENT_MISMATCH', declared.target_environment + ' != ' + environment);
    }
    if (declared.target_database !== database.db) {
      throw fail('TARGET_DATABASE_MISMATCH', declared.target_database + ' != ' + database.db);
    }
    return {targetSystemId: declared.target_system_id, environment: declared.target_environment,
      database: declared.target_database, schemaHead: declared.schema_head,
      createdByRun: declared.created_by_run, adoptedExistingTables: declared.adopted_existing_tables || []};
  });

  /* A previously committed run re-verifies every row it wrote against the database's own rendering
   * and the ledger it recorded. No target row is rewritten; only this run's own bookkeeping may be
   * touched. */
  const previouslyCommitted = !!(existingRun && existingRun.status === 'committed');

  return {alreadyCommitted: previouslyCommitted, targetGuard: guardRow};
}

/* ------------------------------------------------------------------ stage 2: batches */

async function runBatches(client, args) {
  const {runId, batches, sourceFingerprint} = args;
  const results = [];
  const expected = new Map(batches.map((batch) => [batch.ordinal, batch]));

  const recorded = (await client.query(
    'SELECT ordinal, definition_hash, status, cursor, rows_written, attempt_count FROM v5_migration.batch WHERE run_id = $1 ORDER BY ordinal',
    [runId])).rows;
  for (const row of recorded) {
    const planned = expected.get(row.ordinal);
    if (!planned) {
      /* A batch row from an earlier run of the same id whose plan no longer exists: the model has
       * changed under a reused run id. That is a hard refusal, never a silent re-plan. */
      throw fail('BATCH_PLAN_DIVERGED', 'ordinal ' + row.ordinal + ' (' + row.kind + ')');
    }
    if (row.definition_hash !== planned.definitionHash) {
      throw fail('BATCH_DEFINITION_CHANGED', planned.kind + '#' + row.ordinal);
    }
  }
  const byOrdinal = new Map(recorded.map((row) => [row.ordinal, row]));

  for (const batch of batches) {
    const prior = byOrdinal.get(batch.ordinal);
    if (prior && prior.status === 'committed') {
      results.push(await verifyCommittedBatch(client, runId, batch));
      continue;
    }
    const written = await runBatch(client, {runId, batch, sourceFingerprint});
    results.push(written);
    if (typeof args.onBatch === 'function') {
      await args.onBatch({ordinal: batch.ordinal, kind: batch.spec.kind, rowsWritten: written.rowsWritten});
    }
  }
  return results;
}

function locatorOf(spec, key) { return ledgerLocatorOf(spec.table, key); }

/* Reads one target row by its primary key and hashes it in Node with the shared ledger contract. */
async function selectRowHashes(client, spec, columns, pkValues) {
  const result = await client.query(selectSql(spec, columns), pkValues);
  if (!result.rows.length) return null;
  return rowHashes(spec, columns, result.rows[0]);
}

/* A committed batch on a resumed or repeated run is re-verified by RECOMPUTING the row hash in Node
 * from the stored row and comparing it with the ledger entry this run wrote; no target row is
 * written. The Node-side hash is independent of session, TimeZone and jsonb rendering. */
async function verifyCommittedBatch(client, runId, batch) {
  const spec = batch.spec;
  const entries = new Map((await client.query(
    `SELECT source_locator, row_hash, target_pk_hash FROM v5_migration.row_ledger
      WHERE run_id = $1 AND batch_ordinal = $2 ORDER BY source_locator`, [runId, batch.ordinal])).rows
    .map((row) => [row.source_locator, row]));
  await withTransaction(client, async (phase) => {
    await phase.data();
    const columns = await specColumns(client, spec);
    for (const row of batch.rows) {
      const entry = entries.get(locatorOf(spec, row.key));
      if (!entry) throw fail('ROW_LEDGER_MISSING', spec.table + ':' + row.key);
      const pkValues = spec.pk.map((column) => row.values[column]);
      const actual = await selectRowHashes(client, spec, columns, pkValues);
      if (!actual) throw fail('COMMITTED_ROW_MISSING', spec.table + ':' + row.key);
      if (actual.row_hash !== entry.row_hash || actual.target_pk_hash !== entry.target_pk_hash) {
        throw fail('COMMITTED_ROW_MISMATCH', spec.table + ':' + row.key);
      }
    }
  });
  return {
    ordinal: batch.ordinal, kind: spec.kind, definitionHash: batch.definitionHash,
    status: 'committed', rowsWritten: 0, rowsVerified: batch.rows.length, attemptCount: 0,
    cursor: batch.cursor, committedRowHash: hash(batch.rows.map((row) => row.key)), verified: true
  };
}

async function runBatch(client, args) {
  const {runId, batch, sourceFingerprint} = args;
  const spec = batch.spec;
  const attempts = await startBatch(client, runId, batch);
  let written = 0;
  let verifiedRows = 0;
  let verified = 0;

  try {
    /* Runner-scoped pre-fetch: the exact source locators a same-fingerprint import already wrote.
     * This is the whole provenance domain that a row collision may legally belong to. */
    const provenance = new Set((await client.query(
      `SELECT l.source_locator FROM v5_migration.row_ledger l
         JOIN v5_migration.run r ON r.run_id = l.run_id
        WHERE l.target_table = $1 AND r.source_fingerprint = $2`,
      [spec.table, sourceFingerprint])).rows.map((row) => row.source_locator));

    await withTransaction(client, async (phase) => {
      /* Phase 1: the target family rows, as v5_owner. */
      await phase.data();
      const columns = await specColumns(client, spec);
      const insertStatement = insertSql(spec, columns);
      const plainStatement = insertPlainSql(spec, columns);
      const ledgerEntries = [];
      let insertedRows = 0;
      for (const row of batch.rows) {
        const locator = locatorOf(spec, row.key);
        const pkValues = spec.pk.map((column) => row.values[column]);
        let hashes = null;
        if (spec.uniqueKey === false) {
          hashes = await selectRowHashes(client, spec, columns, pkValues);
          const duplicates = await client.query(selectSql(spec, columns), pkValues);
          if (duplicates.rows.length > 1) throw fail('TARGET_DUPLICATE_ROW', spec.table + ':' + row.key);
        }
        if (!hashes) {
          const inserted = await client.query(
            spec.uniqueKey === false ? plainStatement : insertStatement,
            parameterValues(spec, row));
          if (inserted.rows.length) {
            /* Hash the row this statement actually produced, in Node, from the explicit column list. */
            hashes = rowHashes(spec, columns, inserted.rows[0]);
            insertedRows += 1;
          } else {
            /* ON CONFLICT DO NOTHING: the row already exists. It may only be a row a same-fingerprint
             * import already wrote; a collision with foreign or diverging state is a hard refusal,
             * never an overwrite. */
            if (!provenance.has(locator)) throw fail('ROW_NOT_CREATED_BY_RUN', spec.table + ':' + row.key);
            hashes = await selectRowHashes(client, spec, columns, pkValues);
            if (!hashes) throw fail('COMMITTED_ROW_MISSING', spec.table + ':' + row.key);
            verifiedRows += 1;
          }
        } else {
          verifiedRows += 1;
        }
        ledgerEntries.push({locator, hashes});
      }
      /* Phase 2: this run's own bookkeeping, as the trusted runner that owns v5_migration. */
      await phase.runner();
      for (const entry of ledgerEntries) {
        const prior = (await client.query(
          'SELECT row_hash, target_pk_hash FROM v5_migration.row_ledger WHERE run_id = $1 AND source_locator = $2 AND target_table = $3',
          [runId, entry.locator, spec.table])).rows[0] || null;
        if (prior && (prior.row_hash !== entry.hashes.row_hash || prior.target_pk_hash !== entry.hashes.target_pk_hash)) {
          throw fail('COMMITTED_ROW_MISMATCH', spec.table + ':' + entry.locator.slice(spec.table.length + 1));
        }
        if (!prior) {
          await client.query(
            `INSERT INTO v5_migration.row_ledger (run_id, source_locator, target_table, target_pk_hash, row_hash, batch_ordinal, written_at)
             VALUES ($1, $2, $3, $4, $5, $6, now())`,
            [runId, entry.locator, spec.table, entry.hashes.target_pk_hash, entry.hashes.row_hash, batch.ordinal]);
        }
      }
      await client.query(
        `UPDATE v5_migration.batch SET status = 'committed', cursor = $3, committed_row_hash = $4,
           rows_written = $5, attempt_count = $6, finished_at = now(), error_code = NULL
         WHERE run_id = $1 AND ordinal = $2`,
        [runId, batch.ordinal, batch.cursor, hash(batch.rows.map((row) => row.key)), insertedRows, attempts]);
      written = insertedRows;
      verified = verifiedRows;
    });
    return {
      ordinal: batch.ordinal, kind: spec.kind, definitionHash: batch.definitionHash,
      status: 'committed', rowsWritten: written, rowsVerified: verified, attemptCount: attempts,
      cursor: batch.cursor, committedRowHash: hash(batch.rows.map((row) => row.key)), verified: false
    };
  } catch (error) {
    await markBatchFailed(client, runId, batch, error);
    throw error;
  }
}

async function startBatch(client, runId, batch) {
  return withTransaction(client, async (phase) => {
    await phase.runner();
    const prior = (await client.query(
      'SELECT attempt_count FROM v5_migration.batch WHERE run_id = $1 AND ordinal = $2 FOR UPDATE',
      [runId, batch.ordinal])).rows[0] || null;
    const attempts = prior ? prior.attempt_count + 1 : 1;
    if (prior) {
      await client.query(
        `UPDATE v5_migration.batch SET status = 'running', attempt_count = $3, error_code = NULL,
           started_at = COALESCE(started_at, now()) WHERE run_id = $1 AND ordinal = $2`,
        [runId, batch.ordinal, attempts]);
    } else {
      await client.query(
        `INSERT INTO v5_migration.batch (run_id, ordinal, kind, definition_hash, cursor, status, attempt_count, started_at)
         VALUES ($1, $2, $3, $4, $5, 'running', 1, now())`,
        [runId, batch.ordinal, batch.spec.kind, batch.definitionHash, null]);
    }
    return attempts;
  });
}

async function markBatchFailed(client, runId, batch, error) {
  try {
    await withTransaction(client, async (phase) => {
      await phase.runner();
      await client.query(
        `UPDATE v5_migration.batch SET status = 'failed', error_code = $3, finished_at = now()
         WHERE run_id = $1 AND ordinal = $2`,
        [runId, batch.ordinal, String(error.code || 'LOAD_FAILED').slice(0, 100)]);
      await client.query(
        `UPDATE v5_migration.run SET status = 'failed', failure_code = $2, failure_detail = $3, finished_at = now()
         WHERE run_id = $1 AND status = 'running'`,
        [runId, String(error.code || 'LOAD_FAILED').slice(0, 100), String(error.message).slice(0, 400)]);
    });
  } catch { /* the run row already records the failure path; never mask the original error */ }
}

/* ------------------------------------------------------------------ stage 3: coverage */

async function writeCoverage(client, runId, rows) {
  const counts = {};
  for (let at = 0; at < rows.length; at += 200) {
    const slice = rows.slice(at, at + 200);
    await withTransaction(client, async (phase) => {
      await phase.runner();
      for (const row of slice) {
        const result = await client.query(
          `INSERT INTO v5_migration.coverage (run_id, locator_kind, name, key, classification, rule_id, note, observed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (run_id, locator_kind, name, key) DO NOTHING`,
          [runId, row.locatorKind, row.name, row.key, row.classification, row.ruleId, row.note]);
        if (result.rowCount) counts[row.classification] = (counts[row.classification] || 0) + 1;
      }
    });
  }
  /* Every classification observed in the ledger, including rows written by an earlier run of the
   * same id (a resume re-derives the identical locator set, so the counts are stable). */
  const all = (await client.query(
    'SELECT classification, count(*)::int AS n FROM v5_migration.coverage WHERE run_id = $1 GROUP BY classification ORDER BY classification',
    [runId])).rows;
  return Object.fromEntries(all.map((row) => [row.classification, row.n]));
}

/* ------------------------------------------------------------------ stage 4: finalise */

async function finaliseRun(client, args) {
  const {runId, model, batches, coverageCounts, guard, derived} = args;
  const rowsWritten = batches.reduce((sum, batch) => sum + batch.rowsWritten, 0);
  const rowsVerified = batches.reduce((sum, batch) => sum + (batch.rowsVerified || 0), 0);
  const verifiedFromLedger = batches.reduce((sum, batch) => sum + (batch.verified ? batch.rowsVerified : 0), 0);
  const counters = {
    loaderVersion: LOADER_VERSION,
    schemaHead: model.capture.schemaHead.maxId,
    tables: model.schema.tables.length,
    stateAccounts: model.state.parsed.accounts.length,
    stateMatches: model.state.parsed.matches.length,
    rooms: model.rooms.length,
    coverageLocators: Object.values(coverageCounts).reduce((sum, n) => sum + n, 0),
    rowsWritten,
    rowsVerified,
    rowsVerifiedFromLedger: verifiedFromLedger,
    batches: batches.length,
    derived
  };
  await withTransaction(client, async (phase) => {
    await phase.runner();
    await client.query(
      `UPDATE v5_migration.run SET status = 'committed', finished_at = now(), counters = $2::jsonb,
         failure_code = NULL, failure_detail = NULL WHERE run_id = $1`,
      [runId, JSON.stringify(counters)]);
    await client.query('UPDATE v5_migration.target_guard SET updated_at = now() WHERE target_system_id = $1',
      [guard.targetSystemId]);
  });
  return {counters, coverageCounts, targetGuard: guard};
}

/* monetization.reward_events.event_id is GENERATED ALWAYS; the explicit OVERRIDING SYSTEM VALUE
 * insert does not advance the identity sequence, so a later runtime insert would collide. The
 * sequence is advanced once past every imported event id. */
async function fixIdentitySequence(client) {
  return withTransaction(client, async (phase) => {
    await phase.data();
    const result = await client.query(
      `SELECT setval(pg_get_serial_sequence('monetization.reward_events', 'event_id'),
                     GREATEST((SELECT COALESCE(max(event_id), 0) FROM monetization.reward_events), 1),
                     (SELECT count(*) FROM monetization.reward_events) > 0) AS advanced`);
    return result.rows[0].advanced;
  }, {role: 'v5_owner'});
}

module.exports = {load, LOADER_VERSION, DEFAULT_BATCH_SIZE, KIND_ORDER, EPHEMERAL_TABLES, PROVENANCE_TABLES};
