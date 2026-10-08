#!/usr/bin/env node
'use strict';

// P17 source-side candidate evidence. No network, provider credentials,
// deployment ID, fabricated service digest or "ready" declaration. Real
// release publication is gated separately after services exist and are tested.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FORMAT = 'mega-v5-source-candidate/v1';
const FILES = Object.freeze([
  'packages/migrations/manifest.json',
  'packages/contracts/realtime.js',
  'packages/contracts/commands.js',
  'packages/contracts/http-guards.js',
  'packages/contracts/native-bridge.js',
  'native/client/bundle.config.json'
]);
const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function assert(condition, message) { if (!condition) throw new Error('V5_CANDIDATE_REFUSED: ' + message); }
function loadSources(root) {
  const bytes = new Map();
  for (const file of FILES) bytes.set(file,fs.readFileSync(path.join(root,file)));
  const migrations = JSON.parse(bytes.get(FILES[0]).toString('utf8'));
  assert(Array.isArray(migrations.migrations) && migrations.migrations.length >= 1, 'migration ledger missing');
  for (let i=0;i<migrations.migrations.length;i++) {
    const row=migrations.migrations[i];
    assert(row && row.id === i + 1 && SHA64.test(row.sha256), 'migration chain not consecutive');
    assert(typeof row.file === 'string' && /^migrations\/[0-9]{4}_[a-z0-9_]+\.sql$/.test(row.file),
      'migration file name invalid');
    const body=fs.readFileSync(path.join(root,'packages/migrations',row.file));
    // Match scripts/v5/migrate.js:migrationChecksum exactly. Raw SQL bytes
    // alone are not the authoritative checksum; the logical migration name
    // and newline are also included to prevent file/name substitution.
    const signed=Buffer.concat([Buffer.from(row.name+'\n','utf8'),body]);
    assert(sha256(signed) === row.sha256,'migration checksum mismatch: '+row.file);
  }
  const proto=bytes.get(FILES[1]).toString('utf8').match(/\bconst PROTOCOL = '([^']+)'/);
  assert(proto && proto[1] === 'realtime/v1','realtime protocol version not frozen/recognized');
  return {bytes,migrations,realtimeProtocol:proto[1]};
}
function candidate(root,sourceSha) {
  assert(SHA40.test(sourceSha),'source SHA must be an exact 40-character lowercase commit');
  const sources=loadSources(root);
  const files={};
  for (const [file,data] of sources.bytes) files[file]=sha256(data);
  return {
    schema: FORMAT,
    status: 'SOURCE_ONLY_NOT_DEPLOYABLE',
    gitSha: sourceSha,
    milestone: 'V5',
    candidateVersion: '5.0.0-dev.' + sourceSha.slice(0,12),
    schemaEvidence: {
      migrationCount: sources.migrations.migrations.length,
      highestMigrationId: sources.migrations.migrations.at(-1).id,
      manifestSha256: files[FILES[0]]
    },
    protocolEvidence: {
      realtime: sources.realtimeProtocol,
      realtimeContractSha256: files[FILES[1]]
    },
    sourceHashes: files,
    deployable: false,
    artifacts: {},
    deploymentIds: {},
    gateEvidence: [],
    excludedProduct: 'new megaxo.online website (P21 deferred)'
  };
}
function verify(root,record,expectedSha) {
  assert(record && typeof record === 'object' && !Array.isArray(record),'candidate object required');
  assert(SHA40.test(expectedSha),'expected git SHA required');
  const expected=candidate(root,expectedSha);
  // Canonical byte equality rejects extra fields, fake signatures/digests,
  // skipped schema records, alternate actors and spurious "ready" flags.
  assert(JSON.stringify(record) === JSON.stringify(expected),
    'source candidate differs from checked-in schema/protocol/assets or claims deployment');
  assert(!record.deployable && Object.keys(record.artifacts).length === 0,'source not deployable');
  return true;
}
function outputPath(root,input) {
  assert(typeof input === 'string' && /^\.artifacts\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(input),
    'candidate output must be a named .artifacts JSON file');
  return path.join(root,input);
}
function run(args,root=process.cwd()) {
  const cmd=args[0], flag=args[1], sha=args[2];
  assert((cmd === 'create' || cmd === 'verify') && flag === '--sha' &&
    typeof sha === 'string','usage: create|verify --sha COMMIT_SHA [--output .artifacts/name.json|--file .artifacts/name.json]');
  if (cmd === 'create') {
    assert(args.length === 5 && args[3] === '--output','create requires --output');
    const result=candidate(root,sha);
    const dest=outputPath(root,args[4]);
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.writeFileSync(dest,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
    return result;
  }
  assert(args.length === 5 && args[3] === '--file','verify requires --file');
  const dest=outputPath(root,args[4]);
  assert(fs.lstatSync(dest).isFile() && !fs.lstatSync(dest).isSymbolicLink(),'manifest must be a regular file');
  const data=JSON.parse(fs.readFileSync(dest,'utf8'));
  verify(root,data,sha);
  return data;
}
if (require.main === module) {
  try {
    const result=run(process.argv.slice(2));
    process.stdout.write('V5_SOURCE_CANDIDATE_OK ' + result.gitSha + ' ' +
      result.schemaEvidence.manifestSha256 + ' (NOT DEPLOYABLE)\n');
  } catch (error) {
    process.stderr.write('V5_SOURCE_CANDIDATE_ERROR ' + error.message + '\n');
    process.exitCode=2;
  }
}
module.exports={FILES,FORMAT,sha256,loadSources,candidate,verify,run,outputPath};
