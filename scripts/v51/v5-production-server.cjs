'use strict';
/* scripts/v51/v5-production-server.cjs - V5 PRODUCTION composition entry point (E5).
 *
 * The production twin of `scripts/v51/p21-staging-server.cjs`. It composes the SAME real stack in
 * ONE process, against the PRODUCTION target instead of staging:
 *
 *   apps/web static bundle + apps/api handler + the signed Core service ingress
 *   (`createCoreServiceIngress`) + the realtime transport (`createRealtimeTransport`), backed by the
 *   real Neon `mega_xo_v5_production` database through least-privilege runtime roles
 *   (`api_runtime` / `core_runtime` / `worker_runtime`) and the real managed Aiven Valkey.
 *
 * Its purpose is that the owner-authorised production cutover is a CONFIGURATION CHANGE plus an
 * immutable-image deploy, not new code: the composition, the role separation, the secret custody,
 * the namespace derivation and the health surface are identical in shape to the proven staging
 * entry, so only the binding, the secret directory, the inventory and the two deliberate switches
 * below differ between staging and production.
 *
 * SAFETY IDIOMS (all copied from the staging entry, deliberately):
 *   - FAIL-CLOSED TARGET BINDING. Binding comes from `MEGA_V5_PRODUCTION_SERVER=<project>/<branch>/
 *     <database>` and must equal the exact identity declared in docs/v5/environments/production.json.
 *     The inventory must still declare `"nonserving": true`; a target that declares
 *     `"nonserving": false` is REFUSED unless the separate authority-epoch switch is set (see the
 *     operator sequence). The database must be `mega_xo_v5_production`.
 *   - DISTINCT NAMESPACE. Every env var is `MEGA_V5_PRODUCTION_*` (never the staging `MEGA_V51_*`),
 *     the secrets directory and the Redis credential envelope are separate files, and the ephemera
 *     namespace is DERIVED (`prd<5 hex>`, over a production-only hash domain) so a production process
 *     can never share staging's `mx:stg:<keyVersion>:*` coordination namespace.
 *   - SECRETS ONLY FROM FILES. The Neon CA, the per-role credential envelope, the Core gateway HMAC
 *     secret and the OTP/mail secret load from absolute, regular, non-symlinked mode-0600 files.
 *     Nothing is read from an inline env value, and no secret or connection URL is ever printed.
 *   - EXPLICIT ROLE SEPARATION, ASSERTED AT BOOT. API uses `api_runtime`, Core uses `core_runtime`,
 *     the worker uses `worker_runtime`; every pool's `describe().role` is asserted, and the API
 *     handler context is asserted to hold no Core pool (it reaches Core only over the signed
 *     ingress), mirroring the proof in tests/v5-p11-browser-compat.test.js.
 *   - OUTBOUND PROVIDER CLASSES STAY DISABLED, ENFORCED FROM THE TARGET FILE: email,
 *     storeNotifications and adRewards are read from the bound inventory, never from a flag. The
 *     current production inventory disables all three; a class the inventory enables is refused
 *     because no provider implementation is configured here.
 *   - NO V4 COUPLING. This module never reads, writes, starts or stops a V4 path, container,
 *     database or service, and never shells out to Docker. It binds loopback only (never a
 *     wildcard), applies a route-aware crawl policy (blanket noindex; manifest-indexable 200 pages
 *     released, per owner directive A04 2026-10-16) and serves the generated bundle only.
 *
 * OPERATOR SEQUENCE (E5 - every step below is a deliberate, separate switch):
 *   1. E1-E4 complete: the legacy V4 authority is frozen and fenced, its writers stopped by the
 *      fence/epoch tooling (NOT by this process), and docs/v5/environments/production.json
 *      reconciled. This process never touches the legacy authority.
 *   2. Provision the production secrets directory OUTSIDE Git (mode 0700) with the credential
 *      envelope, the role envelope, the sealed signing-key custody and the Neon root CA
 *      (credentials.json, runtime-roles.json, keys.sealed.json, ca.pem) plus the two generated-once
 *      files otp.secret and core-gateway.secret. Every file must be mode 0600.
 *   3. DELIBERATE SWITCH A - the FIRST PRODUCTION WRITE: create the single ACTIVE `prd` signing key
 *      row in identity.signing_keys (access-service bootstrap) with its private half already sealed
 *      in keys.sealed.json. This entry point REFUSES to boot before that exists
 *      (EXISTING_SIGNING_KEY_CUSTODY_REQUIRED) and never mints a key implicitly.
 *   4. Build the immutable web artifact from the frozen commit:
 *        node scripts/p21/build-web.js --output .artifacts/p21-web
 *   5. Export the binding and start the co-located stack (loopback only; no wildcard, no --allow-host
 *      escape hatch in production):
 *        MEGA_V5_PRODUCTION_SERVER=blue-sun-85454968/br-dawn-dawn-b8f9n7zq/mega_xo_v5_production \
 *        MEGA_V5_PRODUCTION_SECRETS=<absolute dir> MEGA_HTTP_PORT=8080 \
 *        node scripts/v51/v5-production-server.cjs --web-build .artifacts/p21-web
 *      While the inventory declares `"nonserving": true` the binding validator REFUSES any authority
 *      epoch, so this process cannot become the recorded serving authority by configuration drift;
 *      it still composes the REAL production pools, so start it only once the E4 writer fence is
 *      recorded. /livez and /readyz answer exactly as the deploy tooling and the host health monitor
 *      expect, and that is the only traffic this step needs.
 *   6. DELIBERATE SWITCH B - the AUTHORITY EPOCH: flip `"nonserving"` to false in the inventory (after
 *      the recorded writer fence and first application write) and start with
 *        MEGA_V5_PRODUCTION_SERVE=v5:<13-digit epoch>:<16-64 hex>
 *      This is one configuration change plus one immutable-image deploy - no new code. A serving
 *      target whose epoch is missing or malformed is REFUSED, and an epoch supplied while the target
 *      is still nonserving is REFUSED (never arm early).
 *   7. Verify: /livez and /readyz answer 200 {"status":"ok","live":true,"ready":true}; / serves the
 *      bundle shell; a missing asset is a real 404, never an HTML fallback; route-aware robots header.
 *
 * Usage: MEGA_V5_PRODUCTION_SERVER=blue-sun-85454968/br-dawn-dawn-b8f9n7zq/mega_xo_v5_production \
 *          node scripts/v51/v5-production-server.cjs [--port 8080] [--web-build .artifacts/p21-web]
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createResendMailTransport } = require(path.join(__dirname, '..', '..', 'packages', 'services', 'mail-resend.js'));

const ROOT = path.resolve(__dirname, '..', '..');
const PRODUCTION_TARGET_FILE = path.join(ROOT, 'docs/v5/environments/production.json');
const REDIS_PRODUCTION_FILE = path.join(ROOT, 'docs/v5/environments/redis-production.json');

/* Production-only env prefix. Nothing here reads a staging variable, and nothing staging reads is
 * read here: the two processes cannot be started, or configured, by the same accident. */
const SECRETS_DIR = process.env.MEGA_V5_PRODUCTION_SECRETS || '/Users/oculus/Downloads/Mega-XO-private-evidence/v5-neon-production';
const BINDING_ENV = 'MEGA_V5_PRODUCTION_SERVER';
const SERVING_EPOCH_ENV = 'MEGA_V5_PRODUCTION_SERVE';
const HTTP_PORT_ENV = 'MEGA_HTTP_PORT';
const REDIS_CREDENTIALS_ENV = 'MEGA_V5_PRODUCTION_REDIS_CREDENTIALS';

/* The scheduled backup-freshness unit's state file. `/opsz` reads it to answer "is the newest
 * verified backup inside the approved RPO", so the probe is backup-aware rather than a liveness
 * echo. The production unit sets `MEGA_V5_PRODUCTION_STATE_DIR`; the default matches the deployed
 * systemd unit's root. */
const STATE_DIR = process.env.MEGA_V5_PRODUCTION_STATE_DIR || '/opt/mega-xo-v5-production/state';
const FRESHNESS_STATE_FILE = path.join(STATE_DIR, 'freshness-state.json');
/* These live in the PROTECTED deployment state dir (the same one the backup gate and
 * freshness checker read), never inside the swappable src-final tree. */
const WORKER_OBSERVATION_FILE = path.join(STATE_DIR, 'worker-observation.json');
const DB_WRITE_JOURNAL_FILE = path.join(STATE_DIR, 'db-write-journal');
const DEFAULT_IDLE_PULSE_MS = 2 * 60 * 60 * 1000;
const commerceSweepContext = new AsyncLocalStorage();

/* The private-material filenames inside the secrets directory. All are absolute, regular,
 * non-symlinked, mode-0600 files; the two `.secret` files are created once (0600) and then reused, so
 * a restart never invalidates a one-time code or a configured ingress caller. */
const SECRET_FILES = Object.freeze({
  credentials: 'credentials.json', runtimeRoles: 'runtime-roles.json', keys: 'keys.sealed.json',
  ca: 'ca.pem', otp: 'otp.secret', gateway: 'core-gateway.secret',
  /* SEC-V52: the edge proxy assertion secret (the same value Caddy sends as X-Mega-Proxy-Key).
   * Deployed from the host-managed proxy secret file; MEGA_PROXY_SECRET_FILE may point at the
   * absolute deployment path instead. Never reused as the Core ingress HMAC key. */
  proxy: 'proxy.secret',
  /* Dedicated key. Analytics rotation must never rotate OTPs or the reverse. */
  apkDownloads: 'apk-download.secret',
});

/* The exact production identity. Pinned here as well as read from the inventory: a drift in either
 * place is a refusal, never a silent rebinding. */
const PRODUCTION_IDENTITY = Object.freeze({
  environment: 'production',
  projectId: 'blue-sun-85454968',
  branchId: 'br-dawn-dawn-b8f9n7zq',
  endpointId: 'ep-mute-surf-b8v94ksa',
  host: 'ep-mute-surf-b8v94ksa.c-14.us-east-1.aws.neon.tech',
  database: 'mega_xo_v5_production',
  pgMajor: 16,
});
const PRODUCTION_DATABASE = PRODUCTION_IDENTITY.database;
const PRODUCTION_BINDING = [PRODUCTION_IDENTITY.projectId, PRODUCTION_IDENTITY.branchId, PRODUCTION_IDENTITY.database].join('/');

/* `v5:<13-digit epoch ms>:<16-64 hex>` - the authority-epoch grammar the P22/P23 cutover tooling
 * already verifies (scripts/v5/p23/retirement-readiness.js). Reused rather than invented. */
const AUTHORITY_EPOCH = /^v5:[0-9]{13}:[0-9a-f]{16,64}$/;
const BINDING_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/* The three outbound provider classes. Their state is a property of the bound target file. */
const OUTBOUND_CLASSES = Object.freeze(['email', 'storeNotifications', 'adRewards']);
const OUTBOUND_STATES = Object.freeze(['disabled', 'enabled']);

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
/* Production serves inside the co-located edge: the loopback port the edge/monitor front, on the same
 * `MEGA_HTTP_PORT` pattern the V4 deployment already uses (default 8080). */
const DEFAULT_HTTP_PORT = 8080;
const GATEWAY_TIMEOUT_MS = 30000;
const SECRET_MAX_BYTES = 4 * 1024 * 1024;
const REFUSE = (code, detail) => { const error = new Error(detail === undefined ? code : `${code}: ${String(detail).slice(0, 200)}`); error.code = code; return error; };

/* Native AdMob configuration is a single fail-closed boundary: reject typoed modes/IDs rather
 * than quietly composing an ad-enabled status with no usable inventory. Google SSV signs
 * `ad_unit` as the provider's numeric unit suffix; translate that verified suffix back to the
 * exact configured full unit before Core compares it with the ticket's stored binding. */
function resolveCommerceAdsConfig(env = process.env) {
  const mode = env.MEGA_AD_MODE || 'off';
  if (!['off', 'rewarded', 'hybrid'].includes(mode)) throw REFUSE('INVALID_AD_MODE');
  const deletion = env.MEGA_ACCOUNT_DELETION_ENABLED || 'false';
  if (!['true', 'false'].includes(deletion)) throw REFUSE('INVALID_ACCOUNT_DELETION_FLAG');
  const validVersion = (value) => typeof value === 'string' && /^[A-Za-z0-9._-]{3,64}$/.test(value);
  const privacyVersion = env.MEGA_PRIVACY_POLICY_VERSION || '';
  const retentionVersion = env.MEGA_RETENTION_POLICY_VERSION || '';
  const consentVersion = env.MEGA_AD_CONSENT_VERSION || '';
  const unitPattern = /^ca-app-pub-\d{16}\/\d{10}$/;
  const adUnits = {};
  for (const platform of ['ANDROID', 'IOS']) {
    const readUnit = (name) => {
      const value = env[name] || '';
      if (value && (typeof value !== 'string' || !unitPattern.test(value))) {
        throw REFUSE('INVALID_ADMOB_UNIT', name);
      }
      return value;
    };
    const rewarded = readUnit(`ADMOB_${platform}_REWARDED_UNIT`);
    const interstitial = readUnit(`ADMOB_${platform}_INTERSTITIAL_UNIT`);
    if (interstitial && !rewarded) throw REFUSE('ADMOB_REWARDED_UNIT_REQUIRED', platform.toLowerCase());
    if (rewarded || interstitial) adUnits[platform.toLowerCase()] = Object.freeze({ rewarded, interstitial });
  }
  // The callback includes only the numeric unit suffix. It must resolve to exactly one full unit.
  const unitByCallbackId = new Map();
  for (const units of Object.values(adUnits)) {
    for (const fullUnit of [units.rewarded, units.interstitial].filter(Boolean)) {
      const callbackId = fullUnit.slice(fullUnit.lastIndexOf('/') + 1);
      const previous = unitByCallbackId.get(callbackId);
      if (previous && previous !== fullUnit) throw REFUSE('AMBIGUOUS_ADMOB_UNIT_BINDING');
      unitByCallbackId.set(callbackId, fullUnit);
    }
  }
  if (mode !== 'off') {
    if (deletion !== 'true' || !validVersion(privacyVersion) || !validVersion(retentionVersion)) {
      throw REFUSE('ADS_REQUIRE_PRIVACY_RELEASE');
    }
    if (!validVersion(consentVersion)) throw REFUSE('ADS_REQUIRE_CONSENT_RELEASE');
    if (!adUnits.android || !adUnits.android.rewarded) throw REFUSE('ADMOB_ANDROID_REWARDED_UNIT_REQUIRED');
    if (mode === 'hybrid' && Object.values(adUnits).some((units) => !units.interstitial)) {
      throw REFUSE('INCOMPLETE_ADMOB_UNITS');
    }
  }
  return Object.freeze({ mode, adUnits: Object.freeze(adUnits), unitByCallbackId });
}

function bindAdMobVerifier(baseVerifier, adsConfig) {
  if (typeof baseVerifier !== 'function') throw REFUSE('AD_VERIFIER_REQUIRED');
  return async (raw) => {
    const event = await baseVerifier(raw);
    const callbackId = event && typeof event.adUnit === 'string' ? event.adUnit : '';
    const configuredUnit = Object.values(adsConfig.adUnits).flatMap((units) => [units.rewarded, units.interstitial])
      .find((unit) => unit && unit === callbackId) || adsConfig.unitByCallbackId.get(callbackId);
    if (!configuredUnit) throw REFUSE('UNCONFIGURED_ADMOB_UNIT');
    return { ...event, adUnit: configuredUnit };
  };
}

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const safeError = (err) => (err && err.message) ? String(err.message).slice(0, 120) : 'ERROR';

/* One shared idle wake, with independent single-flight lanes. A wake arriving during a pass is
 * latched until it finishes; a deadline re-arm can never overwrite an earlier insert wake. */
function createIdlePulseScheduler({ intervalMs = DEFAULT_IDLE_PULSE_MS, now = Date.now, timers = globalThis, onError = () => {} } = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 0x7fffffff) throw REFUSE('INVALID_IDLE_PULSE');
  const lanes = new Map();
  let interval = null, stopped = false, pulseCount = 0, nextPulseAt = now() + intervalMs;
  const report = (name, error) => { try { onError(name, error); } catch {} };
  function armAt(name, at) {
    const lane = lanes.get(name);
    if (stopped || !lane) return;
    if (lane.timer !== null && lane.timerAt <= at) return;
    if (lane.timer !== null) timers.clearTimeout(lane.timer);
    lane.timerAt = at;
    lane.timer = timers.setTimeout(() => {
      lane.timer = null;
      if (lane.pending) { lane.latched = true; return; }
      run(name);
    }, Math.max(0, at - now()));
    lane.timer.unref?.();
  }
  function run(name) {
    const lane = lanes.get(name);
    if (stopped || !lane) return Promise.resolve();
    if (lane.pending) return lane.pending;
    if (lane.timer !== null) { timers.clearTimeout(lane.timer); lane.timer = null; }
    if (lane.wakeAt !== null && lane.wakeAt <= now()) lane.wakeAt = null;
    lane.pending = Promise.resolve().then(lane.callback).catch((error) => report(name, error)).finally(() => {
      lane.pending = null;
      if (lane.latched) { lane.latched = false; armAt(name, now()); }
      else if (lane.wakeAt !== null) armAt(name, lane.wakeAt);
    });
    return lane.pending;
  }
  return {
    get nextPulseAt() { return nextPulseAt; },
    get pulseCount() { return pulseCount; },
    add(name, callback) {
      if (lanes.has(name)) throw REFUSE('DUPLICATE_IDLE_LANE');
      lanes.set(name, { callback, pending: null, timer: null, timerAt: 0, wakeAt: null, latched: false });
    },
    run, armAt,
    wake(name, delayMs) {
      const lane = lanes.get(name);
      if (stopped || !lane) return;
      // An earlier deadline/pulse must not consume the delayed write wake before its
      // transaction has had a chance to commit (the pool hook fires before sending SQL).
      lane.wakeAt = Math.min(lane.wakeAt ?? Infinity, now() + delayMs);
      armAt(name, lane.wakeAt);
    },
    start() {
      if (stopped || interval !== null) return;
      nextPulseAt = now() + intervalMs;
      interval = timers.setInterval(() => {
        pulseCount++;
        nextPulseAt = now() + intervalMs;
        for (const [name, lane] of lanes) {
          // A pass that began before the pulse may have skipped a now-due slow sweep.
          if (lane.pending) lane.latched = true;
          run(name);
        }
      }, intervalMs);
      interval.unref?.();
    },
    async stop() {
      stopped = true;
      if (interval !== null) { timers.clearInterval(interval); interval = null; }
      for (const lane of lanes.values()) if (lane.timer !== null) { timers.clearTimeout(lane.timer); lane.timer = null; }
      await Promise.allSettled([...lanes.values()].map((lane) => lane.pending));
    },
  };
}

const WRITE_SQL = /^(?:(?:insert|update|delete|truncate|merge|create|alter|drop|grant|revoke|comment|do|call|copy|refresh|reindex|lock)\b|with\b)/i;
function createWriteWakeHooks({ journalFile = DB_WRITE_JOURNAL_FILE, wakeWorker = () => {}, wakeCommerce = () => {} } = {}) {
  let lastTouchAt = 0;
  function journalTouch(sql) {
    if (!WRITE_SQL.test(sql)) return;
    try {
      fs.mkdirSync(path.dirname(journalFile), { recursive: true });
      if (!fs.existsSync(journalFile)) fs.closeSync(fs.openSync(journalFile, 'a', 0o600));
      // Distinct mtimes even when several statements arrive in the same millisecond.
      lastTouchAt = Math.max(Date.now(), lastTouchAt + 1);
      fs.utimesSync(journalFile, lastTouchAt / 1000, lastTouchAt / 1000);
    } catch { /* A journal/wake failure must never reject a database statement. */ }
  }
  function wakeOnInsert(sql) {
    try { if (/insert\s+into\s+ops\.outbox\b/i.test(sql)) wakeWorker(); } catch {}
    // Sweep-owned writes must not recursively start a permanent two-second SQL loop. Async
    // context suppresses only those writes; concurrent purchase/webhook writes still latch a pass.
    try { if (WRITE_SQL.test(sql) && /\bmonetization\./i.test(sql) && !commerceSweepContext.getStore()) wakeCommerce(); } catch {}
  }
  return { journalTouch, wakeOnInsert, onWrite(sql) { try { journalTouch(sql); } catch {} try { wakeOnInsert(sql); } catch {} } };
}

/* The gate consumes an observation only when a probe is being considered/run. The health route
 * calls it at probe start too, so boot/retry/pulse probes establish the same journal baseline. */
function createDbProbeGate({ journalFile = DB_WRITE_JOURNAL_FILE, pulseCount = () => 0 } = {}) {
  let lastMtime = null, lastPulse = -1;
  return () => {
    let mtime = null;
    try { mtime = fs.statSync(journalFile).mtimeMs; } catch {}
    const pulse = pulseCount();
    const changed = mtime !== lastMtime || pulse !== lastPulse;
    lastMtime = mtime; lastPulse = pulse;
    return changed;
  };
}

/* Worker deadlines and observation reads are part of a pass, never a monitor request. */
function createIdleMaintenance({ worker, pool, commerceTasks = {}, tournamentTick = async () => {}, probeDb = async () => {}, observationFile = WORKER_OBSERVATION_FILE,
  intervalMs = DEFAULT_IDLE_PULSE_MS, now = Date.now, timers = globalThis, onError = () => {} } = {}) {
  const scheduler = createIdlePulseScheduler({ intervalMs, now, timers, onError });
  let lastSlowAt = null;
  scheduler.add('commerce', () => commerceSweepContext.run(true, async () => {
    await Promise.all(Object.entries(commerceTasks).map(async ([name, task]) => {
      try { await task(); } catch (error) { onError(name, error); }
    }));
  }));
  scheduler.add('worker', async () => {
    const startedAt = now();
    const includeSlow = lastSlowAt === null || startedAt - lastSlowAt >= DEFAULT_IDLE_PULSE_MS;
    try {
      await worker.tick({ includeSlow });
      if (includeSlow) lastSlowAt = startedAt;
    } finally {
      await refreshWorkerObservation({ pool, observationFile, now });
      let nextAt = null;
      try { nextAt = await worker.nextWakeAt(); } catch (error) { onError('worker_deadline', error); }
      const deadline = typeof nextAt === 'number' && Number.isFinite(nextAt)
        ? (nextAt <= now() ? now() + 1000 : nextAt) : Infinity;
      scheduler.armAt('worker', Math.min(deadline, scheduler.nextPulseAt));
    }
  });
  // The timer still owns active deadlines/wake(), but an idle sweep is realigned to this pulse
  // after activity, rather than keeping a second two-hour cadence at a different wall-clock phase.
  scheduler.add('tournaments', tournamentTick);
  scheduler.add('db_health', async () => {
    // Snapshot the journal after the pulse's writes, so a monitor cannot extend the suspend tail
    // by treating those same maintenance writes as fresh traffic one minute later.
    await Promise.all(['commerce', 'worker', 'tournaments'].map((name) => scheduler.run(name)));
    await probeDb();
  });
  return {
    get pulseCount() { return scheduler.pulseCount; },
    wakeWorker() { scheduler.wake('worker', 1000); },
    wakeCommerce() { scheduler.wake('commerce', 2000); },
    async start() {
      worker.start(); // intervalMs: 0; only the composition arms worker deadlines.
      scheduler.start();
      await Promise.all(['commerce', 'worker', 'tournaments', 'db_health'].map((name) => scheduler.run(name)));
    },
    stop() { return scheduler.stop(); },
  };
}

/* ------------------------------------------------------------------ secrets */

/* Reads private material from an absolute, regular, non-symlinked file whose mode grants nothing to
 * group/other. The mode is checked on the OPENED descriptor, so a path swapped after the initial
 * lstat cannot slip a world-readable file past the guard. The returned text is never logged; callers
 * either parse it or use it as a key. */
function readSecretFile(file, { label, maxBytes = SECRET_MAX_BYTES } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw REFUSE('SECRET_PATH_REQUIRED', label);
  let lst;
  try { lst = fs.lstatSync(file); } catch { throw REFUSE('SECRET_FILE_UNREADABLE', label); }
  if (!lst.isFile() || lst.isSymbolicLink()) throw REFUSE('SECRET_FILE_UNSAFE', label);
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
  catch { throw REFUSE('SECRET_FILE_UNREADABLE', label); }
  let text;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw REFUSE('SECRET_FILE_UNSAFE', label);
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw REFUSE('SECRET_FILE_NOT_PRIVATE', label);
    if (stat.size === 0 || stat.size > maxBytes) throw REFUSE('SECRET_FILE_SIZE_INVALID', label);
    text = fs.readFileSync(fd, 'utf8');
  } finally { try { fs.closeSync(fd); } catch { /* descriptor already gone */ } }
  return text;
}

/* `SECRET_FILES` names -> absolute paths inside the configured secrets directory. The directory
 * itself must be absolute; a relative root would make every guard path-dependent. */
function secretPaths(dir = SECRETS_DIR) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw REFUSE('SECRETS_DIR_MUST_BE_ABSOLUTE');
  const out = {};
  for (const [key, name] of Object.entries(SECRET_FILES)) out[key] = path.join(dir, name);
  return Object.freeze(out);
}

/* Loads (or, on the very first boot, mints once) a STABLE operator secret. A fresh random value on
 * every restart would invalidate every one-time code already issued and every configured ingress
 * caller. The file is mode 0600, never printed and shared by every process of this environment. */
function loadStableSecret(secretPath, code) {
  if (fs.existsSync(secretPath)) {
    const value = readSecretFile(secretPath, { label: path.basename(secretPath) }).trim();
    if (value.length >= 32) return value;
    throw REFUSE(`${code}_TOO_SHORT`);
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, generated + '\n', { mode: 0o600, flag: 'wx' });
  return generated;
}

/* --------------------------------------------------------- pure validators */

/* `<projectId>/<branchId>/<database>` - the staging convention, widened to name the branch too. */
function parseProductionBinding(binding) {
  if (typeof binding !== 'string' || binding.length === 0) throw REFUSE('PRODUCTION_BINDING_REQUIRED', BINDING_ENV);
  const parts = binding.split('/');
  if (parts.length !== 3 || parts.some((part) => !BINDING_TOKEN.test(part))) throw REFUSE('MALFORMED_PRODUCTION_BINDING', binding.length);
  return Object.freeze({ projectId: parts[0], branchId: parts[1], database: parts[2] });
}

/* The exact-target guard: the inventory must still be the pinned production identity, and it must not
 * have started serving unless the deliberate authority-epoch switch is set. Returns the bound
 * descriptor; every other outcome throws. */
function validateProductionBinding({ binding, target, servingEpoch = null } = {}) {
  const parsed = parseProductionBinding(binding);
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw REFUSE('REFUSED_PRODUCTION_TARGET_FILE', 'inventory required');
  if (target.environment !== PRODUCTION_IDENTITY.environment) throw REFUSE('REFUSED_PRODUCTION_TARGET_FILE', 'environment');
  for (const field of ['projectId', 'branchId', 'endpointId', 'host']) {
    if (target[field] !== PRODUCTION_IDENTITY[field]) throw REFUSE('REFUSED_PRODUCTION_TARGET_FILE', `${field} drift`);
  }
  if (target.pgMajor !== PRODUCTION_IDENTITY.pgMajor) throw REFUSE('REFUSED_PRODUCTION_TARGET_FILE', 'pgMajor');
  /* The database name alone decides whether this is production at all. */
  if (target.database !== PRODUCTION_DATABASE) throw REFUSE('REFUSED_NON_PRODUCTION_DATABASE', target.database);
  if (parsed.projectId !== target.projectId || parsed.branchId !== target.branchId || parsed.database !== target.database) {
    throw REFUSE('REFUSED_PRODUCTION_BINDING', 'the binding does not name the exact production project/branch/database');
  }
  if (typeof target.nonserving !== 'boolean') throw REFUSE('REFUSED_NONSERVING_FLAG_INVALID');
  const outbound = resolveOutboundPolicy(target);
  /* LR10 production-bug fix (2026-10-19): provider composition is asserted in main() WITH the
   * entry's capability map — an enabled class without an implemented provider still refuses there.
   * Refusing here made boot depend on provider wiring the validator cannot see and blocked a
   * correctly provisioned inventory from ever starting. The declaration itself stays validated. */
  /* Switch A is the first production write and switch B is the authority epoch; nothing here can
   * reach a serving target by accident, and nothing arms early. */
  if (target.nonserving === true) {
    if (servingEpoch !== null && servingEpoch !== undefined && servingEpoch !== '') throw REFUSE('SERVING_EPOCH_BEFORE_CUTOVER');
    return Object.freeze({ ...parsed, host: target.host, endpointId: target.endpointId, nonserving: true, serving: false, servingEpoch: null, outbound });
  }
  if (typeof servingEpoch !== 'string' || !AUTHORITY_EPOCH.test(servingEpoch)) throw REFUSE('REFUSED_SERVING_PRODUCTION_TARGET', `${SERVING_EPOCH_ENV} (authority epoch) required`);
  return Object.freeze({ ...parsed, host: target.host, endpointId: target.endpointId, nonserving: false, serving: true, servingEpoch, outbound });
}

/* Outbound policy is READ FROM THE TARGET FILE, never from a flag. The resolved state of a class is
 * exactly what the bound inventory declares; an explicit request can only CONFIRM a declaration, never
 * flip a `disabled` class on (`OUTBOUND_CLASS_DISABLED_BY_TARGET`). An inventory that enables a class
 * therefore yields an enabled policy, which the composition then refuses to run without a provider for. */
function resolveOutboundPolicy(target, requested = {}) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw REFUSE('REFUSED_PRODUCTION_TARGET_FILE', 'outbound');
  const declared = target.outbound;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) throw REFUSE('OUTBOUND_DECLARATION_INVALID', 'outbound section');
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) throw REFUSE('OUTBOUND_REQUEST_INVALID');
  for (const key of Object.keys(requested)) {
    if (!OUTBOUND_CLASSES.includes(key)) throw REFUSE('OUTBOUND_CLASS_UNKNOWN', key);
  }
  const policy = {};
  for (const klass of OUTBOUND_CLASSES) {
    const state = declared[klass];
    if (!OUTBOUND_STATES.includes(state)) throw REFUSE('OUTBOUND_DECLARATION_INVALID', klass);
    const wanted = requested[klass];
    if (wanted !== undefined && !OUTBOUND_STATES.includes(wanted)) throw REFUSE('OUTBOUND_REQUEST_INVALID', klass);
    /* A request may only CONFIRM the declaration: it can never flip a class either way. */
    if (wanted !== undefined && wanted !== state) {
      throw REFUSE(state === 'disabled' ? 'OUTBOUND_CLASS_DISABLED_BY_TARGET' : 'OUTBOUND_REQUEST_INVALID', klass);
    }
    policy[klass] = state;
  }
  return Object.freeze(policy);
}

/* A mail transport bound to the resolved policy. When email is disabled by the target the worker
 * defers every delivery (`enabled() === false`) instead of claiming work it must not send. */
function createMailTransportForPolicy(policy, options = {}) {
  if (!policy || typeof policy !== 'object') throw REFUSE('OUTBOUND_POLICY_REQUIRED');
  if (policy.email === 'disabled') {
    const unreachable = (method) => () => { throw REFUSE('OUTBOUND_DISABLED_BY_TARGET', method); };
    return Object.freeze({
      enabled: () => false,
      sendOtp: unreachable('sendOtp'),
      sendPasswordChanged: unreachable('sendPasswordChanged'),
      sendSecurityNotice: unreachable('sendSecurityNotice'),
      sendMail: unreachable('sendMail'),
    });
  }
  /* LR10: the Resend transport is the implemented email provider. The key arrives through the
   * approved secret channel (RESEND_API_KEY or RESEND_API_KEY_FILE, mode 0600); a composition that
   * enables email without it is refused here rather than at first send. */
  const resendApiKey = options.resendApiKey;
  if (typeof resendApiKey !== 'string' || resendApiKey.length === 0) {
    throw REFUSE('OUTBOUND_EMAIL_KEY_REQUIRED');
  }
  const emailFetch = options.emailFetch || globalThis.fetch;
  if (typeof emailFetch !== 'function') throw REFUSE('OUTBOUND_EMAIL_FETCH_REQUIRED');
  return createResendMailTransport({ apiKey: resendApiKey, fetcher: emailFetch });
}

/* This entry point composes NO outbound provider: it has no mail provider, no store notification
 * verifier and no rewarded-ad service. A target file that ENABLES a class is therefore refused
 * explicitly rather than silently ignored - a declared outbound effect that nothing implements is a
 * configuration error, and the cutover inventory keeps all three disabled. */
function assertProviderClassesComposable(policy, capabilities = {}) {
  if (!policy || typeof policy !== 'object') throw REFUSE('OUTBOUND_POLICY_REQUIRED');
  const enabled = OUTBOUND_CLASSES.filter((klass) => policy[klass] === 'enabled');
  const unimplemented = enabled.filter((klass) => typeof capabilities[klass] !== 'string' || capabilities[klass].length === 0);
  if (unimplemented.length > 0) throw REFUSE('OUTBOUND_CLASS_UNIMPLEMENTED', unimplemented.join(','));
  return Object.freeze({ composed: false, classes: Object.freeze({ ...policy }) });
}

/* --------------------------------------------------------------- namespace */

/* The ephemera namespace is `mx:<environment>:<keyVersion>:<family>:...` (packages/services/ephemera
 * .js). Both halves are DERIVED: the environment token is production-only (`prd`) and the keyVersion
 * comes from a production-only hash domain over the binding, so a production process can never land
 * in `mx:stg:*` - and, for the same input, its keyVersion differs from staging's by construction. */
function deriveNamespace(environment, binding) {
  const map = { production: 'prd', staging: 'stg', dev: 'tst' };
  const token = map[environment];
  if (!token) throw REFUSE('NAMESPACE_ENVIRONMENT_INVALID', environment);
  if (typeof binding !== 'string' || binding.length === 0) throw REFUSE('PRODUCTION_BINDING_REQUIRED');
  const digest = crypto.createHash('sha256').update(`mega-v5:${environment}:namespace:${binding}`).digest('hex');
  const keyVersion = `${token}${digest.slice(0, 5)}`;
  if (!/^[a-z0-9]{1,8}$/.test(keyVersion)) throw REFUSE('INVALID_KEY_VERSION');
  return Object.freeze({ environment: token, keyVersion, prefix: `mx:${token}:${keyVersion}:` });
}

/* ------------------------------------------------------------- role binding */

const REQUIRED_ROLE = Object.freeze({ api: 'api_runtime', core: 'core_runtime', worker: 'worker_runtime' });

/* `describe().role` is the pool's own assertion of the login identity it was built with. A pool whose
 * role is not the one this composition expects is refused before a single statement runs. */
function assertPoolRole(pool, expectedRole, label) {
  const described = pool && typeof pool.describe === 'function' ? pool.describe() : null;
  const role = described ? described.role : null;
  if (role !== expectedRole) throw REFUSE('POOL_ROLE_MISMATCH', `${label || 'pool'} expected ${expectedRole}, observed ${role}`);
  return described;
}

/* The three pools must describe exactly the three required runtime roles, each exactly once, and no
 * role may be observed twice: a composition that hands the Core pool to the API (or vice versa) is
 * refused before a single statement runs. */
function assertRoleSeparation(pools) {
  const out = {};
  for (const key of ['api', 'core', 'worker']) {
    const described = assertPoolRole(pools && pools[key], REQUIRED_ROLE[key], key);
    out[key] = Object.freeze({ role: described.role, applicationName: described.applicationName || null });
  }
  const required = Object.values(REQUIRED_ROLE).sort().join(',');
  const observed = Object.values(out).map((entry) => entry.role).sort().join(',');
  if (observed !== required) throw REFUSE('POOL_ROLE_MISMATCH', `api/core/worker roles are ${observed}`);
  return Object.freeze(out);
}

/* The public API process holds ONLY API-role credentials: it carries no Core pool and no Core service,
 * and reaches Core exclusively over the signed ingress (the proof composed in
 * tests/v5-p11-browser-compat.test.js). This assertion makes that structural, not aspirational. */
function assertApiCompositionHoldsNoCoreAccess(context) {
  if (!context || typeof context !== 'object') throw REFUSE('API_CONTEXT_REQUIRED');
  for (const key of ['corePool', 'coreService', 'leaderboardPool', 'workerPool', 'privacyPool', 'coreClient']) {
    if (context[key] !== undefined) throw REFUSE('API_HOLDS_CORE_POOL', key);
  }
  const described = assertPoolRole(context.pool, REQUIRED_ROLE.api, 'api');
  return Object.freeze({ role: described.role, applicationName: described.applicationName || null });
}

/* The mirror assertion: the Core-side composition (Core service, Core-owned queue, leaderboard
 * materializer) runs on the `core_runtime` pool and never on the API's. The one deliberate exception
 * is the API-owned ticket issuer, exactly as in the proven staging stack: ticket rows are API-granted
 * (createTicketIssuer enforces `api_runtime` itself), so it is asserted separately rather than waived.
 */
function assertCoreCompositionUsesCorePool({ corePool, queuePool, leaderboardPool, ticketIssuerPool, apiPool } = {}) {
  const core = assertPoolRole(corePool, REQUIRED_ROLE.core, 'core');
  assertPoolRole(queuePool, REQUIRED_ROLE.core, 'queue');
  assertPoolRole(leaderboardPool, REQUIRED_ROLE.core, 'leaderboard');
  assertPoolRole(ticketIssuerPool, REQUIRED_ROLE.api, 'ticketIssuer');
  assertPoolRole(apiPool, REQUIRED_ROLE.api, 'api');
  if (corePool === apiPool) throw REFUSE('POOL_ROLE_MISMATCH', 'the Core composition shares the API pool');
  return Object.freeze({ role: core.role, applicationName: core.applicationName || null });
}

/* The connection budget is read from the inventory's per-role limits; a pool that would exceed its
 * role allocation (or a role limit that is missing/absurd) is refused before any socket. */
function resolveConnectionBudget(target, poolMax = { api: 6, core: 6, worker: 2 }) {
  const limits = target && target.roleConnectionLimits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw REFUSE('INVENTORY_ROLE_LIMITS_INVALID');
  const roleConnections = {};
  for (const role of Object.values(REQUIRED_ROLE)) {
    const limit = limits[role];
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw REFUSE('INVENTORY_ROLE_LIMITS_INVALID', role);
    roleConnections[role] = limit;
  }
  for (const [key, role] of Object.entries(REQUIRED_ROLE)) {
    const max = poolMax[key];
    if (!Number.isInteger(max) || max < 1 || max > roleConnections[role]) throw REFUSE('POOL_MAX_EXCEEDS_ROLE_LIMIT', role);
  }
  const totalConnections = Object.values(roleConnections).reduce((sum, n) => sum + n, 0);
  return Object.freeze({
    budget: Object.freeze({ totalConnections, roleConnections: Object.freeze(roleConnections) }),
    poolMax: Object.freeze({ api: poolMax.api, core: poolMax.core, worker: poolMax.worker }),
  });
}

const PRIVATE_BIND = /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/;

/* The HTTP bind. Default is loopback (`127.0.0.1`). When colocated with a Docker ingress (e.g. Caddy
 * edge container on the same host), `--allow-private-bind` allows binding to the bridge gateway
 * (172.18.x.x, 10.x.x, 192.168.x) so the edge can proxy to it, exactly as core-edge-proxy.cjs does.
 * Wildcard (`0.0.0.0`, `::`) and privileged ports (<1024) remain ALWAYS refused. */
function resolveHttpBinding({ host, port, allowPrivate = false } = {}) {
  const resolvedHost = host === undefined || host === null || host === '' ? '127.0.0.1' : host;
  if (!LOOPBACK.has(resolvedHost) && !(allowPrivate && PRIVATE_BIND.test(resolvedHost))) {
    throw REFUSE('REFUSED_NON_LOOPBACK_BIND', resolvedHost);
  }
  if (resolvedHost === '0.0.0.0' || resolvedHost === '::') throw REFUSE('REFUSED_WILDCARD_BIND');
  const resolvedPort = port === undefined || port === null || port === '' ? DEFAULT_HTTP_PORT : Number(port);
  if (!Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) throw REFUSE('HTTP_PORT_INVALID', String(port));
  /* Every privileged port is refused - never silently substituted: a stack that asked for one must
   * fail loudly instead of binding somewhere else. */
  if (resolvedPort < 1024) throw REFUSE('REFUSED_RESERVED_HTTP_PORT', String(resolvedPort));
  return Object.freeze({ host: resolvedHost, port: resolvedPort });
}

/* Server-side identity of the served artifact. Reused verbatim from the staging entry: the generated
 * bundle (scripts/p21/build-web.js) is the ONLY thing served, never the raw apps/web source tree, and
 * the artifact's own manifest is both the route table and the file allowlist, so an unlisted path is a
 * real 404 rather than a rewritten source file. */
function loadWebArtifact(dir) {
  const manifestPath = path.join(dir, 'web-build.manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('WEB_BUILD_ARTIFACT_REQUIRED: run scripts/p21/build-web.js');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.generator !== 'scripts/p21/build-web.js' || !Array.isArray(manifest.files)) {
    throw new Error('WEB_BUILD_ARTIFACT_INVALID');
  }
  const apk = manifest.store_links?.androidApk || null;
  if (apk) {
    const entry = typeof apk.path === 'string'
      ? manifest.files.find(file => file.path === apk.path.slice(1)) : null;
    if (typeof apk.path !== 'string' || !/^\/downloads\/android\/[A-Za-z0-9._-]+\.apk$/.test(apk.path) ||
        !Number.isSafeInteger(apk.versionCode) || apk.versionCode < 1 ||
        !entry || entry.sha256 !== apk.sha256 || entry.bytes !== apk.bytes) {
      throw new Error('WEB_BUILD_APK_MISMATCH');
    }
  }
  return Object.freeze({
    dir, routes: manifest.routes || {}, files: new Set(['web-build.manifest.json', ...manifest.files.map((f) => f.path)]),
    seo: manifest.seo || null, androidApk: apk,
    sourceCommit: manifest.source_commit || null, bundleSha256: manifest.bundle_sha256 || null, fileCount: manifest.file_count || manifest.files.length,
  });
}

/* Which surface a request path belongs to. Pure and total, so the routing decision can be asserted
 * offline: `ingress` (the signed Core ingress), `api` (the API handler, which also owns /livez,
 * /readyz and /health), `ops` (the operations-health probe: the V5 equivalent of the V4 `/opsz`,
 * which reads backup freshness and the durable worker queue rather than process liveness alone),
 * `operator` (refused privately), `realtime` (owned by the transport) or `static` (the generated
 * bundle). */
function classifyPath(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0) throw REFUSE('PATH_REQUIRED');
  if (pathname === '/realtime/v1/snapshot' || pathname === '/realtime/v1/snapshot/' || pathname.startsWith('/realtime/v1/match/')) return 'realtime';
  if (pathname.startsWith('/ingress/')) return 'ingress';
  if (pathname === '/opsz') return 'ops';
  if (pathname.startsWith('/api/') || pathname.startsWith('/auth/') || pathname.startsWith('/.well-known/') ||
      pathname === '/health' || pathname === '/livez' || pathname === '/readyz') return 'api';
  return 'static';
}

/* Route-aware crawl policy (LR04, owner directive A04 2026-10-16). The generated bundle already
 * ships per-page <meta name="robots"> plus a per-route metadata map (manifest.seo.metadata, built
 * from apps/web/seo.js); the old blanket production noindex header used to override that contract
 * sitewide. The header policy now mirrors the preview/vercel contract exactly: every response
 * defaults to noindex, nofollow, and ONLY a 200 response for a manifest route whose metadata marks
 * it indexable is released with the manifest's robots value. 404s, static assets, private routes
 * (game shell, account, ...), APIs, health/ops probes and unknown paths keep the noindex header.
 * Staging keeps its own unconditional noindex in scripts/v51/p21-staging-server.cjs, untouched. */
const DEFAULT_ROBOTS_HEADER = 'noindex, nofollow';
function robotsHeaderFor({ pathname, status, seo }) {
  if (typeof pathname !== 'string' || pathname.length === 0) return DEFAULT_ROBOTS_HEADER;
  const route = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  const meta = seo && seo.metadata ? seo.metadata[route] : null;
  if (status === 200 && meta && meta.indexable === true && typeof meta.robots === 'string' && meta.robots) return meta.robots;
  return DEFAULT_ROBOTS_HEADER;
}

/* Legal files (e.g. /legal/privacy.html) additionally carry the canonical Link header their alias
 * route (e.g. /privacy) declares, exactly like the preview server does. */
function legalCanonicalLink({ pathname, seo }) {
  if (typeof pathname !== 'string') return null;
  const rawLegal = /^\/legal\/([a-z-]+)\.html$/.exec(pathname);
  if (!rawLegal || !seo || !seo.metadata) return null;
  const meta = seo.metadata['/' + rawLegal[1]];
  return meta && typeof meta.canonical === 'string' ? '<' + meta.canonical + '>; rel="canonical"' : null;
}

/* The operations-health budget: how stale a verified backup may be before `/opsz` reports red, and
 * how much worker backlog is tolerable. The defaults mirror `packages/services/observability.js`
 * (24 h backup age, 100 outbox rows) so the V5 probe keeps the SAME meaning the V4 `/opsz` carried
 * (backup freshness + recovery/backlog), never a liveness-only green. */
const OPS_BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const OPS_OUTBOX_BACKLOG_MAX = 100;
let cachedWorkerObservation = null;
let cachedWorkerObservationFile = null;
const WORKER_COUNTS_SQL = "SELECT count(*) FILTER (WHERE state = 'failed')::int AS dlq, " +
  "count(*) FILTER (WHERE state IN ('queued', 'sending'))::int AS backlog FROM ops.outbox";

async function refreshWorkerObservation({ pool, observationFile = WORKER_OBSERVATION_FILE, now = Date.now }) {
  let dlq = null, backlog = null;
  try {
    const counts = (await pool.query(WORKER_COUNTS_SQL)).rows[0];
    dlq = counts.dlq; backlog = counts.backlog;
  } catch { /* An unreadable queue is persisted as unknown, never silently green. */ }
  const observation = { at: now(), dlq, backlog, source: 'worker-tick' };
  cachedWorkerObservation = observation;
  cachedWorkerObservationFile = observationFile;
  const temp = `${observationFile}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(observationFile), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(observation) + '\n', { mode: 0o600 });
    fs.renameSync(temp, observationFile);
  } catch { try { fs.unlinkSync(temp); } catch {} }
  return observation;
}

function readWorkerObservation(observationFile) {
  if (cachedWorkerObservationFile === observationFile && cachedWorkerObservation) return cachedWorkerObservation;
  try { return JSON.parse(fs.readFileSync(observationFile, 'utf8')); } catch { return null; }
}

/* The V5 operations-health probe. It answers the SAME contract the V4 perimeter published -
 * `200 {"ok":true}` when operations are healthy and `503 {"ok":false}` when they are not - so the
 * existing external `mega-xo-opsz` monitor keeps its meaning across the cutover. It is NOT a
 * liveness probe: it fails when the newest verified backup is stale, when the durable outbox has
 * dead-lettered (`failed`) rows, or when the queue is far beyond the backlog budget. The backup
 * freshness it reads is the SAME state the scheduled `mega-xo-v5-freshness` unit maintains. */
async function buildOpsReport({ freshnessFile, observationFile = WORKER_OBSERVATION_FILE, now }) {
  const at = now();
  const failures = [];

  /* 1. Backup freshness from the scheduled freshness unit's state file. A missing or unreadable
   * report is a failure: "no evidence" is never reported green. */
  let backup = { fresh: false, state: 'unknown', checkedAtUtc: null, ageMs: null };
  try {
    const doc = JSON.parse(fs.readFileSync(freshnessFile, 'utf8'));
    const checkedAt = doc.checkedAtUtc ? Date.parse(doc.checkedAtUtc) : NaN;
    const ageMs = Number.isFinite(checkedAt) ? at - checkedAt : null;
    const declaredFresh = doc.state === 'fresh';
    const reportFresh = ageMs !== null && ageMs <= OPS_BACKUP_MAX_AGE_MS;
    backup = { fresh: declaredFresh && reportFresh, state: doc.state || 'unknown', checkedAtUtc: doc.checkedAtUtc || null, ageMs };
    if (!declaredFresh) failures.push('newest verified backup is stale');
    else if (!reportFresh) failures.push('backup freshness report is older than the 24h budget');
  } catch {
    failures.push('backup freshness report is missing or unreadable');
  }

  /* 2. The last worker-pass observation, including after a failed tick. Age is explicit; an old
   * failure stays a failure until another real pass observes recovery. Monitors NEVER query SQL. */
  let worker = { dlq: null, backlog: null, ageMs: null };
  const observation = readWorkerObservation(observationFile);
  if (observation && Number.isFinite(observation.at) && observation.at >= 0 &&
      Number.isSafeInteger(observation.dlq) && observation.dlq >= 0 &&
      Number.isSafeInteger(observation.backlog) && observation.backlog >= 0) {
    worker = { dlq: observation.dlq, backlog: observation.backlog, ageMs: Math.max(0, at - observation.at) };
    if (worker.dlq > 0) failures.push(`dead-lettered jobs in the outbox (${worker.dlq})`);
    if (worker.backlog > OPS_OUTBOX_BACKLOG_MAX) failures.push(`outbox backlog (${worker.backlog}) exceeds the budget (${OPS_OUTBOX_BACKLOG_MAX})`);
  } else {
    if (observation && Number.isFinite(observation.at)) worker.ageMs = Math.max(0, at - observation.at);
    failures.push('worker queue could not be read');
  }

  const ok = failures.length === 0;
  return { ok, failures, backup, worker, at };
}

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json',
});

/** Stream a pinned APK and record only a fully ended source stream sent as HTTP 200. */
function streamApkFile(absolute, res, recordCompleted = null) {
  let streamEnded = false, streamFailed = false, responseAborted = false;
  const stream = fs.createReadStream(absolute);
  stream.once('end', () => { streamEnded = true; });
  stream.once('error', () => {
    streamFailed = true;
    if (!res.headersSent) {
      res.statusCode = 500;
      res.removeHeader('Content-Length');
      res.removeHeader('Content-Disposition');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('File unavailable');
    }
    else res.destroy();
  });
  res.once('close', () => {
    if (!res.writableFinished) {
      responseAborted = true;
      stream.destroy();
    }
  });
  if (typeof recordCompleted === 'function') res.once('finish', () => {
    const expectedBytes = Number(res.getHeader('Content-Length'));
    if (res.statusCode !== 200 || !streamEnded || streamFailed || responseAborted ||
        !Number.isSafeInteger(expectedBytes) || stream.bytesRead !== expectedBytes) return;
    // The file has already been delivered to Node's HTTP response: analytics must never gate it.
    Promise.resolve().then(recordCompleted).catch(() => console.error(JSON.stringify({
      event: 'apk.metrics_write_failed', code: 'APK_METRICS_PERSIST_FAILED',
    })));
  });
  stream.pipe(res);
  return stream;
}

function wantsApkMetrics(searchParams) {
  const values = searchParams?.getAll?.('metrics') || [];
  return values.length === 1 && values[0] === '1';
}

/* Reads a non-secret JSON inventory (a checked-in allowlisted manifest, never secret material). */
function readInventory(file) {
  if (!fs.existsSync(file)) throw REFUSE('INVENTORY_MISSING', path.basename(file));
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw REFUSE('INVENTORY_INVALID', path.basename(file)); }
  return parsed;
}

/* ------------------------------------------------------------------- main */

async function main() {
  /* The composition modules are required INSIDE main so that requiring this file for its validators
   * never loads a service, reads a secret or opens a socket. */
  const { createPgPool } = require(path.join(ROOT, 'packages/db/pg/pool.js'));
  const { createAccountService } = require(path.join(ROOT, 'packages/services/accounts.js'));
  const { createCoreService } = require(path.join(ROOT, 'packages/services/core.js'));
  const { createAccessService } = require(path.join(ROOT, 'packages/services/access.js'));
  const { createTicketIssuer } = require(path.join(ROOT, 'packages/services/tickets.js'));
  const { createQueueService } = require(path.join(ROOT, 'packages/services/queue.js'));
  const { createTournamentService } = require(path.join(ROOT, 'packages/services/tournaments.js'));
  const { createTournamentTimer } = require(path.join(ROOT, 'packages/services/tournament-timer.js'));
  const { createCoreGateway, createCoreServiceIngress } = require(path.join(ROOT, 'packages/services/core-gateway.js'));
  const { createCommerceService } = require(path.join(ROOT, 'packages/services/commerce.js'));
  const { createCommerceIngressService } = require(path.join(ROOT, 'packages/services/commerce-ingress.js'));
  const { createCashfreeProvider } = require(path.join(ROOT, 'packages/services/cashfree.js'));
  const { createPolarProvider } = require(path.join(ROOT, 'packages/services/polar.js'));
  const { createDodoProvider } = require(path.join(ROOT, 'packages/services/dodo.js'));
  const { createRateLimiter } = require(path.join(ROOT, 'packages/services/rate-limit.js'));
  const { createProviderCallbackLimiter, createCallbackSourceIp } = require(path.join(ROOT, 'packages', 'services', 'provider-callback-limit.js'));
  const { createAdMobVerifier } = require(path.join(ROOT, 'server/admob-ssv.js'));
  const { createPgStoreDb } = require(path.join(ROOT, 'packages/services/store-pg-adapter.js'));
  const { createMetricsSink } = require(path.join(ROOT, 'packages/services/metrics.js'));
  const { StorePurchaseProvider } = require(path.join(ROOT, 'server/store-purchase-provider.js'));
  const { GooglePlayBilling } = require(path.join(ROOT, 'server/google-play-billing.js'));
  const { AppleStoreKit } = require(path.join(ROOT, 'server/apple-storekit.js'));
  const { GooglePlayStoreNotifications, AppleStoreNotificationsV5 } = require(path.join(ROOT, 'server/v5-store-notifications.js'));
  const { createRealtimeTransport } = require(path.join(ROOT, 'packages/services/realtime-transport.js'));
  const { resolveManagedRedisTarget } = require(path.join(ROOT, 'packages/services/managed-ephemera.js'));
  const { createEphemeraService } = require(path.join(ROOT, 'packages/services/ephemera.js'));
  const { createWorkerApp } = require(path.join(ROOT, 'packages/services/worker-workflows.js'));
  const { createApiHandler } = require(path.join(ROOT, 'apps/api/index.js'));
  const security = require(path.join(ROOT, 'packages/services/security.js'));
  const { resolveAuth } = require(path.join(ROOT, 'apps/api/routes/helpers.js'));
  const { resolveStatic, CSP } = require(path.join(ROOT, 'scripts/p21/serve-web.js'));
  /* The web bundle's /api/download redirect handler (same contract as the preview server
   * and the P21-DOWNLOAD tests): GET/HEAD only, no-store, Vary: User-Agent, and it never
   * guesses a launch link - it sends the caller to the download page. Mounted on this
   * origin so the homepage and download-page buttons resolve instead of falling into the
   * API JSON 404. It shares no state with the API handler and touches no database. */
  const downloadHandler = require(path.join(ROOT, 'apps/web/download-config.cjs')).createDownloadHandler();

  /* 1. TARGET BINDING. Explicit, exact and fail-closed; the process refuses to start otherwise. */
  const binding = process.env[BINDING_ENV];
  const servingEpoch = process.env[SERVING_EPOCH_ENV] || null;
  const target = readInventory(PRODUCTION_TARGET_FILE);
  const boundary = validateProductionBinding({ binding, target, servingEpoch });
  const namespace = deriveNamespace('production', binding);
  if (namespace.environment !== 'prd') throw REFUSE('NAMESPACE_ISOLATION_FAILED');

  /* 2. HTTP BIND. Loopback only, on the production `MEGA_HTTP_PORT` pattern. */
  const httpBinding = resolveHttpBinding({
    host: arg('--host', '127.0.0.1'),
    port: arg('--port', process.env[HTTP_PORT_ENV] || String(DEFAULT_HTTP_PORT)),
    allowPrivate: process.argv.includes('--allow-private-bind'),
  });
  const webBuildDir = path.resolve(arg('--web-build', path.join(ROOT, '.artifacts/p21-web')));

  /* 3. PRIVATE MATERIAL. Everything from absolute mode-0600 regular files; nothing inline. The two
   * `.secret` files may be minted once on first boot; the signing-key custody file may NOT (see the
   * deliberate switch A below), so its absence is reported by its own explicit refusal. */
  const secrets = secretPaths(process.env.MEGA_V5_PRODUCTION_SECRETS || SECRETS_DIR);
  for (const file of [secrets.credentials, secrets.runtimeRoles, secrets.ca]) {
    if (!fs.existsSync(file)) throw REFUSE('MISSING_PRODUCTION_MATERIAL', path.basename(file));
  }
  const creds = JSON.parse(readSecretFile(secrets.credentials, { label: 'credentials.json' }));
  const caPem = readSecretFile(secrets.ca, { label: 'ca.pem' });
  if (!caPem.includes('-----BEGIN CERTIFICATE-----')) throw REFUSE('NEON_CA_NOT_PEM');
  const runtimeRoles = JSON.parse(readSecretFile(secrets.runtimeRoles, { label: 'runtime-roles.json' }));

  /* The credential and role envelopes must describe the SAME target the binding named - a staging
   * envelope can never be pointed at production by changing one environment variable. */
  const migrationUrl = new URL(String(creds.migration_url));
  if (creds.project !== boundary.projectId || creds.branch !== boundary.branchId || creds.database !== boundary.database ||
      runtimeRoles.host !== boundary.host || runtimeRoles.database !== boundary.database ||
      migrationUrl.hostname !== boundary.host || migrationUrl.pathname !== `/${boundary.database}`) {
    throw REFUSE('REFUSED_PRODUCTION_CREDENTIAL_BINDING');
  }
  for (const role of Object.values(REQUIRED_ROLE)) {
    const entry = runtimeRoles.roles && runtimeRoles.roles[role];
    if (!entry || typeof entry.password !== 'string' || entry.password.length === 0) throw REFUSE('RUNTIME_ROLE_CREDENTIAL_MISSING', role);
  }

  /* 4. MANAGED REDIS. The inventory names the intended endpoint; the private envelope holds the
   * credential. `resolveManagedRedisTarget` is the audited P06 guard: it validates the inventory, the
   * envelope privacy, the provider identity and the `rediss://` endpoint BEFORE any socket exists, and
   * it derives the production namespace (`prd`). The adapter's `keyVersion` is then bound to THIS
   * process's derived namespace, so the production process can never share staging's coordination
   * keyspace (`mx:stg:*`) even for an identical input. */
  const redisInventory = readInventory(REDIS_PRODUCTION_FILE);
  const redisCredentialFile = process.env[REDIS_CREDENTIALS_ENV] || redisInventory.redis.credentialFile;
  const redisTarget = resolveManagedRedisTarget({ inventory: redisInventory, environment: 'production', credentialFile: redisCredentialFile });
  if (redisTarget.namespace !== namespace.environment) throw REFUSE('NAMESPACE_ISOLATION_FAILED');
  const ephemera = await createEphemeraService({ ...redisTarget.options, keyVersion: namespace.keyVersion });
  if (!(await ephemera.healthy())) throw REFUSE('PRODUCTION_REDIS_UNHEALTHY');

  /* 5. ROLE-SEPARATED POOLS. One pool per role, each max capped by the inventory's role limit. */
  /* SCRAM channel binding (SCRAM-SHA-256-PLUS) is negotiated automatically by node-postgres over the
   * verified TLS stream - there is no `channel_binding` pool option to set - so `ssl: {ca,
   * rejectUnauthorized: true}` plus the pinned `sslRootCertPath` is the whole TLS contract here. */
  const { budget, poolMax } = resolveConnectionBudget(target);
  let idleMaintenance = null;
  const { onWrite } = createWriteWakeHooks({
    wakeWorker: () => idleMaintenance?.wakeWorker(),
    wakeCommerce: () => idleMaintenance?.wakeCommerce(),
  });
  const mkPool = (role, max) => createPgPool({
    host: runtimeRoles.host, port: 5432, database: runtimeRoles.database, user: role,
    password: runtimeRoles.roles[role].password, role, label: 'production', service: 'v5-production-server', revision: 'v51-server',
    ssl: { ca: caPem, rejectUnauthorized: true }, sslRootCertPath: secrets.ca,
    targetFile: PRODUCTION_TARGET_FILE, budget, pool: { max, idleTimeoutMillis: 5000, connectionTimeoutMillis: 15000 },
    lockTimeoutMs: 15000, statementTimeoutMs: 30000, idleInTransactionTimeoutMs: 15000,
    onWrite,
  });
  const apiPool = mkPool(REQUIRED_ROLE.api, poolMax.api);
  const corePool = mkPool(REQUIRED_ROLE.core, poolMax.core);
  const workerPool = mkPool(REQUIRED_ROLE.worker, poolMax.worker);
  /* Structural assertion BEFORE any statement: the API process holds no Core pool and the Core
   * composition holds no API pool (beyond the API-owned ticket issuer, as in staging). */
  const roleSeparation = assertRoleSeparation({ api: apiPool, core: corePool, worker: workerPool });
  const apiCheck = (await apiPool.query('SELECT current_user AS role')).rows[0];
  const coreCheck = (await corePool.query('SELECT current_user AS role')).rows[0];
  const workerCheck = (await workerPool.query('SELECT current_user AS role')).rows[0];
  if (apiCheck.role !== REQUIRED_ROLE.api || coreCheck.role !== REQUIRED_ROLE.core || workerCheck.role !== REQUIRED_ROLE.worker) {
    throw REFUSE('RUNTIME_ROLE_BINDING_FAILED');
  }

  /* DELIBERATE SWITCH A. The active `prd` signing key is created by the operator's access-service
   * bootstrap; this entry never mints one (that write is the recorded first production write). */
  const keyFile = secrets.keys;
  if (!fs.existsSync(keyFile)) throw REFUSE('EXISTING_SIGNING_KEY_CUSTODY_REQUIRED');
  const activeKeys = await apiPool.query("SELECT kid FROM identity.signing_keys WHERE environment = 'prd' AND state = 'active'");
  if (activeKeys.rows.length !== 1) throw REFUSE('EXISTING_ACTIVE_SIGNING_KEY_REQUIRED');

  /* ONE stable OTP/mail secret, loaded BEFORE any consumer and shared by the account service (which
   * mints/hashes a code) and the API handler (which verifies it), and by the worker (whose mail body
   * seal is HKDF over the same operator secret in V4 and V5). */
  const otpSecret = loadStableSecret(secrets.otp, 'PRODUCTION_OTP_SECRET');
  const apkDownloadSecret = loadStableSecret(secrets.apkDownloads, 'PRODUCTION_APK_DOWNLOAD_SECRET');
  const access = await createAccessService(apiPool, {
    issuer: 'https://api.megaxo.online', environment: 'prd', keyFile,
    playerAudiences: ['mega-browser', 'mega-android', 'mega-ios'], serviceAudiences: ['mega-core'],
  });
  /* The signed Core ingress secret must be STABLE across restarts and shared with any external caller
   * (e.g. the stateless Vercel API) that presents it. File-backed, 0600, never printed. */
  const gatewaySecret = loadStableSecret(secrets.gateway, 'PRODUCTION_GATEWAY_SECRET');
  const core = await createCoreService(corePool, { ephemera });
  const accounts = await createAccountService(apiPool, {
    deletionPolicy: { enabled: true, policyVersion: 'v51-production' }, otpSecret,
    ephemera,
    provisionActor: async (actor) => { await core.provisionActor(actor); },
    cancelSocialOffers: async (actor, targetActor) => { await core.cancelSocialOffers(actor, targetActor); },
  });
  const ticketIssuer = await createTicketIssuer(apiPool, { environment: 'prd', audience: 'mega-core' });
  const queue = await createQueueService({ ephemera, core, pool: corePool });
  /* Matchmaker wake-on-join (infrastructure brief 2026-10-19, part B/F): the adaptive matcher
   * loop backs off when nobody is queued, so a fresh join must re-arm it immediately or the
   * first candidate could wait out the whole backoff ceiling. Only the mutating entry point is
   * wrapped; status/cancel and every other method delegate untouched. */
  let wakeMatchmaker = () => {};
  const queueActivity = ['join'].reduce((acc, method) => {
   const base = queue[method];
   if (typeof base === 'function') acc[method] = async (...args) => { const out = await base.apply(queue, args); wakeMatchmaker(); return out; };
   return acc;
  }, { ...queue }); // a frozen service's own methods are non-writable: a derived object cannot override them (Sol P1 #1)
  const tournaments = createTournamentService({ pool: corePool, core, ephemera });
  await tournaments.ready;
  const tournamentTimer = createTournamentTimer({ tournaments, owner: `prd_tournaments_${process.pid}`,
    idleIntervalMs: DEFAULT_IDLE_PULSE_MS, activeMaxMs: 15000,
    onError: error => console.error(JSON.stringify({ event: 'tournaments.tick_error', code: safeError(error) })) });
  /* Deadline-driven scheduling needs wake-on-mutation: any successful run/settle/completeFixture
   * may create or advance a real deadline, so the timer must recompute immediately instead of
   * waiting out the idle reconciliation sweep. Only the mutating entry points are wrapped; the
   * raw frozen service stays the owner of close() and every read path. */
  const tournamentActivity = ['run', 'settle', 'completeFixture'].reduce((acc, method) => {
   const base = tournaments[method];
   if (typeof base !== 'function') return acc;
   acc[method] = async (...args) => { const out = await base.apply(tournaments, args); tournamentTimer.wake(); return out; };
   return acc;
  }, { ...tournaments }); // same frozen-object constraint (Sol P1 #1)
  /* LR12: the commerce service runs on the Core-owned pool inside the Core process; the API tier
   * reaches it ONLY through the signed commerce ingress. Grants stay disabled until the provider
   * verifiers (AdMob SSV verifyAd / store verifyPurchase + purchaseProvider) and the eligibility
   * policy are configured in a later provider lane — the mounted routes answer honestly with
   * adMode 'off' / purchasesAvailable false until then. */
  const commerceAds = resolveCommerceAdsConfig(process.env);
  const commerceAdMode = commerceAds.mode;
  /* LR15: the AdMob SSV verifier is composed whenever rewarded ads are enabled. It verifies the
   * ECDSA signature against Google's PUBLISHED verifier keys (gstatic, 24h cache) — no secret
   * material here. Store verifiers (verifyPurchase/purchaseProvider) remain a later lane; the
   * eligibility gate stays conservative (verified, unheld accounts — the accountOf gate enforces
   * the same invariants again inside the service). Client-side UMP/ATT consent remains the native
   * apps' own gate before any ad request. */
  const adUnits = commerceAds.adUnits;
  const baseAdVerifier = commerceAdMode !== 'off' ? createAdMobVerifier() : null;
  const verifyAd = baseAdVerifier ? bindAdMobVerifier(baseAdVerifier, commerceAds) : null;
  /* LR15 store lane: when purchases are enabled AND the store env is present, the Google Play /
   * Apple StoreKit verifiers run through the PG adapter with the DEPLOYED role split - the
   * revocation check on the core pool (0021), every store_finalize write/read on the worker pool
   * (0022). Missing or incomplete store env refuses loudly rather than enabling a half-configured
   * verifier; the product map mirrors the legacy config grammar (external sku -> internal id). */
  const PRODUCT_IDS = ['crowns_100', 'crowns_525', 'crowns_1100', 'remove_ads'];
  const mapProducts = (prefix) => {
    const values = PRODUCT_IDS.map((id) => process.env[prefix + id] || '');
    if (values.some(Boolean) && !values.every(Boolean)) throw REFUSE('INCOMPLETE_' + prefix + 'PRODUCTS');
    if (new Set(values.filter(Boolean)).size !== values.filter(Boolean).length) throw REFUSE('DUPLICATE_' + prefix + 'PRODUCT');
    const map = {};
    values.forEach((v, i) => {
      if (v) {
        if (!/^[A-Za-z0-9._-]{1,160}$/.test(v)) throw REFUSE('INVALID_' + prefix + 'PRODUCT');
        map[v] = PRODUCT_IDS[i];
      }
    });
    return map;
  };
  let purchaseProvider = null;
  let storeNotificationHandlers = null;
  if (process.env.MEGA_PURCHASES_ENABLED === 'true') {
    const storeSecretReader = require(path.join(ROOT, 'server/production/config.js')).secret;
    const googleJson = storeSecretReader(process.env, 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
    const googleProducts = mapProducts('GOOGLE_PLAY_PRODUCT_');
    let googlePlay = null;
    if (googleJson) {
      if (!process.env.GOOGLE_PLAY_PACKAGE_NAME) throw REFUSE('INVALID_GOOGLE_PLAY_PACKAGE_NAME');
      const serviceAccount = JSON.parse(googleJson);
      if (!serviceAccount || !/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(serviceAccount.client_email || '') || typeof serviceAccount.private_key !== 'string' || !serviceAccount.private_key.includes('BEGIN PRIVATE KEY')) throw REFUSE('INVALID_GOOGLE_PLAY_SERVICE_ACCOUNT');
      googlePlay = { packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME, serviceAccount, products: googleProducts, pubsubAudience: process.env.GOOGLE_PLAY_PUBSUB_AUDIENCE || '', pubsubServiceAccount: process.env.GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT || '' };
    }
    let apple = null;
    const rootsPath = process.env.APPLE_STORE_ROOTS_FILE || '';
    if (rootsPath) {
      if (!path.isAbsolute(rootsPath)) throw REFUSE('ABSOLUTE_APPLE_ROOTS_PATH_REQUIRED');
      const stat = fs.statSync(rootsPath);
      if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o007)) throw REFUSE('INSECURE_APPLE_ROOTS_FILE');
      const pem = fs.readFileSync(rootsPath, 'utf8');
      const trustedRoots = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
      if (!trustedRoots.length) throw REFUSE('INVALID_APPLE_ROOTS_FILE');
      apple = { bundleId: process.env.APPLE_STORE_BUNDLE_ID || 'online.megaxo.xoxo', environment: process.env.APPLE_STORE_ENVIRONMENT || 'Production', appAppleId: Number(process.env.APPLE_STORE_APP_ID) || null, products: mapProducts('APPLE_STORE_PRODUCT_'), trustedRoots };
    }
    if (googlePlay || apple) {
      const storeDb = createPgStoreDb({ corePool, workerPool });
      const googlePlayInstance = googlePlay ? new GooglePlayBilling(storeDb, googlePlay) : null;
      const appleStoreKitInstance = apple ? new AppleStoreKit(storeDb, apple) : null;
      purchaseProvider = new StorePurchaseProvider({ google: googlePlayInstance, apple: appleStoreKitInstance });
      /* MXA-ECO-005: the trusted store-notification verification classes. Composed only when the
       * matching store verifier config exists; the Google lane additionally needs its push
       * identity (service-account email and/or expected audience). Absent config keeps the
       * notification routes honestly 503 — the API never accepts an unverifiable callback. */
      storeNotificationHandlers = {
        google: googlePlayInstance ? new GooglePlayStoreNotifications({
          packageName: googlePlay.packageName,
          serviceAccountEmail: googlePlay.pubsubServiceAccount || null,
          expectedAudience: googlePlay.pubsubAudience || null,
          billing: googlePlayInstance,
        }) : null,
        apple: appleStoreKitInstance ? new AppleStoreNotificationsV5({ storeKit: appleStoreKitInstance }) : null,
      };
    }
  }
  /* LR13: the Cashfree web-commerce lane. When CASHFREE_APP_ID is present the WHOLE configuration
   * must be present (fail-loud, the legacy INCOMPLETE_CASHFREE_CONFIG contract): the secret comes
   * from the file-backed secret reader (never a raw value in the process listing), the catalog
   * prices are the server-authoritative INR amounts, and the return/notify URLs point at the
   * canonical origin (overridable for staging). Absent env keeps the lane disabled -
   * createOrder refuses CASHFREE_UNAVAILABLE and no provider order can ever be created. */
  let cashfreeProvider = null;
  let cashfreeCatalog = null;
  let cashfreeEnv = 'PRODUCTION';
  if (process.env.CASHFREE_APP_ID) {
    const cashfreeSecret = require(path.join(ROOT, 'server/production/config.js')).secret(process.env, 'CASHFREE_SECRET_KEY');
    if (!cashfreeSecret) throw REFUSE('INCOMPLETE_CASHFREE_CONFIG');
    cashfreeEnv = process.env.CASHFREE_ENV || 'PRODUCTION';
    if (!['PRODUCTION', 'TEST'].includes(cashfreeEnv)) throw REFUSE('INVALID_CASHFREE_ENV');
    cashfreeCatalog = {};
    for (const id of PRODUCT_IDS) {
      const raw = process.env['CASHFREE_PRICE_' + id.toUpperCase()];
      if (!raw) throw REFUSE('INCOMPLETE_CASHFREE_PRICE');
      if (!/^\d+(\.\d{1,2})?$/.test(raw) || Number(raw) <= 0) throw REFUSE('INVALID_CASHFREE_PRICE');
      cashfreeCatalog[id] = raw;
    }
    cashfreeProvider = createCashfreeProvider({
      appId: process.env.CASHFREE_APP_ID,
      secretKey: cashfreeSecret,
      apiVersion: process.env.CASHFREE_API_VERSION || '2025-01-01',
      env: cashfreeEnv,
    });
  }
  const cashfreeReturnUrl = process.env.CASHFREE_RETURN_URL || 'https://megaxo.online';
  const cashfreeNotifyUrl = process.env.CASHFREE_NOTIFY_URL || 'https://megaxo.online/api/monetization/cashfree/webhook';
  /* C05: the Polar lane (the owner decision: Polar = primary global payments, the Indian
   * fallback behind Cashfree). Fail-loud like Cashfree: POLAR_ACCESS_TOKEN without the org id,
   * the webhook secret, or the complete price catalog refuses boot; absent env keeps the lane
   * disabled. Prices are the recorded catalog cents (server-authoritative, compared exactly at
   * settlement); secrets come from the file-backed reader. */
  let polarProvider = null;
  let polarCatalog = null;
  {
    /* A1b: presence detection goes through the SAME secret reader the value uses, so a
     * file-backed POLAR_ACCESS_TOKEN configures the lane exactly like an inline token. */
    const readSecret = require(path.join(ROOT, 'server/production/config.js')).secret;
    const polarToken = readSecret(process.env, 'POLAR_ACCESS_TOKEN');
    if (polarToken) {
    const polarWebhookSecret = readSecret(process.env, 'POLAR_WEBHOOK_SECRET');
    if (!polarWebhookSecret) throw REFUSE('INCOMPLETE_POLAR_CONFIG');
    const polarOrgId = process.env.POLAR_ORGANIZATION_ID || '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(polarOrgId)) throw REFUSE('INVALID_POLAR_ORGANIZATION_ID');
    polarCatalog = {};
    for (const id of PRODUCT_IDS) {
      const priceId = process.env['POLAR_PRICE_' + id.toUpperCase()];
      const cents = process.env['POLAR_PRICE_CENTS_' + id.toUpperCase()];
      if (!priceId || !cents) throw REFUSE('INCOMPLETE_POLAR_PRICE');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(priceId)) throw REFUSE('INVALID_POLAR_PRICE_ID');
      if (!/^\d{1,9}$/.test(cents) || Number(cents) <= 0) throw REFUSE('INVALID_POLAR_PRICE_CENTS');
      polarCatalog[id] = { priceId, amountCents: Number(cents) };
    }
    /* B2: the recurring Mega Pass price is OPTIONAL - an absent one degrades only the pass,
     * never the one-time products (the owner contract forbids one optional missing price from
     * disabling every other offer). */
    const passPriceId = process.env.POLAR_PRICE_MEGA_PASS;
    const passCents = process.env.POLAR_PRICE_CENTS_MEGA_PASS;
    if (passPriceId || passCents) {
      if (!passPriceId || !passCents) throw REFUSE('INCOMPLETE_POLAR_PRICE');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(passPriceId)) throw REFUSE('INVALID_POLAR_PRICE_ID');
      if (!/^\d{1,9}$/.test(passCents) || Number(passCents) <= 0) throw REFUSE('INVALID_POLAR_PRICE_CENTS');
      polarCatalog['mega_pass'] = { priceId: passPriceId, amountCents: Number(passCents) };
    }
    polarProvider = createPolarProvider({
      accessToken: polarToken,
      organizationId: polarOrgId,
      webhookSecret: polarWebhookSecret,
      apiBase: process.env.POLAR_API_BASE || undefined,
    });
    }
  }
  const polarSuccessUrl = process.env.POLAR_SUCCESS_URL || 'https://megaxo.online';
  /* 2026-10-19: the Dodo lane (owner decision: Dodo = PRIMARY web checkout; the Polar code stays
   * composed but dormant, and existing Polar orders keep settling). Fail-loud like Polar:
   * DODO_API_KEY without the webhook secret, the complete product catalog or the intro window
   * grammar refuses boot; absent env keeps the lane disabled. Catalog entries map each store
   * product to its Dodo product id plus the SERVER-AUTHORITATIVE per-currency amounts (usd base
   * + localized inr), which the settlement re-verifies exactly. DODO_INTRO_ENDS_AT is display
   * metadata: the charged price is whatever the configured Dodo product price says, and the
   * documented price-window flip keeps the env and Dodo in agreement. */
  let dodoProvider = null;
  let dodoCatalog = null;
  {
    const readSecret = require(path.join(ROOT, 'server/production/config.js')).secret;
    const dodoKey = readSecret(process.env, 'DODO_API_KEY');
    if (dodoKey) {
      const dodoWebhookSecret = readSecret(process.env, 'DODO_WEBHOOK_SECRET');
      if (!dodoWebhookSecret) throw REFUSE('INCOMPLETE_DODO_CONFIG');
      const dodoMode = process.env.DODO_MODE || 'live';
      if (!['live', 'test'].includes(dodoMode)) throw REFUSE('INVALID_DODO_MODE');
      dodoCatalog = {};
      for (const id of PRODUCT_IDS) {
        const productId = process.env['DODO_PRODUCT_' + id.toUpperCase()];
        const usd = process.env['DODO_PRICE_CENTS_' + id.toUpperCase()];
        if (!productId || !usd) throw REFUSE('INCOMPLETE_DODO_PRICE');
        if (!/^pdt_[A-Za-z0-9]{6,64}$/.test(productId)) throw REFUSE('INVALID_DODO_PRODUCT_ID');
        if (!/^\d{1,9}$/.test(usd) || Number(usd) <= 0) throw REFUSE('INVALID_DODO_PRICE_CENTS');
        const entry = { productId, prices: { usd: Number(usd) } };
        const inr = process.env['DODO_REGION_IN_' + id.toUpperCase()];
        if (inr !== undefined) {
          if (!/^\d{1,9}$/.test(inr) || Number(inr) <= 0) throw REFUSE('INVALID_DODO_PRICE_CENTS');
          entry.prices.inr = Number(inr);
        }
        dodoCatalog[id] = entry;
      }
      const passProductId = process.env.DODO_PRODUCT_MEGA_PASS;
      const passUsd = process.env.DODO_PRICE_CENTS_MEGA_PASS;
      if (passProductId || passUsd) {
        if (!passProductId || !passUsd) throw REFUSE('INCOMPLETE_DODO_PRICE');
        if (!/^pdt_[A-Za-z0-9]{6,64}$/.test(passProductId)) throw REFUSE('INVALID_DODO_PRODUCT_ID');
        if (!/^\d{1,9}$/.test(passUsd) || Number(passUsd) <= 0) throw REFUSE('INVALID_DODO_PRICE_CENTS');
        const entry = dodoCatalog['mega_pass'] || { productId: passProductId, prices: {} };
        entry.productId = passProductId;
        entry.prices.usd = Number(passUsd);
        const passInr = process.env.DODO_REGION_IN_MEGA_PASS;
        if (passInr !== undefined) {
          if (!/^\d{1,9}$/.test(passInr) || Number(passInr) <= 0) throw REFUSE('INVALID_DODO_PRICE_CENTS');
          entry.prices.inr = Number(passInr);
        }
        dodoCatalog['mega_pass'] = entry;
      }
      dodoProvider = createDodoProvider({
        apiKey: dodoKey,
        webhookSecret: dodoWebhookSecret,
        mode: dodoMode,
      });
    }
  }
  const dodoSuccessUrl = process.env.DODO_SUCCESS_URL || 'https://megaxo.online';
  const dodoIntroEndsAt = process.env.DODO_INTRO_ENDS_AT || null;
  /* The REGULAR (pre-intro) display prices for the slashed-price promo. Optional per product:
   * absent env keeps the lane running and the client simply renders no was/now comparison. */
  let dodoRegularCatalog = null;
  {
   const regular = {};
   for (const id of [...PRODUCT_IDS, 'mega_pass']) {
    const usd = process.env['DODO_REGULAR_CENTS_' + id.toUpperCase()];
    const inr = process.env['DODO_REGULAR_IN_' + id.toUpperCase()];
    if (usd === undefined && inr === undefined) continue;
    const prices = {};
    if (usd !== undefined) {
     if (!/^\d{1,9}$/.test(usd) || Number(usd) <= 0) throw REFUSE('INVALID_DODO_PRICE_CENTS');
     prices.usd = Number(usd);
    }
    if (inr !== undefined) {
     if (!/^\d{1,9}$/.test(inr) || Number(inr) <= 0) throw REFUSE('INVALID_DODO_PRICE_CENTS');
     prices.inr = Number(inr);
    }
    regular[id] = { prices };
   }
   if (Object.keys(regular).length > 0) dodoRegularCatalog = regular;
  }
  /* MXA-PROMO-RESTORE-LEDGER: the intro price table is RETAINED after the flip (it is the
   * settlement boundary's price ledger, not a display input). Absent env keeps the lane
   * running - the tolerance simply loses the intro candidate. */
  let dodoIntroCatalog = null;
  {
   const intro = {};
   for (const id of [...PRODUCT_IDS, 'mega_pass']) {
    const usd = process.env['DODO_INTRO_CENTS_' + id.toUpperCase()];
    const inr = process.env['DODO_INTRO_IN_' + id.toUpperCase()];
    if (usd === undefined && inr === undefined) continue;
    const prices = {};
    if (usd !== undefined) {
     if (!/^\d{1,9}$/.test(usd) || Number(usd) <= 0) throw REFUSE('INVALID_DODO_PRICE_CENTS');
     prices.usd = Number(usd);
    }
    if (inr !== undefined) {
     if (!/^\d{1,9}$/.test(inr) || Number(inr) <= 0) throw REFUSE('INVALID_DODO_PRICE_CENTS');
     prices.inr = Number(inr);
    }
    intro[id] = { prices };
   }
   if (Object.keys(intro).length > 0) dodoIntroCatalog = intro;
  }
  const commerce = await createCommerceService(corePool, {
    adMode: commerceAdMode,
    purchasesEnabled: process.env.MEGA_PURCHASES_ENABLED === 'true',
    verifyAd,
    /* MXA-PROMOTION-DISCLOSURE (2026-10-20): the Core-side acceptance verifier for the
     * published anti-hoarding policy. The API tier issues HMAC disclosure tokens derived
     * from the same stable secret; this adapter re-verifies the token inside the receipt
     * before acceptPromotionPolicy records anything, so a forged body can never attest. */
    /* Sol review R2: the verifier takes the RAW secret string and derives internally; a
     * pre-derived Buffer was rejected with DISCLOSURE_SECRET_REQUIRED. */
    verifyPromotionAcceptance: (actor, receipt) => require(path.join(ROOT, 'packages/services/promotion-disclosure.js'))
      .verifyAcceptanceReceipt(String(otpSecret), actor, receipt),
    adUnits,
    eligible: (account) => account && account.verified === true && account.suspended !== true && account.hold !== true,
    purchaseProvider,
    storeNotificationHandlers,
    cashfreeProvider,
    cashfreeCatalog,
    cashfreeEnv,
    cashfreeReturnUrl,
    cashfreeNotifyUrl,
    polarProvider,
    polarCatalog,
    polarSuccessUrl,
    /* Sol review round 2: wired but inert until the env var exists - a discount id that is not
     * configured can never silently charge a wrong amount, and the pack-discount guard stays off. */
    polarPackDiscountId: process.env.POLAR_PACK_DISCOUNT_ID || undefined,
    dodoProvider,
    dodoCatalog,
    dodoRegularCatalog,
    dodoIntroCatalog,
    dodoSuccessUrl,
    dodoPackDiscountId: process.env.DODO_PACK_DISCOUNT_CODE || undefined,
    dodoIntroEndsAt,
    /* MXA-INTRO-STACKING: the flip procedure sets this together with the price env; absent env
     * falls back to the DODO_INTRO_ENDS_AT timestamp (today's deployment behavior). */
    dodoIntroPricingActive: process.env.DODO_INTRO_PRICING_ACTIVE === 'true' ? true : process.env.DODO_INTRO_PRICING_ACTIVE === 'false' ? false : undefined,
    /* MXA-PROMO-CODE: the LAUNCH50 bridge (see the decision log). Inert unless all four vars
     * are present; products is a comma list of game product ids the promo applies to. */
    dodoPromo: process.env.DODO_PROMO_CODE && process.env.DODO_PROMO_PERCENT_BPS && process.env.DODO_PROMO_EXPIRES_AT ? {
      code: process.env.DODO_PROMO_CODE,
      percentBps: Number(process.env.DODO_PROMO_PERCENT_BPS),
      expiresAt: process.env.DODO_PROMO_EXPIRES_AT,
      products: (process.env.DODO_PROMO_PRODUCTS || 'mega_pass').split(',').map(s => s.trim()).filter(Boolean),
    } : undefined,
  });
  const commerceIngress = createCommerceIngressService({ commerce });
   const coreIngress = createCoreServiceIngress({ coreService: core, ticketIssuer, queue: queueActivity, tournaments: tournamentActivity, commerce: commerceIngress, leaderboardPool: corePool, secret: gatewaySecret });
  /* The mirror of the API assertion: Core, the Core-owned queue, the leaderboard materializer and the
   * realtime pool all run on `core_runtime`; the API-owned ticket issuer is the one asserted API member. */
  const coreRole = assertCoreCompositionUsesCorePool({
    corePool, queuePool: corePool, leaderboardPool: corePool, ticketIssuerPool: apiPool, apiPool,
  });
  const coreGateway = createCoreGateway({ coreUrl: `http://${httpBinding.host}:${httpBinding.port}`, secret: gatewaySecret, timeoutMs: GATEWAY_TIMEOUT_MS });

  /* 6. OUTBOUND PROVIDER CLASSES. Resolved from the bound inventory; the disabled mail transport is
   * the only one composed while the inventory disables email, and a class the inventory enables is
   * refused because no provider implementation is configured in this entry. */
  /* LR10: email enabled in the inventory is legal now, but only with the Resend key present in the
   * approved secret channel; the capability map tells the composability check which classes are
   * actually implemented in this entry. */
  const readProviderSecret = require(path.join(ROOT, 'server/production/config.js')).secret;
  const emailEnabled = boundary.outbound.email === 'enabled';
  const resendApiKey = emailEnabled ? readProviderSecret(process.env, 'RESEND_API_KEY', true) : '';
  const providerCapabilities = emailEnabled ? { email: 'resend' } : {};
  const providerComposition = assertProviderClassesComposable(boundary.outbound, providerCapabilities);
  const mailTransport = createMailTransportForPolicy(boundary.outbound, {
    resendApiKey, emailFetch: globalThis.fetch,
  });
  const worker = createWorkerApp({
    pool: workerPool, redis: ephemera, secret: otpSecret, transport: mailTransport,
    eraseDeletion: (request) => core.eraseDeletion(request),
    /* The rate-bucket DELETE grant lives with api_runtime (0020; 0037 withholds it from the worker), so
     * the one sweep that needs it runs on the API connection, exactly as in the proven staging stack. */
    privacyPool: apiPool,
    intervalMs: 0, slowIntervalMs: DEFAULT_IDLE_PULSE_MS,
    workerId: `prd_worker_${process.pid}`,
    log: (event) => console.error(JSON.stringify(event)),
  });

  const webArtifact = loadWebArtifact(webBuildDir);
  /* The binary is streamed by THIS Node server (Caddy proxies it unchanged). Count only completed
   * responses of the manifest-pinned APK. The identity is an anonymous signed, path-scoped cookie;
   * no user account, IP address, device identifier, or optional gameplay telemetry is joined. */
  const { createApkDownloadTracker } = require(path.join(ROOT, 'packages/services/apk-download-tracker.js'));
  const apkDownloadTracker = createApkDownloadTracker({ pool: apiPool, secret: apkDownloadSecret });
  let origin = `http://${httpBinding.host}:${httpBinding.port}`;
  const publicOrigin = arg('--public-origin', null);
  if (publicOrigin !== null) {
    let parsed;
    try { parsed = new URL(publicOrigin); } catch { throw new Error('INVALID_PUBLIC_ORIGIN'); }
    if (parsed.protocol !== 'https:' || parsed.origin !== publicOrigin.replace(/\/$/, '')) throw new Error('PUBLIC_ORIGIN_MUST_BE_HTTPS_ORIGIN');
  }
  const allowedOrigins = ['https://megaxo.online', 'https://www.megaxo.online', origin];
  if (publicOrigin) allowedOrigins.push(publicOrigin);

  /* The API handler context holds ONLY API-role material: no Core pool, no Core service. Queue and
   * leaderboard go through the signed Core gateway; the ticket issuer is the SAME issuer the ingress
   * uses, so browser/native clients can obtain a realtime ticket here exactly as in staging.
   *
   * ROLE SEPARATION IN ONE PROCESS. Like the proven staging entry (and the composition proved by
   * tests/v5-p11-browser-compat.test.js), this is ONE process holding three SEPARATE pools: the API
   * handler is composed with the `api_runtime` pool alone - it never receives the Core pool - while
   * Core, its queue and the realtime transport run exclusively on `core_runtime` and the worker
   * workflows on `worker_runtime`. Every pool's `describe().role` is asserted before any statement, and
   * the API context is asserted to carry no Core handle, so the boundary is structural: an API route
   * can reach Core only over the signed ingress, never by borrowing the Core connection. */
  /* WEB OAUTH LANE (owner directive, 2026-10-15): the browser's Google/Apple sign-in. The provider
   * client is composed from deployment env so the well-known callback completes a REAL exchange
   * (consume -> code exchange -> verified identity -> rotated session) instead of the honest
   * PROVIDER_SIGNIN_UNAVAILABLE fallback. Secrets arrive as env or env_FILE, never in Git. The
   * redirect target is the exact canonical apex the OAuth clients are registered with (www is a
   * JS origin only, never a callback host). The same nativeAudiences env the WebView lane reads
   * keeps ONE audience source for both surfaces. */
  const { IdentityProviders } = require(path.join(ROOT, 'server/identity-provider.js'));
  const webAccountRoutes = require(path.join(ROOT, 'apps/api/routes/account.js'));
  const { createOtpSink } = require(path.join(ROOT, 'packages/services/mail-enqueue.js'));
  /* LR10: durable OTP delivery. When email is enabled the sink seals the challenge delivery into
   * ops.outbox (api_runtime INSERT, migration 0038) with the SAME secret the mail worker derives
   * its key from; the worker claims, opens and delivers through the Resend transport. When email is
   * disabled the sink stays undefined - auth responses never depended on it, and enqueueing mail
   * nothing may send would be dead-letter work by construction. */
  const otpSink = emailEnabled ? createOtpSink({ pool: apiPool, secret: otpSecret }) : undefined;
  const identityProviders = new IdentityProviders({config: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: readProviderSecret(process.env, 'GOOGLE_CLIENT_SECRET'),
      nativeAudiences: (process.env.GOOGLE_NATIVE_AUDIENCES || '').split(',').filter(Boolean),
      authorizedParties: (process.env.GOOGLE_AUTHORIZED_PARTIES || '').split(',').filter(Boolean),
    },
    apple: {
      clientId: process.env.APPLE_SERVICE_ID || '',
      teamId: process.env.APPLE_TEAM_ID || '',
      keyId: process.env.APPLE_KEY_ID || '',
      privateKey: readProviderSecret(process.env, 'APPLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
      nativeAudiences: (process.env.APPLE_NATIVE_AUDIENCES || '').split(',').filter(Boolean),
    },
  }});
  const apiContext = {
    pool: apiPool, accounts, coreGateway, access, nativeAudiences: ['mega-ios', 'mega-android'],
    dbProbeGate: createDbProbeGate({ pulseCount: () => idleMaintenance?.pulseCount || 0 }),
    queue: coreGateway, leaderboard: (query) => coreGateway.leaderboard(query),
    otpSecret, ticketIssuer, allowedOrigins,
    otpSink,
    identityProviders, webCallbackOrigin: 'https://megaxo.online',
    /* LR08: the iOS Universal Links association is served with the REAL Apple Team ID prefix
     * when configured (Apple sign-in requires it anyway); the well-known route fail-closes to the
     * documented placeholder if this is absent or malformed. */
    appleTeamId: process.env.APPLE_TEAM_ID || '',
  };
  apiContext.completeWebSignIn = webAccountRoutes.createWebSignInLane(apiContext);
  /* LR12: the signed commerce facade the monetization routes dispatch through. Kept OUT of the
   * literal above so parallel API-lane PRs merge without textual conflicts. ssv is the actor-free
   * provider-callback path: it signs with an EMPTY actor to the dedicated /ingress/commerce/ssv
   * route — the player command surface has no actor here and would drop the raw payload. */
  /* LR12: the mounted commerce surface is rate-limited per actor (the legacy monetization-http
   * contract: 60 requests per actor per minute -> 429 RATE_LIMITED) BEFORE any Core round-trip.
   * SEC-V52: the actor-free provider callbacks now ALSO carry an admission budget - 600 requests
   * per canonical source IP per minute per provider lane, resolved through the deployment edge
   * (X-Mega-Client-IP only from a trusted proxy peer presenting the host-managed proxy key, the
   * address HMAC-hashed before it becomes a bucket key). A callback that exhausts its budget is
   * never acknowledged with 200. */
  const monetizationLimiter = createRateLimiter({ pool: apiPool, limit: 60, windowMs: 60000, prefix: 'monetization' });
  const callbackSourceIp = createCallbackSourceIp({
    proxySecret: readSecretFile(process.env.MEGA_PROXY_SECRET_FILE || secrets.proxy, { label: 'proxy.secret' }).trim(),
    trustedProxies: process.env.MEGA_TRUSTED_PROXIES || '127.0.0.1/32,::1/128',
  });
  const callbackLimiter = createProviderCallbackLimiter({ pool: apiPool, limit: 600, windowMs: 60000 });
  const nativeEmailLimiter = createRateLimiter({ pool: apiPool, limit: 30, windowMs: 300000, prefix: 'native-email' });
  apiContext.checkNativeEmail = (req) => nativeEmailLimiter.check(callbackSourceIp.resolve(req));
  apiContext.monetization = {
    command: async (input) => {
      if (input && typeof input.actor === 'string' && input.actor) await monetizationLimiter.check(input.actor);
      return coreGateway.commerceCommand(input);
    },
    ssv: (raw) => coreGateway.commerceSsv({ raw }),
    storeNotification: (input) => coreGateway.commerceStoreNotification(input),
    cashfreeWebhook: (payload) => coreGateway.commerceCashfreeWebhook(payload),
    polarWebhook: (payload) => coreGateway.commercePolarWebhook(payload),
    dodoWebhook: (payload) => coreGateway.commerceDodoWebhook(payload),
    checkCallback: async (req, provider) => callbackLimiter.check(provider, callbackSourceIp.resolve(req)),
  };
  /* LR19: the OPTIONAL telemetry sink. Anonymous daily aggregates on ops.rate_buckets; the client
   * lane is opt-in and OFF by default, so this sink normally receives nothing until a player makes
   * the explicit choice on the privacy-choices page. No actor binding is possible by construction. */
  apiContext.metrics = createMetricsSink({ pool: apiPool });
  const apiRole = assertApiCompositionHoldsNoCoreAccess(apiContext);
  const apiHandler = createApiHandler(apiContext);

  const artifactDir = webArtifact.dir;
  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || '/', origin);
      const pathname = parsedUrl.pathname;
      /* Security headers mirror the preview/vercel contract for the SAME bundle; the CSP string is
       * reused from scripts/p21/serve-web.js so it cannot drift into a third copy. The crawl header
       * defaults to noindex and is released per-route in the static branch below. */
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', CSP);
      res.setHeader('X-Robots-Tag', DEFAULT_ROBOTS_HEADER);
      if (security.isOperatorRoute(pathname)) { res.statusCode = 403; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'PRIVATE_OPERATOR_ROUTE' })); return; }
      const surface = classifyPath(pathname);
      if (surface === 'realtime') return;
      if (surface === 'ingress') { await coreIngress(req, res); return; }
      /* /api/download is a web-bundle redirect service, not an API endpoint: dispatch it
       * before the API surface so it keeps its exact P21 contract (303/302/400/405). */
      if (pathname === '/api/download') { downloadHandler(req, res); return; }
      /* /livez and /readyz are served by the API handler with the SAME semantics the deploy tooling
       * and the host health monitor expect: 200 {"status":"ok","live":true,"ready":true} while the
       * database answers, 503 {"status":"degraded",...,"ready":false} when it does not. */
      if (surface === 'api') { await apiHandler(req, res); return; }
      /* `/opsz` keeps the V4 external monitor's contract: 200 {"ok":true} while operations are
       * healthy and 503 {"ok":false} when the newest verified backup is stale, the durable outbox
       * has dead-lettered rows or the queue is far beyond budget. It never reports green on process
       * liveness alone, and it leaks no schema/provider/host detail. */
      if (surface === 'ops') {
        const report = await buildOpsReport({ freshnessFile: FRESHNESS_STATE_FILE, now: Date.now });
        res.statusCode = report.ok ? 200 : 503;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ ok: report.ok }));
        return;
      }
      if (pathname === '/legacy-game') { res.statusCode = 308; res.setHeader('Location', '/legacy-game/' + (parsedUrl.search || '')); res.end(); return; }
      const resolved = resolveStatic(webArtifact, pathname);
      if (resolved.text !== null) { res.statusCode = resolved.status; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(resolved.text); return; }
      const absolute = path.resolve(artifactDir, resolved.file);
      if (!absolute.startsWith(artifactDir + path.sep) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
        res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('Not found'); return;
      }
      /* LR04 route-aware crawl policy: only a 200 manifest route marked indexable is released from
       * the default noindex; everything else (404s, assets, private pages) keeps it. */
      res.setHeader('X-Robots-Tag', robotsHeaderFor({ pathname, status: resolved.status, seo: webArtifact.seo }));
      const legalLink = legalCanonicalLink({ pathname, seo: webArtifact.seo });
      if (legalLink) res.setHeader('Link', legalLink);
      res.statusCode = resolved.status;
      res.setHeader('Content-Type', MIME_TYPES[path.extname(absolute).toLowerCase()] || 'application/octet-stream');
      const pinnedApk = resolved.status === 200 && webArtifact.androidApk &&
        pathname === webArtifact.androidApk.path && resolved.file === pathname.slice(1);
      if (pinnedApk) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405;
          res.setHeader('Allow', 'GET, HEAD');
          res.end(); return;
        }
        /* HEAD probes, bots, invalid paths and failed/aborted transfers never create counters. */
        const size = fs.statSync(absolute).size;
        if (size !== webArtifact.androidApk.bytes) throw new Error('WEB_BUILD_APK_SIZE_MISMATCH');
        res.setHeader('Content-Length', String(size));
        res.setHeader('Content-Disposition', 'attachment; filename="' + path.basename(absolute) + '"');
        res.setHeader('Cache-Control', 'private, no-store');
        if (req.method === 'HEAD') { res.end(); return; }
        let recordCompleted = null;
        try {
          recordCompleted = apkDownloadTracker.observe(req, res, webArtifact.androidApk, {
            metricsEnabled: wantsApkMetrics(parsedUrl.searchParams),
          });
        } catch { /* analytics never gates file availability */ }
        streamApkFile(absolute, res, recordCompleted);
        return;
      }
      const stream = fs.createReadStream(absolute);
      stream.once('error', () => {
        if (!res.headersSent) { res.statusCode = 500; res.end('File unavailable'); }
        else res.destroy();
      });
      stream.pipe(res); return;
    } catch (err) { if (!res.headersSent) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); } res.end(JSON.stringify({ error: safeError(err) })); }
  });

  const realtime = createRealtimeTransport({
    server, pool: corePool, core, ephemera, environment: 'prd', audience: 'mega-core',
    authenticateHttp: async (req) => {
      security.validateCredentials({ cookie: req.headers.cookie, authorization: req.headers.authorization, method: req.method, allowedOrigins });
      const { actor } = await resolveAuth({ accounts, access, nativeAudiences: ['mega-ios', 'mega-android'] }, req);
      if (!actor) throw new Error('AUTH_REQUIRED');
      return { actor };
    },
  });

  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(httpBinding.port, httpBinding.host, resolve); });
  origin = `http://${httpBinding.host}:${httpBinding.port}`;

  /* Startup self-check: the bundle answers for the shell AND for the retained-game / module / art /
   * font / worker paths the client actually requests; a missing sub-resource is a real 404, never an
   * HTML SPA fallback. This is the difference between "a shell returned 200" and "the site works". */
  const probe = async (pathname, method = null) => {
    try {
      const r = await fetch(origin + pathname, method ? { method } : undefined);
      const body = method === 'HEAD' ? null : await r.arrayBuffer();
      return { status: r.status, type: r.headers.get('content-type') || '', bytes: body ? body.byteLength : Number(r.headers.get('content-length') || 0) };
    } catch (err) { return { status: 0, type: '', error: safeError(err) }; }
  };
  const shell = await fetch(`${origin}/`).then((r) => r.text()).catch(() => '');
  const livez = await probe('/livez');
  const readyz = await probe('/readyz');
  const assets = {};
  for (const p of ['/legacy-game/src/game.js', '/legacy-game/src/bot/worker.js', '/store-links.js', '/legal-documents.js',
    '/assets/art/mark.webp', '/assets/fonts/ibm-plex-mono-latin.woff2', '/assets/fonts/space-grotesk-latin.woff2']) {
    assets[p] = await probe(p);
  }
  const missing = await probe('/legacy-game/src/does-not-exist.js');
  /* The plain probe follows redirects, so this one is measured with redirect: 'manual'
   * to assert the handler's actual 303 instead of the download page's final 200. */
  const downloadRedirectStatus = await fetch(origin + '/api/download?platform=android', { redirect: 'manual' }).then((r) => r.status).catch(() => 0);
  const downloadSelfCheck = downloadRedirectStatus === 303;
  const assetSelfCheck = Object.values(assets).every((a) => a.status === 200);
  console.log(JSON.stringify({
    ok: true, origin, publicOrigin, allowedOrigins, binding: `${boundary.projectId}/${boundary.branchId}/${boundary.database}`,
    database: boundary.database, environment: 'production', nonserving: boundary.nonserving, serving: boundary.serving,
    servingEpoch: boundary.servingEpoch, redisNamespace: ephemera.keyVersion, namespacePrefix: namespace.prefix,
    redisProvider: redisInventory.redis.provider, outbound: boundary.outbound, providerComposition,
    roleSeparation, apiRole, coreRole, budget,
    webBuild: { dir: artifactDir, sourceCommit: webArtifact.sourceCommit, bundleSha256: webArtifact.bundleSha256, fileCount: webArtifact.fileCount },
    websiteServesShell: shell.includes('mx-web-shell'), livezStatus: livez.status, readyzStatus: readyz.status,
    assets, missingAssetStatus: missing.status, assetSelfCheck, downloadRedirectStatus, downloadSelfCheck,
    note: 'production composition; loopback only; route-aware crawl policy (approved public pages indexable); no legacy-authority path touched; serves the generated P21 bundle',
  }, null, 2));
  /* Matchmaker timer + stopped flag live ABOVE the shutdown closure so an early signal can never
   * touch a TDZ binding (Sol P1 #2). */
  let matchmakerTimer = null;
  let matchmakerStopped = false;
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
   /* Sol P1 #2: the adaptive matchmaker re-arms itself; a plain clear would race a finally-block
    * reschedule. The stopped flag makes every future arm() a no-op. */
   matchmakerStopped = true;
   if (matchmakerTimer) clearTimeout(matchmakerTimer);
    await idleMaintenance?.stop();
    await tournamentTimer.stop();
    try { await realtime.close(); } catch {}
    try { await new Promise((r) => server.close(r)); } catch {}
    for (const c of [() => worker.stop(), () => tournaments.close(), () => queue.close(), () => ephemera.close(), () => ticketIssuer.close?.(), () => core.close(), () => accounts.close(), () => access.close?.(), () => apiPool.end(), () => corePool.end(), () => workerPool.end()]) { try { await c(); } catch {} }
    process.exit(0);
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  tournamentTimer.start();

  /* Matchmaker timer + stopped flag live ABOVE the shutdown closure so an early signal can never
   * touch a TDZ binding (Sol P1 #2). */

  /* Real matchmaking needs a matcher tick: two real browsers JOIN the queue over HTTP, but nothing
   * pairs them unless a matcher claims+commits. Bounded, single-flight, best-effort, and it only pairs
   * actors ALREADY in the durable queue; it changes no matching rule, TTL or economy. */
  if (arg('--matchmaker', 'on') !== 'off') {
    const matcherId = `prd_matcher_${process.pid}`;
    let ticking = false;
   /* Adaptive cadence (brief part F): an empty queue must not poll the database every 3s
    * forever - the tick backs off to a 30s ceiling after repeated empty passes, and any join
    * (or pairing) resets it to fast so waiting players never lose latency. */
   let emptyStreak = 0;
   const FAST_MS = 3000, MAX_MS = 30000;
   /* Sol P1 #2: the rearmer must EXIST and must stop on shutdown - a lost arm() call would
    * leave the finally block rejecting forever and a wake could throw after a committed join. */
   const arm = (delay) => {
    if (matchmakerStopped) return;
    if (matchmakerTimer) clearTimeout(matchmakerTimer);
    matchmakerTimer = setTimeout(tick, delay);
    matchmakerTimer.unref?.();
   };
   const tick = async () => {
    if (ticking) return;
    ticking = true;
    let anyMatched = false;
    try {
     for (const mode of ['casual', 'ranked']) {
      const result = await queue.matchTick({ mode, matcherId, limit: 4, makeId: () => crypto.randomUUID() });
      if (result.matched) { anyMatched = true; console.log(JSON.stringify({ event: 'matchmaker.pairing', mode, matched: result.matched, at: new Date().toISOString() })); }
     }
    } catch (error) {
     console.error(JSON.stringify({ event: 'matchmaker.tick_error', code: safeError(error) }));
    } finally {
     ticking = false;
     emptyStreak = anyMatched ? 0 : Math.min(emptyStreak + 1, 12);
     arm(Math.min(FAST_MS * 2 ** Math.min(emptyStreak, 10), MAX_MS));
    }
   };
   wakeMatchmaker = () => { emptyStreak = 0; if (!ticking) arm(0); };
   matchmakerTimer = setTimeout(tick, FAST_MS);
   matchmakerTimer.unref?.();
  }

  /* B2 / MXA-ECO-016: commerce maintenance shares the idle pulse and the latched write wake.
   * Each Core/provider method retains its own transaction, lease and due-work decisions. */
  const commerceTasks = {};
  if (arg('--pass-grants', 'on') !== 'off') {
    commerceTasks.pass_grant = () => commerce.processPassGrants?.();
  }

  /* MXA-ECO-016 (audit 2026-10-17): the durable provider finalization sweep. The grant path
   * reports an interrupted consume/acknowledge as finalizationPending; without a retry caller
   * the job could stall into a store auto-refund. Single-flight like the pass sweep - the
   * provider's own processDue lease bounds each tick, and a failed tick just retries. */
  if (arg('--store-finalization', 'on') !== 'off') {
    commerceTasks.store_finalization = () => commerce.processPurchaseFinalizations?.();
  }

  /* MXA-PROMO-RESTORE: the unattended intro-price expiry sweep. Single-flight like the other
   * jobs; the first tick after boot re-verifies provider state (so a restart or a missed window
   * self-heals), a failed restore re-runs on the next tick and raises a RATE-LIMITED operations
   * email so a silently discounted charge state cannot persist. While the restore is failing the
   * commerce service keeps serving intro prices, so the recorded amount always equals the
   * provider charge - no stuck orders, and the alert names the exact failure. */
  if (arg('--intro-restore', 'on') !== 'off') {
    let lastRestoreAlertAt = 0;
    const restoreAlert = async (result) => {
      const nowAt = Date.now();
      if (nowAt - lastRestoreAlertAt < 60 * 60 * 1000) return;
      const to = process.env.OPERATIONS_ALERT_EMAIL || 'contact@antimatterinnovations.com';
      try {
        await mailTransport.sendMail({ to, subject: 'Mega XOXO — promo price restore needs attention', text: 'The scheduled Dodo intro-price restore did not complete: ' + JSON.stringify(result).slice(0, 800) + '. New orders are still recorded at intro prices until the restore succeeds. Investigate the Dodo API response, or apply the base-price env flip manually (scripts/v5/dodo-price-window.cjs --mode base).' });
        /* Sol P2 (promo audit): the hourly allowance is consumed by a SENT alert only - a
         * transient send failure retries on the next tick instead of silencing an hour. */
        lastRestoreAlertAt = nowAt;
      } catch (error) { console.error(JSON.stringify({ event: 'intro_restore_alert_error', code: safeError(error) })); }
    };
    const restoreTick = async () => {
      const result = commerce.processIntroPriceRestore ? await commerce.processIntroPriceRestore() : null;
      if (result && Array.isArray(result.failures) && result.failures.length) {
        console.error(JSON.stringify({ event: 'intro_restore_failed', failures: result.failures }));
        await restoreAlert(result);
      } else if (result && result.done === true && ((result.restored || 0) + (result.already || 0)) > 0) {
        console.log(JSON.stringify({ event: 'intro_restore_done', restored: result.restored || 0, already: result.already || 0, at: new Date().toISOString() }));
      }
      return result;
    };
    commerceTasks.intro_restore = restoreTick;
  }

  const { probeDbHealth } = require(path.join(ROOT, 'apps/api/routes/well-known.js'));
  idleMaintenance = createIdleMaintenance({
    worker, pool: workerPool, commerceTasks,
    tournamentTick: () => tournamentTimer.tick(),
    intervalMs: Number(arg('--idle-pulse-minutes', '120')) * 60 * 1000,
    probeDb: () => probeDbHealth(apiContext),
    onError: (lane, error) => console.error(JSON.stringify({ event: `${lane}_error`, code: safeError(error) })),
  });
  await idleMaintenance.start();
}

if (require.main === module) {
  main().catch((err) => { console.error('PRODUCTION_SERVER_FAILED', safeError(err)); process.exit(1); });
}

module.exports = {
  /* pure validators and builders (offline, deterministic, no socket, no secret) */
  PRODUCTION_IDENTITY, PRODUCTION_DATABASE, PRODUCTION_BINDING, PRODUCTION_TARGET_FILE, REDIS_PRODUCTION_FILE,
  BINDING_ENV, SERVING_EPOCH_ENV, HTTP_PORT_ENV, REDIS_CREDENTIALS_ENV, SECRET_FILES, OUTBOUND_CLASSES,
  REQUIRED_ROLE, DEFAULT_HTTP_PORT,
  parseProductionBinding, validateProductionBinding, resolveOutboundPolicy, createMailTransportForPolicy,
  resolveCommerceAdsConfig, bindAdMobVerifier,
  assertProviderClassesComposable,
  deriveNamespace, assertPoolRole, assertRoleSeparation, assertApiCompositionHoldsNoCoreAccess,
  assertCoreCompositionUsesCorePool,
  resolveConnectionBudget, resolveHttpBinding, classifyPath, buildOpsReport,
  robotsHeaderFor, legalCanonicalLink, DEFAULT_ROBOTS_HEADER,
  FRESHNESS_STATE_FILE, OPS_BACKUP_MAX_AGE_MS, OPS_OUTBOX_BACKLOG_MAX,
  WORKER_OBSERVATION_FILE, DB_WRITE_JOURNAL_FILE, DEFAULT_IDLE_PULSE_MS,
  createIdlePulseScheduler, createIdleMaintenance, createWriteWakeHooks, createDbProbeGate, refreshWorkerObservation,
  /* filesystem-bounded helpers used by the composition (never network) */
  secretPaths, readSecretFile, loadStableSecret, readInventory, loadWebArtifact, streamApkFile, wantsApkMetrics,
  arg, safeError, main,
};
