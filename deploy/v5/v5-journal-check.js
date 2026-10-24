'use strict';

/* A4 compute budget: decide whether this backup cycle may skip WITHOUT opening
 * a database connection. Prints "clean" (skip, no SQL) or "probe" (run the
 * change-check probe) and exits 0 either way; a refused/failed check prints
 * "probe" so the cycle fails open to today's behavior, never to a skipped dump.
 *
 * clean requires ALL of:
 *   - the write journal exists and its mtime equals the PRE-DUMP observation
 *     recorded in the watermark (no pool writer committed since the archive);
 *   - the watermark is structurally valid and bound to a real archive identity;
 *   - the archive is younger than --max-archive-hours (default 12h), so a
 *     non-journaled writer (manual psql) is still caught by a periodic probe.
 * Usage: v5-journal-check.js --watermark F --journal F [--max-archive-hours H]
 */
const fs = require('node:fs');
const path = require('node:path');
const { validToken } = require('./v5-change-check.js');

function main() {
 const args = process.argv.slice(2);
 const get = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
 };
 const watermarkFile = get('--watermark');
 const journalFile = get('--journal');
 const maxHours = Number(get('--max-archive-hours', '12'));
 const out = s => { process.stdout.write(s + '\n'); };
 if (!watermarkFile || !journalFile || !path.isAbsolute(watermarkFile) ||
     !path.isAbsolute(journalFile) || !Number.isFinite(maxHours) || maxHours <= 0) out('probe');
 let watermark = null;
 try { watermark = JSON.parse(fs.readFileSync(watermarkFile, 'utf8')); } catch { return out('probe'); }
 let journalMtime = null;
 try { journalMtime = String(Math.round(fs.statSync(journalFile).mtimeMs)); } catch { return out('probe'); }
 const ok = !!(watermark && watermark.format === 'mega-v5-backup-watermark/v2' &&
  validToken(watermark.token) && /^v5-p15-[\w-]+$/.test(watermark.backupId || '') &&
  /^[a-f0-9]{64}$/.test(watermark.target || '') &&
  /^[a-f0-9]{64}$/.test(watermark.ciphertextSha256 || '') &&
  /^[a-f0-9]{64}$/.test(watermark.manifestSha256 || '') &&
  watermark.journalMtime !== undefined && String(watermark.journalMtime) === journalMtime &&
  Number.isFinite(Date.parse(watermark.archivedAtUtc)) &&
  Date.now() - Date.parse(watermark.archivedAtUtc) < maxHours * 3600 * 1000);
 out(ok ? 'clean' : 'probe');
}
main();
