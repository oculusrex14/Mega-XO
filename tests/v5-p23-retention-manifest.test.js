'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {TYPES,MONITORS,assessRetention}=require('../scripts/v5/p23/retention-manifest');
const SHA='a'.repeat(40),HASH='b'.repeat(64),NOW='2026-10-09T10:45:00Z';
function example(){
  return {
    format:'mega-v5-p23-archive-manifest/v1',sourceSha:SHA,observedAtUtc:NOW,
    operatorRetentionDays:365,
    approvedPolicyRef:'artifact://v5/p23/retention-policy/operator-approved-20261009',
    artifacts:TYPES.map((type,i)=>({
      type,sha256:(i%10).toString().repeat(64),
      immutableArchiveRef:'artifact://v5/p23/archived-item/item-'+i+'-original-release',
      encryptedAtRest:true,retrievalObservedAtUtc:'2026-10-08T10:45:00Z',
      retrievalEvidenceRef:'artifact://v5/p23/retrieval/verified-file-'+i+'-digest',
      retainUntilUtc:'2028-10-09T10:45:00Z',
      accessClass:['v4-frozen-sqlite-encrypted','migration-audit-key-custody',
        'v5-postgres-encrypted-backup'].includes(type)?'RESTRICTED_OPERATORS':'PRIVATE_AUDIT',
      deletionPermitted:false,
    })),
    monitors:MONITORS.map(signal=>({
      signal,decision:signal.startsWith('v4-')?
        'DISABLE_OLD_ALERT_WITH_ARCHIVED_AUDIT':'RETAIN_OR_REPOINT_TO_POSTGRES_AUTHORITY',
      observedEvidenceRef:'artifact://v5/p23/monitor/transition-confirmation-001',
    })),
  };
}
function denies(edit) {
  const x=example();edit(x);
  assert.throws(()=>assessRetention(x,SHA),/P23_RETENTION_REFUSED/);
}
test('complete cold archive claims can never issue a delete, key rotation or release permission',()=>{
  const a=assessRetention(example(),SHA);
  assert.equal(a.artifactsDeclared,TYPES.length);
  assert.equal(a.monitorsMapped,MONITORS.length);
  assert.match(a.manifestFingerprintSha256,/^[a-f0-9]{64}$/);
  assert.equal(a.retrievalAndRestoreIndependentlyVerified,false);
  assert.equal(a.deletionAuthorized,false);
  assert.equal(a.g23Accepted,false);
});
test('archive inventory cannot lose old source/tag, frozen SQLite, migration audit or PG backup',()=>{
  denies(x=>x.artifacts.pop());
  denies(x=>x.artifacts[1].type=x.artifacts[0].type);
  denies(x=>x.artifacts[0].sha256='not-a-digest');
  denies(x=>x.artifacts[2].immutableArchiveRef=x.artifacts[1].immutableArchiveRef);
  denies(x=>x.artifacts[3].type='some-unknown-artifact');
});
test('private archive access and encryption may never be disabled',()=>{
  denies(x=>x.artifacts[0].encryptedAtRest=false);
  denies(x=>x.artifacts[5].accessClass='PUBLIC');
  denies(x=>x.artifacts[6].accessClass='PRIVATE_AUDIT');
  denies(x=>x.artifacts[0].deletionPermitted=true);
  denies(x=>x.artifacts[0].credential='secret-in-PR');
});
test('prevent expired or unreviewed archive policy and fake retrieval',()=>{
  denies(x=>x.operatorRetentionDays=0);
  denies(x=>x.artifacts[0].retainUntilUtc='2026-11-01T00:00:00Z');
  denies(x=>x.artifacts[0].retrievalObservedAtUtc='2026-01-01T00:00:00Z');
  denies(x=>x.artifacts[0].retrievalObservedAtUtc='2027-01-01T00:00:00Z');
  denies(x=>x.approvedPolicyRef='https://untrusted-storage.invalid/opaque');
  denies(x=>x.artifacts[1].immutableArchiveRef='artifact://v5/p23/../secret-key');
  denies(x=>x.artifacts[2].retrievalEvidenceRef=null);
});
test('retired V4 alarms cannot remain attached to old authority or suppress PG monitoring',()=>{
  denies(x=>x.monitors.pop());
  denies(x=>x.monitors[0].decision='KEEP_V4_SQLITE_WRITER_HEALTH_ALARM');
  denies(x=>x.monitors[4].decision='DISABLE_ALL_ALERTS');
  denies(x=>x.monitors[1].signal=x.monitors[0].signal);
  denies(x=>x.monitors[0].observedEvidenceRef='unknown');
});
test('wrong branch or source identity fails closed',()=>{
  const x=example();x.sourceSha='c'.repeat(40);
  assert.throws(()=>assessRetention(x,SHA),/P23_RETENTION_REFUSED/);
});
