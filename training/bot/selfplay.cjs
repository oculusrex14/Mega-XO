'use strict';
/* training/bot/selfplay.cjs - real neural self-play with an approved-research producer (WEB-AI-04/08).
 *
 * Cycle 1: generate a self-play shard whose moves come from a FROZEN research artifact (an ONNX model
 * directory) via the real PUCT producer (neural-search `choose` over onnxruntime-node). The shard's
 * manifest binds the producer kind, version and model hash, so the dataset is provably a function of
 * that artifact.
 *
 * Cycle 2: train a compact student on cycle 1's shard and re-run self-play USING the resulting
 * artifact, producing a shard whose `parentModelSha256` points at cycle 1's model. That chain is the
 * proof the loop actually consumes the previous cycle's research artifact rather than restarting.
 *
 * This is offline research tooling: no provider, no player inference, no publication.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

// Resolve the shared src/ modules relative to the repo, independent of cwd.
const ROOT = path.resolve(__dirname, '..', '..');
const G = require(path.join(ROOT, 'src', 'game.js'));
const C = require(path.join(ROOT, 'src', 'bot', 'contracts.js'));
const NS = require(path.join(ROOT, 'src', 'bot', 'neural-search.js'));
const Data = require(path.join(__dirname, 'generate.cjs'));
const League = require(path.join(__dirname, 'neural_league.cjs'));

function arg(flag, fallback) { const i = process.argv.indexOf(flag); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback; }

function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

/* Build a producer from a frozen ONNX artifact directory. `version` is the model hash prefix, so a shard
 * records exactly which artifact produced it. */
function onnxProducer(modelDir, { budgetMs = 300, simulations = 64, revision = null } = {}) {
  const modelPath = path.join(modelDir, fs.existsSync(path.join(modelDir, 'candidate-dynamic.onnx')) ? 'candidate-dynamic.onnx' : 'candidate.onnx');
  const infer = League.createOnnxInfer(modelPath);
  const modelHash = infer.hash;
  const producer = {
    version: `onnx-${modelHash.slice(0, 16)}`,
    modelHash,
    async choose(state, rng) {
      const res = await NS.choose(state, {
        infer: infer.infer, seed: Math.floor(rng() * 4294967296), budgetMs, simulations,
        modelHash, revision: revision === null ? state.moves.length : revision,
      });
      if (!res || !res.move) throw Error('PRODUCER_NO_MOVE');
      return { move: res.move, version: producer.version };
    },
  };
  return producer;
}

/* Run `games` real neural self-play games and write the shard + a bound manifest. */
async function selfPlay({ modelDir, output, games = 8, seed = 5000, simulations = 64, budgetMs = 300, parentModelSha256 = null }) {
  const producer = onnxProducer(modelDir, { budgetMs, simulations });
  const started = performance.now();
  const manifest = await Data.generateAsync({
    output, games, seed, simulations, neuralEngine: producer,
    trainingStatus: parentModelSha256 ? 'SELF_PLAY_FROM_RESEARCH_ARTIFACT' : 'SELF_PLAY_BOOTSTRAP',
    profile: { selfPlay: true },
  });
  const enriched = {
    ...manifest,
    producer: { kind: 'neural', version: producer.version, modelSha256: producer.modelHash, budgetMs, simulations },
    parentModelSha256,
    selfPlaySeconds: (performance.now() - started) / 1000,
  };
  fs.writeFileSync(output + '.manifest.json', JSON.stringify(enriched, null, 2) + '\n');
  return enriched;
}

async function main() {
  const modelDir = arg('--model', null);
  const output = arg('--output', null);
  if (!modelDir || !output) throw Error('USAGE: selfplay.cjs --model <dir> --output <jsonl> [--games N] [--seed N] [--simulations N] [--budget-ms N] [--parent-sha <hex>]');
  const result = await selfPlay({
    modelDir,
    output,
    games: Number(arg('--games', '8')),
    seed: Number(arg('--seed', '5000')),
    simulations: Number(arg('--simulations', '64')),
    budgetMs: Number(arg('--budget-ms', '300')),
    parentModelSha256: arg('--parent-sha', null),
  });
  console.log(JSON.stringify({ output, records: result.records, producer: result.producer, parentModelSha256: result.parentModelSha256, selfPlaySeconds: result.selfPlaySeconds }, null, 2));
}

module.exports = { onnxProducer, selfPlay };

if (require.main === module) {
  main().catch((err) => { console.error('SELFPLAY_FAILED', err && err.message); process.exit(1); });
}
