/* tests/v5-p06-managed-guard.test.js - V5 P06 managed (free-only) Redis/Valkey binding guards.
 *
 * Boundary refusals for packages/services/managed-ephemera.js. Every case here is a REAL refusal
 * on the frozen API: a whole non-secret environment inventory plus a private runtime credential
 * envelope whose provider/environment/service id/endpoint must agree exactly. The refusals all
 * happen before any socket exists, so no provider is contacted and nothing is awaited on a live
 * endpoint; only synthetic values and owner-temporary 0600 fixtures are used. The one positive case
 * exercises the real factory boundary: a mismatch rejects before any socket, and an unreachable
 * dependency yields the adapter's actual conservative fallback (never a boot outage).
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createManagedEphemera, resolveManagedRedisTarget } = require('../packages/services/managed-ephemera.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-p06-managed-guard-'));
const SECRET = 'syn-' + crypto.randomBytes(12).toString('hex');
const HOST = 'managed-staging.upstash.invalid';
const SERVICE_ID = 'd03707cc-028d-4d2d-9395-43f6752b7ec4';
const REDISS = `rediss://default:${SECRET}@${HOST}:6379`;

/* `environment` is the top-level inventory field; `redis` overrides only the nested managed-target
 * inputs. Keeping them separate is what makes a genuine environment mismatch distinguishable from
 * a stray nested field. */
const inventory = ({ environment = 'staging', redis = {} } = {}) => ({
  environment,
  redis: {
    provider: 'upstash', serviceId: SERVICE_ID, host: HOST, port: 6379,
    region: 'us-east-1', plan: 'free', tls: true, autoUpgrade: false,
    ...redis,
  },
});
const envelope = (over = {}) => ({
  provider: 'upstash', environment: 'staging', databaseId: SERVICE_ID, url: REDISS,
  ...over,
});

let seq = 0;
/* A private owner-temporary envelope. `mode` lets one case prove that a group/other-readable file
 * is refused; every other case is written 0600. */
const writeEnvelope = (doc, mode = 0o600) => {
  const file = path.join(TMP, `envelope-${seq += 1}.json`);
  fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc), { mode });
  if (mode !== 0o600) fs.chmodSync(file, mode);
  return file;
};
const refuse = (want) => (error) => {
  assert.equal(error && error.code, want, `expected code ${want}, got ${error && error.code}`);
  assert.equal(error.message, want);
  return true;
};
const resolveRefusal = (want, input) => {
  const error = (() => { try { resolveManagedRedisTarget(input); return null; } catch (e) { return e; } })();
  assert.ok(error, `expected ${want} refusal`);
  refuse(want)(error);
  assert.ok(!String(error.message).includes(SECRET), 'a failure must never echo the credential');
  assert.ok(!String(error.message).includes(REDISS), 'a failure must never echo the URL');
  return error;
};

test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

/* ---------------------------------------------------------------- inventory shape / free policy */

test('P06 managed guard: inventory must be the exact intended managed target', () => {
  const file = writeEnvelope(envelope());
  resolveRefusal('INVENTORY_REQUIRED', { inventory: null, environment: 'staging', credentialFile: file });
  resolveRefusal('INVENTORY_ENVIRONMENT_INVALID', { inventory: { environment: 'dev', redis: inventory().redis }, environment: 'staging', credentialFile: file });
  resolveRefusal('INVENTORY_REDIS_REQUIRED', { inventory: { environment: 'staging' }, environment: 'staging', credentialFile: file });
  resolveRefusal('INVENTORY_PROVIDER_UNSUPPORTED', { inventory: inventory({ redis: { provider: 'rediscloud' } }), environment: 'staging', credentialFile: file });
  resolveRefusal('INVENTORY_SERVICE_ID_REQUIRED', { inventory: inventory({ redis: { serviceId: '' } }), environment: 'staging', credentialFile: file });
  resolveRefusal('INVENTORY_HOST_REQUIRED', { inventory: inventory({ redis: { host: 'bad host' } }), environment: 'staging', credentialFile: file });
  resolveRefusal('INVENTORY_PORT_INVALID', { inventory: inventory({ redis: { port: 0 } }), environment: 'staging', credentialFile: file });
  resolveRefusal('INVENTORY_REGION_REQUIRED', { inventory: inventory({ redis: { region: '' } }), environment: 'staging', credentialFile: file });
});

test('P06 managed guard: the all-free policy is explicit and enforced', () => {
  const file = writeEnvelope(envelope());
  resolveRefusal('INVENTORY_PLAN_NOT_FREE', { inventory: inventory({ redis: { plan: 'paid' } }), environment: 'staging', credentialFile: file });
  resolveRefusal('INVENTORY_TLS_REQUIRED', { inventory: inventory({ redis: { tls: false } }), environment: 'staging', credentialFile: file });
  resolveRefusal('INVENTORY_AUTO_UPGRADE_FORBIDDEN', { inventory: inventory({ redis: { autoUpgrade: true } }), environment: 'staging', credentialFile: file });
});

/* ---------------------------------------------------------------- environment binding */

test('P06 managed guard: the requested environment must be the inventory environment', () => {
  const file = writeEnvelope(envelope());
  resolveRefusal('ENVIRONMENT_REQUIRED', { inventory: inventory(), environment: 'test', credentialFile: file });
  resolveRefusal('ENVIRONMENT_MISMATCH', { inventory: inventory(), environment: 'production', credentialFile: file });
  resolveRefusal('ENVIRONMENT_MISMATCH', { inventory: inventory({ environment: 'production' }), environment: 'staging', credentialFile: file });
});

/* ---------------------------------------------------------------- private credential file */

test('P06 managed guard: the credential file must be a private 0600 regular file', () => {
  resolveRefusal('CREDENTIAL_FILE_REQUIRED', { inventory: inventory(), environment: 'staging' });
  resolveRefusal('CREDENTIAL_FILE_UNREADABLE', { inventory: inventory(), environment: 'staging', credentialFile: path.join(TMP, 'absent.json') });
  resolveRefusal('CREDENTIAL_FILE_UNSAFE', { inventory: inventory(), environment: 'staging', credentialFile: TMP });
  const loose = writeEnvelope(envelope(), 0o644);
  resolveRefusal('CREDENTIAL_FILE_NOT_PRIVATE', { inventory: inventory(), environment: 'staging', credentialFile: loose });
  resolveRefusal('CREDENTIAL_FILE_NOT_PRIVATE', { inventory: inventory(), environment: 'staging', credentialFile: writeEnvelope(envelope(), 0o640) });
  resolveRefusal('CREDENTIAL_ENVELOPE_INVALID', { inventory: inventory(), environment: 'staging', credentialFile: writeEnvelope('{not json') });
  resolveRefusal('CREDENTIAL_ENVELOPE_INVALID', { inventory: inventory(), environment: 'staging', credentialFile: writeEnvelope([1, 2]) });
});

/* ---------------------------------------------------------------- envelope identity */

test('P06 managed guard: the envelope must match provider/environment/service id exactly', () => {
  const badEnv = writeEnvelope(envelope({ environment: 'production' }));
  resolveRefusal('CREDENTIAL_ENVIRONMENT_MISMATCH', { inventory: inventory(), environment: 'staging', credentialFile: badEnv });
  /* A staging envelope can never bind a production inventory, even with a matching namespace ask. */
  const staging = writeEnvelope(envelope());
  resolveRefusal('CREDENTIAL_ENVIRONMENT_MISMATCH', {
    inventory: inventory({ environment: 'production' }), environment: 'production', credentialFile: staging,
  });
  resolveRefusal('CREDENTIAL_PROVIDER_MISMATCH', { inventory: inventory(), environment: 'staging', credentialFile: writeEnvelope(envelope({ provider: 'aiven' })) });
  resolveRefusal('CREDENTIAL_ID_MISMATCH', { inventory: inventory(), environment: 'staging', credentialFile: writeEnvelope(envelope({ databaseId: 'other-db' })) });
  resolveRefusal('CREDENTIAL_ID_REQUIRED', { inventory: inventory(), environment: 'staging', credentialFile: writeEnvelope(envelope({ databaseId: '' })) });
  resolveRefusal('CREDENTIAL_ID_MISMATCH', { inventory: inventory(), environment: 'staging', credentialFile: writeEnvelope(envelope({ serviceId: SERVICE_ID })) });
  resolveRefusal('CREDENTIAL_ENVELOPE_UNKNOWN_FIELD', {
    inventory: inventory(), environment: 'staging', credentialFile: writeEnvelope(envelope({ apiKey: 'syn-developer-key' })),
  });
});

/* ---------------------------------------------------------------- endpoint / protocol */

test('P06 managed guard: the URL must be credentials-bearing rediss:// at the intended endpoint', () => {
  const base = () => ({ inventory: inventory(), environment: 'staging' });
  const withUrl = (url) => ({ ...base(), credentialFile: writeEnvelope(envelope({ url })) });
  resolveRefusal('CREDENTIAL_URL_REQUIRED', { ...base(), credentialFile: writeEnvelope(envelope({ url: undefined })) });
  resolveRefusal('CREDENTIAL_URL_INVALID', withUrl('not a url'));
  resolveRefusal('CREDENTIAL_URL_INSECURE', withUrl(`redis://default:${SECRET}@${HOST}:6379`));
  resolveRefusal('CREDENTIAL_URL_INSECURE', withUrl(`https://default:${SECRET}@${HOST}:6379`));
  resolveRefusal('CREDENTIAL_URL_QUERY_FORBIDDEN', withUrl(`rediss://default:${SECRET}@${HOST}:6379?ssl=no-verify`));
  resolveRefusal('CREDENTIAL_URL_QUERY_FORBIDDEN', withUrl(`rediss://default:${SECRET}@${HOST}:6379?sni=#`));
  resolveRefusal('CREDENTIAL_URL_PATH_FORBIDDEN', withUrl(`rediss://default:${SECRET}@${HOST}:6379/0`));
  resolveRefusal('CREDENTIAL_URL_CREDENTIALS_REQUIRED', withUrl(`rediss://${HOST}:6379`));
  resolveRefusal('CREDENTIAL_URL_HOST_MISMATCH', withUrl(`rediss://default:${SECRET}@other-host.upstash.invalid:6379`));
  resolveRefusal('CREDENTIAL_URL_PORT_MISMATCH', withUrl(`rediss://default:${SECRET}@${HOST}:6380`));
});

test('P06 managed guard: an optional CA is trusted only when it is a supplied PEM', () => {
  const base = { inventory: inventory(), environment: 'staging' };
  resolveRefusal('CREDENTIAL_CA_INVALID', { ...base, credentialFile: writeEnvelope(envelope({ ca: 'x'.repeat(64) })) });
  resolveRefusal('CREDENTIAL_CA_INVALID', { ...base, credentialFile: writeEnvelope(envelope({ ca: '' })) });
});

/* ---------------------------------------------------------------- factory boundary */

test('P06 managed guard: the factory refuses before Redis I/O and degrades conservatively when down', async () => {
  /* The factory performs the identical guard, so a mismatch rejects (async) with the same code and
   * no socket is ever constructed. */
  await assert.rejects(
    createManagedEphemera({ inventory: inventory(), environment: 'staging', credentialFile: writeEnvelope(envelope({ databaseId: 'other-db' })) }),
    refuse('CREDENTIAL_ID_MISMATCH'),
  );

  /* A bound target whose dependency is unreachable (closed loopback port - no DNS, no provider) is
   * still the real adapter, and a lost dependency is a conservative per-operation refusal, not a
   * boot outage. `close()` drains the bounded reconnect before the test ends. */
  const dead = inventory({ redis: { host: '127.0.0.1', port: 1 } });
  const service = await createManagedEphemera({
    inventory: dead,
    environment: 'staging',
    credentialFile: writeEnvelope(envelope({ url: `rediss://default:${SECRET}@127.0.0.1:1` })),
  });
  const presence = await service.presenceRead('synthetic-actor');
  assert.deepEqual(presence.sessions, []);
  assert.equal(presence.available, false);
  assert.equal(presence.conservative, true);
  await service.close();
});
