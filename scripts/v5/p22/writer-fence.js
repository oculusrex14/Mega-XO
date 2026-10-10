'use strict';

/*
 * P22-02/03/05: review a DECLARATIVE writer inventory, never control one.
 * The known classes are a minimum audit checklist, not a discovered route list.
 * A reviewer MUST map every actual V4/V5 endpoint, cron, webhook, worker and
 * restarted process to one of these classes before claiming any real fence.
 */
const WRITERS = Object.freeze([
  'session-bootstrap','session-refresh','profile-and-save','friends-and-privacy',
  'matchmaking-and-offers','direct-challenges','ranked-and-casual-moves',
  'tournament-entry-and-payout','wallet-and-currency','game-clock-and-deadlines',
  'season-and-scheduled-awards','outbox-and-delivery','email-and-ad-rewards',
  'store-purchase-and-refund','provider-callback-and-inbox','operator-mutations',
]);
const CALLBACKS = new Set(['email-and-ad-rewards','store-purchase-and-refund','provider-callback-and-inbox']);
const PHASES = Object.freeze(['V4_SERVING','V4_FROZEN','V5_EXCLUSIVE']);
const SHA64 = /^[a-f0-9]{64}$/;
const SHA40 = /^[a-f0-9]{40}$/;
function refuse(why) { throw Error('P22_FENCE_REFUSED:' + why); }
function exact(x, keys, name) {
  if (!x || typeof x !== 'object' || Array.isArray(x) ||
      Object.keys(x).sort().join('\0') !== [...keys].sort().join('\0')) refuse('INVALID_' + name);
}
function verifyFence(manifest, sourceSha) {
  exact(manifest,['format','sourceSha','phase','v4ReleaseSha','v4FrozenSnapshotSha256',
    'v4RebootFenceTestRef','firstV5ApplicationWriteRef','entries','safeReadProbes'],'MANIFEST');
  if (manifest.format !== 'mega-v5-p22-writer-inventory/v1' || !SHA40.test(sourceSha) ||
      manifest.sourceSha !== sourceSha || !SHA40.test(manifest.v4ReleaseSha) ||
      !PHASES.includes(manifest.phase)) refuse('RELEASE_SCOPE');
  if (!Array.isArray(manifest.entries) || manifest.entries.length !== WRITERS.length) refuse('INCOMPLETE_CATALOGUE');
  const seen = new Set();
  for (const e of manifest.entries) {
    exact(e,['class','v4Mode','v5Mode','v4RestartFenced','callbackResponse'],'ENTRY');
    if (!WRITERS.includes(e.class) || seen.has(e.class)) refuse('DUPLICATE_OR_UNKNOWN_CLASS');
    seen.add(e.class);
    if (typeof e.v4RestartFenced !== 'boolean') refuse('RESTART_FENCE_FLAG');
    if (manifest.phase === 'V4_SERVING') {
      if (e.v4Mode !== 'V4_WRITES_ONLY' || e.v5Mode !== 'V5_MUTATIONS_DISABLED' ||
          e.v4RestartFenced || e.callbackResponse !== 'NORMAL_V4') refuse('V4_AUTHORITY');
    } else if (manifest.phase === 'V4_FROZEN') {
      if (e.v4Mode !== 'FENCED' || e.v5Mode !== 'V5_MUTATIONS_DISABLED' ||
          !e.v4RestartFenced || e.callbackResponse !== (CALLBACKS.has(e.class)
            ? 'RETRYABLE_NO_ACK' : 'NOT_APPLICABLE')) refuse('FROZEN_POLICY');
    } else {
      if (!['FENCED','FORWARD_TO_V5'].includes(e.v4Mode) ||
          e.v5Mode !== 'V5_POSTGRES_ONLY' || !e.v4RestartFenced ||
          e.callbackResponse !== (CALLBACKS.has(e.class)
            ? 'V5_ACK_AFTER_DURABLE_DEDUPE' : 'NOT_APPLICABLE')) refuse('V5_EXCLUSIVE_POLICY');
    }
  }
  if (manifest.phase === 'V4_SERVING') {
    if (manifest.v4FrozenSnapshotSha256 !== null ||
        manifest.v4RebootFenceTestRef !== null ||
        manifest.firstV5ApplicationWriteRef !== null) refuse('PREMATURE_FREEZE_OR_WRITE_CLAIM');
  } else {
    if (!SHA64.test(manifest.v4FrozenSnapshotSha256) ||
        typeof manifest.v4RebootFenceTestRef !== 'string' ||
        (!/^artifact:\/\/v5\/p22\/[a-z0-9._/-]{8,110}$/.test(manifest.v4RebootFenceTestRef) ||
          manifest.v4RebootFenceTestRef.includes('..'))) {
      refuse('SOURCE_SNAPSHOT_AND_REBOOT_FENCE_PROOF');
    }
    if (manifest.phase === 'V4_FROZEN' && manifest.firstV5ApplicationWriteRef !== null) {
      refuse('PREWRITE_BOUNDARY');
    }
    if (manifest.phase === 'V5_EXCLUSIVE' &&
        (typeof manifest.firstV5ApplicationWriteRef !== 'string' ||
          !/^artifact:\/\/v5\/p22\/first-write\/[a-z0-9._/-]{8,110}$/.test(manifest.firstV5ApplicationWriteRef))) {
      refuse('FIRST_WRITE_BOUNDARY');
    }
  }
  if (!Array.isArray(manifest.safeReadProbes) || manifest.safeReadProbes.length > 3) {
    refuse('READ_ONLY_PROBES');
  }
  const probes = new Set();
  for (const p of manifest.safeReadProbes) {
    exact(p,['method','route','observedNoMutation'],'PROBE');
    if (!['GET','HEAD'].includes(p.method) ||
        !['/livez','/readyz','/healthz'].includes(p.route) || p.observedNoMutation !== true ||
        probes.has(p.method + p.route)) refuse('READ_ONLY_PROBE_UNSAFE');
    probes.add(p.method + p.route);
  }
  // This remains untrusted operator input until independently mapped to real
  // routes/containers and confirmed by observed V4/V5 reboot/routing tests.
  return Object.freeze({
    format:'mega-v5-p22-writer-inventory-assessment/v1',
    sourceSha,
    phase:manifest.phase,
    minimumWriterClassesAccountedFor:seen.size,
    callbacksFailClosed:manifest.phase === 'V4_FROZEN',
    sourceSnapshotHashDeclared:manifest.v4FrozenSnapshotSha256 !== null,
    observedEffectiveFenceVerified:false,
    legacyCookieAndRoutesVerified:false,
    firstWriteVerifiedOnline:false,
    runtimeWritePermission:false,
    cutoverAuthorized:false,
    g22Accepted:false,
  });
}
module.exports={WRITERS,CALLBACKS,PHASES,verifyFence};
