'use strict';
const { PgGuardError } = require('./guards');
const manifest = require('../../migrations/manifest.json');

const RUNTIME_ROLES = new Set(['api_runtime', 'core_runtime', 'worker_runtime']);
const REQUIRED_RELATIONS = {
 api_runtime: ['identity.actors', 'identity.eligibility', 'identity.profiles', 'identity.identities',
  'identity.email_credentials', 'identity.email_challenges', 'identity.email_credential_versions',
  'identity.signin_attempts', 'identity.sessions',
  'profile.profile_saves', 'social.friendships', 'social.friend_requests', 'social.blocks',
  'social.command_outcomes', 'privacy.reports', 'privacy.requests', 'ops.outbox'],
 core_runtime: ['identity.actors', 'identity.eligibility', 'economy.wallets', 'economy.ratings',
  'economy.ledger', 'economy.command_outcomes', 'core.actor_occupancy', 'match.matches',
  'match.participants', 'match.move_outcomes', 'tournament.rooms', 'monetization.receipts',
  'monetization.reward_tickets', 'monetization.command_outcomes', 'social.friendships', 'ops.outbox'],
 worker_runtime: ['ops.outbox', 'monetization.store_finalize', 'monetization.store_notifications',
  'privacy.requests'],
};
const REQUIRED_FUNCTIONS = {
 api_runtime: ['identity.auth_credential(text,text)', 'identity.auth_challenge(text,text)',
  'identity.auth_signin_attempt(text)', 'profile.account_state(text)',
  'profile.account_activity(text)', 'profile.account_export(text)'],
 core_runtime: [],
 worker_runtime: [],
};

/* Runtime boot checks the exact supported migration chain; only the migrator can repair it.
 * No service constructor creates schema, singletons, accounts or opening balances. */
async function verifyRuntimeSchema(pool) {
 const role = pool && typeof pool.describe === 'function' ? pool.describe().role : null;
 if (!RUNTIME_ROLES.has(role) || typeof pool.withTransaction !== 'function') {
  throw new PgGuardError('RUNTIME_POOL_REQUIRED', { role });
 }
 const expected = manifest.migrations;
 let rows, missingRelations, missingFunctions;
 try {
  rows = await pool.withTransaction(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   const ledger = (await tx.query(
    'SELECT id, name, checksum, schema_version FROM meta.migrations ORDER BY id LIMIT $1',
    [expected.length + 1],
   )).rows;
   missingRelations = (await tx.query(
    'SELECT name FROM unnest($1::text[]) AS names(name) WHERE to_regclass(name) IS NULL',
    [REQUIRED_RELATIONS[role]],
   )).rows.map((row) => row.name);
   missingFunctions = (await tx.query(
    "SELECT signature FROM unnest($1::text[]) AS functions(signature)"
    + " WHERE to_regprocedure(signature) IS NULL OR NOT has_function_privilege(to_regprocedure(signature), 'EXECUTE')",
    [REQUIRED_FUNCTIONS[role]],
   )).rows.map((row) => row.signature);
   return ledger;
  });
 } catch (error) {
  if (error && ['42P01', '3F000', '42501'].includes(error.code)) {
   throw new PgGuardError('SCHEMA_NOT_READY', { role, databaseCode: error.code });
  }
  throw error;
 }
 if (rows.length !== expected.length) {
  throw new PgGuardError('SCHEMA_INCOMPATIBLE', { expectedCount: expected.length, observedCount: rows.length });
 }
 for (let i = 0; i < expected.length; i += 1) {
  const actual = rows[i], migration = expected[i];
  if (actual.id !== migration.id || actual.name !== migration.name
      || actual.checksum !== migration.sha256 || actual.schema_version !== migration.id) {
   throw new PgGuardError('SCHEMA_INCOMPATIBLE', { migrationId: migration.id });
  }
 }
 if (missingRelations.length) {
  throw new PgGuardError('SCHEMA_INCOMPATIBLE', { missingRelations });
 }
 if (missingFunctions.length) {
  throw new PgGuardError('SCHEMA_INCOMPATIBLE', { missingFunctions });
 }
 return Object.freeze({ role, schemaHead: expected[expected.length - 1].id, migrations: rows.length });
}

module.exports = { verifyRuntimeSchema };
