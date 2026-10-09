'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {FAMILIES,evaluate}=require('../scripts/v5/p22/import-reconciliation');
const SHA='a'.repeat(40),V4='b'.repeat(40),SNAP='c'.repeat(64),MODEL='d'.repeat(64),SCHEMA='e'.repeat(64);
function families() {
  return Object.fromEntries(FAMILIES.map((family,i)=>[family,{
    rows:i===0?12:i===1?12:i+1,canonicalSha256:((i+1)%10).toString().repeat(64),
  }]));
}
function receipt() {
  const source=families(), loaded=structuredClone(source), verified=structuredClone(source);
  return {
    format:'mega-v5-p22-final-import-reconciliation/v1',
    sourceSha:SHA,environment:'nonserving-production',database:'megaxo_v5_candidate',
    frozenSource:{
      snapshotSha256:SNAP,sourceReleaseSha:V4,fingerprint:MODEL,
      fenceEvidenceRef:'artifact://v5/p22/freeze/consistent-source-01',families:source,
    },
    target:{database:'megaxo_v5_candidate',schemaManifestSha256:SCHEMA,
      writersDisabled:true,providerSideEffectsDisabled:true},
    import:{command:'load',ok:true,runId:'final-run-20261009',database:'megaxo_v5_candidate',
      modelFingerprint:MODEL,snapshotSha256:SNAP,schemaManifestSha256:SCHEMA,
      coverageUnclassified:0,targetFamilies:loaded,targetWriterDisabled:true},
    verify:{command:'verify',ok:true,runId:'final-run-20261009',database:'megaxo_v5_candidate',
      modelFingerprint:MODEL,schemaManifestSha256:SCHEMA,unexplainedCount:0,
      invariantFailures:0,unverifiedLocators:0,targetFamilies:verified},
  };
}
function denied(edit) {
  const x=receipt();edit(x);
  assert.throws(()=>evaluate(x,SHA),/P22_IMPORT_REFUSED/);
}
test('exact final-source/load/reconciliation matching returns review-only status',()=>{
  const x=evaluate(receipt(),SHA);
  assert.equal(x.familiesCompared,FAMILIES.length);
  assert.equal(x.sourceAndTargetDigestClaimsConsistent,true);
  assert.equal(x.actualP03CLIAndFrozenSourceReverified,false);
  assert.equal(x.authorizesApplicationWrites,false);
  assert.equal(x.g22Accepted,false);
});

test('global equality cannot hide per-actor/durable family corruption',()=>{
  denied(x=>{x.import.targetFamilies.wallets.canonicalSha256='f'.repeat(64);});
  denied(x=>{x.verify.targetFamilies.ledger.canonicalSha256='f'.repeat(64);});
  denied(x=>{
    const a=x.verify.targetFamilies.wallets.rows,b=x.verify.targetFamilies.matchAndEscrow.rows;
    x.verify.targetFamilies.wallets.rows=b;
    x.verify.targetFamilies.matchAndEscrow.rows=a;
  });
  denied(x=>{delete x.verify.targetFamilies.privacyAndTombstones;});
  denied(x=>{delete x.import.targetFamilies.providerInboxAndReceipts;});
});

test('import source, target and schema must be same as frozen consistent V4 snapshot',()=>{
  denied(x=>{x.import.snapshotSha256='f'.repeat(64);});
  denied(x=>{x.import.modelFingerprint='f'.repeat(64);});
  denied(x=>{x.verify.modelFingerprint='f'.repeat(64);});
  denied(x=>{x.import.runId='different-final-run';});
  denied(x=>{x.target.schemaManifestSha256='f'.repeat(64);});
  denied(x=>{x.verify.database='different_database';});
  denied(x=>{x.environment='staging';});
  denied(x=>{x.sourceSha='f'.repeat(40);});
});

test('partial imports, unexplained differences and unverified rows always fail closed',()=>{
  denied(x=>{x.import.coverageUnclassified=1;});
  denied(x=>{x.verify.unexplainedCount=1;});
  denied(x=>{x.verify.invariantFailures=1;});
  denied(x=>{x.verify.unverifiedLocators=1;});
  denied(x=>{x.import.ok=false;});
  denied(x=>{x.verify.ok=false;});
  denied(x=>{x.target.writersDisabled=false;});
  denied(x=>{x.target.providerSideEffectsDisabled=false;});
  denied(x=>{x.import.targetWriterDisabled=false;});
});

test('untrusted source manifests and hidden actor details cannot be included',()=>{
  denied(x=>{x.frozenSource.fenceEvidenceRef='https://fake.example.com';});
  denied(x=>{x.import.secret='credential';});
  denied(x=>{x.frozenSource.families.wallets.actorId='example_player';});
  denied(x=>{x.frozenSource.families.wallets.rows=-1;});
});
