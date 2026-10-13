'use strict';
// Multi-LLM Mega XOXO arena (research-only, offline-capable). V5.1.
//
// The LLMs here are CANDIDATE-MOVE / DIVERSITY sources, never assumed ground-truth teachers:
// a language model being bigger does not make it a better Mega XOXO player. Every move any agent
// returns - LLM or classical - is revalidated against the canonical rules (`G.legal`/`G.apply`)
// before it touches the board, and every invalid/unparseable/illegal LLM response is recorded.
//
// What this file owns (single-owner, see docs/v5.1/research/MULTI-LLM-AND-RL-PROGRAMME.md):
//   * `renderState`/`buildPrompt`  - unambiguous canonical state rendering + strict move protocol.
//   * `streamChat`                 - minimal OpenAI-compatible chat client (SSE, TTFT + usage).
//   * `parseMove`                  - robust structured-move parsing (never trusted blindly).
//   * `makeAgent`                  - LLM / expert / mcts / neural / random agent abstraction.
//   * `playGame`/`runMatch`        - real complete games with seeded openings + side alternation.
//   * `writeJsonl`/`summarize`     - replayable records + per-model summary.
//
// Determinism: given (seed, temperature) the classical agents and the opening families are exactly
// reproducible. LLM sampling at temperature 0 is *not* guaranteed bit-identical by the server, so
// records store the raw response text and the seed used for each request.
//
// Usage:
//   node training/bot/llm-arena.cjs --selftest
//   node training/bot/llm-arena.cjs --a llm --a-endpoint http://127.0.0.1:8893 --a-model nemotron-3-5-lightning \
//        --b llm --b-endpoint http://127.0.0.1:8894 --b-model gemma-4-26b --games 2 --out .artifacts/v51/llm-arena
//   node training/bot/llm-arena.cjs --a llm --a-endpoint http://127.0.0.1:8894 --a-model gemma-4-26b --b expert --games 2
//
// Agent specs: random | expert[:<difficulty>] | mcts[:<sims>] | neural[:<modelDir>] | llm|<endpoint>|<model>[|<label>]
// CLI: --a/--b SPEC, --a-endpoint/--a-model/--a-label (and --b-*), --games N, --seed S,
//      --opening-plies N, --temperature T, --max-tokens N, --retries N, --timeout-ms N, --out DIR,
//      --model-dir PATH (neural), --mcts-simulations N, --reasoning-budget N, --no-think,
//      --extra-body JSON, --tag NAME, --no-stream.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const G = require('../../src/game.js');
const C = require('../../src/bot/contracts.js');
const S = require('../../src/bot/search.js');

const PROMPT_VERSION = 'arena-prompt-v1';
const ARENA_VERSION = 'llm-arena-v1';
const SCHEMA_VERSION = 1;
const RAW_LIMIT = 600;

/* ---------------------------------------------------------------------------------------------
 * Canonical, unambiguous state rendering. Everything the agent needs is on the page: whose turn,
 * which mini-board is forced, the 9x9 board, which mini-boards are already claimed, and the exact
 * legal-move list. The agent is never told an outcome and its text is never trusted.
 * -------------------------------------------------------------------------------------------*/
const MACRO_ROWS = [['0', '1', '2'], ['3', '4', '5'], ['6', '7', '8']];
const cell = v => (v === null || v === undefined ? '.' : v);

function renderMini(mini) {
  return mini.map((m, i) => `${i}:${m === null ? 'open' : m}`).join(' ');
}

function renderBoard(state) {
  const lines = [];
  lines.push('Board = 9 mini-boards (0..8) laid out like a tic-tac-toe grid:');
  lines.push('  0 1 2');
  lines.push('  3 4 5');
  lines.push('  6 7 8');
  lines.push('Each mini-board is itself 3x3 with cells 0..8 in the same layout:');
  lines.push('  0 1 2');
  lines.push('  3 4 5');
  lines.push('  6 7 8');
  lines.push('');
  for (const row of MACRO_ROWS) {
    for (let lr = 0; lr < 3; lr++) {
      const blocks = row.map(b => {
        const bi = Number(b);
        const tags = state.mini[bi];
        const cells = state.board[bi].slice(lr * 3, lr * 3 + 3).map(cell).join(' ');
        const tag = tags ? `[${tags}]` : '   ';
        return `m${bi}${tag} ${cells}`;
      });
      lines.push('  ' + blocks.join('  ||  '));
    }
    lines.push('  ' + '-'.repeat(46));
  }
  lines.push('');
  lines.push(`mini-board status: ${renderMini(state.mini)}`);
  return lines.join('\n');
}

function renderState(state) {
  const legal = G.legal(state);
  const required = state.required === null ? 'free (any open mini-board)' : `${state.required}${state.mini[state.required] ? ' (claimed -> route to any open mini-board)' : ''}`;
  const list = legal.map(m => `${m.b},${m.c}`).join(' ');
  return [
    '=== MEGA XOXO STATE ===',
    `turn: ${state.turn}`,
    `required mini-board b: ${required}`,
    `ply: ${state.moves.length}`,
    '',
    renderBoard(state),
    '',
    `legal moves (${legal.length}) as "b,c" pairs: ${list}`,
  ].join('\n');
}

const SYSTEM_PROMPT = [
  'You are a Mega XOXO (Ultimate Tic-Tac-Toe) move generator.',
  'Rules: players alternate; X moves first. Placing in cell c of mini-board b sends the opponent to',
  'mini-board c. If mini-board c is already claimed (won or drawn), the opponent may play in any open',
  'mini-board. Claiming a mini-board claims only that mini-board. The first player to claim three',
  'mini-boards in a row (rows, columns or diagonals of the 3x3 grid of mini-boards) wins.',
  'If a mini-board fills without a line, it is drawn and can be used as a routing destination.',
  '',
  'You MUST answer with exactly one JSON object and nothing else: {"b": <0-8>, "c": <0-8>}',
  'where b is the mini-board index and c is the cell index. b,c MUST be one of the listed legal moves.',
].join('\n');

function buildPrompt(state, { reasoningBudget = 0 } = {}) {
  const body = renderState(state);
  const hint = reasoningBudget > 0
    ? `You may use up to about ${reasoningBudget} tokens of reasoning, but your FINAL answer line must be exactly one JSON object: {"b":..,"c":..}`
    : 'No explanation. Answer with the single JSON object only.';
  return { system: SYSTEM_PROMPT, user: `${body}\n\nChoose your move. ${hint}` };
}

/* ---------------------------------------------------------------------------------------------
 * Minimal OpenAI-compatible chat client. SSE streaming gives us real TTFT and exact usage.
 * -------------------------------------------------------------------------------------------*/
function joinUrl(endpoint, suffix) {
  return endpoint.replace(/\/+$/, '') + suffix;
}

async function listModels(endpoint, timeoutMs = 10000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(joinUrl(endpoint, '/v1/models'), { signal: ac.signal });
    if (!res.ok) throw Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

function parseSseChunk(line) {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try { return JSON.parse(payload); } catch { return null; }
}

/* Returns {content, reasoning, ttftMs, latencyMs, promptTokens, completionTokens, finishReason}.
 * `extraBody` is merged verbatim (e.g. {chat_template_kwargs:{enable_thinking:false}} to silence a
 * hybrid reasoning model's thinking block on servers - SGLang/OpenAI-compatible - that accept it). */
async function streamChat({ endpoint, model, messages, temperature = 0, maxTokens = 512, timeoutMs = 120000, seed = null, stream = true, extraBody = null }) {
  const body = { model, messages, temperature, max_tokens: maxTokens, ...(extraBody || {}) };
  if (Number.isInteger(seed)) body.seed = seed;
  if (stream) { body.stream = true; body.stream_options = { include_usage: true }; }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  let content = '';
  let reasoning = '';
  let ttftMs = null;
  let promptTokens = null;
  let completionTokens = null;
  let finishReason = null;
  try {
    const res = await fetch(joinUrl(endpoint, '/v1/chat/completions'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    if (!stream) {
      const json = await res.json();
      const msg = json.choices?.[0]?.message || {};
      content = msg.content || '';
      reasoning = msg.reasoning_content || '';
      ttftMs = Date.now() - started;
      finishReason = json.choices?.[0]?.finish_reason || null;
      promptTokens = json.usage?.prompt_tokens ?? null;
      completionTokens = json.usage?.completion_tokens ?? null;
      return { content, reasoning, ttftMs, latencyMs: Date.now() - started, promptTokens, completionTokens, finishReason };
    }
    let buf = '';
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const evt = parseSseChunk(line);
        if (!evt) continue;
        const delta = evt.choices?.[0]?.delta || {};
        if (delta.content) { if (ttftMs === null) ttftMs = Date.now() - started; content += delta.content; }
        if (delta.reasoning_content) { if (ttftMs === null) ttftMs = Date.now() - started; reasoning += delta.reasoning_content; }
        if (evt.choices?.[0]?.finish_reason) finishReason = evt.choices[0].finish_reason;
        if (evt.usage) { promptTokens = evt.usage.prompt_tokens ?? promptTokens; completionTokens = evt.usage.completion_tokens ?? completionTokens; }
      }
    }
    return { content, reasoning, ttftMs, latencyMs: Date.now() - started, promptTokens, completionTokens, finishReason };
  } catch (e) {
    return { content, reasoning, ttftMs, latencyMs: Date.now() - started, promptTokens, completionTokens, finishReason, error: e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(e.message || e) };
  } finally { clearTimeout(timer); }
}

/* ---------------------------------------------------------------------------------------------
 * Robust structured-move parsing. Ordered from strictest to most permissive; every step is bounded
 * and none of them decides legality - `G.legal` does, afterwards.
 * -------------------------------------------------------------------------------------------*/
function normalizeMove(obj) {
  if (!obj) return null;
  const ints = v => (typeof v === 'number' && Number.isInteger(v)) ? v
    : (typeof v === 'string' && /^\d+$/.test(v.trim())) ? Number(v.trim()) : null;
  let b = ints(obj.b ?? obj.board ?? obj.mini ?? obj.micro ?? obj.B);
  let c = ints(obj.c ?? obj.cell ?? obj.C);
  if (b !== null && c !== null) return { b, c };
  if (Array.isArray(obj.move) && obj.move.length === 2) {
    const [x, y] = obj.move.map(ints);
    if (x !== null && y !== null) return { b: x, c: y };
  }
  return null;
}

function candidateObjects(text) {
  const out = [];
  const cleaned = String(text || '').replace(/```(?:json)?/gi, ' ').replace(/```/g, ' ');
  for (const m of cleaned.matchAll(/\{[^{}]*\}/g)) out.push(m[0]);
  return out;
}

function parseMove(text) {
  const raw = String(text || '');
  if (!raw.trim()) return { move: null, reason: 'empty-content' };
  // 1. whole payload is the object
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const m = normalizeMove(JSON.parse(trimmed));
    if (m) return { move: m, reason: 'json-whole' };
  } catch { /* fall through */ }
  // 2. embedded {...}: models emit the answer LAST (reasoning first), so scan in reverse.
  const candidates = candidateObjects(raw);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const m = normalizeMove(JSON.parse(candidates[i]));
      if (m) return { move: m, reason: 'json-embedded' };
    } catch { /* keep scanning */ }
  }
  // 3. bare pair forms: [b, c] or "b,c" / "b c"
  const arr = trimmed.match(/\[?\s*(\d)\s*,\s*(\d)\s*\]?/);
  if (arr) return { move: { b: Number(arr[1]), c: Number(arr[2]) }, reason: 'pair-scan' };
  // 4. labelled forms: b=1 c=2 / "b 1, c 2" / "b: 6 c: 0"
  const lab = trimmed.match(/\bb\s*[=:]?\s*(\d)\D{1,8}?c\s*[=:]?\s*(\d)\b/i);
  if (lab) return { move: { b: Number(lab[1]), c: Number(lab[2]) }, reason: 'labelled-scan' };
  // 5. word forms: "mini 1 cell 2" / "mini-board 4, cell 8"
  const word = trimmed.match(/mini(?:-?board)?\s*[=:]?\s*(\d)\D{1,12}?cell\s*[=:]?\s*(\d)/i);
  if (word) return { move: { b: Number(word[1]), c: Number(word[2]) }, reason: 'word-scan' };
  return { move: null, reason: 'unparseable' };
}

function truncate(text) {
  const t = String(text || '');
  return t.length > RAW_LIMIT ? t.slice(0, RAW_LIMIT) + `...[${t.length} chars]` : t;
}

/* ---------------------------------------------------------------------------------------------
 * Agents. Every agent exposes `choose(state, ctx) -> Promise<{move, meta}>`; `move` may be null when
 * the game is already over. The runner revalidates whatever comes back.
 * -------------------------------------------------------------------------------------------*/
function hashLabel(value) {
  return parseInt(crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8), 16);
}

function fallbackMove(state, rng) {
  const moves = G.legal(state);
  return moves.length ? moves[Math.floor(rng() * moves.length)] : null;
}

function makeRandomAgent({ label = 'random' } = {}) {
  return { kind: 'random', label, choose: async (state, ctx) => ({ move: fallbackMove(state, ctx.rng), meta: { source: 'random', fallback: false } }) };
}

function makeExpertAgent({ label = 'expert', difficulty = 'Expert', budgetMs = 320 } = {}) {
  return {
    kind: 'expert', label,
    choose: async (state, ctx) => {
      const started = Date.now();
      const res = S.choose(state, { difficulty, seed: ctx.seed, budgetMs, clock: () => performance.now() });
      return { move: res && res.move ? { b: res.move.b, c: res.move.c } : null, meta: { source: `expert:${difficulty}`, latencyMs: Date.now() - started, engineVersion: res?.diagnostics?.engineVersion ?? null } };
    },
  };
}

function makeMctsAgent({ label = 'mcts', simulations = 400, budgetMs = 320 } = {}) {
  return {
    kind: 'mcts', label,
    choose: async (state, ctx) => {
      const started = Date.now();
      const res = S.mcts(state, { seed: ctx.seed, simulations, budgetMs, clock: () => performance.now() });
      return { move: res && res.move ? { b: res.move.b, c: res.move.c } : null, meta: { source: `mcts:${simulations}sim`, latencyMs: Date.now() - started, visits: res?.diagnostics?.visits ?? null } };
    },
  };
}

/* Neural is optional and only constructed when a model dir is given; a missing runtime is a
 * recorded error, not a silent downgrade. */
async function makeNeuralAgent({ label, modelDir, budgetMs = 1500, simulations = 256 } = {}) {
  if (!modelDir) throw Error('NEURAL_MODEL_DIR_REQUIRED');
  const bytes = new Uint8Array(fs.readFileSync(modelDir));
  let ort;
  try { ort = require('onnxruntime-node'); } catch { throw Error('NEURAL_RUNTIME_MISSING: onnxruntime-node not installed'); }
  const O = require('../../src/bot/onnx.js');
  const NS = require('../../src/bot/neural-search.js');
  const modelHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const model = new O.Model(ort, bytes, { preferGPU: false });
  await model.initialize();
  return {
    kind: 'neural', label: label || `neural:${path.basename(modelDir)}`, modelHash, provider: model.provider,
    choose: async (state, ctx) => {
      const started = Date.now();
      const res = await NS.choose(state, { infer: s => model.infer(s), seed: ctx.seed, budgetMs, simulations, gameId: ctx.gameId, revision: state.moves.length, modelHash });
      return { move: res && res.move ? { b: res.move.b, c: res.move.c } : null, meta: { source: 'neural-puct', latencyMs: Date.now() - started, modelHash, provider: model.provider } };
    },
  };
}

function makeLlmAgent({ label, endpoint, model, temperature = 0, maxTokens = 512, retries = 2, timeoutMs = 120000, reasoningBudget = 0, stream = true, serveInfo = null, extraBody = null, modelRevision = null }) {
  return {
    kind: 'llm', label, endpoint, model, temperature, serveInfo, extraBody, modelRevision,
    async choose(state, ctx) {
      const { system, user } = buildPrompt(state, { reasoningBudget });
      const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
      const attempts = [];
      let move = null;
      let lastReason = 'no-attempt';
      for (let attempt = 0; attempt <= retries && !move; attempt++) {
        const res = await streamChat({
          endpoint, model, messages, temperature, maxTokens, timeoutMs, stream, extraBody,
          seed: (hashLabel(`${ctx.seed}:${ctx.gameId}:${state.moves.length}:${attempt}`) >>> 0),
        });
        const parsed = res.error ? { move: null, reason: `request-error: ${res.error}` } : parseMove(res.content || res.reasoning || '');
        let legal = false;
        if (parsed.move) legal = G.legal(state).some(m => m.b === parsed.move.b && m.c === parsed.move.c);
        const outcome = res.error ? 'request-error' : !parsed.move ? 'unparseable' : legal ? 'valid' : 'illegal-move';
        attempts.push({
          attempt, outcome, reason: parsed.move ? (legal ? parsed.reason : 'illegal-move') : parsed.reason,
          move: parsed.move, raw: truncate(res.content || res.reasoning), ttftMs: res.ttftMs,
          latencyMs: res.latencyMs, promptTokens: res.promptTokens ?? null, completionTokens: res.completionTokens ?? null,
          finishReason: res.finishReason ?? null, error: res.error ?? null,
        });
        if (parsed.move && legal) { move = parsed.move; lastReason = parsed.reason; break; }
        lastReason = parsed.move ? 'illegal-move' : parsed.reason;
        if (attempt < retries) {
          const why = parsed.move
            ? `"b":${parsed.move.b},"c":${parsed.move.c} is not a legal move in this position.`
            : `Your previous reply was not a parseable move (${parsed.reason}).`;
          messages.push({ role: 'assistant', content: truncate(res.content || res.reasoning || '(empty)') });
          messages.push({ role: 'user', content: `${why} Reply with exactly one JSON object {"b":<0-8>,"c":<0-8>} chosen from the legal list above, and nothing else.` });
        }
      }
      let fallback = false;
      if (!move) { move = fallbackMove(state, ctx.rng); fallback = true; }
      const used = attempts[attempts.length - 1] || {};
      const invalidAttempts = attempts.filter(a => a.outcome !== 'valid').length;
      const sum = key => attempts.reduce((acc, a) => acc + (Number.isFinite(a[key]) ? a[key] : 0), 0);
      const sumOrNull = key => attempts.some(a => Number.isFinite(a[key])) ? sum(key) : null;
      return {
        move,
        meta: {
          source: `llm:${model}`, attempts: attempts.length, invalidAttempts, retriesUsed: attempts.length - 1,
          fallback, finalReason: lastReason,
          ttftMs: used.ttftMs ?? null, latencyMs: sumOrNull('latencyMs'),
          promptTokens: sumOrNull('promptTokens'), completionTokens: sumOrNull('completionTokens'),
          attemptsDetail: attempts,
        },
      };
    },
  };
}

/* Spec grammar (no ambiguity with URLs):
 *   random | expert[:<difficulty>] | mcts[:<sims>] | neural[:<modelDir>] | llm|<endpoint>|<model>[|<label>]
 * plus explicit flags --a-endpoint/--a-model/--a-label (and --b-*), or the shared --endpoint/--model
 * which apply to any `llm` side that did not get its own. A bare `kind:arg` colon form is still
 * accepted for the URL-free kinds so `expert:Hard` works. */
function parseSpec(spec) {
  const raw = String(spec || '');
  if (!raw) throw Error('EMPTY_AGENT_SPEC');
  if (raw.includes('|')) {
    const [kind, ...args] = raw.split('|');
    return { kind, args };
  }
  const idx = raw.indexOf(':');
  if (idx < 0) return { kind: raw, args: [] };
  return { kind: raw.slice(0, idx), args: [raw.slice(idx + 1)] };
}

async function makeAgent(spec, opts = {}) {
  const parsed = typeof spec === 'string' ? parseSpec(spec) : spec;
  const kind = parsed.kind;
  if (kind === 'random') return makeRandomAgent({ label: parsed.label || 'random' });
  if (kind === 'expert') return makeExpertAgent({ label: parsed.label || parsed.args[0] || 'expert', difficulty: opts.difficulty || parsed.args[0] || 'Expert', budgetMs: opts.expertBudgetMs ?? 320 });
  if (kind === 'mcts') return makeMctsAgent({ label: parsed.label || 'mcts', simulations: opts.mctsSimulations ?? (parsed.args[0] ? Number(parsed.args[0]) : 400), budgetMs: opts.mctsBudgetMs ?? 320 });
  if (kind === 'neural') return makeNeuralAgent({ label: parsed.label || parsed.args[0] || null, modelDir: opts.modelDir || parsed.args[0], budgetMs: opts.neuralBudgetMs ?? 1500, simulations: opts.neuralSimulations ?? 256 });
  if (kind === 'llm') {
    const endpoint = parsed.endpoint || parsed.args[0];
    const model = parsed.model || parsed.args[1];
    if (!endpoint || !model) throw Error('LLM_SPEC_REQUIRES_ENDPOINT_AND_MODEL');
    let serveInfo = null;
    try { serveInfo = await listModels(endpoint, opts.timeoutMs ?? 10000); } catch (e) { serveInfo = { error: String(e.message || e) }; }
    return makeLlmAgent({ label: parsed.label || parsed.args[2] || `${model}@${endpoint}`, endpoint, model, temperature: opts.temperature, maxTokens: opts.maxTokens, retries: opts.retries, timeoutMs: opts.timeoutMs, reasoningBudget: opts.reasoningBudget, stream: opts.stream, serveInfo, extraBody: parsed.extraBody ?? opts.extraBody ?? null });
  }
  throw Error(`UNKNOWN_AGENT_KIND: ${kind}`);
}

/* ---------------------------------------------------------------------------------------------
 * Game loop. Openings are seeded 4-ply random openings exactly as training/bot/generate.cjs does,
 * so both sides see the same families and the arena is comparable to the training pipeline.
 * -------------------------------------------------------------------------------------------*/
function openingFamily(moves) {
  return moves.map(m => `${m.b}${m.c}`).join(',');
}

async function playGame({ matchId, gameIndex, seed, openingPlies, agents, temperature, maxTokens, retries, first = null }) {
  const rng = C.seeded(seed);
  // `first` lets the match runner control who opens (side alternation). Only when it is left
  // unset does the seed pick the starter - exactly like training/bot/generate.cjs.
  const starter = first || (seed % 2 ? 'O' : 'X');
  let state = G.create(starter);
  for (let i = 0; i < openingPlies && !state.winner; i++) {
    const moves = G.legal(state);
    state = G.apply(state, moves[Math.floor(rng() * moves.length)]);
  }
  const opening = state.moves.map(({ b, c }) => ({ b, c }));
  const gameId = `${matchId}-${gameIndex}`;
  const decisions = [];
  const errors = [];
  while (!state.winner) {
    const player = state.turn;
    const agent = player === 'X' ? agents.X : agents.O;
    const legalBefore = G.legal(state);
    let out;
    try {
      out = await agent.choose(state, { rng, seed: seed + state.moves.length * 7919, gameId, revision: state.moves.length });
    } catch (e) {
      errors.push({ ply: state.moves.length, agent: agent.label, error: String(e.message || e) });
      out = { move: null, meta: { source: agent.kind, fallback: true, error: String(e.message || e) } };
    }
    let move = out.move;
    let ruleViolation = false;
    if (!move || !legalBefore.some(m => m.b === move.b && m.c === move.c)) {
      ruleViolation = Boolean(move);
      move = fallbackMove(state, rng);
      out.meta = { ...out.meta, fallback: true, ruleViolation };
    }
    const { attemptsDetail, ...flat } = out.meta || {};
    const record = {
      ply: state.moves.length, player, agent: agent.label, kind: agent.kind, move: { b: move.b, c: move.c },
      legalMoves: legalBefore.length, ruleViolation,
      attemptsDetail: attemptsDetail || null, ...flat,
    };
    decisions.push(record);
    state = G.apply(state, move);
  }
  return {
    schemaVersion: SCHEMA_VERSION, arenaVersion: ARENA_VERSION, promptVersion: PROMPT_VERSION,
    gameId, matchId, gameIndex, seed, first: starter, openingPlies, opening, openingFamily: openingFamily(opening),
    agents: {
      X: { kind: agents.X.kind, label: agents.X.label, model: agents.X.model ?? null, endpoint: agents.X.endpoint ?? null, modelRevision: agents.X.modelRevision ?? null, serveInfo: agents.X.serveInfo ?? null },
      O: { kind: agents.O.kind, label: agents.O.label, model: agents.O.model ?? null, endpoint: agents.O.endpoint ?? null, modelRevision: agents.O.modelRevision ?? null, serveInfo: agents.O.serveInfo ?? null },
    },
    temperature, maxTokens, retries,
    moves: state.moves, winner: state.winner, winLine: state.line, decisions, errors,
  };
}

function pct(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function summarize(records, meta) {
  const perAgent = new Map();
  const touch = label => {
    if (!perAgent.has(label)) perAgent.set(label, {
      label, kind: null, model: null, endpoint: null, games: 0, wins: 0, losses: 0, draws: 0, asX: 0, asO: 0, started: 0,
      decisions: 0, fallbacks: 0, invalidResponses: 0, retriesUsed: 0, ruleViolations: 0, errors: 0,
      latencies: [], ttfts: [], promptTokens: 0, completionTokens: 0, legal: 0,
    });
    return perAgent.get(label);
  };
  for (const rec of records) {
    for (const [side, info] of Object.entries(rec.agents)) {
      const a = touch(info.label);
      a.kind = info.kind; a.model = info.model; a.endpoint = info.endpoint;
      a.games++;
      if (side === 'X') a.asX++; else a.asO++;
      if (rec.first === side) a.started++;
      if (rec.winner === 'DRAW') a.draws++;
      else if (rec.winner === side) a.wins++;
      else a.losses++;
    }
    for (const d of rec.decisions) {
      const a = touch(d.agent);
      a.decisions++; a.legal++;
      if (d.fallback) a.fallbacks++;
      if (d.ruleViolation) a.ruleViolations++;
      if (d.retriesUsed) a.retriesUsed += d.retriesUsed;
      if (d.invalidAttempts) a.invalidResponses += d.invalidAttempts;
      if (Number.isFinite(d.latencyMs)) a.latencies.push(d.latencyMs);
      if (Number.isFinite(d.ttftMs)) a.ttfts.push(d.ttftMs);
      if (Number.isFinite(d.promptTokens)) a.promptTokens += d.promptTokens;
      if (Number.isFinite(d.completionTokens)) a.completionTokens += d.completionTokens;
    }
    for (const e of rec.errors) touch(e.agent).errors++;
  }
  const agents = [...perAgent.values()].map(a => ({
    label: a.label, kind: a.kind, model: a.model, endpoint: a.endpoint,
    games: a.games, wins: a.wins, losses: a.losses, draws: a.draws, asX: a.asX, asO: a.asO, started: a.started,
    decisions: a.decisions, invalidResponses: a.invalidResponses, retriesUsed: a.retriesUsed,
    fallbacks: a.fallbacks, ruleViolations: a.ruleViolations, errors: a.errors,
    latencyMs: { n: a.latencies.length, mean: a.latencies.length ? Math.round(a.latencies.reduce((x, y) => x + y, 0) / a.latencies.length) : null, p50: pct(a.latencies, 0.5), p95: pct(a.latencies, 0.95) },
    ttftMs: { n: a.ttfts.length, mean: a.ttfts.length ? Math.round(a.ttfts.reduce((x, y) => x + y, 0) / a.ttfts.length) : null, p50: pct(a.ttfts, 0.5), p95: pct(a.ttfts, 0.95) },
    promptTokens: a.promptTokens, completionTokens: a.completionTokens,
  }));
  return { ...meta, games: records.length, agents, outcomes: records.map(r => ({ gameId: r.gameId, winner: r.winner, moves: r.moves.length, openingFamily: r.openingFamily })) };
}

function writeJsonl(records, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

/* ---------------------------------------------------------------------------------------------
 * Match runner: side alternation (every pairing played both first-player ways).
 * -------------------------------------------------------------------------------------------*/
async function runMatch({ a, b, games = 2, seed = 7001, openingPlies = 4, temperature = 0, maxTokens = 512, retries = 2, matchId = null, onGame = null }) {
  const records = [];
  const errors = [];
  const id = matchId || `${a.label}-vs-${b.label}`;
  for (let i = 0; i < games; i++) {
    // Side alternation: A takes the X seat in even games, B takes it in odd games. X ALWAYS moves
    // first under the canonical rules, so who opens is controlled purely by the seat swap.
    const aFirst = i % 2 === 0;
    const agents = aFirst ? { X: a, O: b } : { X: b, O: a };
    const first = 'X';
    try {
      const rec = await playGame({ matchId: id, gameIndex: i, seed: seed + i * 104729, openingPlies, agents, temperature, maxTokens, retries, first });
      records.push(rec);
      if (onGame) onGame(rec);
    } catch (e) {
      errors.push({ gameIndex: i, error: String(e.message || e) });
    }
  }
  return { matchId: id, a: a.label, b: b.label, records, errors };
}

/* ---------------------------------------------------------------------------------------------
 * Self-test: random-vs-random and expert-vs-random, no LLM needed. Must finish rules-legally.
 * -------------------------------------------------------------------------------------------*/
async function selftest() {
  const out = { arenaVersion: ARENA_VERSION, promptVersion: PROMPT_VERSION, checks: [] };
  const random = makeRandomAgent({ label: 'random' });
  const expert = makeExpertAgent({ label: 'expert', budgetMs: 320 });
  for (const [name, x, o] of [['random-vs-random', random, random], ['expert-vs-random', expert, random]]) {
    const rec = await playGame({ matchId: 'selftest', gameIndex: 0, seed: 4242, openingPlies: 4, agents: { X: x, O: o }, temperature: 0, maxTokens: 0, retries: 0 });
    // Replay the record through the canonical rules as an independent legality proof.
    let replay = G.create(rec.first);
    let ok = true;
    for (const m of rec.moves) {
      if (!G.legal(replay).some(l => l.b === m.b && l.c === m.c)) { ok = false; break; }
      replay = G.apply(replay, { b: m.b, c: m.c });
    }
    const checks = {
      name, moves: rec.moves.length, winner: rec.winner, replayWinner: replay.winner,
      replayLegal: ok, agrees: replay.winner === rec.winner, fallbacks: rec.decisions.filter(d => d.fallback).length,
    };
    out.checks.push(checks);
    if (!ok || !checks.agrees || rec.winner === null) throw Error(`SELFTEST_FAILED: ${name}`);
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------
 * CLI
 * -------------------------------------------------------------------------------------------*/
function parseArgs(argv) {
  const opts = { games: 2, seed: 7001, openingPlies: 4, temperature: 0, maxTokens: 512, retries: 2, timeoutMs: 120000, out: '.artifacts/v51/llm-arena', stream: true, reasoningBudget: 0, mctsSimulations: 400 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--selftest') opts.selftest = true;
    else if (arg === '--no-stream') opts.stream = false;
    else if (arg === '--a') opts.a = next();
    else if (arg === '--b') opts.b = next();
    else if (arg === '--endpoint') opts.endpoint = next();
    else if (arg === '--model') opts.model = next();
    else if (arg === '--a-endpoint') opts.aEndpoint = next();
    else if (arg === '--a-model') opts.aModel = next();
    else if (arg === '--a-label') opts.aLabel = next();
    else if (arg === '--b-endpoint') opts.bEndpoint = next();
    else if (arg === '--b-model') opts.bModel = next();
    else if (arg === '--b-label') opts.bLabel = next();
    else if (arg === '--games') opts.games = Number(next());
    else if (arg === '--seed') opts.seed = Number(next());
    else if (arg === '--opening-plies') opts.openingPlies = Number(next());
    else if (arg === '--temperature') opts.temperature = Number(next());
    else if (arg === '--max-tokens') opts.maxTokens = Number(next());
    else if (arg === '--reasoning-budget') opts.reasoningBudget = Number(next());
    else if (arg === '--retries') opts.retries = Number(next());
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(next());
    else if (arg === '--mcts-simulations') opts.mctsSimulations = Number(next());
    else if (arg === '--extra-body') opts.extraBody = JSON.parse(next());
    else if (arg === '--no-think') opts.extraBody = { chat_template_kwargs: { enable_thinking: false } };
    else if (arg === '--model-dir') opts.modelDir = next();
    else if (arg === '--out') opts.out = next();
    else if (arg === '--tag') opts.tag = next();
  }
  return opts;
}

/* Turn one CLI side into a full spec object, merging the side flags with the shared --endpoint/--model. */
function sideSpec({ kind, endpoint, model, label, sharedEndpoint, sharedModel, extraBody }) {
  const parsed = parseSpec(kind || 'random');
  const isLlm = parsed.kind === 'llm';
  return {
    kind: parsed.kind,
    args: parsed.args,
    endpoint: endpoint || parsed.args[0] || (isLlm ? sharedEndpoint : undefined),
    model: model || parsed.args[1] || (isLlm ? sharedModel : undefined),
    label: label || (isLlm ? `${model || parsed.args[1] || sharedModel || 'llm'}@${endpoint || parsed.args[0] || sharedEndpoint || 'endpoint'}` : undefined),
    extraBody,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selftest) {
    const result = await selftest();
    console.log(JSON.stringify(result, null, 2));
    const dir = path.join(opts.out, 'selftest');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'selftest.json'), JSON.stringify(result, null, 2));
    return;
  }
  if (!opts.a || !opts.b) throw Error('SPECIFY --a and --b agent specs, or --selftest');
  const agentOpts = {
    temperature: opts.temperature, maxTokens: opts.maxTokens, retries: opts.retries, timeoutMs: opts.timeoutMs,
    reasoningBudget: opts.reasoningBudget, stream: opts.stream, modelDir: opts.modelDir,
    mctsSimulations: opts.mctsSimulations,
  };
  const a = await makeAgent(sideSpec({ kind: opts.a, endpoint: opts.aEndpoint, model: opts.aModel, label: opts.aLabel, sharedEndpoint: opts.endpoint, sharedModel: opts.model, extraBody: opts.extraBody }), agentOpts);
  const b = await makeAgent(sideSpec({ kind: opts.b, endpoint: opts.bEndpoint, model: opts.bModel, label: opts.bLabel, sharedEndpoint: opts.endpoint, sharedModel: opts.model, extraBody: opts.extraBody }), agentOpts);
  const tag = opts.tag || `${a.label}-vs-${b.label}`.replace(/[^a-zA-Z0-9_.-]+/g, '_');
  const match = await runMatch({ a, b, games: opts.games, seed: opts.seed, openingPlies: opts.openingPlies, temperature: opts.temperature, maxTokens: opts.maxTokens, retries: opts.retries, matchId: tag });
  const meta = {
    arenaVersion: ARENA_VERSION, promptVersion: PROMPT_VERSION, seed: opts.seed, openingPlies: opts.openingPlies,
    temperature: opts.temperature, maxTokens: opts.maxTokens, retries: opts.retries, reasoningBudget: opts.reasoningBudget,
    stream: opts.stream, createdAt: new Date().toISOString(),
    agentsRequested: { a: opts.a, b: opts.b },
    agentIdentity: {
      a: { kind: a.kind, label: a.label, model: a.model ?? null, endpoint: a.endpoint ?? null, modelRevision: a.modelRevision ?? null },
      b: { kind: b.kind, label: b.label, model: b.model ?? null, endpoint: b.endpoint ?? null, modelRevision: b.modelRevision ?? null },
    },
    servedModels: { a: a.serveInfo ?? null, b: b.serveInfo ?? null },
    matchErrors: match.errors,
  };
  fs.mkdirSync(opts.out, { recursive: true });
  const jsonl = writeJsonl(match.records, path.join(opts.out, `${tag}.jsonl`));
  const summary = summarize(match.records, meta);
  const summaryFile = path.join(opts.out, `${tag}.summary.json`);
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ records: jsonl, summary: summaryFile, games: match.records.length, outcomes: summary.outcomes, matchErrors: match.errors }, null, 2));
}

module.exports = {
  ARENA_VERSION, PROMPT_VERSION, SCHEMA_VERSION,
  renderState, renderBoard, buildPrompt, SYSTEM_PROMPT,
  streamChat, listModels, joinUrl,
  parseMove, normalizeMove, truncate,
  makeAgent, makeRandomAgent, makeExpertAgent, makeMctsAgent, makeNeuralAgent, makeLlmAgent, parseSpec, sideSpec,
  playGame, runMatch, selftest, summarize, writeJsonl, pct, fallbackMove, hashLabel,
};

if (require.main === module) {
  main().catch(e => { console.error(JSON.stringify({ error: String(e.message || e), stack: e.stack })); process.exit(1); });
}
