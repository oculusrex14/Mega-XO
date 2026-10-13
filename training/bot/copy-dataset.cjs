'use strict';
// Copy a seed dataset (+ its manifest) into the operator's working shard path, so generation 1 of an
// RL run bootstraps from existing strong-search labels instead of weak self-play. The manifest is
// copied verbatim (its sha256 already matches the data), so validate-data.cjs and train.py accept it
// unchanged. Usage: node copy-dataset.cjs <seed.jsonl> <dest.jsonl>
const fs = require('node:fs');
const [seed, dest] = process.argv.slice(2);
if (!seed || !dest) { console.error('USAGE: copy-dataset.cjs <seed.jsonl> <dest.jsonl>'); process.exit(2); }
if (!fs.existsSync(seed)) { console.error('SEED_DATASET_MISSING: ' + seed); process.exit(1); }
if (!fs.existsSync(seed + '.manifest.json')) { console.error('SEED_MANIFEST_MISSING: ' + seed + '.manifest.json'); process.exit(1); }
fs.mkdirSync(require('node:path').dirname(dest), { recursive: true });
fs.copyFileSync(seed, dest);
fs.copyFileSync(seed + '.manifest.json', dest + '.manifest.json');
// Re-verify the hash relationship the downstream stages will assert, so a bad seed fails HERE.
const crypto = require('node:crypto');
const manifest = JSON.parse(fs.readFileSync(dest + '.manifest.json', 'utf8'));
const raw = fs.readFileSync(dest);
if (crypto.createHash('sha256').update(raw).digest('hex') !== manifest.sha256) { console.error('SEED_HASH_MISMATCH'); process.exit(1); }
console.log(JSON.stringify({ copied: dest, records: manifest.records, sha256: manifest.sha256 }));
