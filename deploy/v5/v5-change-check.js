'use strict';
/* A4: WAL is cluster-wide, including Neon's control database. Only an exact,
 * database-local transactional clock + sequence state can authorize an idle skip.
 * The SQL guards are installed by migration 0070. Missing/unknown state dumps;
 * a failed live probe fails the cycle. --force never becomes a skip.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function validToken(token) {
  return token && token.format === 'mega-v5-db-change/v1' && token.covered === true &&
    typeof token.database === 'string' && /^[a-f0-9]{32}$/.test(token.epoch || '') &&
    Array.isArray(token.revisions) && token.revisions.length === 64 &&
    token.revisions.every(v => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) &&
    Array.isArray(token.excludedSchemas) &&
    ['', 'learning'].includes(token.excludedSchemas.join(',')) && token.excludedSchemas.length <= 1 &&
    Array.isArray(token.sequences) && token.sequences.every(s => Array.isArray(s) &&
      s.length === 4 && typeof s[0] === 'string' && typeof s[1] === 'string' &&
      typeof s[2] === 'string' && /^-?[0-9]+$/.test(s[2]) && typeof s[3] === 'boolean');
}
function tokenText(token) {
  return JSON.stringify([token.database, token.epoch, token.excludedSchemas, token.revisions, token.sequences]);
}
function targetFingerprint(doc) {
  return crypto.createHash('sha256').update(JSON.stringify([
    doc.projectId,doc.sourceId,doc.host,doc.port,doc.database
  ])).digest('hex');
}
function unchanged(previous, current, target) {
  return previous && previous.format === 'mega-v5-backup-watermark/v2' &&
    previous.target === target && /^v5-p15-[\w-]+$/.test(previous.backupId || '') &&
    /^[a-f0-9]{64}$/.test(previous.ciphertextSha256 || '') &&
    /^[a-f0-9]{64}$/.test(previous.manifestSha256 || '') &&
    validToken(previous.token) && validToken(current.token) &&
    tokenText(previous.token) === tokenText(current.token);
}
function proofValid(marker, newestId, now, rpoSeconds) {
  return !!(marker && marker.format === 'mega-v5-backup-unchanged/v2' &&
    marker.backupId === newestId && /^[a-f0-9]{64}$/.test(marker.target || '') &&
    /^[a-f0-9]{64}$/.test(marker.ciphertextSha256 || '') &&
    /^[a-f0-9]{64}$/.test(marker.manifestSha256 || '') &&
    typeof marker.checkedAt === 'string' && Date.parse(marker.checkedAt) > now-rpoSeconds*1000 &&
    Date.parse(marker.checkedAt) <= now && validToken(marker.token) && validToken(marker.previous) &&
    tokenText(marker.token) === tokenText(marker.previous));
}
function main() {
  const ROOT = process.env.V5_ROOT || '/opt/mega-xo-v5-production';
  let directTarget;
  for (const candidate of ['../../scripts/v5/p15/direct-target.js',
    path.join(ROOT, 'lib/scripts/v5/p15/direct-target.js')]) {
    try { directTarget = require(candidate); break; } catch {}
  }
  function refuse(code) { throw Error('V5_CHANGE_CHECK_REFUSED: ' + code); }
  if (!directTarget) refuse('P15_DIRECT_TARGET_CONTRACT_MISSING');
  const args = process.argv.slice(2);
  const sourceAt = args.indexOf('--source');
  const source = sourceAt >= 0 ? args[sourceAt+1] : path.join(ROOT,'state/prod-source.json');
  const targetDoc = directTarget.readTarget(source, 'backup', process.env);
  const pgEnv = {...directTarget.buildPgEnv(targetDoc,process.env),V5_ROOT:ROOT};
  const target = targetFingerprint(targetDoc);
  const lsnOnly = args.includes('--print-lsn');
  const excludeLearning = targetDoc.kind === 'nonserving-production-source';
  const sql = lsnOnly ? 'SELECT pg_current_wal_lsn()::text' :
    "SELECT json_build_object('lsn',pg_current_wal_lsn()::text,'token',ops.backup_change_probe("+
      (excludeLearning ? 'true' : 'false')+"))::text";
  const checkedAt=new Date().toISOString();
  const probe = spawnSync(process.env.V5_PSQL_BIN || 'psql',
    ['-X','-v','ON_ERROR_STOP=1','-t','-A','-c',sql],
    {env:pgEnv,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  if (probe.error || probe.status !== 0) {
    if(lsnOnly)refuse('LIVE_PROBE_FAILED');
    process.stdout.write(JSON.stringify({event:'change_check',changed:true,target,checkedAt,
      probeUnavailable:true,current:{token:null,lsn:null},previous:null})+'\n');
    return 0; // attempt the mandatory full backup; never renew an unchanged proof
  }
  if (lsnOnly) {
    const lsn = String(probe.stdout || '').trim();
    if (!/^[0-9A-F]+\/[0-9A-F]+$/.test(lsn)) refuse('INVALID_LSN');
    process.stdout.write(lsn+'\n'); return 0;
  }
  let current;
  try { current = JSON.parse(probe.stdout); } catch { refuse('INVALID_PROBE'); }
  if (!current || !/^[0-9A-F]+\/[0-9A-F]+$/.test(current.lsn || '') ||
      current.token?.database !== targetDoc.database ||
      JSON.stringify(current.token.excludedSchemas) !== JSON.stringify(excludeLearning ? ['learning'] : [])) refuse('PROBE_TARGET_MISMATCH');
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(path.join(ROOT,'state/last-backup-state.json'),'utf8')); } catch {}
  const skip = !args.includes('--force') &&
    !fs.existsSync(path.join(ROOT,'state/backup-skip-disabled')) && unchanged(previous,current,target);
  const result = {event:'change_check',changed:!skip,target,checkedAt,current,previous};
  process.stdout.write(JSON.stringify(result)+'\n');
  return skip ? 42 : 0;
}
module.exports = {validToken,tokenText,unchanged,proofValid,targetFingerprint};
if (require.main === module) {
  try { process.exitCode=main(); }
  catch (err) { process.stderr.write(String(err.message)+'\n'); process.exitCode=2; }
}
