'use strict';

/* MXA-PROMOTION-DISCLOSURE (2026-10-20): publication gate for the launch-promotion anti-hoarding
 * policy (migration 0066 inserts it UNPUBLISHED). Run this on the production host AFTER the
 * release that ships the disclosure UI is live — the batch-deploy procedure documents the step.
 * Until published, checkouts keep working without an acceptance; once published, every
 * promotional Crown checkout requires the disclosure acceptance first (fail-closed).
 *
 * Usage (host, admin/owner DIRECT endpoint):
 *   V5_MIGRATE_DATABASE_URL=postgres://... node scripts/v5/publish-promotion-policy.cjs [--dry-run]
 *
 * Guarantees:
 *   - rule_hash is computed from the SHIPPED module (packages/services/promotion-disclosure.js);
 *     the script refuses when the deployed policy already carries a DIFFERENT hash, so words can
 *     never change silently under an accepted policy.
 *   - Idempotent: re-running with the same hash is a no-op success.
 *   - Never expires, never retires, never touches allocations. */

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const Disclosure = require(path.join(ROOT, 'packages', 'services', 'promotion-disclosure.js'));

function fail(code, message) {
  process.stderr.write('PUBLISH_REFUSED ' + code + (message ? ': ' + message : '') + '\n');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const ruleHash = Disclosure.ruleHash();
const url = process.env.V5_MIGRATE_DATABASE_URL || process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url || typeof url !== 'string' || !/^postgres(ql)?:\/\//.test(url.trim())) {
  fail('CONFIG', 'set V5_MIGRATE_DATABASE_URL (admin/owner DIRECT endpoint) to run the publication');
}

let client;
main().catch((error) => fail('DB', error && error.message));

async function main() {
  const { Client } = require(path.join(ROOT, 'node_modules', 'pg'));
  client = new Client({ connectionString: url.trim(), application_name: 'publish-promotion-policy' });
  await client.connect();
  const existing = (await client.query(
    "SELECT policy_version, campaign_id, cap, published_at, rule_hash, expires_at FROM monetization.promotion_policies WHERE policy_version = 'promotion-allocation-v1'"
  )).rows[0];
  if (!existing) fail('POLICY_MISSING', 'migration 0066 has not been applied to this database');
  if (existing.cap !== 22000) fail('CAP_MISMATCH', 'policy cap ' + existing.cap + ' does not match the shipped 22,000 rule');
  if (existing.published_at) {
    if (existing.rule_hash !== ruleHash) {
      fail('HASH_MISMATCH', 'policy published ' + existing.published_at + ' with hash ' + existing.rule_hash + '; shipped rule text hash is ' + ruleHash + ' — the disclosed words changed, which requires a NEW policy version, not an edit');
    }
    process.stdout.write('PUBLISH_NOOP already published at ' + existing.published_at + ' with the shipped hash\n');
    return;
  }
  if (dryRun) {
    process.stdout.write('PUBLISH_DRY_RUN would set published_at=now(), rule_hash=' + ruleHash + '\n');
    return;
  }
  const updated = await client.query(
    "UPDATE monetization.promotion_policies SET published_at = clock_timestamp(), rule_hash = $1 WHERE policy_version = 'promotion-allocation-v1' AND published_at IS NULL RETURNING published_at",
    [ruleHash]
  );
  if (updated.rowCount !== 1) fail('RACE', 'the policy was published concurrently with a different outcome; re-read before retrying');
  const verify = (await client.query(
    "SELECT published_at, rule_hash FROM monetization.promotion_policies WHERE policy_version = 'promotion-allocation-v1'"
  )).rows[0];
  if (!verify.published_at || verify.rule_hash !== ruleHash) fail('VERIFY', 'post-update read does not match the shipped hash');
  process.stdout.write('PUBLISHED at ' + verify.published_at + ' rule_hash=' + verify.rule_hash + '\n');
}

process.on('exit', () => { try { if (client) client.end(); } catch { /* best effort */ } });
