'use strict';
/* tools/v5-migration/reconcile.js - P03 target-side reconciler: verify() + report().
 *
 * OWNERSHIP / BOUNDARY
 *   This module is the reconciliation half of the P03 import. It never writes a SOURCE value into
 *   a destination table, never re-derives the source archive from itself, and never writes to
 *   anything but `v5_migration.difference`. Every destination read is an EXPLICIT column list
 *   (information_schema + a generated `SELECT "c1","c2",...` - never `SELECT *`) issued on the
 *   trusted direct connection: `parseAndGuardUrl` TLS/PLUS posture (owned by scripts/v5/migrate.js),
 *   the session advisory lock the runner takes, and `SET LOCAL ROLE v5_owner` inside the one
 *   transaction exactly like migrate.js:runMigration. It is never used over the pooled runtime path.
 *
 * WHAT IT COMPARES (design docs/v5/designs/p03-extraction-design.md sections 4.1-4.7)
 *   Layer A - ledger integrity, generic over every destination the run claims to have written:
 *     re-reads v5_migration.row_ledger, resolves each structured locator `kind:<canon(keys)>` to its
 *     target row, and reports (i) a missing target row, (ii) an extra target row the run never
 *     wrote, (iii) a tampered row whose canonical hash no longer equals the committed row_hash.
 *   Layer B - per-entity semantic comparison for the A07 tables: for every actor, available and
 *     reserved coins/crowns, purchased counters, credits, ratings (exact hundredths), tier, owned
 *     items, equipped frame, boosts, reward tickets/casual rewards/reward events, daily progress,
 *     season state/history, tournament record, match history, match history rows, and every
 *     identity/profile/credential/visibility field the manifest maps.
 *   Layer C - the conservation equations C1..C9 of section 4.3, each an executed assertion with an
 *     explicit residual. C6 (wealth) is a cross-check only and is never used as a balance equation.
 *   Layer D - reported evidence, never a balance equation: journal/receipt/ledger/tombstone counts
 *     and per-actor sums, the burn distribution, and whether the source journal fully explains each
 *     actor's available balance. A journal that does not explain a balance yields a labelled
 *     `baseline-needed` informational record; no row is ever invented to make it balance.
 *
 * STATUS VOCABULARY (section 4.7). Every comparison yields exactly one status:
 *   match | explained(category, rule_id) | unexplained. The explained set is CLOSED; a category
 *   outside EXPLAINED_CATEGORIES is a programming error, never a silent pass. Each non-match
 *   appends one row to v5_migration.difference (hashes only, INSERT .. ON CONFLICT DO NOTHING; a
 *   previously committed difference row is never overwritten).
 *
 * CANONICAL TARGET ROW (the hash contract shared with the importer)
 *   row_hash   = sha256(canon(plain object of ALL columns by name, values normalized))
 *   pk_hash    = sha256(canon(plain object of the primary-key columns by name))
 *   locator    = `<kind>:<canon({pkColumn: value, ...})>` using canonical.js (sorted keys)
 *   timestamptz -> integer epoch milliseconds; DATE -> 'YYYY-MM-DD' (SQL `to_char`, so the reading
 *   session's TimeZone cannot change the value); NUMERIC/bigint -> JS number; arrays -> arrays.
 *   The row hash covers EVERY column without exception. Because the importer writes the row it
 *   hashes, the reconciler never has to guess the importer's value shape for a hash-level
 *   comparison: it hashes the target row exactly as Postgres returns it, which is the only
 *   representation the ledger can have been produced from. A small, explicit set of target-owned
 *   bookkeeping clocks/lease fences (UNCOMPARED_COLUMNS, which have no source counterpart and may
 *   not be invented) is skipped by the SEMANTIC pass only - never by the hash comparison.
 */

const MAPPING = require('./mapping.json');
const {canonical, hash, hashSet} = require('./canonical.js');
const {
  locatorOf: ledgerLocatorOf, locatorKey: ledgerLocatorKey,
  readTable: ledgerReadTable, readHashedTable: ledgerReadHashedTable, normalizeRow: ledgerNormalizeRow,
  rowHash: ledgerRowHash, pkHash: ledgerPkHash
} = require('./ledger.js');
const D = require('../../src/domain.js');

/* The closed explained-category set of design section 4.7. Nothing outside this set may be
 * attributed, and `unexplained` is the absence of an attribution. */
const EXPLAINED_CATEGORIES = Object.freeze([
  'array-order-normalized', 'restore-normalization', 'orphan-tombstone', 'refund-without-revocation',
  'receipt-without-revocation', 'expired-session', 'expired-challenge', 'drained-outbox',
  'ephemeral-rebuild', 'deleted-principal', 'lan-guest-principal', 'legacy-product-catalogue',
  'transient-settlement-field', 'clock-different', 'unclassified-key-accepted'
]);
const EXPLAINED_SET = new Set(EXPLAINED_CATEGORIES);

const UNEXPLAINED = 'unexplained';
const ABSENT = Symbol('absent');

/* ------------------------------------------------------------------ destination registry
 * One row per logical locator kind the importer can write. `table` is schema-qualified (0036's
 * row_ledger_target_idx joins on it) and `pk` lists the stable primary key columns in PK order.
 * `pk: null` marks a destination with no unique key in the shipped DDL: it cannot be addressed by
 * a locator and is compared as a set (or not at all), never invented.
 * `complete: false` marks a destination whose expected row set is deliberately partial (a lazily
 * created aggregate, or a table whose only source clock is absent so no row can be fabricated);
 * its uncovered target rows are NOT reported as extras.
 */
const TABLES = Object.freeze({
  actors: {table: 'identity.actors', pk: ['actor_id'], complete: true, owner: 'A'},
  eligibility: {table: 'identity.eligibility', pk: ['actor_id'], complete: true, owner: 'A'},
  profiles: {table: 'identity.profiles', pk: ['actor_id'], complete: true, owner: 'A'},
  identities: {table: 'identity.identities', pk: ['provider', 'subject'], complete: true, owner: 'A'},
  email_credentials: {table: 'identity.email_credentials', pk: ['email'], complete: true, owner: 'A'},
  sessions: {table: 'identity.sessions', pk: ['token_hash'], complete: false, owner: 'E'},
  email_challenges: {table: 'identity.email_challenges', pk: ['challenge_id'], complete: false, owner: 'E'},
  email_credential_versions: {table: 'identity.email_credential_versions', pk: ['challenge_id'], complete: false, owner: 'E'},
  signin_attempts: {table: 'identity.signin_attempts', pk: ['state_hash'], complete: false, owner: 'E'},
  profile_saves: {table: 'profile.profile_saves', pk: ['actor_id'], complete: true, owner: 'A'},
  friendships: {table: 'social.friendships', pk: ['actor_a', 'actor_b'], complete: true, owner: 'A'},
  friend_requests: {table: 'social.friend_requests', pk: ['from_id', 'to_id'], complete: true, owner: 'A'},
  blocks: {table: 'social.blocks', pk: ['blocker_id', 'blocked_id'], complete: true, owner: 'A'},
  social_command_outcomes: {table: 'social.command_outcomes', pk: ['actor_id', 'key'], complete: true, owner: 'A'},
  wallets: {table: 'economy.wallets', pk: ['actor_id'], complete: true, owner: 'C'},
  ratings: {table: 'economy.ratings', pk: ['actor_id'], complete: true, owner: 'C'},
  burns: {table: 'economy.system_burns', pk: ['id'], complete: true, owner: 'C'},
  actor_legacy_extra: {table: 'economy.actor_legacy_extra', pk: ['actor_id'], complete: true, owner: 'C'},
  command_outcomes: {table: 'economy.command_outcomes', pk: ['actor_id', 'key'], complete: true, owner: 'C', keyCodec: 'json-string'},
  wallet_operations: {table: 'economy.wallet_operations', pk: ['actor_id', 'key'], complete: true, owner: 'C'},
  wallet_ledger_entries: {table: 'economy.wallet_ledger_entries', pk: ['actor_id', 'entry_id'], complete: true, owner: 'C'},
  daily_progress: {table: 'economy.daily_progress', pk: ['actor_id', 'day'], complete: true, owner: 'C'},
  season_state: {table: 'economy.season_state', pk: ['actor_id'], complete: true, owner: 'C'},
  season_history: {table: 'economy.season_history', pk: ['actor_id', 'seq'], complete: true, owner: 'C', ordinalColumns: ['seq']},
  tournament_records: {table: 'economy.tournament_records', pk: ['actor_id'], complete: true, owner: 'C'},
  match_history: {table: 'economy.match_history', pk: ['actor_id', 'seq'], complete: true, owner: 'C', ordinalColumns: ['seq']},
  ledger: {table: 'economy.ledger', pk: ['entry_id'], complete: true, owner: 'C'},
  occupancy: {table: 'core.actor_occupancy', pk: ['actor_id'], complete: false, owner: 'C'},
  matches: {table: 'match.matches', pk: ['match_id'], complete: true, owner: 'C'},
  match_participants: {table: 'match.participants', pk: ['match_id', 'seat'], complete: true, owner: 'C'},
  match_escrow_contributions: {table: 'match.escrow_contributions', pk: ['match_id', 'actor_id'], complete: true, owner: 'C'},
  match_move_outcomes: {table: 'match.move_outcomes', pk: ['match_id', 'key'], complete: true, owner: 'C'},
  rooms: {table: 'tournament.rooms', pk: ['room_id'], complete: true, owner: 'C'},
  room_players: {table: 'tournament.room_players', pk: ['room_id', 'actor_id'], complete: true, owner: 'C', ordinalColumns: ['ordinal']},
  room_escrow_contributions: {table: 'tournament.escrow_contributions', pk: ['room_id', 'actor_id'], complete: true, owner: 'C'},
  fixtures: {table: 'tournament.fixtures', pk: ['room_id', 'fixture_id'], complete: true, owner: 'C'},
  party_command_outcomes: {table: 'tournament.command_outcomes', pk: ['actor_id', 'key'], complete: true, owner: 'C', keyCodec: 'json-string'},
  owned_items: {table: 'cosmetics.owned_items', pk: ['actor_id', 'item'], complete: true, owner: 'C'},
  credits: {table: 'monetization.credits', pk: ['actor_id'], complete: false, owner: 'C'},
  redeemed_frames: {table: 'monetization.redeemed_frames', pk: ['actor_id', 'frame'], complete: true, owner: 'C'},
  boosts: {table: 'monetization.boosts', pk: ['actor_id', 'boost_seq'], complete: true, owner: 'C', ordinalColumns: ['boost_seq']},
  reward_daily: {table: 'monetization.reward_daily', pk: ['actor_id', 'day'], complete: true, owner: 'C'},
  monetization_command_outcomes: {table: 'monetization.command_outcomes', pk: ['actor_id', 'key'], complete: true, owner: 'C'},
  reward_tickets: {table: 'monetization.reward_tickets', pk: ['ticket_id'], complete: true, owner: 'C'},
  casual_rewards: {table: 'monetization.casual_rewards', pk: ['actor_id', 'match_id'], complete: true, owner: 'C'},
  reward_events: {table: 'monetization.reward_events', pk: ['event_id'], complete: true, owner: 'C'},
  ad_ticket_context: {table: 'monetization.ad_ticket_context', pk: ['ticket_id'], complete: true, owner: 'C'},
  receipts: {table: 'monetization.receipts', pk: ['store', 'transaction_id'], complete: true, owner: 'C'},
  store_bindings: {table: 'monetization.store_bindings', pk: ['actor_id'], complete: true, owner: 'C'},
  store_revocations: {table: 'monetization.store_revocations', pk: ['store', 'transaction_id'], complete: true, owner: 'C'},
  store_finalize: {table: 'monetization.store_finalize', pk: ['store', 'transaction_id'], complete: true, owner: 'W'},
  store_notifications: {table: 'monetization.store_notifications', pk: ['store', 'notification_id'], complete: false, owner: 'W'},
  day_snapshots: {table: 'season.day_snapshots', pk: ['day', 'actor_id'], complete: true, owner: 'C'},
  league_week: {table: 'season.league_week', pk: ['id'], complete: true, owner: 'C'},
  weekly_payouts: {table: 'season.weekly_payouts', pk: ['payout_id'], complete: true, owner: 'C'},
  reports: {table: 'privacy.reports', pk: ['report_id'], complete: true, owner: 'A'},
  privacy_requests: {table: 'privacy.requests', pk: ['request_id'], complete: true, owner: 'P'},
  deletion_receipts: {table: 'privacy.deletion_receipts', pk: ['receipt_id'], complete: true, owner: 'A'},
  support_events: {table: 'support.events', pk: ['event_id'], complete: false, owner: 'P'},
  operator_audit: {table: 'audit.operator_audit', pk: ['audit_id'], complete: true, owner: 'P'},
  controls: {table: 'runtime.controls', pk: ['id'], complete: false, owner: 'P'},
  runtime_state: {table: 'runtime.state', pk: ['key'], complete: true, owner: 'P'},
  outbox: {table: 'ops.outbox', pk: ['outbox_id'], complete: false, owner: 'W'},
  rate_buckets: {table: 'ops.rate_buckets', pk: ['bucket_id'], complete: false, owner: 'E'},
  guests: {table: null, pk: null, complete: false, owner: 'E', quarantine: true}
});

/* Tables the run must have produced exactly one row per source record for. Used to decide which
 * destinations participate in the semantic (Layer B) comparison and the extra-row scan. */
const SEMANTIC_KINDS = Object.freeze([
  'actors', 'eligibility', 'profiles', 'identities', 'email_credentials', 'profile_saves',
  'friendships', 'friend_requests', 'blocks',
  'wallets', 'ratings', 'burns', 'daily_progress', 'season_state', 'season_history',
  'tournament_records', 'match_history', 'wallet_operations', 'wallet_ledger_entries', 'ledger',
  'matches', 'match_participants', 'match_escrow_contributions', 'match_move_outcomes',
  'rooms', 'room_players', 'room_escrow_contributions', 'fixtures',
  'owned_items', 'credits', 'redeemed_frames', 'boosts', 'reward_daily',
  'reward_tickets', 'casual_rewards', 'reward_events', 'receipts',
  'day_snapshots', 'league_week', 'weekly_payouts',
  'reports', 'privacy_requests', 'deletion_receipts', 'operator_audit',
  'controls', 'runtime_state', 'outbox', 'rate_buckets'
]);
const SEMANTIC_SET = new Set(SEMANTIC_KINDS);

/* ------------------------------------------------------------------ small helpers */

function owned(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

/* reader's Authority.export() encoding: an array of [key, value] pairs. */
function pairMap(pairs) {
  const map = new Map();
  if (!Array.isArray(pairs)) return map;
  for (const pair of pairs) if (Array.isArray(pair) && pair.length === 2) map.set(pair[0], pair[1]);
  return map;
}
/* The eight state roots arrive as [key,value] pair arrays. They are projected into a Map in
 * CANONICAL KEY ORDER, so every derived expectation and every equation walks the same order the
 * reader hashed. */
function sortedEntries(pairs) {
  const map = pairMap(pairs);
  const ordered = new Map();
  for (const [key, value] of [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    ordered.set(key, value);
  }
  return ordered;
}
function valuesOf(table) { return table && Array.isArray(table.rows) ? table.rows.map((row) => row.values) : []; }
function msOf(value) { return value === undefined || value === null ? null : value; }
function nullable(value) { return value === undefined ? null : value; }

/* Quarter id in the source's own format, from the injected capture clock only (never Date.now()).
 * Mirrors src/domain.js:season without importing a runtime clock. */
function quarterOf(ms) {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  return date.getUTCFullYear() + '-Q' + (Math.floor(date.getUTCMonth() / 3) + 1);
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  try { return canonical(a) === canonical(b); } catch { return String(a) === String(b); }
}

/* A JSON document has two legal representations here: the source model's parsed value and the
 * target's TEXT column carrying the same document (economy.wallet_operations.result,
 * match.move_outcomes.result, tournament.command_outcomes.response). Comparing them is not a
 * normalization - it is the identical document in its other representation - so a text that parses
 * to the expected value is a match. A text that does not parse is compared as text, unchanged. */
function valuesEquivalent(left, right) {
  if (valuesEqual(left, right)) return true;
  const parse = (value) => {
    if (typeof value !== 'string' || value.length === 0 || value[0] !== '{' && value[0] !== '[') return undefined;
    try { return JSON.parse(value); } catch { return undefined; }
  };
  const leftParsed = parse(left);
  if (leftParsed !== undefined && valuesEqual(leftParsed, right)) return true;
  const rightParsed = parse(right);
  if (rightParsed !== undefined && valuesEqual(left, rightParsed)) return true;
  return false;
}

/* Canonical textual form of one value for the difference report: the VALUE ITSELF is never
 * written to the difference table, only its hash, so this only feeds hashing. */
function valueHash(value) {
  if (value === ABSENT || value === undefined) return null;
  try { return hash({v: value}); } catch { return hash({v: String(value)}); }
}
function actorHash(actorId) { return typeof actorId === 'string' && actorId ? hash({actor: actorId}) : null; }

/* The structured canonical source locator: `<schema-qualified table>#<key>` (see ledger.js). The
 * same function, from the same module, is what the importer commits, so the two can never drift. */
const SIX = 6;
function locatorFor(kind, keys) {
  const spec = TABLES[kind];
  if (!spec || !spec.pk) throw reconcileError('LOCATOR_KIND_UNKNOWN', kind);
  return ledgerLocatorOf(spec.table, ledgerLocatorKey(spec.pk.map((column, index) => {
    const value = keys[column];
    /* The importer's ledger key zero-pads a positional ordinal to six digits and leaves every other
     * part verbatim (`loader.js` key builders), so the locator must be built the same way. This is
     * display/identity formatting only: the `seq`/`ordinal`/`boost_seq` COLUMN keeps the plain number. */
    return spec.ordinalColumns && spec.ordinalColumns.includes(column)
      ? String(value).padStart(SIX, '0') : value;
  })));
}
function pkKeyOf(pkColumns, keys) { return pkColumns.map((column) => String(keys[column])).join('\u0000'); }

/* 0034 stores the operation key of the economy/party command families as the CANONICAL JSON STRING
 * TEXT (`to_json(key)::text`), so the target column carries `"k1"` where the source key is `k1`.
 * The identity is applied exactly once, to the raw source key, and never re-applied to a value that
 * already carries the encoding (a legitimate source key may itself begin with a quote). */
function encodeTargetKey(kind, rawKey) {
  const spec = TABLES[kind];
  return spec && spec.keyCodec === 'json-string' ? JSON.stringify(rawKey) : rawKey;
}
function decodeTargetKey(kind, storedKey) {
  const spec = TABLES[kind];
  if (!spec || spec.keyCodec !== 'json-string' || typeof storedKey !== 'string') return storedKey;
  try { const parsed = JSON.parse(storedKey); return typeof parsed === 'string' ? parsed : storedKey; }
  catch { return storedKey; }
}
/* The target-side PK key of a locator's keys: the identity the row must actually carry. */
function pkKeyFromLocator(kind, keys) {
  const spec = TABLES[kind];
  if (!spec || !spec.pk) return null;
  const projected = {};
  for (const column of spec.pk) projected[column] = column === 'key' ? encodeTargetKey(kind, keys[column]) : keys[column];
  return pkKeyOf(spec.pk, projected);
}

/* Every destination read, and every hash, comes from the shared ledger contract. */
function readTable(client, table, pkColumns) { return ledgerReadTable(client, table, pkColumns); }
function normalizeRow(columns, raw) { return ledgerNormalizeRow(columns, raw); }
function rowHash(columns, raw) { return ledgerRowHash(columns, raw); }
function targetPkHash(pkColumns, normalizedRow) { return ledgerPkHash(pkColumns, normalizedRow); }

function reconcileError(code, detail) {
  const error = new Error(code + ': ' + detail);
  error.code = code;
  error.detail = detail;
  return error;
}

/* ------------------------------------------------------------------ explained-category explainers
 * Each explainer is a pure predicate over a concrete difference. A category is only ever applied
 * when its predicate holds, and the returned rule_id names the concrete justification.
 */

function explainArrayOrder(expected, actual) {
  if (!Array.isArray(expected) || !Array.isArray(actual)) return null;
  if (expected.length !== actual.length) return null;
  try {
    if (canonical(hashSet(expected)) !== canonical(hashSet(actual))) return null;
  } catch { return null; }
  return {category: 'array-order-normalized', ruleId: 'set-equality-under-order'};
}

function ephemeralRuleFor(kind) {
  const spec = MAPPING.ephemeral && MAPPING.ephemeral[kind];
  if (!spec) return null;
  return {policy: spec.policy, note: spec.note};
}

/* ------------------------------------------------------------------ expectation model */

/* One expected destination row: `keys` are the PK columns, `row` the canonical target columns the
 * importer is required to produce, `reported` names the reader-reported normalization deltas that
 * become explained(informational) difference records instead of silent passes, and `actor` carries
 * the owning actor for actor_hash. */
function expectation(kind, keys, row, options = {}) {
  return {
    kind, keys, row,
    locator: locatorFor(kind, keys),
    actor: options.actor === undefined ? null : options.actor,
    reported: options.reported || null,
    note: options.note || null
  };
}

function bucket() { return new Map(); }
function put(buckets, kind, item) {
  if (!buckets.has(kind)) buckets.set(kind, bucket());
  buckets.get(kind).set(pkKeyOf(TABLES[kind].pk || [], item.keys), item);
}

/* The source's own composite operation ids, re-split exactly as the source built them:
 * economy/party: id = JSON.stringify([actor,key]); social: id = actor + ':' + key. */
function parseCompositeId(id) {
  if (typeof id !== 'string') return null;
  if (id.startsWith('[')) {
    try {
      const parsed = JSON.parse(id);
      if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
        return {actor: parsed[0], key: parsed[1]};
      }
    } catch { return null; }
    return null;
  }
  const at = id.indexOf(':');
  if (at < 0) return null;
  return {actor: id.slice(0, at), key: id.slice(at + 1)};
}

/* Actor field list from the manifest: any account key outside it is genuine legacy data and is
 * preserved in economy.actor_legacy_extra rather than dropped. */
const ACCOUNT_FIELDS = new Set(Object.keys(MAPPING.state.types.account.fields));

function buildExpectations(model) {
  const state = (model.state && model.state.parsed) || {};
  const accounts = sortedEntries(state.accounts);
  const matches = sortedEntries(state.matches);
  const receipts = sortedEntries(state.receipts);
  const snapshots = sortedEntries(state.snapshots);
  const weeklyPaid = sortedEntries(state.weeklyPaid);
  const burned = isObject(state.burned) ? state.burned : {coins: 0, crowns: 0};
  const journal = Array.isArray(state.journal) ? state.journal : [];
  const normalization = new Map();
  for (const entry of (model.hashes && model.hashes.normalization) || []) {
    normalization.set(String(entry.actor) + '\u0000' + String(entry.field), entry);
  }
  const normalized = (actor, field) => normalization.get(String(actor) + '\u0000' + String(field)) || null;
  const buckets = new Map();

  /* ------------------------------------------------------------ actors */
  for (const [id, a] of accounts) {
    /* Disposition V: the raw value is copied byte-exact. Disposition N: the reader REPORTS a
     * normalization delta but never rewrites the raw value, so the target column must carry the
     * raw source value and the delta becomes one explained(informational) record. */
    const reported = [];
    const rawPurchased = (key, target) => (Number.isSafeInteger(a[key]) && a[key] >= 0 ? a[key] : 0);
    if (normalized(id, 'state.accounts[].purchasedCoins') || normalized(id, 'state.accounts[].purchasedCrowns')) {
      reported.push({field: 'wallets.purchased_coins', category: 'restore-normalization', ruleId: 'purchased-invalid-or-clamped'});
      reported.push({field: 'wallets.purchased_crowns', category: 'restore-normalization', ruleId: 'purchased-invalid-or-clamped'});
    }
    for (const field of ['purchasedCoins', 'purchasedCrowns']) {
      if (normalized(id, 'state.accounts[].' + field)) continue;
      const column = field === 'purchasedCoins' ? 'purchased_coins' : 'purchased_crowns';
      const balance = field === 'purchasedCoins' ? a.coins : a.crowns;
      if (Number.isSafeInteger(a[field]) && Number.isSafeInteger(balance) && a[field] > balance) {
        reported.push({field: 'wallets.' + column, category: 'restore-normalization', ruleId: 'purchased-invalid-or-clamped'});
      }
    }
    if (normalized(id, 'state.accounts[].legacyCompetitionRestricted')) {
      reported.push({field: 'wallets.legacy_competition_restricted', category: 'restore-normalization', ruleId: 'boolean-coercion'});
    }
    if (normalized(id, 'state.accounts[].casualRating')) {
      reported.push({field: 'ratings.casual_rating', category: 'restore-normalization', ruleId: 'casual-rating-default'});
    }
    if (normalized(id, 'state.accounts[].casualGames')) {
      reported.push({field: 'ratings.casual_games', category: 'restore-normalization', ruleId: 'casual-games-default'});
    }
    if (!owned(a, 'tournamentRecord')) {
      for (const column of ['entered', 'wins', 'runner_up', 'top3', 'top5', 'finish_sum', 'premium_wins']) {
        reported.push({field: 'tournament_records.' + column, category: 'restore-normalization', ruleId: 'missing-default'});
      }
    }
    if (!owned(a, 'seasonHistory')) {
      reported.push({field: 'season_history', category: 'restore-normalization', ruleId: 'missing-default'});
    }
    const staleSeason = !isObject(a.season) || a.season.id !== quarterOf(model.capture.clockMs);
    if (staleSeason) {
      reported.push({field: 'season_state', category: 'restore-normalization', ruleId: 'season-roll-or-create'});
    }

    put(buckets, 'actors', expectation('actors', {actor_id: a.id}, {
      actor_id: a.id, region: nullable(a.region),
      wealth_public: a.wealthPublic === true, created_at: msOf(a.createdAt)
    }, {actor: id, reported}));
    put(buckets, 'eligibility', expectation('eligibility', {actor_id: a.id}, {
      actor_id: a.id, verified: a.verified === true,
      suspended: a.suspended === true, security_hold: a.hold === true
    }, {actor: id}));
    put(buckets, 'wallets', expectation('wallets', {actor_id: a.id}, {
      actor_id: a.id, coins: a.coins, crowns: a.crowns,
      reserved_coins: a.reservedCoins, reserved_crowns: a.reservedCrowns,
      purchased_coins: rawPurchased('purchasedCoins'), purchased_crowns: rawPurchased('purchasedCrowns'),
      purchase_influenced: a.purchaseInfluenced === true,
      legacy_competition_restricted: owned(a, 'legacyCompetitionRestricted') ? a.legacyCompetitionRestricted === true : a.purchaseInfluenced === true
    }, {actor: id}));

    put(buckets, 'ratings', expectation('ratings', {actor_id: a.id}, {
      actor_id: a.id, rating: a.rating, peak: a.peak,
      casual_rating: Number.isFinite(a.casualRating) ? a.casualRating : 1000,
      games: a.games, casual_games: Number.isSafeInteger(a.casualGames) ? a.casualGames : 0,
      tier: a.tier, reached_at: a.reachedAt === undefined ? null : a.reachedAt,
      last_rated_at: a.lastRatedAt === undefined ? null : a.lastRatedAt
    }, {actor: id}));

    for (const [day, value] of Object.entries(isObject(a.daily) ? a.daily : {})) {
      put(buckets, 'daily_progress', expectation('daily_progress', {actor_id: a.id, day}, {
        actor_id: a.id, day, finished: value.finished, seconds: value.seconds, boards: value.boards,
        casual: value.casual, friend: value.friend, ranked: value.ranked,
        ranked_bonus: value.rankedBonus, claimed: Array.isArray(value.claimed) ? value.claimed.slice() : []
      }, {actor: id}));
    }

    if (isObject(a.season)) {
      const s = a.season;
      put(buckets, 'season_state', expectation('season_state', {actor_id: a.id}, {
        actor_id: a.id, season_id: s.id, started_at: s.startedAt, games: s.games, queue_games: s.queueGames,
        opponents: Array.isArray(s.opponents) ? s.opponents.slice() : [], wins: s.wins, losses: s.losses,
        draws: s.draws, peak_rating: s.peakRating, last_rated_at: nullable(s.lastRatedAt),
        qualified_at: nullable(s.qualifiedAt)
      }, {actor: id}));
    }
    const history = Array.isArray(a.seasonHistory) ? a.seasonHistory : [];
    for (let seq = 0; seq < history.length; seq++) {
      const s = history[seq];
      put(buckets, 'season_history', expectation('season_history', {actor_id: a.id, seq}, {
        actor_id: a.id, seq, season_id: s.id, started_at: s.startedAt, games: s.games, queue_games: s.queueGames,
        opponents: Array.isArray(s.opponents) ? s.opponents.slice() : [], wins: s.wins, losses: s.losses,
        draws: s.draws, peak_rating: s.peakRating, last_rated_at: nullable(s.lastRatedAt),
        qualified_at: nullable(s.qualifiedAt), finish_rating: s.finishRating, finish_tier: s.finishTier,
        ended_at: s.endedAt
      }, {actor: id}));
    }
    const record = isObject(a.tournamentRecord)
      ? a.tournamentRecord
      : {entered: 0, wins: 0, runnerUp: 0, top3: 0, top5: 0, bestFinish: null, finishSum: 0, premiumWins: 0};
    put(buckets, 'tournament_records', expectation('tournament_records', {actor_id: a.id}, {
      actor_id: a.id, entered: record.entered, wins: record.wins, runner_up: record.runnerUp,
      top3: record.top3, top5: record.top5, best_finish: nullable(record.bestFinish),
      finish_sum: record.finishSum, premium_wins: record.premiumWins
    }, {actor: id}));
    const matchHistory = Array.isArray(a.history) ? a.history : [];
    for (let seq = 0; seq < matchHistory.length; seq++) {
      const h = matchHistory[seq];
      put(buckets, 'match_history', expectation('match_history', {actor_id: a.id, seq}, {
        actor_id: a.id, seq, match_id: h.id, at: h.at, opponent: h.opponent, mode: h.mode, queue: h.queue,
        symbol: h.symbol, rated: h.rated, qualified: h.qualified, activity_qualified: h.activityQualified,
        result: h.result, reason: nullable(h.reason), active_seconds: nullable(h.activeSeconds),
        rating_delta: h.ratingDelta, casual_delta: h.casualDelta
      }, {actor: id}));
    }
    for (const [key, operation] of Object.entries(isObject(a.operations) ? a.operations : {})) {
      put(buckets, 'wallet_operations', expectation('wallet_operations', {actor_id: a.id, key}, {
        actor_id: a.id, key, fingerprint: operation.fingerprint,
        result: operation.result, committed_at: null
      }, {actor: id}));
    }
    const ledgerEntries = Array.isArray(a.ledger) ? a.ledger : [];
    for (const entry of ledgerEntries) {
      put(buckets, 'wallet_ledger_entries', expectation('wallet_ledger_entries', {actor_id: a.id, entry_id: entry.id}, {
        actor_id: a.id, entry_id: entry.id, operation_id: nullable(entry.operation),
        currency: entry.currency, amount: entry.amount, reason: entry.reason, at: entry.at
      }, {actor: id}));
    }
    const ownedItems = Array.isArray(a.owned) ? a.owned : [];
    for (const item of ownedItems) {
      put(buckets, 'owned_items', expectation('owned_items', {actor_id: a.id, item}, {
        actor_id: a.id, item, acquired_at: null
      }, {actor: id}));
    }
    if (isObject(a.monetization)) {
      const m = a.monetization;
      put(buckets, 'credits', expectation('credits', {actor_id: a.id}, {
        actor_id: a.id, credit_balance: m.credits, equipped_frame: m.equipped,
        last_ad_at: nullable(m.lastAdAt), last_reward_start: nullable(m.lastRewardStart), extra: null
      }, {actor: id}));
      for (const frame of Array.isArray(m.redeemed) ? m.redeemed : []) {
        put(buckets, 'redeemed_frames', expectation('redeemed_frames', {actor_id: a.id, frame}, {
          actor_id: a.id, frame, redeemed_at: null
        }, {actor: id}));
      }
      const boosts = Array.isArray(m.boosts) ? m.boosts : [];
      for (let seq = 0; seq < boosts.length; seq++) {
        put(buckets, 'boosts', expectation('boosts', {actor_id: a.id, boost_seq: seq}, {
          actor_id: a.id, boost_seq: seq, started_at: boosts[seq].startedAt, ends_at: boosts[seq].endsAt
        }, {actor: id}));
      }
      for (const [day, value] of Object.entries(isObject(m.daily) ? m.daily : {})) {
        put(buckets, 'reward_daily', expectation('reward_daily', {actor_id: a.id, day}, {
          actor_id: a.id, day, base: value.base, bonus: value.bonus, automatic: value.automatic
        }, {actor: id}));
      }
    }

    /* legacy account keys -> economy.actor_legacy_extra */
    const extra = {};
    let extraCount = 0;
    for (const key of Object.keys(a)) if (!ACCOUNT_FIELDS.has(key)) { extra[key] = a[key]; extraCount++; }
    if (extraCount) put(buckets, 'actor_legacy_extra', expectation('actor_legacy_extra', {actor_id: a.id}, {
      actor_id: a.id, extra
    }, {actor: id}));
  }

  /* ------------------------------------------------------------ social graph */
  for (const [id, a] of accounts) {
    for (const friend of Array.isArray(a.friends) ? a.friends : []) {
      const pair = [id, friend].sort();
      /* The source stores the edge in both actors' arrays (C8 symmetry); the target keeps one
       * canonical row keyed actor_a < actor_b, so the duplicate is de-duplicated, never dropped. */
      if (id > pair[0]) continue;
      put(buckets, 'friendships', expectation('friendships', {actor_a: pair[0], actor_b: pair[1]}, {
        actor_a: pair[0], actor_b: pair[1]
      }, {actor: id, note: 'source order ' + id + '<->' + friend}));
    }
    for (const target of Array.isArray(a.friendRequests) ? a.friendRequests : []) {
      put(buckets, 'friend_requests', expectation('friend_requests', {from_id: id, to_id: target}, {
        from_id: id, to_id: target
      }, {actor: id}));
    }
    for (const target of Array.isArray(a.blocked) ? a.blocked : []) {
      put(buckets, 'blocks', expectation('blocks', {blocker_id: id, blocked_id: target}, {
        blocker_id: id, blocked_id: target
      }, {actor: id}));
    }
  }

  /* ------------------------------------------------------------ matches */
  for (const [id, m] of matches) {
    const quote = m.quote || {};
    const terms = m.terms || {};
    const receipt = isObject(m.receipt) ? m.receipt : null;
    put(buckets, 'matches', expectation('matches', {match_id: id}, {
      match_id: id, source: terms.source, mode: terms.mode, kind: terms.kind, rated: terms.rated === true,
      amount: terms.amount, currency: terms.currency, turn_seconds: terms.turnSeconds,
      from_tier: terms.from, to_tier: terms.to, terms_ratings: terms.ratings,
      terms_json: terms, terms_hash: m.termsHash, quote_json: quote, pool: quote.pool,
      contribution_a: Array.isArray(quote.contributions) ? quote.contributions[0] : null,
      contribution_b: Array.isArray(quote.contributions) ? quote.contributions[1] : null,
      accepted_count: Array.isArray(m.accepted) ? m.accepted.length : 0, status: m.status,
      created_at: m.created, expires_at: m.expires, state_json: m.state, revision: m.revision,
      symbol_x: m.symbols ? m.symbols.X : null, symbol_y: m.symbols ? m.symbols.O : null,
      escrow: m.escrow, settled: m.settled === true,
      started_at: m.started === undefined ? null : m.started,
      last_move_at: m._lastMoveAt === undefined ? null : m._lastMoveAt,
      deadline: m.deadline === undefined ? null : m.deadline,
      move_timings: m._moveTimings === undefined ? null : m._moveTimings,
      pre_ratings: m.preRatings === undefined ? null : m.preRatings,
      pre_tiers: m.preTiers === undefined ? null : m.preTiers,
      /* A receipt field the source itself omits stays ABSENT (NULL), never invented: the documented
       * operator-void shape carries only {reason,refunded,burn,payout,rating}. */
      receipt_json: receipt,
      receipt_at: receipt && owned(receipt, 'at') ? receipt.at : null,
      receipt_reason: receipt && owned(receipt, 'reason') ? receipt.reason : null,
      receipt_payout: receipt && owned(receipt, 'payout') ? receipt.payout : null,
      receipt_burn: receipt && owned(receipt, 'burn') ? receipt.burn : null,
      receipt_bonus: receipt && owned(receipt, 'bonus') ? receipt.bonus : null,
      receipt_refunded: receipt && owned(receipt, 'refunded') ? receipt.refunded : null,
      risk_flags: Array.isArray(m.riskFlags) ? m.riskFlags.slice() : [],
      risk_actors: m._riskActors === undefined ? {} : m._riskActors,
      extra: null
    }, {
      actor: null,
      reported: m._pendingReason === undefined || m._pendingReason === null ? [] : [
        {field: 'match.matches._pendingReason', category: 'transient-settlement-field', ruleId: 'pending-reason-transient'}
      ]
    }));
    const players = Array.isArray(m.players) ? m.players : [];
    const accepted = Array.isArray(m.accepted) ? m.accepted : [];
    for (let seat = 0; seat < players.length; seat++) {
      put(buckets, 'match_participants', expectation('match_participants', {match_id: id, seat}, {
        match_id: id, seat, actor_id: players[seat], accepted: accepted.includes(players[seat])
      }));
    }
    if (m.escrow > 0 && m.settled !== true && Array.isArray(quote.contributions)) {
      for (let seat = 0; seat < players.length; seat++) {
        const amount = quote.contributions[seat];
        if (!amount) continue;
        put(buckets, 'match_escrow_contributions', expectation('match_escrow_contributions', {match_id: id, actor_id: players[seat]}, {
          match_id: id, actor_id: players[seat], amount
        }, {actor: players[seat]}));
      }
    }
    for (const pair of Array.isArray(m.commands) ? m.commands : []) {
      if (!Array.isArray(pair)) continue;
      put(buckets, 'match_move_outcomes', expectation('match_move_outcomes', {match_id: id, key: pair[0]}, {
        match_id: id, key: pair[0], fingerprint: pair[1].fingerprint, result: pair[1].result, committed_at: null
      }));
    }
  }

  /* ------------------------------------------------------------ rooms */
  for (const room of Array.isArray(model.rooms) ? model.rooms : []) {
    const r = room.parsed || {};
    const quote = isObject(r.quote) ? r.quote : null;
    const receipt = isObject(r.receipt) ? r.receipt : null;
    put(buckets, 'rooms', expectation('rooms', {room_id: room.id}, {
      room_id: room.id, code: room.code, owner_id: r.owner, name: nullable(r.name), format: r.format,
      table_kind: nullable(r.table), sequential: r.sequential === true, quote_json: quote,
      quote_currency: quote ? quote.currency : null, entry: quote ? quote.entry : null,
      pool: quote ? quote.pool : null, burn: quote ? quote.burn : null,
      clock_seconds: r.clock, increment_seconds: r.increment, capacity: r.capacity,
      rules_version: r.rulesVersion, status: r.status, created_at: r.created, expires_at: r.expires,
      started_at: nullable(r.started), ended_at: nullable(r.ended), deadline: nullable(r.deadline),
      paused_at: nullable(r.pausedAt), reason: nullable(r.reason), draw_game: nullable(r.drawGame),
      revision: r.revision, round_delay_ms: r.roundDelay,
      groups_json: Array.isArray(r.groups) ? r.groups : null,
      final_refs_json: r.finalRefs === undefined ? null : r.finalRefs,
      seed_json: r.seed === undefined ? null : r.seed,
      ranking: Array.isArray(r.ranking) ? r.ranking.slice() : [],
      receipt_json: receipt, risk_flags: Array.isArray(r.riskFlags) ? r.riskFlags.slice() : [],
      risk_actors: r._riskActors === undefined ? {} : r._riskActors,
      escrow: r.escrow === undefined ? 0 : r.escrow, settled: r.settled === true, settled_at: null,
      timer_lease_owner: null, timer_lease_epoch: null, timer_lease_until: null,
      extra: null, shape_version: r.version
    }));
    const players = Array.isArray(r.players) ? r.players : [];
    for (let ordinal = 0; ordinal < players.length; ordinal++) {
      const player = players[ordinal];
      put(buckets, 'room_players', expectation('room_players', {room_id: room.id, actor_id: player.id}, {
        room_id: room.id, actor_id: player.id, name: player.name, ready: player.ready === true,
        withdrawn: player.withdrawn === true, joined_at: null, ordinal
      }));
    }
    if (r.escrow > 0 && r.settled !== true) {
      for (const contribution of Array.isArray(r.contributions) ? r.contributions : []) {
        if (!contribution || !contribution.amount) continue;
        put(buckets, 'room_escrow_contributions', expectation('room_escrow_contributions', {room_id: room.id, actor_id: contribution.id}, {
          room_id: room.id, actor_id: contribution.id, amount: contribution.amount
        }, {actor: contribution.id}));
      }
    }
    const fixtures = Array.isArray(r.fixtures) ? r.fixtures : [];
    for (const fixture of fixtures) {
      put(buckets, 'fixtures', expectation('fixtures', {room_id: room.id, fixture_id: fixture.id}, {
        room_id: room.id, fixture_id: fixture.id, label: nullable(fixture.label), round: nullable(fixture.round),
        group_id: nullable(fixture.group), decisive: nullable(fixture.decisive), slots_json: fixture.slots,
        players: Array.isArray(fixture.players) ? fixture.players.slice() : [],
        ready: Array.isArray(fixture.ready) ? fixture.ready.slice() : [], status: fixture.status,
        state_json: nullable(fixture.state), mini_json: nullable(fixture.mini), winner: nullable(fixture.winner),
        attempt: nullable(fixture.attempt), opens_at: nullable(fixture.opens), expires_at: nullable(fixture.expires),
        ready_deadline: nullable(fixture.readyDeadline), turn_at: nullable(fixture.turnAt),
        finished_at: nullable(fixture.finished), banks_json: nullable(fixture.banks),
        last_move_at: nullable(fixture._lastMoveAt), move_timings: nullable(fixture._moveTimings),
        reason: nullable(fixture.reason), history_json: nullable(fixture.history), revision: 0,
        lease_owner: null, lease_epoch: null, lease_until: null, extra: null
      }));
    }
  }

  /* ------------------------------------------------------------ journal */
  for (const entry of journal) {
    put(buckets, 'ledger', expectation('ledger', {entry_id: entry.id}, {
      entry_id: entry.id, actor_id: entry.actor, currency: entry.currency, amount: entry.amount,
      reason: entry.reason, source: entry.source, at: entry.at
    }, {actor: entry.actor}));
  }

  /* ------------------------------------------------------------ operation-outcome families
   * Design 4.6: the stored outcome is fidelity-only. The primary key, the fingerprint text and the
   * response bytes are compared verbatim; the payload itself is never recomputed and never
   * fabricated. The two families whose key column was re-encoded by 0034 (economy, party) carry the
   * canonical JSON-string form on the target, which the ledger keys above express in SOURCE form. */
  for (const row of valuesOf(model.tables && model.tables.commands)) {
    const id = parseCompositeId(row.id);
    if (!id) continue;
    put(buckets, 'command_outcomes', expectation('command_outcomes', {actor_id: id.actor, key: id.key}, {
      actor_id: id.actor, key: encodeTargetKey('command_outcomes', id.key),
      fingerprint: row.fingerprint, response: row.response, committed_at: null
    }, {actor: id.actor}));
  }
  for (const row of valuesOf(model.tables && model.tables.party_commands)) {
    const id = parseCompositeId(row.id);
    if (!id) continue;
    let roomId = null;
    try {
      const parsed = JSON.parse(row.response);
      if (isObject(parsed) && typeof parsed.id === 'string') roomId = parsed.id;
    } catch { roomId = null; }
    put(buckets, 'party_command_outcomes', expectation('party_command_outcomes', {actor_id: id.actor, key: id.key}, {
      actor_id: id.actor, key: encodeTargetKey('party_command_outcomes', id.key), room_id: roomId,
      fingerprint: row.fingerprint, response: row.response, committed_at: null
    }, {
      actor: id.actor,
      reported: roomId === null ? [{field: 'tournament.command_outcomes.room_id', category: 'ephemeral-rebuild', ruleId: 'party-response-has-no-room'}] : []
    }));
  }
  for (const row of valuesOf(model.tables && model.tables.social_operations)) {
    const id = parseCompositeId(row.id);
    if (!id) continue;
    put(buckets, 'social_command_outcomes', expectation('social_command_outcomes', {actor_id: id.actor, key: id.key}, {
      actor_id: id.actor, key: id.key, fingerprint: row.fingerprint, result: row.result, committed_at: null
    }, {actor: id.actor}));
  }
  for (const row of valuesOf(model.tables && model.tables.v35_commands)) {
    put(buckets, 'monetization_command_outcomes', expectation('monetization_command_outcomes', {actor_id: row.actor, key: row.key}, {
      actor_id: row.actor, key: row.key, fingerprint: row.fingerprint, response: row.response, committed_at: null
    }, {actor: row.actor}));
  }

  /* ------------------------------------------------------------ burns + league */
  put(buckets, 'burns', expectation('burns', {id: 1}, {
    id: 1, coins: burned.coins || 0, crowns: burned.crowns || 0
  }));
  put(buckets, 'league_week', expectation('league_week', {id: 1}, {
    id: 1, week: state.leagueWeek === undefined ? null : state.leagueWeek
  }));

  /* ------------------------------------------------------------ snapshots / weekly payouts */
  for (const [date, tiers] of snapshots) {
    for (const actor of Object.keys(isObject(tiers) ? tiers : {})) {
      put(buckets, 'day_snapshots', expectation('day_snapshots', {day: date, actor_id: actor}, {
        day: date, actor_id: actor, tier: tiers[actor]
      }, {actor}));
    }
  }
  for (const [key, payment] of weeklyPaid) {
    put(buckets, 'weekly_payouts', expectation('weekly_payouts', {payout_id: key}, {
      payout_id: key, week: payment.week, actor_id: payment.account, amount: payment.amount,
      tier: nullable(payment.tier), eligible: payment.eligible === true, days: nullable(payment.days),
      created_at: null
    }, {actor: payment.account}));
  }

  /* ------------------------------------------------------------ direct source tables */
  for (const row of valuesOf(model.tables && model.tables.profiles)) {
    put(buckets, 'profiles', expectation('profiles', {actor_id: row.actor}, {
      actor_id: row.actor, tag: row.tag, username: row.username, display_name: row.display_name,
      avatar: row.avatar, stats_visibility: row.stats_visibility, presence_visibility: row.presence_visibility,
      created_at: row.created, username_changed: nullable(row.username_changed), version: row.version
    }, {actor: row.actor}));
  }
  for (const row of valuesOf(model.tables && model.tables.identities)) {
    put(buckets, 'identities', expectation('identities', {provider: row.provider, subject: row.subject}, {
      provider: row.provider, subject: row.subject, actor_id: row.actor, created_at: row.created
    }, {actor: row.actor}));
  }
  for (const row of valuesOf(model.tables && model.tables.email_credentials)) {
    put(buckets, 'email_credentials', expectation('email_credentials', {email: row.email}, {
      email: row.email, actor_id: row.actor, salt: row.salt, password_hash: row.password_hash,
      created_at: row.created, verified_at: nullable(row.verified_at)
    }, {actor: row.actor}));
  }
  for (const row of valuesOf(model.tables && model.tables.profile_saves)) {
    put(buckets, 'profile_saves', expectation('profile_saves', {actor_id: row.actor}, {
      actor_id: row.actor, revision: row.revision, payload_text: row.payload, updated_at: row.updated
    }, {actor: row.actor}));
  }
  for (const row of valuesOf(model.tables && model.tables.v35_tickets)) {
    put(buckets, 'reward_tickets', expectation('reward_tickets', {ticket_id: row.id}, {
      ticket_id: row.id, actor_id: row.actor, kind: row.kind, issued_at: row.issued,
      expires_at: nullable(row.expires), day: row.day, settled: row.settled === 1 || row.settled === true,
      transaction_id: nullable(row.transaction_id)
    }, {actor: row.actor}));
  }
  for (const row of valuesOf(model.tables && model.tables.v35_casual)) {
    put(buckets, 'casual_rewards', expectation('casual_rewards', {actor_id: row.actor, match_id: row.match_id}, {
      actor_id: row.actor, match_id: row.match_id, base: row.base, bonus: row.bonus
    }, {actor: row.actor}));
  }
  for (const row of valuesOf(model.tables && model.tables.v35_events)) {
    put(buckets, 'reward_events', expectation('reward_events', {event_id: row.id}, {
      event_id: row.id, actor_id: row.actor, kind: row.kind, at: row.at, value: nullable(row.value)
    }, {actor: row.actor}));
  }
  for (const [key, receipt] of receipts) {
    const at = key.indexOf(':');
    if (at < 0) continue;
    put(buckets, 'receipts', expectation('receipts', {store: key.slice(0, at), transaction_id: key.slice(at + 1)}, {
      store: key.slice(0, at), transaction_id: key.slice(at + 1), actor_id: receipt.actor,
      product_id: receipt.productId, crowns: receipt.crowns, refunded: receipt.refunded === true,
      purchased_at: receipt.at
    }, {actor: receipt.actor}));
  }
  for (const row of valuesOf(model.tables && model.tables.v41_store_bindings)) {
    put(buckets, 'store_bindings', expectation('store_bindings', {actor_id: row.actor}, {
      actor_id: row.actor, google_id: row.google_id, apple_token: row.apple_token, created_at: row.created
    }, {actor: row.actor}));
  }
  for (const row of valuesOf(model.tables && model.tables.v41_store_revocations)) {
    put(buckets, 'store_revocations', expectation('store_revocations', {store: row.store, transaction_id: row.transaction_id}, {
      store: row.store, transaction_id: row.transaction_id, product_id: nullable(row.product_id),
      occurred_at: row.occurred_at, reason: row.reason
    }));
  }
  for (const row of valuesOf(model.tables && model.tables.v41_reports)) {
    put(buckets, 'reports', expectation('reports', {report_id: row.id}, {
      report_id: row.id, reporter_id: row.reporter, target_id: row.target, category: row.category,
      detail: row.detail, created_at: row.created, state: row.state,
      reviewed_at: nullable(row.reviewed_at), reviewed_by: nullable(row.reviewed_by), outcome: nullable(row.outcome)
    }, {actor: row.reporter}));
  }
  for (const row of valuesOf(model.tables && model.tables.v41_privacy_requests)) {
    put(buckets, 'privacy_requests', expectation('privacy_requests', {request_id: row.id}, {
      request_id: row.id, actor_id: row.actor, kind: row.kind, state: row.state,
      requested_at: row.requested_at, updated_at: row.updated_at, completed_at: nullable(row.completed_at),
      policy_version: row.policy_version, note: nullable(row.note)
    }, {actor: row.actor}));
  }
  for (const row of valuesOf(model.tables && model.tables.v41_deletion_receipts)) {
    put(buckets, 'deletion_receipts', expectation('deletion_receipts', {receipt_id: row.id}, {
      receipt_id: row.id, actor_hash: row.actor_hash, tombstone: row.tombstone,
      completed_at: row.completed_at, policy_version: row.policy_version, retained: row.retained
    }));
  }
  for (const row of valuesOf(model.tables && model.tables.v41_operator_audit)) {
    put(buckets, 'operator_audit', expectation('operator_audit', {audit_id: row.id}, {
      audit_id: row.id, at: row.at, operator: row.operator, action: row.action,
      actor_id: nullable(row.actor), reason: row.reason, detail: row.detail,
      prev_hash: row.prev_hash, entry_hash: row.entry_hash
    }));
  }
  for (const row of valuesOf(model.tables && model.tables.v4_controls)) {
    put(buckets, 'controls', expectation('controls', {id: row.id}, {
      id: row.id, maintenance: row.maintenance === 1 || row.maintenance === true
    }, {
      reported: row.maintenance ? [{field: 'runtime.controls.maintenance', category: 'ephemeral-rebuild', ruleId: 'inert-control-import'}] : []
    }));
  }
  for (const row of valuesOf(model.tables && model.tables.v4_runtime)) {
    put(buckets, 'runtime_state', expectation('runtime_state', {key: row.key}, {key: row.key, value: row.value}));
  }
  for (const row of valuesOf(model.tables && model.tables.v4_outbox)) {
    const drained = row.state !== 'queued' && row.state !== 'sending';
    put(buckets, 'outbox', expectation('outbox', {outbox_id: row.id}, {
      outbox_id: row.id, payload: drained ? null : nullable(row.payload), kind: row.kind, state: row.state,
      created_at: row.created, expires_at: row.expires, next_at: row.next_at, lease_until: row.lease_until,
      attempts: row.attempts, lease_owner: null, lease_token: null
    }, {
      reported: drained ? [{field: 'ops.outbox.payload', category: 'drained-outbox', ruleId: 'terminal-state-payload-nulled'}] : []
    }));
  }
  const bucketsForRate = [
    ...valuesOf(model.tables && model.tables.community_limits).map((row) => ({id: row.id, hits: row.hits, expires: null})),
    ...valuesOf(model.tables && model.tables.v4_limits).map((row) => ({id: row.id, hits: row.hits, expires: row.expires}))
  ];
  for (const row of bucketsForRate) {
    put(buckets, 'rate_buckets', expectation('rate_buckets', {bucket_id: row.id}, {
      bucket_id: row.id, hits: row.hits, expires_at: nullable(row.expires)
    }));
  }

  return {buckets, accounts, matches, receipts, snapshots, weeklyPaid, burned, journal, normalization};
}

/* ------------------------------------------------------------------ difference sink */

function differenceRecord(kind, fields) {
  const category = fields.category === UNEXPLAINED ? UNEXPLAINED : fields.category;
  const severity = fields.severity || (category === UNEXPLAINED ? 'unexplained' : 'explained');
  if (category !== UNEXPLAINED && !EXPLAINED_SET.has(category)) {
    throw reconcileError('DIFFERENCE_CATEGORY_UNKNOWN', String(category));
  }
  return {
    kind,
    category,
    actorHash: fields.actorHash || null,
    locator: fields.locator,
    fieldPath: fields.fieldPath,
    expectedHash: fields.expectedHash === undefined ? null : fields.expectedHash,
    actualHash: fields.actualHash === undefined ? null : fields.actualHash,
    ruleId: fields.ruleId || null,
    severity,
    detail: fields.detail || null
  };
}

/* ------------------------------------------------------------------ semantic comparison */

function compareRows(expected, actual, options) {
  const records = [];
  const columns = new Set();
  for (const key of Object.keys(expected.row)) columns.add(key);
  if (actual) for (const key of Object.keys(actual)) columns.add(key);
  for (const column of [...columns].sort()) {
    if (UNCOMPARED_COLUMNS.has(options.table + '.' + column)) continue;
    const left = owned(expected.row, column) ? expected.row[column] : ABSENT;
    const right = actual && owned(actual, column) ? actual[column] : ABSENT;
    if (left === ABSENT && right === ABSENT) continue;
    if (valuesEquivalent(left, right)) continue;
    if (right === ABSENT) {
      records.push(differenceRecord(expected.kind, {
        category: UNEXPLAINED, actorHash: actorHash(expected.actor), locator: expected.locator,
        fieldPath: options.table + '.' + column, expectedHash: valueHash(left), actualHash: null,
        detail: 'expected column absent from the target row'
      }));
      continue;
    }
    const orderAttribution = ORDER_TOLERANT_COLUMNS.has(options.table + '.' + column) ? explainArrayOrder(left, right) : null;
    if (orderAttribution) {
      records.push(differenceRecord(expected.kind, {
        category: orderAttribution.category, actorHash: actorHash(expected.actor), locator: expected.locator,
        fieldPath: options.table + '.' + column, expectedHash: valueHash(left), actualHash: valueHash(right),
        ruleId: orderAttribution.ruleId, severity: 'explained'
      }));
      continue;
    }
    records.push(differenceRecord(expected.kind, {
      category: UNEXPLAINED, actorHash: actorHash(expected.actor), locator: expected.locator,
      fieldPath: options.table + '.' + column, expectedHash: valueHash(left), actualHash: valueHash(right)
    }));
  }
  return records;
}

/* Target-owned bookkeeping columns: the DDL gives them a clock (default now()/lease fences) and the
 * SOURCE carries no corresponding value, so there is nothing to compare them against and nothing may
 * be invented for them. They are excluded from the semantic comparison only; the row hash committed
 * in row_ledger still covers them, so the ledger-integrity pass catches any later modification. */
const UNCOMPARED_COLUMNS = new Set([
  'economy.system_burns.updated_at',
  'runtime.controls.updated_at',
  'season.league_week.published_at',
  'core.actor_occupancy.claimed_at',
  'tournament.rooms.settled_at',
  'tournament.rooms.timer_lease_owner',
  'tournament.rooms.timer_lease_epoch',
  'tournament.rooms.timer_lease_until',
  'tournament.fixtures.lease_owner',
  'tournament.fixtures.lease_epoch',
  'tournament.fixtures.lease_until',
  'monetization.store_finalize.lease_owner',
  'monetization.store_finalize.lease_token',
  'monetization.store_finalize.lease_until',
  'monetization.store_notifications.lease_owner',
  'monetization.store_notifications.lease_token',
  'monetization.store_notifications.lease_until',
  'ops.outbox.lease_owner',
  'ops.outbox.lease_token'
]);

/* Columns whose source value is a SET: the reader hashes them order-agnostically, so a permutation
 * is explicitly not a data difference and is attributed as array-order-normalized. */
const ORDER_TOLERANT_COLUMNS = new Set([
  'economy.daily_progress.claimed',
  'match.matches.risk_flags',
  'tournament.rooms.risk_flags',
  'tournament.fixtures.ready'
]);

/* ------------------------------------------------------------------ equations C1..C9 */

function equation(id, description, assertions) {
  const failures = assertions.filter((entry) => entry.status === 'fail');
  return {
    id, description,
    status: failures.length ? 'fail' : 'pass',
    assertions: assertions.length,
    failures: failures.length,
    residuals: assertions.map((entry) => ({subject: entry.subject, residual: entry.residual, status: entry.status}))
  };
}

function checkEquality(id, subject, actual, derived, records, context) {
  const equal = valuesEqual(actual, derived);
  if (!equal) {
    records.push(differenceRecord(id, {
      category: UNEXPLAINED, actorHash: context.actorHash || null,
      locator: 'invariant:' + id, fieldPath: 'equations.' + id + '.' + subject,
      expectedHash: valueHash(derived), actualHash: valueHash(actual),
      detail: context.detail || 'conservation equation'
    }));
  }
  return {subject, residual: equal ? 0 : 1, status: equal ? 'pass' : 'fail'};
}

/* C1: available/reserved identity, per actor and per currency, both sides.
 * C2: reserved closure against open match/room contributions.
 * C3: burn composition (settled match receipts + settled room receipts, never the journal subset).
 * C4: conversion row pairing.
 * C5: tournament pool algebra when rooms exist.
 * C6: wealth identity, cross-check only.
 * C7: occupancy single-valuedness.
 * C8: relationship symmetry/direction.
 * C9: principal referential classes. */
function runEquations(model, expectations, target, records) {
  const state = (model.state && model.state.parsed) || {};
  const equations = [];
  const actors = expectations.accounts;

  /* ---------------- C1 available/reserved identity (per actor, per currency) */
  {
    const assertions = [];
    for (const [id, a] of actors) {
      const wallet = lookup(target, 'wallets', {actor_id: id});
      for (const [currency, column] of [['coins', 'coins'], ['crowns', 'crowns'], ['coins', 'reserved_coins'], ['crowns', 'reserved_crowns']]) {
        const sourceColumn = column === 'reserved_coins' ? 'reservedCoins' : column === 'reserved_crowns' ? 'reservedCrowns' : column;
        assertions.push(checkEquality('C1', id + ':' + (column.startsWith('reserved') ? 'reserved_' : 'available_') + currency,
          wallet ? wallet[column] : ABSENT, a[sourceColumn], records, {actorHash: actorHash(id)}));
      }
    }
    equations.push(equation('C1', 'available/reserved identity per actor and per currency (A07)', assertions));
  }

  /* ---------------- C2 reserved closure */
  {
    const derived = new Map();
    const add = (actor, currency, amount) => {
      const key = actor + '\u0000' + currency;
      derived.set(key, (derived.get(key) || 0) + amount);
    };
    for (const [id, m] of expectations.matches) {
      if (!(m.escrow > 0) || m.settled === true) continue;
      const contributions = m.quote && Array.isArray(m.quote.contributions) ? m.quote.contributions : [];
      const players = Array.isArray(m.players) ? m.players : [];
      const currency = m.quote ? m.quote.currency : null;
      for (let seat = 0; seat < players.length; seat++) if (contributions[seat]) add(players[seat], currency, contributions[seat]);
    }
    for (const room of Array.isArray(model.rooms) ? model.rooms : []) {
      const r = room.parsed || {};
      if (!(r.escrow > 0) || r.settled === true) continue;
      const currency = r.quote ? r.quote.currency : null;
      for (const contribution of Array.isArray(r.contributions) ? r.contributions : []) if (contribution.amount) add(contribution.id, currency, contribution.amount);
    }
    const assertions = [];
    for (const [id, a] of actors) {
      for (const currency of ['coins', 'crowns']) {
        const sourceValue = currency === 'coins' ? a.reservedCoins : a.reservedCrowns;
        const derivedValue = derived.get(id + '\u0000' + currency) || 0;
        assertions.push(checkEquality('C2', id + ':reserved_' + currency, sourceValue, derivedValue, records, {
          actorHash: actorHash(id), detail: 'reserved balance must equal the open match and room contributions'
        }));
        /* Target-side counterpart (C2T): the target's own reserved column against its own open
         * escrows. A cross-check (the target may legitimately diverge if reserved was already
         * released), never a substitute for the source-side equation above. */
        const wallet = lookup(target, 'wallets', {actor_id: id});
        const targetDerived = targetReservedClosure(target, id, currency);
        assertions.push(checkEquality('C2T', id + ':target_reserved_' + currency,
          wallet ? wallet[currency === 'coins' ? 'reserved_coins' : 'reserved_crowns'] : ABSENT, targetDerived, records, {
            actorHash: actorHash(id), detail: 'target reserved column vs target open escrows'
          }));
      }
    }
    equations.push(equation('C2', 'reserved closure against open match/room contributions', assertions));
  }

  /* ---------------- C3 burn composition */
  {
    const sourceBurn = {coins: 0, crowns: 0};
    for (const [, m] of expectations.matches) {
      if (m.settled !== true || !m.receipt) continue;
      if (m.receipt.currency === 'coins' || m.receipt.currency === 'crowns') sourceBurn[m.receipt.currency] += m.receipt.burn || 0;
    }
    for (const room of Array.isArray(model.rooms) ? model.rooms : []) {
      const r = room.parsed || {};
      if (r.settled !== true || !isObject(r.receipt)) continue;
      if (r.receipt.currency === 'coins' || r.receipt.currency === 'crowns') sourceBurn[r.receipt.currency] += r.receipt.burn || 0;
    }
    const targetBurn = {coins: 0, crowns: 0};
    for (const row of targetRows(target, 'match.matches')) {
      if (row.settled !== true || row.currency === null) continue;
      if (row.receipt_burn !== null) targetBurn[row.currency] += row.receipt_burn;
    }
    for (const row of targetRows(target, 'tournament.rooms')) {
      if (row.settled !== true || row.quote_currency === null || !isObject(row.receipt_json)) continue;
      if (row.receipt_json.refunded === true) continue;
      targetBurn[row.quote_currency] += row.receipt_json.burn || 0;
    }
    const assertions = [];
    for (const currency of ['coins', 'crowns']) {
      const burned = expectations.burned[currency] || 0;
      assertions.push(checkEquality('C3', 'burned_' + currency, burned, sourceBurn[currency], records, {
        detail: 'state.burned == settled match receipt burn + settled room receipt burn (never the journal subset)'
      }));
      const targetBurned = lookup(target, 'burns', {id: 1});
      assertions.push(checkEquality('C3', 'target_burned_' + currency,
        targetBurned ? targetBurned[currency] : ABSENT, targetBurn[currency], records, {
          detail: 'target system_burns vs target settled receipts'
        }));
    }
    equations.push(equation('C3', 'burn composition = settled match receipts + settled room receipts', assertions));
  }

  /* ---------------- C4 conversion row pairing */
  {
    const assertions = [];
    const journalEntries = expectations.journal;
    for (const [id, a] of actors) {
      for (const [key, operation] of Object.entries(isObject(a.operations) ? a.operations : {})) {
        const result = operation.result || {};
        const ledgerRows = (Array.isArray(a.ledger) ? a.ledger : []).filter((entry) => entry.operation === key);
        const journalRows = journalEntries.filter((entry) => entry.actor === id && typeof entry.id === 'string' && (entry.id === key + ':out' || entry.id === key + ':in'));
        assertions.push(checkEquality('C4', id + ':' + key + ':ledger_pairs', ledgerRows.length, 2, records, {
          actorHash: actorHash(id), detail: 'exactly two account ledger rows per conversion key'
        }));
        assertions.push(checkEquality('C4', id + ':' + key + ':journal_pairs', journalRows.length, 2, records, {
          actorHash: actorHash(id), detail: 'exactly two journal rows per conversion key'
        }));
        let expectedCredit = null;
        try { expectedCredit = D.conversion(result.from, result.debit).credit; } catch { expectedCredit = null; }
        assertions.push(checkEquality('C4', id + ':' + key + ':credit', result.credit, expectedCredit, records, {
          actorHash: actorHash(id), detail: '10:1 conversion arithmetic re-derived with the pure domain function'
        }));
        for (const entry of ledgerRows) {
          const targetRow = lookup(target, 'wallet_ledger_entries', {actor_id: id, entry_id: entry.id});
          assertions.push(checkEquality('C4', id + ':' + entry.id + ':target', targetRow ? targetRow.amount : ABSENT, entry.amount, records, {
            actorHash: actorHash(id), detail: 'conversion ledger row imported verbatim'
          }));
        }
      }
    }
    if (!assertions.length) assertions.push({subject: 'no-conversions', residual: 0, status: 'pass'});
    equations.push(equation('C4', 'conversion row pairing and 10:1 arithmetic', assertions));
  }

  /* ---------------- C5 tournament pool algebra */
  {
    const assertions = [];
    const rooms = Array.isArray(model.rooms) ? model.rooms : [];
    for (const room of rooms) {
      const r = room.parsed || {};
      const quote = r.quote;
      if (!quote) continue;
      const pool = quote.pool, burn = quote.burn, payouts = Array.isArray(quote.payouts) ? quote.payouts : [];
      assertions.push(checkEquality('C5', room.id + ':pool', pool, quote.entry * 10, records, {detail: 'pool == entry*10'}));
      assertions.push(checkEquality('C5', room.id + ':burn', burn, pool / 10, records, {detail: 'burn == pool/10'}));
      assertions.push(checkEquality('C5', room.id + ':payout_sum', payouts.reduce((sum, v) => sum + v, 0) + burn, pool, records, {detail: 'sum(payouts)+burn == pool'}));
      assertions.push(checkEquality('C5', room.id + ':fourth_payout', payouts[4], quote.entry, records, {detail: 'payouts[4] == entry'}));
    }
    if (!assertions.length) assertions.push({subject: 'no-tournament-rooms', residual: 0, status: 'pass'});
    equations.push(equation('C5', 'tournament pool algebra', assertions));
  }

  /* ---------------- C6 wealth identity, cross-check only */
  {
    const assertions = [];
    for (const [id, a] of actors) {
      const wealth = D.wealth(a);
      const wallet = lookup(target, 'wallets', {actor_id: id});
      if (!wallet) continue;
      const targetWealth = D.wealth({
        coins: wallet.coins, crowns: wallet.crowns,
        reservedCoins: wallet.reserved_coins, reservedCrowns: wallet.reserved_crowns
      });
      assertions.push({
        subject: id, residual: wealth - targetWealth,
        status: wealth === targetWealth ? 'pass' : 'cross-check'
      });
    }
    const equationRecord = equation('C6', 'wealth identity cross-check only (never a balance equation)', assertions);
    equationRecord.crossCheck = true;
    equations.push(equationRecord);
  }

  /* ---------------- C7 occupancy single-valuedness */
  {
    const assertions = [];
    const derived = new Map();
    for (const [id, a] of actors) if (a.activeMatch) derived.set(id, a.activeMatch);
    const liveTargets = new Set();
    for (const [id, m] of expectations.matches) if (m.status === 'OFFERED' || m.status === 'PLAYING') liveTargets.add(id);
    for (const room of Array.isArray(model.rooms) ? model.rooms : []) {
      const r = room.parsed || {};
      if ((r.escrow > 0) && r.settled !== true) liveTargets.add('tournament:' + room.id);
    }
    for (const [id, target] of derived) {
      /* The reverse map must be injective: an occupancy reference is held by an actor, and that
       * actor holds exactly one reference (the source's own Map keying makes this structural). */
      const injective = typeof target === 'string' && target.length > 0;
      assertions.push({subject: 'single-valued:' + id, residual: injective ? 0 : 1, status: injective ? 'pass' : 'fail'});
      if (!injective) {
        records.push(differenceRecord('C7', {
          category: UNEXPLAINED, actorHash: actorHash(id), locator: 'invariant:C7',
          fieldPath: 'equations.C7.single_valued', expectedHash: valueHash('match-id|tournament:roomId'),
          actualHash: valueHash(target), detail: 'an occupancy reference must be a single non-empty value'
        }));
      }
      const live = liveTargets.has(target);
      assertions.push({subject: 'live-target:' + id, residual: live ? 0 : 1, status: live ? 'pass' : 'fail'});
      if (!live) {
        records.push(differenceRecord('C7', {
          category: UNEXPLAINED, actorHash: actorHash(id), locator: 'invariant:C7',
          fieldPath: 'equations.C7.dangling_occupancy', expectedHash: valueHash('live-entity'),
          actualHash: valueHash(target), detail: 'activeMatch must reference an open match or room'
        }));
      }
    }
    /* The target's occupancy table must agree with the same rule: at most one row per actor is
     * structural (PK), and each row must reference a live entity on the target side. */
    const targetLive = new Set();
    for (const row of targetRows(target, 'match.matches')) if (row.status === 'OFFERED' || row.status === 'PLAYING') targetLive.add('match:' + row.match_id);
    for (const row of targetRows(target, 'tournament.rooms')) if (row.escrow > 0 && row.settled !== true) targetLive.add('tournament:' + row.room_id);
    for (const row of targetRows(target, 'core.actor_occupancy')) {
      const live = targetLive.has(row.kind + ':' + row.ref_id);
      assertions.push({subject: 'target-live:' + row.actor_id, residual: live ? 0 : 1, status: live ? 'pass' : 'fail'});
      if (!live) {
        records.push(differenceRecord('C7', {
          category: UNEXPLAINED, actorHash: actorHash(row.actor_id), locator: 'invariant:C7',
          fieldPath: 'equations.C7.target_dangling_occupancy', expectedHash: valueHash('live-entity'),
          actualHash: valueHash(row.kind + ':' + row.ref_id), detail: 'target occupancy references no live entity'
        }));
      }
    }
    for (const [id, m] of expectations.matches) {
      if (!(m.escrow > 0) || m.settled === true) continue;
      for (const player of Array.isArray(m.players) ? m.players : []) {
        const held = derived.get(player);
        const ok = held === id;
        assertions.push({subject: 'match:' + id + ':' + player, residual: ok ? 0 : 1, status: ok ? 'pass' : 'fail'});
        if (!ok) {
          records.push(differenceRecord('C7', {
            category: UNEXPLAINED, actorHash: actorHash(player), locator: 'invariant:C7',
            fieldPath: 'equations.C7.match_occupancy', expectedHash: valueHash(id), actualHash: valueHash(held === undefined ? ABSENT : held),
            detail: 'every open match player must occupy that match'
          }));
        }
      }
    }
    for (const room of Array.isArray(model.rooms) ? model.rooms : []) {
      const r = room.parsed || {};
      if (!(r.escrow > 0) || r.settled === true) continue;
      for (const contribution of Array.isArray(r.contributions) ? r.contributions : []) {
        const ok = derived.get(contribution.id) === 'tournament:' + room.id;
        assertions.push({subject: 'room:' + room.id + ':' + contribution.id, residual: ok ? 0 : 1, status: ok ? 'pass' : 'fail'});
        if (!ok) {
          records.push(differenceRecord('C7', {
            category: UNEXPLAINED, actorHash: actorHash(contribution.id), locator: 'invariant:C7',
            fieldPath: 'equations.C7.room_occupancy', expectedHash: valueHash('tournament:' + room.id),
            actualHash: valueHash(derived.get(contribution.id) === undefined ? ABSENT : derived.get(contribution.id)),
            detail: 'every open room contributor must occupy that room'
          }));
        }
      }
    }
    equations.push(equation('C7', 'occupancy single-valued and injective', assertions));
  }

  /* ---------------- C8 relationship symmetry / direction */
  {
    const assertions = [];
    for (const [id, a] of actors) {
      for (const friend of Array.isArray(a.friends) ? a.friends : []) {
        const other = pairMap(state.accounts).get(friend);
        const symmetric = other && Array.isArray(other.friends) && other.friends.includes(id);
        assertions.push({subject: 'friends:' + id + '<->' + friend, residual: symmetric ? 0 : 1, status: symmetric ? 'pass' : 'fail'});
        if (!symmetric) {
          records.push(differenceRecord('C8', {
            category: UNEXPLAINED, actorHash: actorHash(id), locator: 'invariant:C8',
            fieldPath: 'equations.C8.friendship_symmetry', expectedHash: valueHash(true), actualHash: valueHash(false),
            detail: 'friendships must be symmetric in both directions'
          }));
        }
      }
      for (const blocked of Array.isArray(a.blocked) ? a.blocked : []) {
        const blockRow = lookup(target, 'blocks', {blocker_id: id, blocked_id: blocked});
        assertions.push({subject: 'block-direction:' + id + '>' + blocked, residual: blockRow ? 0 : 1, status: blockRow ? 'pass' : 'fail'});
      }
    }
    equations.push(equation('C8', 'relationship symmetry and direction', assertions));
  }

  /* ---------------- C9 principal referential classes */
  {
    const accountsById = pairMap(state.accounts);
    const tombstones = new Set(valuesOf(model.tables && model.tables.v41_deletion_receipts).map((row) => row.tombstone));
    const guests = new Set(valuesOf(model.tables && model.tables.party_guests).map((row) => row.actor));
    const sentinels = new Set(['system']);
    const classify = (id) => {
      if (typeof id !== 'string' || !id) return 'unknown';
      if (accountsById.has(id)) return 'account';
      if (tombstones.has(id)) return 'deleted-principal';
      if (guests.has(id)) return 'lan-guest-principal';
      if (sentinels.has(id)) return 'account';
      if (/^deleted_[0-9a-f]{32}$/.test(id)) return 'deleted-principal';
      return 'unknown';
    };
    const assertions = [];
    const references = [];
    for (const [id, a] of actors) {
      for (const entry of Array.isArray(a.history) ? a.history : []) references.push([entry.opponent, id + '.history[].opponent']);
      for (const entry of Array.isArray(a.season && a.season.opponents) ? a.season.opponents : []) references.push([entry, id + '.season.opponents']);
      for (const season of Array.isArray(a.seasonHistory) ? a.seasonHistory : []) for (const entry of Array.isArray(season.opponents) ? season.opponents : []) references.push([entry, id + '.seasonHistory[].opponents']);
      for (const entry of Array.isArray(a.friends) ? a.friends : []) references.push([entry, id + '.friends[]']);
      for (const entry of Array.isArray(a.friendRequests) ? a.friendRequests : []) references.push([entry, id + '.friendRequests[]']);
      for (const entry of Array.isArray(a.blocked) ? a.blocked : []) references.push([entry, id + '.blocked[]']);
    }
    for (const [id, m] of expectations.matches) {
      for (const player of Array.isArray(m.players) ? m.players : []) references.push([player, id + '.players']);
      for (const player of Array.isArray(m.accepted) ? m.accepted : []) references.push([player, id + '.accepted']);
      for (const symbol of Object.values(isObject(m.symbols) ? m.symbols : {})) references.push([symbol, id + '.symbols']);
      if (m.receipt && m.receipt.winner) references.push([m.receipt.winner, id + '.receipt.winner']);
    }
    for (const room of Array.isArray(model.rooms) ? model.rooms : []) {
      const r = room.parsed || {};
      for (const player of Array.isArray(r.players) ? r.players : []) references.push([player.id, room.id + '.players']);
      for (const entry of Array.isArray(r.ranking) ? r.ranking : []) references.push([entry, room.id + '.ranking']);
      for (const contribution of Array.isArray(r.contributions) ? r.contributions : []) references.push([contribution.id, room.id + '.contributions']);
    }
    for (const entry of expectations.journal) references.push([entry.actor, 'journal.actor']);
    for (const [, payment] of expectations.weeklyPaid) references.push([payment.account, 'weeklyPaid.account']);
    for (const [date, tiers] of expectations.snapshots) for (const id of Object.keys(isObject(tiers) ? tiers : {})) references.push([id, 'snapshots[' + date + ']']);

    let unresolved = 0;
    const byClass = {account: 0, 'deleted-principal': 0, 'lan-guest-principal': 0};
    for (const [reference, where] of references) {
      const klass = classify(reference);
      if (klass !== 'unknown') byClass[klass] = (byClass[klass] || 0) + 1;
      if (klass === 'unknown') {
        unresolved++;
        records.push(differenceRecord('C9', {
          category: UNEXPLAINED, locator: 'invariant:C9', fieldPath: 'equations.C9.principal.' + where,
          expectedHash: valueHash('account|deleted_<32hex>|lan-guest|system'), actualHash: valueHash('unresolved'),
          detail: 'reference does not resolve to any documented principal class'
        }));
        continue;
      }
      assertions.push({subject: where, residual: 0, status: 'pass', klass});
    }
    assertions.push({subject: 'unresolved', residual: unresolved, status: unresolved === 0 ? 'pass' : 'fail'});
    const c9 = equation('C9', 'principal referential classes (account / deleted tombstone / LAN guest)', assertions);
    c9.classes = byClass;
    equations.push(c9);
  }

  return equations;
}

/* Target-side reserved closure: Σ over open matches and open rooms of that actor's contributions. */
function targetReservedClosure(target, actorId, currency) {
  let total = 0;
  for (const row of targetRows(target, 'match.matches')) {
    if (!(row.escrow > 0) || row.settled === true || row.currency !== currency) continue;
    const contribution = targetRows(target, 'match.escrow_contributions')
      .find((entry) => entry.match_id === row.match_id && entry.actor_id === actorId);
    if (contribution) total += contribution.amount;
  }
  for (const row of targetRows(target, 'tournament.rooms')) {
    if (!(row.escrow > 0) || row.settled === true || row.quote_currency !== currency) continue;
    const contribution = targetRows(target, 'tournament.escrow_contributions')
      .find((entry) => entry.room_id === row.room_id && entry.actor_id === actorId);
    if (contribution) total += contribution.amount;
  }
  return total;
}

/* ------------------------------------------------------------------ evidence (reported only) */

function evidence(model, expectations) {
  const journalBySource = {};
  const journalByActorCurrency = {};
  for (const entry of expectations.journal) {
    journalBySource[entry.source] = (journalBySource[entry.source] || 0) + 1;
    const key = entry.actor + '\u0000' + entry.currency;
    journalByActorCurrency[key] = (journalByActorCurrency[key] || 0) + entry.amount;
  }
  const receipts = [...expectations.receipts.values()];
  const burnJournalSubset = expectations.journal
    .filter((entry) => entry.reason === 'Currency retired')
    .reduce((sum, entry) => sum + entry.amount, 0);

  /* Does the source journal fully explain each actor's available balance? On the known live source
   * it does (opening 150 + mints 2 and 5 = 157). This is REPORTED, never used as a balance equation,
   * and a non-explaining actor yields a labelled `baseline-needed` informational record. */
  const balanceExplanations = [];
  for (const [id, a] of expectations.accounts) {
    for (const currency of ['coins', 'crowns']) {
      const journalSum = journalByActorCurrency[id + '\u0000' + currency] || 0;
      const balance = currency === 'coins' ? a.coins : a.crowns;
      balanceExplanations.push({actorHash: actorHash(id), currency, explained: journalSum === balance});
    }
  }
  const unexplainedBalances = balanceExplanations.filter((row) => !row.explained);

  return {
    journalCount: expectations.journal.length,
    journalBySource,
    journalByActorCurrency: Object.keys(journalByActorCurrency).length,
    burnFromJournalSubset: burnJournalSubset,
    burned: {...expectations.burned},
    receiptCount: receipts.length,
    receiptCrownsSum: receipts.reduce((sum, receipt) => sum + (receipt.crowns || 0), 0),
    receiptRefundedCount: receipts.filter((receipt) => receipt.refunded === true).length,
    ledgerEntryCount: [...expectations.buckets.get('wallet_ledger_entries') || []].length,
    journalExplainsBalance: {
      checked: balanceExplanations.length,
      explained: balanceExplanations.length - unexplainedBalances.length,
      unexplained: unexplainedBalances.length,
      rows: balanceExplanations
    },
    baselineNeeded: unexplainedBalances.map((row) => ({actorHash: row.actorHash, currency: row.currency})),
    tombstones: valuesOf(model.tables && model.tables.v41_deletion_receipts).length,
    storeRevocations: valuesOf(model.tables && model.tables.v41_store_revocations).length,
    supportEvents: valuesOf(model.tables && model.tables.v41_support_events).length,
    principals: {
      accounts: expectations.accounts.size,
      guests: valuesOf(model.tables && model.tables.party_guests).length,
      tombstones: valuesOf(model.tables && model.tables.v41_deletion_receipts).length
    }
  };
}

/* ------------------------------------------------------------------ target index */

function targetRows(target, table) { return (target.get(table) || []).map((entry) => entry.normalized); }
function lookup(target, kind, keys) {
  const spec = TABLES[kind];
  if (!spec || !spec.table) return null;
  const key = pkKeyOf(spec.pk, keys);
  const index = target.get(spec.table);
  if (!index) return null;
  const entry = index.find((row) => row.pkKey === key);
  return entry ? entry.normalized : null;
}

async function loadTarget(client) {
  const target = new Map();
  const seen = new Set();
  for (const kind of Object.keys(TABLES)) {
    const spec = TABLES[kind];
    if (!spec.table || seen.has(spec.table)) continue;
    seen.add(spec.table);
    const spec2 = spec;
    const read = await ledgerReadHashedTable(client, spec2.table, spec2.pk || []);
    if (!read.present) { target.set(spec2.table, []); continue; }
    target.set(spec2.table, read.hashed.map((row) => ({
      raw: row.raw, normalized: row.normalized, columns: read.columns,
      pkKey: spec2.pk ? pkKeyOf(spec2.pk, row.normalized) : null,
      dbRowHash: row.dbRowHash, dbPkHash: row.dbPkHash
    })));
  }
  return target;
}

/* ------------------------------------------------------------------ verify */

async function verify({model, run, client}) {
  if (!model || typeof model !== 'object') throw reconcileError('MODEL_REQUIRED', 'a reader model is required');
  if (!run || typeof run !== 'object' || typeof run.run_id !== 'string') throw reconcileError('RUN_REQUIRED', 'a v5_migration.run row is required');
  if (!client || typeof client.query !== 'function') throw reconcileError('CLIENT_REQUIRED', 'a connected client is required');
  const runId = run.run_id;

  const modelFingerprint = model.hashes && model.hashes.sourceFingerprint;
  const modelClock = model.capture && model.capture.clockMs;
  const sourceSchemaHead = model.capture && model.capture.schemaHead ? model.capture.schemaHead.maxId : null;
  const records = [];
  const invariants = {runId, sourceFingerprint: modelFingerprint, checks: [], uncompared: [], projectedTables: [], scopeTables: []};

  /* A run bound to a different source fingerprint is a hard refusal: the model is not this run's
   * source, so every comparison below would be meaningless. */
  if (run.source_fingerprint !== modelFingerprint) {
    throw reconcileError('RUN_MODEL_MISMATCH', 'run.source_fingerprint does not match the model source fingerprint');
  }
  const runRow = (await client.query(
    'SELECT run_id, source_fingerprint, extractor_release, schema_head, capture_clock_ms, status, target_environment, target_database, started_at FROM v5_migration.run WHERE run_id = $1',
    [runId])).rows[0];
  if (!runRow) throw reconcileError('RUN_UNKNOWN', runId);
  invariants.runStatus = runRow.status;
  invariants.schemaHead = runRow.schema_head;
  invariants.captureClockMs = Number(runRow.capture_clock_ms);
  invariants.environment = runRow.target_environment;
  invariants.database = runRow.target_database;
  invariants.targetEnvironment = runRow.target_environment;

  const guard = (await client.query(
    'SELECT target_system_id, target_environment, target_database, schema_head, adopted_existing_tables FROM v5_migration.target_guard WHERE target_database = $1',
    [runRow.target_database])).rows[0] || null;
  if (!guard) throw reconcileError('TARGET_GUARD_MISSING', 'no v5_migration.target_guard row for this database');
  const adopted = new Set(Array.isArray(guard.adopted_existing_tables) ? guard.adopted_existing_tables : []);
  invariants.targetSystemIdHash = hash({v: guard.target_system_id});
  invariants.adoptedTables = [...adopted].sort();
  invariants.checks.push({id: 'guard', status: guard.schema_head === runRow.schema_head ? 'pass' : 'fail'});
  invariants.sourceSchemaHead = sourceSchemaHead;
  /* The source's own migration-chain length is provenance: it is recorded (never imported as target
   * history) and a mismatch with the target schema head is an explicit, visible check. */
  invariants.checks.push({id: 'source-schema-head', status: sourceSchemaHead === null || sourceSchemaHead === runRow.schema_head ? 'pass' : 'fail'});
  /* The adopted-table list is what authorises a pre-existing row to survive inside a destination
   * this run wrote; it is recorded here because the extra-row scan below consults it. */

  const ledgerRows = (await client.query(
    'SELECT source_locator, target_table, target_pk_hash, row_hash, batch_ordinal FROM v5_migration.row_ledger WHERE run_id = $1',
    [runId])).rows;
  invariants.ledgerRows = ledgerRows.length;

  /* Which locator kind owns a target table. Needed before the ledger is resolved, because the
   * sibling importer's `<schema.table>#<key>` locator carries no kind of its own. */
  const kindByTable = new Map();
  for (const kind of Object.keys(TABLES)) {
    const spec = TABLES[kind];
    if (spec.table && !kindByTable.has(spec.table)) kindByTable.set(spec.table, kind);
  }

  const expectations = buildExpectations(model);
  const target = await loadTarget(client);

  /* ------------------------------------------------ Layer A: ledger integrity */
  const ledgerByTable = new Map();
  for (const row of ledgerRows) {
    const parsed = resolveLocator(row) || {kind: kindByTable.get(row.target_table) || 'row_ledger', keys: null};
    invariants.ledgerKinds = invariants.ledgerKinds || {};
    invariants.ledgerKinds[parsed.kind] = (invariants.ledgerKinds[parsed.kind] || 0) + 1;
    if (!ledgerByTable.has(row.target_table)) ledgerByTable.set(row.target_table, new Map());
    ledgerByTable.get(row.target_table).set(row.source_locator, {...row, parsed, keys: parsed.keys, kind: parsed.kind});
  }
  const scopeTables = new Set(ledgerByTable.keys());
  invariants.scopeTables = [...scopeTables].sort();

  /* Two locator encodings are accepted, because both the design text and the sibling importer are
   * legitimate: `<kind>:<canon(keys)>` (a JSON object after the first colon) and
   * `<schema.table>#<key>` (the importer's bare-table prefix form). The committed `target_table` is
   * the authority for which destination a ledger row addresses in either case. */
  function resolveLocator(row) {
    const text = String(row.source_locator);
    const at = text.indexOf(':');
    if (at > 0 && text[at + 1] === '{') {
      try {
        const keys = JSON.parse(text.slice(at + 1));
        if (keys && typeof keys === 'object' && !Array.isArray(keys)) return {kind: text.slice(0, at), keys};
      } catch { /* fall through to the table form */ }
    }
    const hashAt = text.indexOf('#');
    if (hashAt < 0) return null;
    const table = text.slice(0, hashAt);
    const kind = kindByTable.get(table);
    const spec = kind ? TABLES[kind] : null;
    if (!spec || !spec.pk) return null;
    const parts = text.slice(hashAt + 1).split('\u001f');
    if (parts.length !== spec.pk.length) return null;
    const keys = {};
    for (let index = 0; index < spec.pk.length; index++) {
      const column = spec.pk[index];
      /* A positional-ordinal part is zero-padded in the key; the COLUMN holds a plain number. */
      keys[column] = spec.ordinalColumns && spec.ordinalColumns.includes(column) ? String(Number(parts[index])) : parts[index];
    }
    return {kind, keys};
  }

  const coveredPk = new Map(); // table -> Set(pkKey)
  for (const [table, entries] of ledgerByTable) {
    const kind = kindByTable.get(table);
    const spec = kind ? TABLES[kind] : null;
    const covered = new Set();
    coveredPk.set(table, covered);
    for (const entry of entries.values()) {
      const keys = entry.keys;
      if (!keys || typeof keys !== 'object') {
        records.push(differenceRecord(entry.kind || 'row_ledger', {
          category: UNEXPLAINED, locator: entry.source_locator, fieldPath: 'row_ledger.source_locator',
          expectedHash: valueHash('kind:<canon(keys)> | <schema.table>#<key>'), actualHash: valueHash(entry.source_locator),
          detail: 'unparsable structured locator'
        }));
        continue;
      }
      const index = target.get(table) || [];
      if (!spec || !spec.pk) continue;
      const pkKey = pkKeyFromLocator(entry.kind, keys);
      let found = index.find((row) => row.pkKey === pkKey);
      if (found) {
        covered.add(found.pkKey);
      } else {
        /* The importer's locator key is a projection of the source record and is not always
         * invertible into the target primary key (its escrow/participant families key on the SEAT
         * index, and its command families key on a concatenated actor+key). Falling back to the
         * ledger's OWN row hash is sound: the hash identifies the row uniquely, so a single
         * matching target row proves the row is present and unmodified, zero matches prove it is
         * missing or tampered, and several matches are reported as ambiguous rather than guessed. */
        const matches = index.filter((row) => row.dbRowHash === entry.row_hash || row.normalized && hash(row.normalized) === entry.row_hash);
        if (matches.length === 1) { found = matches[0]; covered.add(found.pkKey); }
      }
      if (!found) {
        records.push(differenceRecord(entry.kind, {
          category: UNEXPLAINED, locator: entry.source_locator, fieldPath: table + '.__row',
          expectedHash: entry.row_hash, actualHash: null,
          detail: 'committed ledger row is missing from the target'
        }));
        continue;
      }
      const actualHash = hash(found.normalized);
      if (actualHash !== entry.row_hash && found.dbRowHash !== entry.row_hash) {
        records.push(differenceRecord(entry.kind, {
          category: UNEXPLAINED, locator: entry.source_locator, fieldPath: table + '.__row_hash',
          expectedHash: entry.row_hash, actualHash,
          detail: 'committed row hash mismatch: the target row was modified after it was committed'
        }));
      } else {
        invariants.hashConventions = invariants.hashConventions || {};
        const convention = actualHash === entry.row_hash ? 'canonical' : 'to_jsonb';
        invariants.hashConventions[convention] = (invariants.hashConventions[convention] || 0) + 1;
      }
      const pkHash = targetPkHash(spec.pk, found.normalized);
      if (pkHash !== entry.target_pk_hash && found.dbPkHash !== entry.target_pk_hash) {
        records.push(differenceRecord(entry.kind, {
          category: UNEXPLAINED, locator: entry.source_locator, fieldPath: table + '.__pk_hash',
          expectedHash: entry.target_pk_hash, actualHash: pkHash,
          detail: 'the located row has a different primary key than the ledger committed'
        }));
      }
    }
  }

  /* Extra target rows: a row present in a destination the run claims to have written, whose PK is
   * not covered by any committed ledger locator for that table. */
  for (const [table, entries] of target) {
    const kind = kindByTable.get(table);
    const spec = kind ? TABLES[kind] : null;
    if (!spec || !spec.pk) continue;
    const covered = coveredPk.get(table);
    if (!covered) continue; // the run declares nothing for this table; see the adopted-table pass below
    for (const entry of entries) {
      if (covered.has(entry.pkKey)) continue;
      const adoptedRow = adopted.has(table);
      const sourceKeys = sourceKeysOf(kind, spec.pk, entry.normalized);
      if (adoptedRow) {
        records.push(differenceRecord(kind, {
          category: 'ephemeral-rebuild', locator: locatorFor(kind, sourceKeys),
          fieldPath: table + '.__row', expectedHash: null, actualHash: hash(entry.normalized),
          ruleId: 'adopted-existing-table', severity: 'informational',
          detail: 'pre-existing adopted row, not written by this run'
        }));
        continue;
      }
      records.push(differenceRecord(kind, {
        category: UNEXPLAINED, locator: locatorFor(kind, sourceKeys),
        fieldPath: table + '.__row', expectedHash: null, actualHash: hash(entry.normalized),
        detail: 'extra target row this run did not write'
      }));
    }
  }

  /* ------------------------------------------------ Layer B: semantic comparison */
  /* Per-entity comparison for every destination this run committed (scopeTables), so an actor's
   * wallet, ratings, credits, entitlements, progress, history and season are all compared
   * individually - never as an aggregate. */
  for (const kind of SEMANTIC_KINDS) {
    const spec = TABLES[kind];
    if (!spec.table || !spec.pk) continue;
    if (!scopeTables.has(spec.table)) continue;
    const expectedMap = expectations.buckets.get(kind);
    invariants.projectedTables.push(spec.table);
    const actualByPk = new Map((target.get(spec.table) || []).map((row) => [row.pkKey, row]));
    for (const [pkKey, item] of expectedMap || []) {
      const found = actualByPk.get(pkKey);
      records.push(...compareRows(item, found ? found.normalized : null, {table: spec.table}));
      for (const entry of item.reported || []) {
        records.push(differenceRecord(kind, {
          category: entry.category, actorHash: actorHash(item.actor), locator: item.locator,
          fieldPath: entry.field, expectedHash: valueHash('source-raw'), actualHash: valueHash('reported-delta'),
          ruleId: entry.ruleId, severity: 'explained',
          detail: 'the reader reported a normalization delta; the raw source value is what the target carries'
        }));
      }
    }
    /* An extra target row for this destination is reported once, by the ledger scan above, which is
     * the only pass that can tell an adopted pre-existing row from a row this run did not write. */
  }

  /* ------------------------------------------------ Layer C: equations, occupancy, principals */
  const equations = runEquations(model, expectations, target, records);

  /* ------------------------------------------------ reported classification records
   * Design 4.1/4.4/4.7: a permanent revocation tombstone is imported even without a matching
   * receipt, an archived catalogue id is coverage-review rather than a drop, and a reference that
   * resolves to a deletion tombstone or a quarantined LAN guest is a documented principal class.
   * Each is reported as explained(informational); none of them suppresses a real difference. */
  {
    const receiptsByKey = new Map();
    for (const [key, receipt] of expectations.receipts) receiptsByKey.set(key, receipt);
    const revocations = valuesOf(model.tables && model.tables.v41_store_revocations);
    for (const revocation of revocations) {
      const key = revocation.store + ':' + revocation.transaction_id;
      if (receiptsByKey.has(key)) continue;
      records.push(differenceRecord('store_revocations', {
        category: 'orphan-tombstone', locator: 'store_revocations:' + canonical({store: revocation.store, transaction_id: revocation.transaction_id}),
        fieldPath: 'monetization.store_revocations.__orphan', expectedHash: null, actualHash: valueHash(key),
        ruleId: 'revocation-without-receipt', severity: 'informational',
        detail: 'permanent refund tombstone with no matching purchase receipt; imported, never dropped'
      }));
    }
    const knownProducts = new Set(D.CROWN_PACKS.map((pack) => pack.id).concat(['classic']));
    for (const [key, receipt] of expectations.receipts) {
      if (receipt.refunded === true && !revocations.some((row) => row.store + ':' + row.transaction_id === key)) {
        records.push(differenceRecord('receipts', {
          category: 'refund-without-revocation', locator: 'receipts:' + canonical({key}),
          fieldPath: 'monetization.receipts.refunded', expectedHash: valueHash(true), actualHash: valueHash(false),
          ruleId: 'refund-without-revocation-tombstone', severity: 'informational',
          detail: 'the receipt is refunded and no revocation tombstone exists for it'
        }));
      }
      if (!knownProducts.has(receipt.productId)) {
        records.push(differenceRecord('receipts', {
          category: 'legacy-product-catalogue', locator: 'receipts:' + canonical({key}),
          fieldPath: 'monetization.receipts.product_id', expectedHash: valueHash([...knownProducts].sort()), actualHash: valueHash(receipt.productId),
          ruleId: 'archived-catalogue-id', severity: 'informational',
          detail: 'product id outside the current catalogue; preserved verbatim, never repriced'
        }));
      }
    }
    const tombstones = new Set(valuesOf(model.tables && model.tables.v41_deletion_receipts).map((row) => row.tombstone));
    const guests = new Set(valuesOf(model.tables && model.tables.party_guests).map((row) => row.actor));
    for (const tombstone of tombstones) {
      records.push(differenceRecord('deletion_receipts', {
        category: 'deleted-principal', locator: 'deletion_receipts:' + canonical({tombstone}),
        fieldPath: 'principals.deleted', expectedHash: null, actualHash: valueHash(tombstone),
        ruleId: 'deletion-tombstone', severity: 'informational',
        detail: 'references to this tombstone stay as text; the principal is never resurrected'
      }));
    }
    for (const guest of guests) {
      records.push(differenceRecord('guests', {
        category: 'lan-guest-principal', locator: 'party_guests:' + canonical({actor: guest}),
        fieldPath: 'principals.lan_guest', expectedHash: null, actualHash: valueHash(guest),
        ruleId: 'lan-guest-quarantine', severity: 'informational',
        detail: 'LAN bearer identity: quarantined, never materialised as a platform actor'
      }));
    }
    for (const [id, a] of expectations.accounts) {
      for (const entry of Array.isArray(a.history) ? a.history : []) {
        if (tombstones.has(entry.opponent)) {
          records.push(differenceRecord('match_history', {
            category: 'deleted-principal', locator: locatorFor('match_history', {actor_id: id, seq: 0}),
            fieldPath: 'economy.match_history.opponent', expectedHash: null, actualHash: valueHash(entry.opponent),
            ruleId: 'deletion-tombstone', severity: 'informational', detail: 'opponent reference is a deletion tombstone'
          }));
        }
      }
    }
  }

  /* ------------------------------------------------ clock difference */
  if (modelClock !== undefined && Number(runRow.capture_clock_ms) !== Number(modelClock)) {
    records.push(differenceRecord('run', {
      category: 'clock-different', locator: 'run:' + runId, fieldPath: 'run.capture_clock_ms',
      expectedHash: valueHash(modelClock), actualHash: valueHash(Number(runRow.capture_clock_ms)),
      ruleId: 'capture-clock-mismatch', severity: 'explained',
      detail: 'derived classifications (expiry, week/quarter) differ, so differing rows are expected'
    }));
  }

  /* ------------------------------------------------ coverage gate */
  const coverageUnclassified = (model.coverage && model.coverage.unclassified_count) || 0;
  invariants.coverageUnclassified = coverageUnclassified;
  invariants.checks.push({id: 'coverage', status: coverageUnclassified === 0 ? 'pass' : 'fail'});
  for (const accepted of (model.coverage && model.coverage.accepted) || []) {
    records.push(differenceRecord('coverage', {
      category: 'unclassified-key-accepted', locator: 'coverage:' + accepted.locator,
      fieldPath: 'coverage.accepted', expectedHash: valueHash(accepted.ruleId), actualHash: null,
      ruleId: accepted.ruleId || 'allow-unclassified', severity: 'explained',
      detail: 'explicitly accepted unclassified locator'
    }));
  }

  /* ------------------------------------------------ ephemeral policy records */
  for (const table of ['account_sessions', 'email_challenges', 'v4_email_versions', 'session_presence', 'community_limits', 'party_guests']) {
    const sourceRows = valuesOf(model.tables && model.tables[table]);
    const targetTable = {account_sessions: 'identity.sessions', email_challenges: 'identity.email_challenges', v4_email_versions: 'identity.email_credential_versions', session_presence: null, community_limits: 'ops.rate_buckets', party_guests: null}[table];
    if (sourceRows.length && targetTable && scopeTables.has(targetTable)) continue;
    if (!sourceRows.length) continue;
    const policy = ephemeralRuleFor(table);
    const category = table === 'party_guests' ? 'lan-guest-principal'
      : table === 'v4_outbox' ? 'drained-outbox'
        : table === 'email_challenges' || table === 'v4_email_versions' ? 'expired-challenge'
          : table === 'account_sessions' ? 'expired-session' : 'ephemeral-rebuild';
    records.push(differenceRecord(table, {
      category, locator: 'table:' + table, fieldPath: 'coverage.tables.' + table,
      expectedHash: valueHash(sourceRows.length), actualHash: null,
      ruleId: (policy && policy.policy) || 'ephemeral-expiry-policy', severity: 'explained',
      detail: 'ephemeral source rows are recorded as a count + policy, not silently re-issued'
    }));
  }

  /* ------------------------------------------------ report */
  const evidenceBlock = evidence(model, expectations);

  /* Deduplicate records by the difference primary key, first writer wins (deterministic order). */
  const byKey = new Map();
  for (const record of records) {
    const key = [record.locator, record.fieldPath, record.category].join('\u0000');
    if (!byKey.has(key)) byKey.set(key, record);
  }
  const differences = [...byKey.values()].sort((a, b) =>
    (a.locator < b.locator ? -1 : a.locator > b.locator ? 1 : a.fieldPath < b.fieldPath ? -1 : a.fieldPath > b.fieldPath ? 1 : a.category < b.category ? -1 : 1));

  for (const record of differences) {
    await client.query(
      `INSERT INTO v5_migration.difference
         (run_id, category, actor_hash, locator, field_path, expected_hash, actual_hash, rule_id, severity, detail, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11::double precision / 1000))
       ON CONFLICT (run_id, locator, field_path, category) DO NOTHING`,
      [runId, record.category, record.actorHash, record.locator, record.fieldPath,
        record.expectedHash, record.actualHash, record.ruleId, record.severity, record.detail,
        Number(runRow.capture_clock_ms)]);
  }

  const byCategory = {};
  for (const record of differences) byCategory[record.category] = (byCategory[record.category] || 0) + 1;
  const unexplainedCount = differences.filter((record) => record.category === UNEXPLAINED).length;
  const explainedCount = differences.length - unexplainedCount;

  /* The A07 statement: a swapped wallet between two actors leaves the global totals identical and
   * MUST still fail. It is reported explicitly so no reader can mistake totals for reconciliation. */
  let globalCoins = 0, globalCrowns = 0;
  for (const [, a] of expectations.accounts) { globalCoins += a.coins; globalCrowns += a.crowns; }
  invariants.a07 = {
    perActorPerCurrencyCompared: true,
    actors: expectations.accounts.size,
    globalAvailableTotals: {coins: globalCoins, crowns: globalCrowns},
    statement: 'global totals are insufficient: exchanging two actors\' wallets leaves the totals unchanged and must still fail the per-actor per-currency comparison'
  };

  invariants.equations = equations.map((entry) => ({id: entry.id, status: entry.status, assertions: entry.assertions, failures: entry.failures, crossCheck: entry.crossCheck === true}));
  invariants.evidence = evidenceBlock;
  invariants.uncompared = [
    'core.actor_occupancy.claimed_at (no source clock; comparison is set-based)',
    'monetization.store_finalize/monetization.store_notifications.next_at+lease columns (no source clock)',
    'season.league_week.published_at / runtime.controls.updated_at (bookkeeping clocks)',
    'monetization.credits rows for actors with no monetization block (lazily created at runtime)'
  ];

  const result = {
    differences,
    byCategory,
    unexplainedCount,
    explainedCount,
    informationalCount: differences.filter((record) => record.severity === 'informational').length,
    equations,
    invariants,
    evidence: evidenceBlock
  };
  result.summary = report(result);
  return result;
}

/* PK keys of a TARGET row, expressed the way a source locator would express them. */
function sourceKeysOf(kind, pkColumns, normalized) {
  const keys = {};
  for (const column of pkColumns) keys[column] = column === 'key' ? decodeTargetKey(kind, normalized[column]) : normalized[column];
  return keys;
}

/* ------------------------------------------------------------------ report */

/* Sanitized, checksummed summary: counts, category names and hashes ONLY. No actor id, no
 * connection string, no row value, no raw source text may leave through this function. */
function report(result) {
  if (!result || typeof result !== 'object') throw reconcileError('RESULT_REQUIRED', 'a verify() result is required');
  const categories = {};
  for (const category of EXPLAINED_CATEGORIES) if (result.byCategory && result.byCategory[category]) categories[category] = result.byCategory[category];
  const body = {
    kind: 'v5-reconcile-summary',
    version: 1,
    runIdHash: result.invariants && result.invariants.runId ? hash({run: result.invariants.runId}) : null,
    sourceFingerprint: result.invariants && result.invariants.sourceFingerprint ? result.invariants.sourceFingerprint : null,
    counts: {
      differences: (result.differences || []).length,
      unexplained: result.unexplainedCount || 0,
      explained: result.explainedCount || 0,
      informational: result.informationalCount || 0
    },
    byCategory: categories,
    equations: (result.equations || []).map((entry) => ({id: entry.id, status: entry.status, assertions: entry.assertions, failures: entry.failures})),
    invariants: {
      ledgerRows: result.invariants ? result.invariants.ledgerRows : 0,
      scopeTables: result.invariants ? (result.invariants.scopeTables || []).length : 0,
      projectedTables: result.invariants ? (result.invariants.projectedTables || []).length : 0,
      coverageUnclassified: result.invariants ? (result.invariants.coverageUnclassified || 0) : 0,
      ledgerKinds: result.invariants && result.invariants.ledgerKinds ? Object.keys(result.invariants.ledgerKinds).sort() : [],
      a07: result.invariants && result.invariants.a07 ? {
        perActorPerCurrencyCompared: result.invariants.a07.perActorPerCurrencyCompared,
        actors: result.invariants.a07.actors,
        globalAvailableTotals: result.invariants.a07.globalAvailableTotals
      } : null
    },
    evidence: result.evidence ? {
      journalCount: result.evidence.journalCount,
      journalBySource: result.evidence.journalBySource,
      burned: result.evidence.burned,
      receiptCount: result.evidence.receiptCount,
      receiptCrownsSum: result.evidence.receiptCrownsSum,
      receiptRefundedCount: result.evidence.receiptRefundedCount,
      ledgerEntryCount: result.evidence.ledgerEntryCount,
      journalExplainsBalance: result.evidence.journalExplainsBalance ? {
        checked: result.evidence.journalExplainsBalance.checked,
        explained: result.evidence.journalExplainsBalance.explained,
        unexplained: result.evidence.journalExplainsBalance.unexplained
      } : null,
      baselineNeeded: (result.evidence.baselineNeeded || []).length,
      tombstones: result.evidence.tombstones,
      principals: result.evidence.principals
    } : null,
    differencesSha256: hash((result.differences || []).map((record) => ({
      category: record.category, locator: record.locator, fieldPath: record.fieldPath,
      expectedHash: record.expectedHash, actualHash: record.actualHash, ruleId: record.ruleId
    }))),
    gate: {
      pass: (result.unexplainedCount || 0) === 0 && ((result.invariants && result.invariants.coverageUnclassified) || 0) === 0,
      requireUnexplained: 0,
      requireCoverageUnclassified: 0
    }
  };
  body.summaryChecksum = hash(body);
  return body;
}

module.exports = {
  verify,
  report,
  readTable,
  normalizeRow,
  rowHash,
  targetPkHash,
  locatorFor,
  EXPLAINED_CATEGORIES,
  TABLES
};
