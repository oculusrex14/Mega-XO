#!/usr/bin/env node
'use strict';

/**
 * V5 R2 upload + INDEPENDENT readback for one sealed P15 archive pair.
 *
 * Contract rules (bucket, prefix, object naming, manifest/archive binding,
 * permissions, ciphertext sha256, sealed-envelope header equality) come from
 * the deployed P15 library so the checked-in rules decide; only the transport
 * differs: `curl --aws-sigv4` instead of AWS CLI v2, because the host has no
 * reviewed aws-cli and its rclone 1.60.1-DEV is not trusted for R2 S3.
 *
 * Writer and reader are separate bucket-scoped credentials (R2 rule:
 * access key id = token id, secret = sha256 token value). PutObject carries
 * If-None-Match:* so an immutable object is never overwritten; the readback
 * re-fetches BOTH objects with the READER credential and re-hashes them.
 * Nothing is ever deleted from the bucket.
 */
const fs = require('node:fs');
const path = require('node:path');
const r2 = require('./v5-lib.js');
const { assertTarget, objectKeys } = r2.contract();
const { inspectPair } = r2.manifest();
const { digestFile } = r2.sealed();
const client = require('./v5-r2-client.js');

const refuse = client.refuse;

async function main(argv) {
  if (argv.length !== 12) {
    refuse('usage: --credentials F --target F --manifest F --archive F --receipt F --source-sha SHA');
  }
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  for (const k of ['credentials', 'target', 'manifest', 'archive', 'receipt', 'source-sha']) {
    if (typeof args[k] !== 'string' || !args[k]) refuse('missing --' + k);
  }
  const sourceSha = args['source-sha'];
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) refuse('exact 40-hex source SHA required');

  const creds = client.credentials(args.credentials);
  const target = assertTarget(client.readJson(args.target));
  for (const role of ['writer', 'reader']) {
    if (target.bucket !== creds[role].bucket ||
        creds[role].endpoint !== 'https://' + target.accountId + '.r2.cloudflarestorage.com') {
      refuse(role + ' credential is not scoped to the declared V5-only bucket/endpoint');
    }
  }

  // Validate pair + envelope BEFORE any network call.
  const manifest = (await inspectPair(args.manifest, args.archive, sourceSha)).manifest;
  if (!['nonserving-staging-source', 'nonserving-production-source'].includes(manifest.sourceKind) ||
      manifest.backupRunClass !== 'REAL_DIRECT_PG16_DUMP') {
    refuse('only a real reviewed non-serving V5 staging/production dump may be published');
  }
  const keys = objectKeys(target, manifest);

  if (fs.existsSync(args.receipt)) refuse('receipt exists; refusing to overwrite an immutable record');
  if (path.dirname(args.receipt) !== path.dirname(args.archive)) refuse('receipt must sit beside the archive');
  if (!/\.r2-receipt\.json$/.test(args.receipt)) refuse('receipt must end .r2-receipt.json');

  const manifestSha = client.sha256File(args.manifest);
  const scratch = path.join(path.dirname(args.archive),
    '.' + manifest.backupId + '.' + require('node:crypto').randomBytes(6).toString('hex'));
  const tempCipher = scratch + '.cipher.partial';
  const tempManifest = scratch + '.manifest.partial';
  try {
    // If the manifest PUT fails, an already stored ciphertext object is left in
    // place on purpose: an orphaned encrypted object is recoverable and removing
    // it could destroy the only copy. NEVER delete a possibly recoverable object.
    client.put(creds.writer, keys.ciphertextKey, args.archive, 'application/octet-stream',
      manifest.ciphertextSha256);
    client.put(creds.writer, keys.manifestKey, args.manifest, 'application/json',
      manifestSha);

    // Independent retrieval, READER credential only.
    const cipherHead = client.head(creds.reader, keys.ciphertextKey);
    const manifestHead = client.head(creds.reader, keys.manifestKey);
    if (Number(cipherHead['content-length']) !== manifest.ciphertextBytes) {
      refuse('stored ciphertext length differs from the manifest');
    }
    if (Number(manifestHead['content-length']) !== fs.statSync(args.manifest).size) {
      refuse('stored manifest length differs from the local manifest');
    }
    if (cipherHead['x-amz-meta-sha256'] !== manifest.ciphertextSha256 ||
        manifestHead['x-amz-meta-sha256'] !== manifestSha) {
      refuse('stored object checksum metadata differs from the local bytes');
    }
    client.get(creds.reader, keys.ciphertextKey, tempCipher);
    client.get(creds.reader, keys.manifestKey, tempManifest);
    const st = fs.lstatSync(tempCipher);
    if (!st.isFile() || st.isSymbolicLink() || st.size !== manifest.ciphertextBytes) {
      refuse('retrieved ciphertext is not the expected regular byte stream');
    }
    const readCipherSha = await digestFile(tempCipher);
    if (readCipherSha !== manifest.ciphertextSha256) {
      refuse('INDEPENDENT READBACK MISMATCH: retrieved ciphertext sha256 differs from the uploaded archive');
    }
    if (client.sha256File(tempManifest) !== manifestSha) {
      refuse('INDEPENDENT READBACK MISMATCH: retrieved manifest sha256 differs from the uploaded manifest');
    }
    const receipt = {
      format: 'mega-v5-p15-r2-upload-readback/v1',
      backupId: manifest.backupId,
      sourceSha: manifest.sourceSha,
      backupCreatedAtUtc: manifest.createdAtUtc,
      readbackCheckedAtUtc: new Date().toISOString(),
      r2Bucket: target.bucket,
      r2AccountId: target.accountId,
      objectKey: keys.ciphertextKey,
      manifestObjectKey: keys.manifestKey,
      ciphertextSha256: manifest.ciphertextSha256,
      ciphertextBytes: manifest.ciphertextBytes,
      manifestSha256: manifestSha,
      retrievedCiphertextSha256: readCipherSha,
      uploadUsedWriteOncePrecondition: true,
      separateWriterReaderProfilesUsed: true,
      ciphertextAndManifestReadbackMatching: true,
      transport: 'curl-aws-sigv4',
      realProviderUploadAndIndependentReadbackObserved: true,
      mockedCallsOnly: false,
      decryptionAndRestoreFromR2Completed: false,
      providerIamIndependentlyAudited: false,
      productionRetentionApproved: false,
      g15Accepted: false
    };
    // The receipt is the immutable record of this upload attempt; it is written
    // only after the independent readback matched, so its absence means either
    // "no upload happened" or "the upload was not independently verified".
    const fd = fs.openSync(args.receipt, fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return receipt;
  } finally {
    for (const f of [tempCipher, tempManifest]) { try { fs.unlinkSync(f); } catch {} }
  }
}

main(process.argv.slice(2)).then((receipt) => {
  process.stdout.write(JSON.stringify(receipt) + '\n');
}, (e) => {
  const msg = e && typeof e.message === 'string' ? e.message : '';
  process.stderr.write((msg.startsWith('V5_') || msg.startsWith('P15_') ? msg : 'V5_R2_REFUSED: upload/readback failed') + '\n');
  process.exitCode = 2;
});
