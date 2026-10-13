'use strict';
// Tiny throughput / latency probe for ONE OpenAI-compatible endpoint (research-only). V5.1.
//
// It uses the SAME prompt shape as the arena: a real mid-game Mega XOXO position rendered by
// `buildPrompt` from llm-arena.cjs, so the numbers correspond to what an arena move costs
// (prompt tokens, structured-move output length), not to a synthetic random payload.
//
// Reports per concurrency level: TTFT (mean/p50/p95), end-to-end latency, decode tok/s
// (derived: (completion_tokens-1)/decode time), aggregate output tok/s, and the share of
// responses that parsed into a legal canonical move. Everything is bounded by `--timeout-ms`.
//
// Usage:
//   node training/bot/llm-bench.cjs --endpoint http://127.0.0.1:8894 --model gemma-4-26b \
//        --concurrency 1,4 --requests 8 --max-tokens 64
//   node training/bot/llm-bench.cjs --endpoint ... --model ... --prompt-only
//
// Options: --endpoint --model --concurrency 1,4,16 --requests N --max-tokens N --timeout-ms N
//          --temperature T --ply N --reasoning-budget N --out FILE --label NAME --stream/--no-stream

const fs = require('node:fs');
const path = require('node:path');
const G = require('../../src/game.js');
const C = require('../../src/bot/contracts.js');
const A = require('./llm-arena.cjs');

function parseArgs(argv) {
  const opts = {
    concurrency: [1, 4], requests: 8, maxTokens: 64, timeoutMs: 60000, temperature: 0,
    ply: 8, reasoningBudget: 0, stream: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--endpoint') opts.endpoint = next();
    else if (arg === '--model') opts.model = next();
    else if (arg === '--concurrency') opts.concurrency = String(next()).split(',').map(Number).filter(n => n > 0);
    else if (arg === '--requests') opts.requests = Number(next());
    else if (arg === '--max-tokens') opts.maxTokens = Number(next());
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(next());
    else if (arg === '--temperature') opts.temperature = Number(next());
    else if (arg === '--ply') opts.ply = Number(next());
    else if (arg === '--reasoning-budget') opts.reasoningBudget = Number(next());
    else if (arg === '--label') opts.label = next();
    else if (arg === '--out') opts.out = next();
    else if (arg === '--extra-body') opts.extraBody = JSON.parse(next());
    else if (arg === '--no-think') opts.extraBody = { chat_template_kwargs: { enable_thinking: false } };
    else if (arg === '--no-stream') opts.stream = false;
    else if (arg === '--prompt-only') opts.promptOnly = true;
  }
  return opts;
}

/* A deterministic mid-game position: seeded random plies, exactly like the arena openings, so the
 * probe prompt is the same shape and size as a real arena query. */
function probeState(seed, ply) {
  const rng = C.seeded(seed);
  let state = G.create(seed % 2 ? 'O' : 'X');
  for (let i = 0; i < ply && !state.winner; i++) {
    const moves = G.legal(state);
    state = G.apply(state, moves[Math.floor(rng() * moves.length)]);
  }
  return state;
}

const percentile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
};
const mean = values => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);

async function runLevel({ endpoint, model, messages, concurrency, requests, maxTokens, timeoutMs, temperature, stream, state, extraBody = null }) {
  const results = [];
  let next = 0;
  const wallStart = Date.now();
  const worker = async () => {
    while (true) {
      const idx = next++;
      if (idx >= requests) return;
      const res = await A.streamChat({ endpoint, model, messages, temperature, maxTokens, timeoutMs, stream, extraBody, seed: 1234 + idx });
      const parsed = res.error ? { move: null, reason: res.error } : A.parseMove(res.content || res.reasoning || '');
      const legal = parsed.move ? G.legal(state).some(m => m.b === parsed.move.b && m.c === parsed.move.c) : false;
      results.push({
        idx, ttftMs: res.ttftMs, latencyMs: res.latencyMs,
        promptTokens: res.promptTokens ?? null, completionTokens: res.completionTokens ?? null,
        finishReason: res.finishReason ?? null, parse: parsed.reason, legal, error: res.error ?? null,
      });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = Date.now() - wallStart;
  const ok = results.filter(r => !r.error);
  const ttfts = ok.map(r => r.ttftMs).filter(Number.isFinite);
  const latencies = ok.map(r => r.latencyMs).filter(Number.isFinite);
  const decodeRates = ok.map(r => {
    if (!Number.isFinite(r.ttftMs) || !Number.isFinite(r.completionTokens) || r.completionTokens < 2) return null;
    const decodeMs = r.latencyMs - r.ttftMs;
    return decodeMs > 0 ? ((r.completionTokens - 1) / decodeMs) * 1000 : null;
  }).filter(Number.isFinite);
  const outTokens = ok.reduce((a, r) => a + (r.completionTokens || 0), 0);
  return {
    concurrency, requests, errors: results.length - ok.length,
    ttftMs: { n: ttfts.length, mean: mean(ttfts), p50: percentile(ttfts, 0.5), p95: percentile(ttfts, 0.95) },
    latencyMs: { n: latencies.length, mean: mean(latencies), p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    decodeTokPerSec: decodeRates.length ? Number((decodeRates.reduce((a, b) => a + b, 0) / decodeRates.length).toFixed(2)) : null,
    outputTokPerSec: wallMs > 0 ? Number((outTokens / (wallMs / 1000)).toFixed(2)) : null,
    wallMs, outputTokens: outTokens,
    legalMoveRate: ok.length ? Number((ok.filter(r => r.legal).length / ok.length).toFixed(3)) : null,
    errorSamples: [...new Set(results.filter(r => r.error).map(r => r.error))].slice(0, 3),
    promptTokensMean: ok.length ? Math.round(ok.reduce((a, r) => a + (r.promptTokens || 0), 0) / ok.length) : null,
    completionTokensMean: ok.length ? Math.round(outTokens / ok.length) : null,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.endpoint || !opts.model) throw Error('SPECIFY --endpoint and --model');
  const state = probeState(7788, opts.ply);
  const { system, user } = A.buildPrompt(state, { reasoningBudget: opts.reasoningBudget });
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  if (opts.promptOnly) {
    console.log(JSON.stringify({ promptChars: user.length, systemChars: system.length, legalMoves: G.legal(state).length, prompt: user }, null, 2));
    return;
  }
  let serveInfo = null;
  try { serveInfo = await A.listModels(opts.endpoint, 10000); } catch (e) { serveInfo = { error: String(e.message || e) }; }
  const report = {
    benchVersion: 'llm-bench-v1', promptVersion: A.PROMPT_VERSION, createdAt: new Date().toISOString(),
    endpoint: opts.endpoint, model: opts.model, label: opts.label || null, serveInfo,
    temperature: opts.temperature, maxTokens: opts.maxTokens, timeoutMs: opts.timeoutMs, stream: opts.stream, extraBody: opts.extraBody ?? null,
    promptShapedFrom: { seed: 7788, ply: opts.ply, moves: state.moves.length, legalMoves: G.legal(state).length },
    levels: [],
  };
  for (const concurrency of opts.concurrency) {
    report.levels.push(await runLevel({
      endpoint: opts.endpoint, model: opts.model, messages, concurrency, requests: opts.requests,
      maxTokens: opts.maxTokens, timeoutMs: opts.timeoutMs, temperature: opts.temperature, stream: opts.stream, state,
      extraBody: opts.extraBody ?? null,
    }));
  }
  if (opts.out) { fs.mkdirSync(path.dirname(opts.out), { recursive: true }); fs.writeFileSync(opts.out, JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify({ out: opts.out || null, endpoint: opts.endpoint, model: opts.model, levels: report.levels }, null, 2));
}

module.exports = { runLevel, probeState, parseArgs };

if (require.main === module) {
  main().catch(e => { console.error(JSON.stringify({ error: String(e.message || e), stack: e.stack })); process.exit(1); });
}
