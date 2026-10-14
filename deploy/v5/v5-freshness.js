#!/usr/bin/env node
'use strict';

/**
 * V5 backup freshness + retrievability checker.
 *
 * Looks at the newest manifest object in the V5-only R2 prefix using the
 * INDEPENDENT READER credential, validates that manifest through the checked-in
 * P15 contract, confirms the matching ciphertext object is still present with
 * the manifest's exact byte length and sha256 metadata, then compares the
 * object's provider LastModified against the approved RPO.
 *
 * Exits 0 when the newest backup is fresh and intact; exits 2 with a reason
 * when it is stale, missing or damaged - and in that case attempts the same
 * Resend alert path the V4 monitor uses.
 *
 * Operator inputs (never needed by the production unit):
 *   --rpo-seconds N     evaluate against an RPO other than the stored policy
 *   --at ISO8601        evaluate freshness as of a given UTC instant (audit)
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const r2 = require('./v5-lib.js');
const { assertTarget } = r2.contract();
const { readManifest } = r2.manifest();
const client = require('./v5-r2-client.js');

const ROOT = process.env.V5_ROOT || '/opt/mega-xo-v5-production';
const STATE = path.join(ROOT, 'state');
const RESEND_KEY = process.env.V5_RESEND_KEY_FILE || '/opt/mega-xo/secrets/resend_api_key';
const RESEND_TO = 'contact@antimatterinnovations.com';
const fail = client.refuse;

function utc(iso) { return iso.replace(/\.\d{3}Z$/, 'Z'); }

function alert(kind, subject, text) {
  let key;
  try {
    key = fs.readFileSync(RESEND_KEY, 'utf8').replace(/[\r\n]+/g, '');
  } catch {
    return { attempted: true, sent: false, error: 'Resend key unreadable at ' + RESEND_KEY };
  }
  if (!/^re_[A-Za-z0-9_-]+$/.test(key)) return { attempted: true, sent: false, error: 'Resend key malformed' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '.v5-alert-'));
  fs.chmodSync(dir, 0o700);
  const cfg = path.join(dir, 'curlrc');
  try {
    fs.writeFileSync(cfg,
      'url = "https://api.resend.com/emails"\nrequest = "POST"\n' +
      'header = "Authorization: Bearer ' + key + '"\n' +
      'header = "Content-Type: application/json"\n' +
      'silent\nshow-error\nfail-with-body\nmax-time = 15\n', { mode: 0o600 });
    const payload = JSON.stringify({
      from: 'Mega XO Ops <' + RESEND_TO + '>',
      to: [RESEND_TO],
      subject,
      text
    });
    const res = spawnSync('curl', ['--config', cfg, '--data-binary', payload], {
      encoding: null, timeout: 20000,
      env: { PATH: '/usr/bin:/bin', HOME: '/', LANG: 'C', LC_ALL: 'C' }
    });
    if (res.error) return { attempted: true, sent: false, error: 'curl error ' + res.error.code };
    if (res.status !== 0) {
      const body = (res.stdout || Buffer.alloc(0)).toString('utf8').slice(0, 200);
      return { attempted: true, sent: false, error: 'Resend rejected (curl ' + res.status + ') ' + body };
    }
    return { attempted: true, sent: true, kind };
  } finally {
    try { fs.unlinkSync(cfg); } catch {}
    try { fs.rmdirSync(dir); } catch {}
    key = undefined;
  }
}

function parseArgs(argv) {
  const out = { rpo: null, at: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rpo-seconds') { out.rpo = Number(argv[++i]); }
    else if (argv[i] === '--at') { out.at = argv[++i]; }
    else fail('unknown argument ' + argv[i]);
  }
  // An audit override evaluates a hypothetical instant/limit; it must never be
  // able to move the live alert-suppression clock, so it never persists state.
  out.audit = out.rpo !== null || out.at !== null;
  return out;
}

function policy() {
  let rpo = 900, source = 'default';
  const file = path.join(STATE, 'backup-policy.json');
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number.isSafeInteger(doc.rpoSeconds) && doc.rpoSeconds > 0) { rpo = doc.rpoSeconds; source = file; }
  } catch {}
  if (process.env.V5_RPO_SECONDS) { rpo = Number(process.env.V5_RPO_SECONDS); source = 'V5_RPO_SECONDS'; }
  return { rpo, source };
}

function stateRead() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE, 'freshness-state.json'), 'utf8')); } catch { return null; }
}
function stateWrite(doc) {
  const file = path.join(STATE, 'freshness-state.json');
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(doc, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function main(argv) {
  const opts = parseArgs(argv);
  const { rpo, source: rpoSource } = policy();
  if (opts.rpo !== null) {
    if (!Number.isSafeInteger(opts.rpo) || opts.rpo <= 0) fail('--rpo-seconds must be a positive integer');
    opts.rpoEffective = opts.rpo;
  } else {
    opts.rpoEffective = rpo;
  }
  let now = Date.now();
  if (opts.at) {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test(opts.at) || !Number.isFinite(Date.parse(opts.at))) {
      fail('--at must be an ISO-8601 UTC instant');
    }
    now = Date.parse(opts.at);
  }

  const creds = client.credentials(path.join(STATE, 'r2-credentials.json'));
  const target = assertTarget(client.readJson(path.join(STATE, 'r2-target.json')));
  if (target.bucket !== creds.reader.bucket ||
      creds.reader.endpoint !== 'https://' + target.accountId + '.r2.cloudflarestorage.com') {
    fail('reader credential is not scoped to the declared V5-only bucket/endpoint');
  }

  const problems = [];
  let newest = null, integrity = null, manifestCount = 0;
  try {
    const objects = client.list(creds.reader, target.prefix);
    const manifests = objects.filter((o) => o.key.endsWith('.manifest.json'));
    manifestCount = manifests.length;
    if (manifests.length === 0) {
      problems.push('no manifest object exists under ' + target.prefix);
    } else {
      manifests.sort((a, b) => Date.parse(b.lastModified) - Date.parse(a.lastModified));
      newest = manifests[0];
      const age = Math.floor((now - Date.parse(newest.lastModified)) / 1000);
      newest.ageSeconds = age;
      newest.backupId = path.basename(newest.key, '.manifest.json');

      // Independent integrity re-check of the newest pair, straight from R2.
      const dir = fs.mkdtempSync(path.join(stateDir(), '.freshness-'));
      fs.chmodSync(dir, 0o700);
      // readManifest enforces that the file name is <backupId>.manifest.json, so
      // the fetched copy keeps the immutable identity it was published under.
      const local = path.join(dir, newest.backupId + '.manifest.json');
      try {
        client.get(creds.reader, newest.key, local);
        fs.chmodSync(local, 0o600);
        const manifest = readManifest(local);
        if (manifest.backupId !== newest.backupId) problems.push('newest manifest filename/ID mismatch');
        const cipherKey = target.prefix + manifest.ciphertextFile;
        const head = client.head(creds.reader, cipherKey);
        if (Number(head['content-length']) !== manifest.ciphertextBytes) {
          problems.push('newest ciphertext object length does not match its manifest');
        } else if (head['x-amz-meta-sha256'] !== manifest.ciphertextSha256) {
          problems.push('newest ciphertext object sha256 metadata does not match its manifest');
        }
        integrity = {
          backupId: manifest.backupId, sourceSha: manifest.sourceSha,
          ciphertextKey: cipherKey, ciphertextBytes: manifest.ciphertextBytes,
          ciphertextSha256: manifest.ciphertextSha256,
          createdAtUtc: manifest.createdAtUtc,
          manifestValidatedByContract: true,
          ciphertextHeadVerified: true
        };
      } catch (e) {
        problems.push('newest manifest could not be validated: ' + (e && e.message ? e.message : 'error'));
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    }
  } catch (e) {
    problems.push('R2 listing/readback failed: ' + (e && e.message ? e.message : 'error'));
  }

  if (newest && newest.ageSeconds > opts.rpoEffective) {
    problems.push('newest uploaded backup is ' + newest.ageSeconds + ' s old, beyond the ' +
      opts.rpoEffective + ' s RPO (limit source: ' + (opts.rpo !== null ? '--rpo-seconds' : rpoSource) + ')');
  }

  const healthy = problems.length === 0;
  const previous = stateRead();
  const previousState = previous && previous.state ? previous.state : 'unknown';
  const nowIso = new Date(now).toISOString();
  const result = {
    format: 'mega-v5-backup-freshness/v1',
    evaluatedAtUtc: nowIso,
    rpoSeconds: opts.rpoEffective,
    rpoSource: opts.rpo !== null ? '--rpo-seconds' : rpoSource,
    manifestObjectsUnderPrefix: manifestCount,
    newestManifestKey: newest ? newest.key : null,
    newestManifestLastModifiedUtc: newest ? utc(newest.lastModified) : null,
    newestManifestAgeSeconds: newest ? newest.ageSeconds : null,
    newestIntegrity: integrity,
    state: healthy ? 'fresh' : 'stale',
    previousState,
    problems
  };

  const repeatSeconds = Number(process.env.V5_ALERT_REPEAT_SECONDS || 3600);
  const lastAlertAt = previous && previous.lastAlertAtUtc ? Date.parse(previous.lastAlertAtUtc) : 0;
  const transition = healthy ? previousState === 'stale' : previousState !== 'stale';
  const due = !healthy && (!lastAlertAt || now - lastAlertAt >= repeatSeconds * 1000);
  let alertResult = null;
  if (healthy) {
    if (previousState === 'stale') {
      alertResult = alert('recovered', 'Mega XO V5 backup recovered',
        'Mega XO V5 production backup freshness check is passing again on ' + os.hostname() +
        ' at ' + nowIso + '. Newest manifest: ' + newest.key + ' (' + newest.ageSeconds + ' s old).');
    }
  } else if (transition || due) {
    const text = 'Mega XO V5 production backup freshness check FAILED on ' + os.hostname() +
      ' at ' + nowIso + ': ' + problems.join('; ') +
      '. Newest manifest: ' + (newest ? newest.key : 'none') + '. Runbook: docs/v5.1/release/V5-BACKUP-SERVICE-20261014.md';
    alertResult = alert('stale', 'Mega XO V5 backup STALE', text);
  }
  if (alertResult) {
    result.alert = alertResult;
    console.error('V5_BACKUP_ALERT_ATTEMPTED: ' + (alertResult.sent ? 'delivered' : 'FAILED - ' + alertResult.error));
  }

  if (!opts.audit) {
    // An audit run reports but cannot move the live state: it may be evaluating a
    // hypothetical instant or a tightened limit that the production unit never uses.
    const alerted = !!(alertResult && alertResult.sent);
    stateWrite({
      state: healthy ? 'fresh' : 'stale',
      checkedAtUtc: nowIso,
      // Keep the previous alert timestamp when a notification is still pending, so
      // the next cycle retries instead of silently swallowing the alert.
      lastAlertAtUtc: alerted ? nowIso : ((previous && previous.lastAlertAtUtc) || null),
      consecutiveUnhealthy: healthy ? 0 : ((previous && previous.consecutiveUnhealthy) || 0) + 1
    });
  } else {
    result.statePersisted = false;
  }

  if (!healthy) {
    result.result = 'STALE';
    console.log(JSON.stringify(result));
    console.error('V5_BACKUP_STALE: ' + problems.join('; '));
    process.exitCode = 2;
    return;
  }
  result.result = 'FRESH';
  console.log(JSON.stringify(result));
}

function stateDir() { return STATE; }

try { fs.mkdirSync(STATE, { recursive: true, mode: 0o700 }); } catch {}
main(process.argv.slice(2));
