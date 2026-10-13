'use strict';
/* training/bot/selfplay-anchored.cjs - anchored self-play generation for the RL loop.
 *
 * The multi-generation RL run (rl3) measured that REPLACING the training corpus with pure self-play
 * per generation DEGRADES the model (0.931 -> 0.394 -> 0.294 vs tacticalUCT): once the current model is
 * weaker than the strong-label corpus, the targets get weaker. The corrected loop keeps the strong-label
 * corpus in EVERY generation and only ADDS self-play from the current champion:
 *
 *   output = anchor rows (strong-search + external utttai + tactics)  ++  self-play rows (current champion)
 *
 * so the value/policy anchor never disappears. Usage:
 *   node selfplay-anchored.cjs --model <champion-export-dir> --anchor <anchor.jsonl> --output <shard.jsonl>
 *       [--games N --seed N --simulations N --budget-ms N] [--parent-sha <hex>]
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { selfPlay } = require('./selfplay.cjs');

function arg(flag, fallback) { const i = process.argv.indexOf(flag); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback; }

async function main() {
  const modelDir = arg('--model'); const anchor = arg('--anchor'); const output = arg('--output');
  if (!modelDir || !anchor || !output) throw Error('USAGE: selfplay-anchored.cjs --model <dir> --anchor <jsonl> --output <jsonl>');
  const tmp = output + '.selfplay';
  const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const anchorManifest = JSON.parse(fs.readFileSync(anchor + '.manifest.json', 'utf8'));
  // 1. self-play from the current champion
  const sp = await selfPlay({
    modelDir, output: tmp, games: Number(arg('--games', '160')), seed: Number(arg('--seed', '9100')),
    simulations: Number(arg('--simulations', '48')), budgetMs: Number(arg('--budget-ms', '300')),
    parentModelSha256: arg('--parent-sha', null),
  });
  // 2. concatenate anchor ++ self-play into the shard, streaming line by line (the anchor may be >1 GB)
  //    and recomputing the manifest hash over the joined bytes.
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const hash = crypto.createHash('sha256');
  const counts = { train: 0, validation: 0, holdout: 0, qualification: 0, external: 0 };
  let records = 0;
  const fd = fs.openSync(output, 'w');
  try {
    for (const src of [anchor, tmp]) {
      const data = fs.readFileSync(src);           // Buffer, not a string (avoids the length limit)
      let start = 0;
      for (let i = 0; i <= data.length; i++) {
        if (i === data.length || data[i] === 10) {
          if (i > start) {
            const line = data.subarray(start, i);
            fs.writeSync(fd, line); fs.writeSync(fd, '\n'); hash.update(line); hash.update('\n'); records++;
            const s = JSON.parse(line.toString()).split || JSON.parse(line.toString()).externalSplit || 'external';
            if (counts[s] !== undefined) counts[s]++;
          }
          start = i + 1;
        }
      }
    }
  } finally { fs.closeSync(fd); }
  const manifest = {
    schemaVersion: 1, records, sha256: hash.digest('hex'), counts, anchor: { path: anchor, sha256: anchorManifest.sha256, records: anchorManifest.records },
    selfPlay: { producer: sp.producer, parentModelSha256: sp.parentModelSha256, records: sp.records },
    trainingStatus: 'ANCHORED_SELF_PLAY', anchored: true,
    note: 'strong-label anchor corpus kept in the training mix; self-play added, never substituted',
  };
  fs.writeFileSync(output + '.manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  fs.unlinkSync(tmp); if (fs.existsSync(tmp + '.manifest.json')) fs.unlinkSync(tmp + '.manifest.json');
  console.log(JSON.stringify({ output, records, anchorRecords: anchorManifest.records, selfPlayRecords: sp.records, producer: sp.producer.version }, null, 2));
}

main().catch((err) => { console.error('SELFPLAY_ANCHORED_FAILED', err && err.message); process.exit(1); });
