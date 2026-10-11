'use strict';
/**
 * Safe AI Runtime and Model Delivery Staging Tool (B05.03, B05.05, B05.06, B05.08, B05.10).
 *
 * Responsibilities:
 * 1. Stages pinned onnxruntime-web@1.23.2 WASM and WebGPU runtime assets with verified hashes.
 * 2. Measures separate model, gzip-compressed, runtime JS, and unpacked WASM bytes.
 * 3. Stages optional candidate models into same-origin immutable hash-named paths (/.../<sha256>.onnx).
 * 4. Produces exact sealed manifest entries for parent builder/native integration without modifying Git.
 * 5. Generates trusted private research catalogs for application configuration, keeping public APPROVED_CATALOG empty.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const MegaBotContract = require('../../src/bot/contracts.js');
const MegaBotPack = require('../../src/bot/pack.js');

const PINNED_ORT_VERSION = '1.23.2';
const MIT_LICENSE_NOTICE = 'Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License.';

// Verbatim upstream redistribution assets, pinned to the v1.23.2 tag commit.
// Read locally: staging must never fetch licenses or runtime code from the network.
const UPSTREAM_COMMIT = 'a83fc4d58cb48eb68890dd689f94f28288cf2278';
const SEALED_LEGAL_FILES = Object.freeze({
  LICENSE: {
    bytes: 1073,
    sha256: '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c',
    role: 'license'
  },
  'ThirdPartyNotices.txt': {
    bytes: 326866,
    sha256: 'e9e90971a8e75a9a8ac0c6412e29c1202d079998389915aa485f46c816c3b4cc',
    role: 'third-party-notices'
  }
});
// Known sealed SHA-256 hashes and byte counts for onnxruntime-web@1.23.2 dist files
const SEALED_RUNTIME_FILES = Object.freeze({
  'ort.wasm.min.js': {
    bytes: 49926,
    sha256: 'c6bc9f8e1d0ecc3983a57910e6a30b2230a512bcd2e0207cd64306459c3de7b4',
    mimeType: 'application/javascript',
    role: 'wasm-runner'
  },
  'ort.webgpu.min.js': {
    bytes: 66329,
    sha256: 'c94f5bb9c17bd37168e9b4220facb2b6fc1dd125a5e91b7a680171840a27f254',
    mimeType: 'application/javascript',
    role: 'webgpu-runner'
  },
  'ort-wasm-simd-threaded.wasm': {
    bytes: 11905541,
    sha256: '45eaee27761ad883742a8d4b8fce1538d60ce43b51adf1726fafccc59b8c1a15',
    mimeType: 'application/wasm',
    role: 'wasm-binary'
  },
  'ort-wasm-simd-threaded.jsep.wasm': {
    bytes: 23824254,
    sha256: 'ac0d8f1cfbf2732420ad78a86072b8507253c63885a61c3fd640b3055256d31d',
    mimeType: 'application/wasm',
    role: 'webgpu-jsep-binary'
  },
  'ort-wasm-simd-threaded.asyncify.wasm': {
    bytes: 25499390,
    sha256: 'babec0bbddb6d3082623b99b7e1391b75e0729bcca076ff8424d7753af97fada',
    mimeType: 'application/wasm',
    role: 'wasm-asyncify-binary'
  },
  'ort-wasm-simd-threaded.mjs': {
    bytes: 20321,
    sha256: '90a557d15c02bac4504d95b67f431d8594635ed2a0a62a7f2cd83d090ff91d3e',
    mimeType: 'application/javascript',
    role: 'wasm-glue'
  },
  'ort-wasm-simd-threaded.jsep.mjs': {
    bytes: 49998,
    sha256: 'c7b70c8003f077c62849e15275d0b1f1d1cf1a6dfc63b967400567c7224bfdbe',
    mimeType: 'application/javascript',
    role: 'webgpu-jsep-glue'
  },
  'ort-wasm-simd-threaded.asyncify.mjs': {
    bytes: 51913,
    sha256: '249b4dc791f081d33bd11760bfd669fe85f97289e679bbeb291b874272125dff',
    mimeType: 'application/javascript',
    role: 'wasm-asyncify-glue'
  }
});

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function gzipBytes(buffer) {
  return zlib.gzipSync(buffer).length;
}

function legalEntries(prefix = '') {
  return Object.entries(SEALED_LEGAL_FILES).map(([filename, expected]) => {
    const file = path.join(__dirname, `ort-${PINNED_ORT_VERSION}-${filename}`);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`STAGE_AI_RUNTIME: legal source must be an unlinked regular file: ${filename}`);
    }
    const bytesBuffer = fs.readFileSync(file);
    if (bytesBuffer.length !== expected.bytes || sha256(bytesBuffer) !== expected.sha256) {
      throw new Error(`STAGE_AI_RUNTIME: legal source hash mismatch: ${filename}`);
    }
    return {
      relativePath: `${prefix}${filename}`,
      bytesBuffer,
      bytes: expected.bytes,
      sha256: expected.sha256,
      source: `https://raw.githubusercontent.com/microsoft/onnxruntime/${UPSTREAM_COMMIT}/${filename}`,
      mimeType: 'text/plain',
      role: expected.role,
      immutable: true,
      requiresWasmCSP: false
    };
  });
}

/**
 * Verifies that onnxruntime-web dist files match pinned checksums and sizes.
 */
function verifyRuntimeDist(sourceDir) {
  const result = { valid: true, version: PINNED_ORT_VERSION, files: {} };
  for (const [filename, expected] of Object.entries(SEALED_RUNTIME_FILES)) {
    const filePath = path.join(sourceDir, filename);
    if (!fs.existsSync(filePath)) {
      result.valid = false;
      result.files[filename] = { status: 'missing' };
      continue;
    }
    const buf = fs.readFileSync(filePath);
    const hash = sha256(buf);
    const matches = buf.length === expected.bytes && hash === expected.sha256;
    if (!matches) result.valid = false;
    result.files[filename] = {
      status: matches ? 'verified' : 'mismatch',
      bytes: buf.length,
      expectedBytes: expected.bytes,
      sha256: hash,
      expectedSha256: expected.sha256
    };
  }
  return result;
}

function safeStagingTarget(targetDir, scratchName) {
  const root = path.resolve('.');
  const target = path.resolve(targetDir);
  const projectRel = path.relative(root, target).split(path.sep).join('/');
  if (projectRel.startsWith('.artifacts/p21-web')) {
    throw new Error(`STAGE_AI_RUNTIME: cannot mutate sealed builder artifact directory: ${target}`);
  }
  const scratch = path.join(root, '.artifacts', 'v51', scratchName);
  const rel = path.relative(scratch, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`STAGE_AI_RUNTIME: target must be inside owned scratch root ${scratch}: ${target}`);
  }
  let current = root;
  for (const component of path.relative(root, target).split(path.sep)) {
    current = path.join(current, component);
    if (fs.existsSync(current) || isSymlink(current)) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`STAGE_AI_RUNTIME: target ancestry must contain only unlinked directories: ${current}`);
      }
      if (fs.existsSync(path.join(current, 'web-build.manifest.json'))) {
        throw new Error(`STAGE_AI_RUNTIME: cannot mutate sealed builder artifact directory: ${current}`);
      }
    }
  }
  return target;
}

function isSymlink(file) {
  try { return fs.lstatSync(file).isSymbolicLink(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function safeStagingFiles(target, filenames) {
  for (const filename of filenames) {
    const file = path.join(target, filename);
    if (!fs.existsSync(file) && !isSymlink(file)) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`STAGE_AI_RUNTIME: output must be an unlinked regular file: ${file}`);
    }
  }
}

/**
 * Stages runtime files into target directory with separate byte measurements.
 */
function stageRuntime({
  sourceDir = path.resolve('.artifacts/v51/ort/node_modules/onnxruntime-web/dist'),
  targetDir,
  includeWebGPU = true,
  includeAsyncify = false,
  dryRun = false
} = {}) {
  if (!targetDir) throw new Error('STAGE_AI_RUNTIME: targetDir is required');
  const target = safeStagingTarget(targetDir, 'staged-runtime');
  const source = path.resolve(sourceDir);
  if (!fs.existsSync(source)) {
    throw new Error(`STAGE_AI_RUNTIME: source directory not found: ${source}`);
  }

  const verification = verifyRuntimeDist(source);
  if (!verification.valid) {
    throw new Error(`STAGE_AI_RUNTIME: runtime verification failed for ${source}`);
  }

  const selectedFiles = ['ort.wasm.min.js', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];
  if (includeWebGPU) {
    selectedFiles.push('ort.webgpu.min.js', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs');
  }
  if (includeAsyncify) {
    selectedFiles.push('ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.mjs');
  }
  safeStagingFiles(target, [...selectedFiles, 'runtime-manifest.json', 'LICENSE', 'ThirdPartyNotices.txt']);
  const legal = legalEntries();

  if (!dryRun) {
    fs.mkdirSync(target, { recursive: true });
  }

  const staged = [];
  let runtimeJsBytes = 0;
  let unpackedWasmBytes = 0;
  let totalBytes = 0;
  let totalGzipBytes = 0;

  for (const filename of selectedFiles) {
    const srcFile = path.join(source, filename);
    const destFile = path.join(target, filename);
    const buf = fs.readFileSync(srcFile);
    const gzLen = gzipBytes(buf);
    const meta = SEALED_RUNTIME_FILES[filename];

    if (!dryRun) {
      fs.writeFileSync(destFile, buf);
    }

    if (filename.endsWith('.wasm')) unpackedWasmBytes += buf.length;
    else runtimeJsBytes += buf.length;
    totalBytes += buf.length;
    totalGzipBytes += gzLen;

    staged.push({
      file: filename,
      bytes: buf.length,
      gzipBytes: gzLen,
      sha256: meta.sha256,
      mimeType: meta.mimeType,
      role: meta.role
    });
  }
  for (const entry of legal) {
    const file = entry.relativePath;
    const gzLen = gzipBytes(entry.bytesBuffer);
    if (!dryRun) fs.writeFileSync(path.join(target, file), entry.bytesBuffer);
    staged.push({ file, bytes: entry.bytes, sha256: entry.sha256, source: entry.source, mimeType: entry.mimeType, role: entry.role, gzipBytes: gzLen });
    totalBytes += entry.bytes;
    totalGzipBytes += gzLen;
  }

  const runtimeManifest = {
    schemaVersion: 1,
    name: 'onnxruntime-web',
    version: PINNED_ORT_VERSION,
    license: 'MIT',
    notice: MIT_LICENSE_NOTICE,
    summary: {
      runtimeJsBytes,
      unpackedWasmBytes,
      totalBytes,
      totalGzipBytes,
      fileCount: staged.length
    },
    files: staged
  };

  if (!dryRun) {
    fs.writeFileSync(
      path.join(target, 'runtime-manifest.json'),
      JSON.stringify(runtimeManifest, null, 2) + '\n'
    );
  }

  return { targetDir: target, manifest: runtimeManifest, stagedFiles: staged };
}

/**
 * Stages an unapproved candidate model into an immutable same-origin hash path.
 */
function stageCandidateModel({
  modelPath,
  targetDir,
  urlPrefix = '/game/ai/',
  version = 'candidate-v1',
  deploymentStatus = 'RESEARCH',
  baseURL = 'https://game.example/',
  dryRun = false
} = {}) {
  if (deploymentStatus !== 'RESEARCH') {
    throw new Error('STAGE_MODEL: staging tool only allows deploymentStatus="RESEARCH"; public APPROVED requires separate manual signoff');
  }
  if (!modelPath) throw new Error('STAGE_MODEL: modelPath is required');
  if (!targetDir) throw new Error('STAGE_MODEL: targetDir is required');
  const target = safeStagingTarget(targetDir, 'staged-models');

  const absModel = path.resolve(modelPath);
  if (!fs.existsSync(absModel)) throw new Error(`STAGE_MODEL: model file not found: ${absModel}`);

  const raw = fs.readFileSync(absModel);
  if (raw.length < 1 || raw.length > MegaBotPack.MAX_BYTES) {
    throw new Error(`STAGE_MODEL: model size out of bounds (${raw.length} bytes)`);
  }

  const modelHash = sha256(raw);
  const gzLen = gzipBytes(raw);
  if (gzLen > MegaBotPack.MAX_COMPRESSED) {
    throw new Error(`STAGE_MODEL: compressed model size exceeds 5MB (${gzLen} bytes)`);
  }

  const normalizedPrefix = urlPrefix.endsWith('/') ? urlPrefix : urlPrefix + '/';
  const relativeURL = `${normalizedPrefix}${modelHash}.onnx`;

  const rawManifest = {
    schemaVersion: 1,
    version,
    ruleset: MegaBotContract.RULESET,
    encodingVersion: MegaBotPack.ENCODING,
    sha256: modelHash,
    bytes: raw.length,
    gzipBytes: gzLen,
    url: relativeURL,
    deploymentStatus
  };

  // Verifies with canonical MegaBotPack.manifest
  const verifiedManifest = MegaBotPack.manifest(rawManifest, baseURL);

  const destFile = path.join(target, `${modelHash}.onnx`);
  safeStagingFiles(target, [`${modelHash}.onnx`, `${modelHash}.manifest.json`]);

  if (!dryRun) {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(destFile, raw);
    fs.writeFileSync(
      path.join(target, `${modelHash}.manifest.json`),
      JSON.stringify(verifiedManifest, null, 2) + '\n'
    );
  }

  return {
    modelHash,
    stagedFile: destFile,
    manifest: verifiedManifest,
    metrics: {
      modelBytes: raw.length,
      gzipBytes: gzLen,
      compressionRatio: +(gzLen / raw.length).toFixed(4)
    }
  };
}

/**
 * In-memory sealed runtime entries for parent builder integration.
 * Performs zero disk writes. Strictly verifies known sealed files from sourceDir.
 * Returns array of { relativePath, bytesBuffer, bytes, sha256, mimeType, role, immutable, requiresWasmCSP }.
 */
function runtimeEntries(
  sourceDir = path.resolve('.artifacts/v51/ort/node_modules/onnxruntime-web/dist'),
  { includeWebGPU = true, targetPrefix = 'legacy-game/src/bot/ort-1.23.2/' } = {}
) {
  const source = path.resolve(sourceDir);
  if (!fs.existsSync(source)) {
    throw new Error(`RUNTIME_ENTRIES: source directory not found: ${source}`);
  }
  const lstat = fs.lstatSync(source);
  if (!lstat.isDirectory() || lstat.isSymbolicLink()) {
    throw new Error(`RUNTIME_ENTRIES: source must be an unlinked regular directory: ${source}`);
  }

  const selectedFiles = ['ort.wasm.min.js', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];
  if (includeWebGPU) {
    selectedFiles.push('ort.webgpu.min.js', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs');
  }

  const entries = [];
  const prefix = targetPrefix.endsWith('/') ? targetPrefix : targetPrefix + '/';

  for (const filename of selectedFiles) {
    const filePath = path.join(source, filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`RUNTIME_ENTRIES: missing required runtime file: ${filename}`);
    }
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`RUNTIME_ENTRIES: runtime file must be an unlinked regular file: ${filename}`);
    }

    const buf = fs.readFileSync(filePath);
    const expected = SEALED_RUNTIME_FILES[filename];
    if (!expected) {
      throw new Error(`RUNTIME_ENTRIES: unmanifested file rejected: ${filename}`);
    }
    if (buf.length !== expected.bytes) {
      throw new Error(`RUNTIME_ENTRIES: size mismatch for ${filename} (got ${buf.length}, expected ${expected.bytes})`);
    }
    const hash = sha256(buf);
    if (hash !== expected.sha256) {
      throw new Error(`RUNTIME_ENTRIES: hash mismatch for ${filename} (got ${hash}, expected ${expected.sha256})`);
    }

    entries.push({
      relativePath: `${prefix}${filename}`,
      bytesBuffer: buf,
      sha256: hash,
      bytes: buf.length,
      mimeType: expected.mimeType,
      role: expected.role,
      immutable: true,
      requiresWasmCSP: filename.endsWith('.wasm')
    });
  }

  entries.push(...legalEntries(prefix));

  return entries;
}

/**
 * In-memory model candidate entry and manifest for parent builder / config integration.
 * Performs zero disk writes. Enforces immutable hash naming and research-only deploymentStatus.
 */
function modelCandidateEntries({
  modelPath,
  version = 'candidate-v1',
  urlPrefix = '/game/ai/',
  baseURL = 'https://game.example/'
} = {}) {
  if (!modelPath) throw new Error('MODEL_ENTRIES: modelPath is required');
  const abs = path.resolve(modelPath);
  if (!fs.existsSync(abs)) throw new Error(`MODEL_ENTRIES: file not found: ${abs}`);
  const stat = fs.lstatSync(abs);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`MODEL_ENTRIES: model file must be an unlinked regular file: ${abs}`);
  }

  const raw = fs.readFileSync(abs);
  if (raw.length < 1 || raw.length > MegaBotPack.MAX_BYTES) {
    throw new Error(`MODEL_ENTRIES: model size out of bounds (${raw.length} bytes)`);
  }

  const hash = sha256(raw);
  const gzLen = gzipBytes(raw);
  if (gzLen > MegaBotPack.MAX_COMPRESSED) {
    throw new Error(`MODEL_ENTRIES: compressed model size exceeds 5MB (${gzLen} bytes)`);
  }

  const prefix = urlPrefix.endsWith('/') ? urlPrefix : urlPrefix + '/';
  const relativeURL = `${prefix}${hash}.onnx`;

  const rawManifest = {
    schemaVersion: 1,
    version,
    ruleset: MegaBotContract.RULESET,
    encodingVersion: MegaBotPack.ENCODING,
    sha256: hash,
    bytes: raw.length,
    gzipBytes: gzLen,
    url: relativeURL,
    deploymentStatus: 'RESEARCH'
  };

  const verifiedManifest = MegaBotPack.manifest(rawManifest, baseURL);

  return {
    modelHash: hash,
    relativePath: `${prefix.replace(/^\/+/, '')}${hash}.onnx`,
    bytesBuffer: raw,
    bytes: raw.length,
    gzipBytes: gzLen,
    sha256: hash,
    mimeType: 'application/octet-stream',
    manifest: verifiedManifest,
    researchCatalogEntry: Object.freeze({ ...verifiedManifest }),
    immutable: true
  };
}

/**
 * Builds entry descriptors for Parent's build-web / native manifest integration.
 * Does not mutate sealed outputs; provides verified inventory and MIME/CSP headers.
 */
function generateBuilderEntries({
  runtimeTargetDir,
  targetPrefix = 'legacy-game/src/bot/ort-1.23.2/'
} = {}) {
  return runtimeEntries(runtimeTargetDir, { targetPrefix });
}

/**
 * Builds a trusted research catalog array for application test/dev configuration.
 * Public APPROVED_CATALOG remains empty.
 */
function createResearchCatalog(manifestList = []) {
  const catalog = [];
  for (const item of manifestList) {
    if (!item || item.deploymentStatus !== 'RESEARCH') {
      throw new Error('CREATE_CATALOG: research catalog entries must have deploymentStatus="RESEARCH"');
    }
    catalog.push(Object.freeze({ ...item }));
  }
  return Object.freeze(catalog);
}

// CLI entrypoint
if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = name => {
    const idx = args.indexOf(name);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  };

  const command = args[0];
  if (command === 'verify') {
    const src = getArg('--source') || path.resolve('.artifacts/v51/ort/node_modules/onnxruntime-web/dist');
    const result = verifyRuntimeDist(src);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.valid ? 0 : 1);
  } else if (command === 'stage-runtime') {
    const src = getArg('--source') || path.resolve('.artifacts/v51/ort/node_modules/onnxruntime-web/dist');
    const dest = getArg('--target') || path.resolve('.artifacts/v51/staged-runtime/ort-1.23.2');
    const res = stageRuntime({ sourceDir: src, targetDir: dest });
    console.log(JSON.stringify(res.manifest, null, 2));
  } else if (command === 'stage-model') {
    const model = getArg('--model');
    const dest = getArg('--target') || path.resolve('.artifacts/v51/staged-models');
    const res = stageCandidateModel({ modelPath: model, targetDir: dest, deploymentStatus: 'RESEARCH' });
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log('Usage:');
    console.log('  node stage-ai-runtime.cjs verify [--source <dir>]');
    console.log('  node stage-ai-runtime.cjs stage-runtime --target <dir> [--source <dir>]');
    console.log('  node stage-ai-runtime.cjs stage-model --model <file> --target <dir> [--status RESEARCH]');
  }
}

module.exports = {
  PINNED_ORT_VERSION,
  MIT_LICENSE_NOTICE,
  SEALED_RUNTIME_FILES,
  SEALED_LEGAL_FILES,
  verifyRuntimeDist,
  stageRuntime,
  stageCandidateModel,
  runtimeEntries,
  modelCandidateEntries,
  generateBuilderEntries,
  createResearchCatalog
};
