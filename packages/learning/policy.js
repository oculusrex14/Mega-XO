'use strict';
/* DC00/D1 retention engine. The windows are DATA (learning.retention_schedule), the sweeps are
 * scheduled jobs driven from that data, and every maximum is dominated by withdrawal and by the
 * applicable-law limit. This module performs no policy decision of its own:
 *
 *   - it never invents a window; a class whose basis is not yet lawful carries NULL, and the
 *     corresponding sweep refuses to run rather than guess;
 *   - it never extends a source's life; a copy (export, spool entry, backup) is bounded by the
 *     source's own expiry (learning.expiry_bound, mirrored in boundExpiry below);
 *   - it never resurrects withdrawn research: a suppression fences the next record, the erasure
 *     sweep nulls the archived payload, and the restore journal carries the suppression forward.
 *
 * Nothing here is imported into a client bundle and nothing here prints a secret.
 */
const fail = code => { const e = new Error(code); e.code = code; throw e; };
const safeCode = e => {
 const m = String(e.message || '').match(/^(CAPTURE_[A-Z0-9_]{1,80})(?:$|\s)/);
 return m ? m[1] : /^[0-9A-Z]{5}$/.test(e.code || '') ? 'CAPTURE_DATABASE_' + e.code : 'CAPTURE_RETENTION_FAILED';
};
const DAY_MS = 86400000;

/* The owner-approved schedule, as data, with the exact basis labels stored in the DB rows. `days`
 * is null exactly where the applicable-law window is not yet established: those classes carry a
 * legal-review obligation and are never swept on an invented number. */
const SCHEDULE = Object.freeze([
 Object.freeze({classId:'capture.adult-gameplay-consented',dataClass:'consented adult gameplay trajectories',
  basis:'consent',days:730,neverPastSource:false,reviewIntervalDays:365,legalReviewRequired:false}),
 Object.freeze({classId:'export.working-research',dataClass:'working research exports',
  basis:'consent',days:90,neverPastSource:true,reviewIntervalDays:null,legalReviewRequired:false}),
 Object.freeze({classId:'analytics.raw-ad',dataClass:'raw advertising analytics',
  basis:'necessary-operational',days:90,neverPastSource:true,reviewIntervalDays:null,legalReviewRequired:false}),
 Object.freeze({classId:'spool.pending-upload',dataClass:'pending client-upload spool',
  basis:'necessary-operational',days:7,neverPastSource:true,reviewIntervalDays:null,legalReviewRequired:false}),
 Object.freeze({classId:'backup.ordinary-encrypted',dataClass:'ordinary encrypted backups',
  basis:'necessary-operational',days:35,neverPastSource:true,reviewIntervalDays:null,legalReviewRequired:false}),
 Object.freeze({classId:'purchase.records',dataClass:'purchase, replay and refund integrity',
  basis:'legal-obligation',days:null,neverPastSource:false,reviewIntervalDays:null,legalReviewRequired:true}),
 Object.freeze({classId:'fraud.integrity',dataClass:'fraud and duplicate-grant prevention',
  basis:'fraud-prevention',days:null,neverPastSource:false,reviewIntervalDays:null,legalReviewRequired:true}),
 Object.freeze({classId:'operations.support',dataClass:'operations and support correlation',
  basis:'operations',days:null,neverPastSource:false,reviewIntervalDays:null,legalReviewRequired:true}),
 Object.freeze({classId:'security.audit',dataClass:'security and accountability audit',
  basis:'security',days:null,neverPastSource:false,reviewIntervalDays:null,legalReviewRequired:true}),
 /* Youth research is a separate lawful protocol, not these adult defaults: it can never carry an
  * adult window and is never swept by this engine. */
 Object.freeze({classId:'youth.research-protocol',dataClass:'youth/protected-age research',
  basis:'separate-lawful-protocol',days:null,neverPastSource:false,reviewIntervalDays:null,legalReviewRequired:true}),
]);
const KINDS = Object.freeze(['captures','exports','spool','backups']);
const CLASS_FOR_KIND = Object.freeze({
 captures:'capture.adult-gameplay-consented',exports:'export.working-research',
 spool:'spool.pending-upload',backups:'backup.ordinary-encrypted'});

function scheduleFor(classId) {
 const row = SCHEDULE.find(x => x.classId === classId);
 if (!row) fail('CAPTURE_RETENTION_CLASS_UNKNOWN');
 return row;
}
/* Mirrors learning.expiry_bound(): a copy never outlives its source. */
function boundExpiry(scheduled, sourceExpires) {
 if (scheduled === null || scheduled === undefined) return sourceExpires ?? null;
 if (sourceExpires === null || sourceExpires === undefined) return scheduled;
 return Math.min(scheduled, sourceExpires);
}
function requireDb(db, kind) {
 if (!KINDS.includes(kind)) fail('CAPTURE_RETENTION_KIND');
 if (!db || typeof db.query !== 'function') fail('CAPTURE_RETENTION_DATABASE');
}
async function scalar(db, sql, args = []) { return (await db.query(sql, args)).rows[0]?.value; }

/* Retention posture as the database reports it. A NULL window on a review class, or a stored
 * schedule that disagrees with the approved one, is a hard refusal - the sweeps then do nothing
 * rather than delete on an unapproved number. */
async function retentionStatus(db) {
 const status = await scalar(db, 'SELECT learning.retention_status() AS value');
 if (!status || typeof status !== 'object') fail('CAPTURE_RETENTION_SCHEDULE_MISSING');
 for (const row of SCHEDULE) {
  const stored = (status.schedule || []).find(x => x.classId === row.classId);
  if (!stored) fail('CAPTURE_RETENTION_SCHEDULE_MISSING');
  if (stored.windowDays !== row.days || stored.basis !== row.basis || stored.legalReviewRequired !== row.legalReviewRequired) {
   fail('CAPTURE_RETENTION_SCHEDULE_DRIFT');
  }
 }
 return status;
}
/* The window a sweep may use, read from the DB row rather than from this file, so a legal change is
 * a data change. A youth/protected-age class is never swept here. */
async function windowDays(db, classId) {
 const status = await retentionStatus(db);
 const row = status.schedule.find(x => x.classId === classId);
 if (row.basis === 'separate-lawful-protocol') fail('CAPTURE_RETENTION_SEPARATE_PROTOCOL');
 if (!Number.isSafeInteger(row.windowDays) || row.windowDays < 1) fail('CAPTURE_RETENTION_LEGAL_REVIEW_REQUIRED');
 return row.windowDays;
}
/* A stored capture window wider than the approved maximum would be an unapproved extension; the
 * enforced (stricter) window is what the enqueue bound already applies. */
async function requireDelegatedBound(db, days) {
 const {retentionDays} = await retentionStatus(db);
 if (retentionDays !== null && Number(retentionDays) > days) fail('CAPTURE_RETENTION_POLICY_EXCEEDS_SCHEDULE');
 return retentionDays;
}

/* ------------------------------------------------------------------ sweeps */

/* Expired (retention-bounded) captures, including any record whose subject has withdrawn. The
 * erasure sweep already owns the tombstone / privacy-epoch / export-revocation bookkeeping, so it
 * is the single implementation; this only proves the stored policy window is not wider than the
 * approved one before allowing it to run. */
async function sweepCaptures(db, {limit = 500} = {}) {
 const days = await windowDays(db, CLASS_FOR_KIND.captures);
 await requireDelegatedBound(db, days);
 const erased = await scalar(db, 'SELECT learning.erase($1) AS value', [limit]);
 return {windowDays:days,erased:erased ?? 0};
}

/* Closed research exports: the DB run is retired here, and the offline file is unlinked by the
 * existing exporter-role `purge-exports` job (which already purges revoked/purged/failed runs), so
 * this sweep needs no exporter credential. A copy never outlives its source: an export's expiry is
 * already LEAST-bound to its members by 0047's export_member_expiry trigger. */
async function sweepExports(db, {limit = 500} = {}) {
 const days = await windowDays(db, CLASS_FOR_KIND.exports);
 const closed = await scalar(db, 'SELECT learning.close_expired_exports($1) AS value', [limit]);
 return {windowDays:days,runsClosed:closed ?? 0};
}

/* The 7-day client-upload spool. The trigger already bounds each row by the window and by its
 * source; this deletes what has come due. */
async function sweepSpool(db, {limit = 500} = {}) {
 const days = await windowDays(db, CLASS_FOR_KIND.spool);
 const purged = await scalar(db, 'SELECT learning.purge_spool($1) AS value', [limit]);
 return {windowDays:days,purged:purged ?? 0};
}

/* The backup-journal replay obligation. The 35-day window is NOT enforced here: it becomes
 * enforceable only once safe pruning has been verified (learning.backup_prune_ready), and this
 * sweep reports that state instead of inventing permission. It also retains enough journal
 * watermarks to cover every backup it could be replayed against, and reports whether a fresher
 * journal is owed because the privacy epoch moved past the newest recorded one. */
async function sweepBackups(db) {
 const days = await windowDays(db, CLASS_FOR_KIND.backups);
 const ready = await scalar(db, 'SELECT learning.backup_prune_ready() AS value');
 const obligation = await scalar(db, 'SELECT learning.journal_obligation() AS value');
 if (!obligation || typeof obligation !== 'object') fail('CAPTURE_RETENTION_SCHEDULE_MISSING');
 const prunable = Number(obligation.watermarks) > 20;
 const watermarksPruned = prunable ? await scalar(db, 'SELECT learning.prune_journal_watermarks(20) AS value') : 0;
 return {windowDays:days,pruneReady:ready === true,pruneAllowed:ready === true,
  journalEpoch:obligation.journalEpoch,liveEpoch:obligation.liveEpoch,
  journalObligation:obligation.due ? 'DUE' : 'CURRENT',watermarksPruned:watermarksPruned ?? 0};
}

const SWEEPS = Object.freeze({captures:sweepCaptures,exports:sweepExports,spool:sweepSpool,backups:sweepBackups});

/* One idempotent sweep. Re-running with nothing due touches zero rows, so the scheduled job can run
 * as often as the operator likes without double-counting or double-deleting. */
async function runRetention(db, {now = Date.now(), kind, limit = 500} = {}) {
 if (!Number.isSafeInteger(now) || now < 0) fail('CAPTURE_RETENTION_CLOCK');
 requireDb(db, kind);
 if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) fail('CAPTURE_RETENTION_ARGUMENT');
 const result = await SWEEPS[kind](db, {limit});
 return Object.freeze({kind,at:new Date(now).toISOString(),...result});
}

module.exports = {SCHEDULE,KINDS,CLASS_FOR_KIND,scheduleFor,boundExpiry,windowDays,retentionStatus,
 runRetention,sweepCaptures,sweepExports,sweepSpool,sweepBackups,safeCode,DAY_MS};
