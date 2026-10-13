# Multi-LLM Mega XOXO arena — pilot (V5.1, research-only)

Owner direction: an extremely strong, lightweight, primarily client-side Mega XOXO bot discovered by
rigorous research, with the LLM simulation arena as a candidate-move / diversity / hard-position
source checked against strong search. **The LLMs are candidate generators, not assumed ground-truth
teachers: a bigger model is not assumed to be a better player.** This document is the honest record
of the first pilot.

Status labels: **implemented · locally-tested** (selftest + all three pilot matches below) ·
**staging-verified** (endpoints reached, records written) — nothing here is device-verified on a
product client, and nothing here enables anything in production or the model catalog.

Artifacts:
- `training/bot/llm-arena.cjs` — arena, agent abstraction, strict structured-move protocol, records.
- `training/bot/llm-bench.cjs` — single-endpoint throughput/latency probe (same prompt shape).
- Raw records: `.artifacts/v51/llm-arena/*.jsonl`, summaries `*.summary.json`, benches `bench-*.json`.

---

## 1. What the arena does (and what it deliberately does not)

- Renders the canonical state unambiguously: turn, forced `required` mini-board (or "free"), the
  9x9 board with claimed mini-boards tagged, and the exact legal-move list as `b,c` pairs.
- Requires a single `{b,c}` JSON move. Parsing is robust and ordered (whole-payload JSON, **last**
  embedded `{...}` because reasoning models emit the answer last, bare pairs, `b=..,c=..`, word
  forms); an unparseable or illegal reply is **recorded** and retried up to `--retries` times with
  the failure appended to the conversation, then a deterministic seeded legal fallback is played.
- **Every** returned move is revalidated with `G.legal(state)` before `G.apply`; the recorder counts
  invalid/unparseable/illegal responses, retries, fallbacks and rule violations per agent. The
  model's own text about legality or outcome is never used for anything.
- Agent kinds: `llm` (OpenAI-compatible chat), `expert` (`S.choose` difficulty Expert),
  `mcts` (`S.mcts`), `random`, and `neural` (`src/bot/onnx.js` + `src/bot/neural-search.js`, only
  constructed when `--model-dir` is passed; a missing runtime/model is a **recorded error**, not a
  silent downgrade).
- Matchups: LLM-vs-LLM, LLM-vs-Expert, LLM-vs-MCTS, each with side alternation (A takes the X seat
  in even games, B in odd games; X always moves first under the canonical rules) and a seeded 4-ply
  random opening family, exactly as `training/bot/generate.cjs` does.
- Records are complete and replayable: full move list, per-decision data (legal-move count, the raw
  truncated response, parse outcome, TTFT/latency, tokens, finish reason), per-agent summary
  (invalid/retry counts, latency mean/p50/p95, TTFT, tokens), and the run metadata (model ids,
  prompt version, seed, temperature, `max_tokens`, retries, served-model listing, `modelRevision`
  when the caller supplies one).

Determinism: given `(seed, temperature)` the classical agents and opening families are exactly
reproducible. LLM sampling at `temperature 0` is **not** guaranteed bit-identical by the server, so
records store the raw response text and the per-request seed.

## 2. Self-test (no LLM required) — pass

```
$ node training/bot/llm-arena.cjs --selftest
```

Both games finish with a rules-legal result, independently replayed through `G.legal`/`G.apply`:

| check | moves | winner | replay legal | replay winner == recorded | fallbacks |
| --- | --- | --- | --- | --- | --- |
| `random-vs-random` | 64 | O | yes | yes | 0 |
| `expert-vs-random` | 35 | X | yes | yes | 0 |

## 3. Endpoints and how the pilot reached them

Both DGX1 SGLang servers were **pre-existing and left read-only** (they were not stopped or
restarted, per the ownership contract):

```
$ ssh dgx-ts 'hostname; docker ps --format "{{.Names}} {{.Image}}"'
aitopatom-a531
nemotron-3-5-lightning-sglang  lmsysorg/sglang:dev-nemotron3-5-lightning   # :8893
gemma-4-26b-sglang             lmsysorg/sglang:latest                      # :8894
```

There is **no `node` on DGX1** (`bash: node: command not found`), so the arena runs on this Mac and
reaches the servers through an SSH tunnel (`curl` on the box and `fetch` over the tunnel hit the
same loopback servers):

```
$ ssh -N -L 18893:127.0.0.1:8893 -L 18894:127.0.0.1:8894 dgx-ts
$ curl -s http://127.0.0.1:18894/v1/models
{"object":"list","data":[{"id":"gemma-4-26b",...}]}
$ curl -s http://127.0.0.1:18893/v1/models
{"object":"list","data":[{"id":"nemotron-3-5-lightning",...,"max_model_len":1048576}]}
```

**Measured model behaviour that shaped the protocol (Nemotron is a hybrid reasoning model).** With
its default thinking mode the model emits a long `reasoning_content` block; with a 128-token budget
it never reached the answer (`finish_reason: "length"`, `content: ""`), so the bench's
`legalMoveRate` was 0.08 then 0.0. Two working levers were measured directly on the box:

```
$ ssh dgx-ts 'curl -s http://127.0.0.1:8893/v1/chat/completions -H "Content-Type: application/json" \
  -d "{\"model\":\"nemotron-3-5-lightning\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\
\"max_tokens\":16,\"chat_template_kwargs\":{\"enable_thinking\":false}}"'
→ content: "Hi there! How can I help you today?", reasoning_content: null
```

`chat_template_kwargs:{enable_thinking:false}` disables thinking entirely; a `/no_think` system turn
also works (~1.0k-token thinking → correct one-line answer in ~8 s). The arena exposes both as
`--no-think` / `--extra-body '{"chat_template_kwargs":{"enable_thinking":false}}'`. Every pilot
Nemotron game below used `enable_thinking:false`. The Gemma server ignores the same extra field
without error (verified with a live call).

## 4. PILOT — real games on DGX1

All games used the canonical rules, a seeded 4-ply opening, `temperature 0`, side alternation, and
per-move rule validation. Every game completed and is replayable from its `.jsonl`.

### 4a. LLM vs LLM

```
$ node training/bot/llm-arena.cjs \
    --a llm --a-endpoint http://127.0.0.1:18893 --a-model nemotron-3-5-lightning --a-label nemotron-3-5-lightning \
    --b llm --b-endpoint http://127.0.0.1:18894 --b-model gemma-4-26b --b-label gemma-4-26b \
    --games 2 --seed 9100 --max-tokens 512 --retries 1 --no-think --timeout-ms 180000 \
    --tag nemotron-vs-gemma --out .artifacts/v51/llm-arena
```

| game | X seat | winner | plies | opening family |
| --- | --- | --- | --- | --- |
| `nemotron-vs-gemma-0` | gemma-4-26b | X (gemma) | 55 | 43,36,67,72 |
| `nemotron-vs-gemma-1` | nemotron-3-5-lightning | X (nemotron) | 39 | 71,15,50,07 |

| agent | W/L/D | X/O seats | decisions | invalid responses | retries | fallbacks | violations | latency mean/p50/p95 (ms) | TTFT mean (ms) | prompt tok | completion tok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| nemotron-3-5-lightning | 1/1/0 | 1/1 | 43 | 3 | 2 | 1 | 0 | 347/343/455 | 138 | 31 571 | 585 |
| gemma-4-26b | 1/1/0 | 1/1 | 43 | 11 | 11 | 0 | 0 | 619/514/1042 | 169 | 40 318 | 702 |

The result is perfectly mirrored: **each model won exactly the game in which it held the X seat**
(X moves first). That is a first-move-advantage signal from 2 games, not a strength ranking between
the models. Every invalid response for both models was **well-formed JSON** (e.g. the raw
`{"b": 2, "c": 4}`) that was simply **not legal in that position** — the failure mode is rule
comprehension (respecting the `required` mini-board), never formatting. Nemotron's single fallback
in game 0 is the seeded-fallback path firing once in a real game.

### 4b. LLM vs Expert (`S.choose` Expert, 320 ms budget)

```
$ node training/bot/llm-arena.cjs --a llm --a-endpoint http://127.0.0.1:18894 --a-model gemma-4-26b --a-label gemma-4-26b \
    --b expert --games 2 --seed 9001 --max-tokens 64 --retries 1 --tag gemma-vs-expert --out .artifacts/v51/llm-arena
$ node training/bot/llm-arena.cjs --a llm --a-endpoint http://127.0.0.1:18893 --a-model nemotron-3-5-lightning --a-label nemotron-3-5-lightning \
    --b expert --games 2 --seed 9200 --max-tokens 512 --retries 1 --no-think --timeout-ms 180000 \
    --tag nemotron-vs-expert --out .artifacts/v51/llm-arena
```

| game | X seat held by | winner | plies | opening family |
| --- | --- | --- | --- | --- |
| `gemma-vs-expert-0` | gemma-4-26b | expert (O) | 32 | 77,73,34,43 |
| `gemma-vs-expert-1` | expert | expert | 25 | 04,41,16,68 |
| `nemotron-vs-expert-0` | nemotron-3-5-lightning | expert (O) | 26 | 78,82,23,38 |
| `nemotron-vs-expert-1` | expert | expert | 33 | 31,16,63,33 |

| pairing | agent | W/L/D | X/O seats | decisions | invalid | retries | fallbacks | violations | latency mean/p50/p95 (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemma vs expert | gemma-4-26b | 0/2/0 | 1/1 | 24 | 2 | 2 | 0 | 0 | 566/533/906 |
| gemma vs expert | expert | 2/0/0 | 1/1 | 25 | 0 | 0 | 0 | 0 | 294/320/320 |
| nemotron vs expert | nemotron-3-5-lightning | 0/2/0 | 1/1 | 25 | 0 | 0 | 0 | 0 | 361/369/489 |
| nemotron vs expert | expert | 2/0/0 | 1/1 | 26 | 0 | 0 | 0 | 0 | 295/320/321 |

Both LLMs lost **0–2** to Expert, and Expert won from both seats (as O against gemma's and
nemotron's X, and as X in the second game of each pairing). Nemotron recorded **0** invalid
responses against Expert; Gemma recorded 2. Zero per-move rule violations for any LLM. Two games
per pairing is far too few to separate the models, but the direction (search beats one-shot LLM
move choice at this budget) is consistent across both models and both seats.

### 4c. Throughput / latency probe (same prompt shape)

```
$ node training/bot/llm-bench.cjs --endpoint http://127.0.0.1:18894 --model gemma-4-26b \
    --concurrency 1,4 --requests 12 --max-tokens 64 --out .artifacts/v51/llm-arena/bench-gemma.json
$ node training/bot/llm-bench.cjs --endpoint http://127.0.0.1:18893 --model nemotron-3-5-lightning \
    --concurrency 1,4 --requests 12 --max-tokens 64 --no-think --out .artifacts/v51/llm-arena/bench-nemotron-nothink.json
```

Prompt is a real mid-game position from `buildPrompt` (~660–680 prompt tokens, 12 legal moves).
`decode tok/s` is derived as `(completion_tokens-1)/(latency-TTFT)`.

| model | max_tokens | thinking | concurrency | TTFT p50/p95 (ms) | latency mean (ms) | decode tok/s | output tok/s | legal-move rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemma-4-26b | 64 | n/a | 1 | 67/244 | 412 | 39.4 | 31.6 | 1.00 |
| gemma-4-26b | 64 | n/a | 4 | 91/114 | 428 | 36.2 | 117.1 | 1.00 |
| nemotron (default) | 128 | on | 1 | 72/288 | 2008 | 66.3 | 63.8 | 0.08 |
| nemotron (default) | 128 | on | 4 | 144/202 | 2428 | 56.0 | 210.8 | 0.00 |
| nemotron | 64 | **off** | 1 | 70/79 | 260 | 63.8 | 50.1 | 1.00 |
| nemotron | 64 | **off** | 4 | 151/182 | 351 | 61.2 | 147.5 | 1.00 |

The raw-decode rate of Nemotron is ~1.6× Gemma's, but **with thinking on its usable move latency is
~2.0 s versus 0.41 s for Gemma** — the reasoning block, not decode speed, dominates. Turning
thinking off makes Nemotron both correct (legal-move rate 1.00) and the faster of the two at
concurrency 1 (260 ms vs 412 ms).

## 5. Honest limitations (what was not run or cannot be concluded)

- **Sample size is tiny.** 6 real games total (2 LLM-vs-LLM, 4 LLM-vs-Expert). No MCTS pairing was
  run in the pilot; the `mcts` agent is exercised only in local quick checks. Per-model win/loss
  numbers at this size are anecdotes, not a ranking.
- **First-move effect dominates the tiny sample.** Every LLM game was won by the player holding the
  X seat (both LLM-vs-LLM games and both LLM-vs-Expert games Expert took X in). Six games cannot
  separate "X is strong here" from "which model is better", so no model ranking is claimed.
  Meaningful comparison needs ≥ tens of games per pairing with both seats.
- **Only DGX1 was used.** The DGX2 → `10.10.10.1:8893|8894` path was **not** exercised; no other
  endpoint/model (Qwen3.8, Ornith, GLM) was played.
- **`neural` agent unrun.** `onnxruntime-node` is not installed in this checkout
  (`require('onnxruntime-node')` → `MODULE_NOT_FOUND`) and no approved model dir was supplied, so
  the neural path returns `NEURAL_MODEL_DIR_REQUIRED`/`NEURAL_RUNTIME_MISSING` rather than a game.
  Not tested end-to-end.
- **No hard-state mining yet.** This pilot only proves the arena runs real, validated games and
  records what is needed; extracting hard states / candidate-move diversity is the next step.
- **Temperature 0 is not bit-reproducible across servers** (SGLang may reorder reductions), so the
  exact LLM move sequence is not guaranteed to reproduce; records keep raw text + seeds.

## 6. Which LLMs looked useful, and why

- **Gemma-4-26B-A4B is the practical candidate-move generator for the next pilot.** Justification is
  measured, not assumed:
  - it emits well-formed JSON on essentially every request (`legal-move rate 1.00` in the 12-request
    bench; its only 13 invalid attempts across 67 real decisions were **parseable moves that were
    illegal in the position**, never format failures);
  - it is the faster usable move source out of the box (no reasoning tax; ~0.42 s/move bench,
    ~0.57–0.62 s/move in-game, TTFT ~0.17–0.21 s);
  - it stayed rules-legal for entire games (0 rule violations) and lost only to Expert.
- **Nemotron-3.5-Lightning-30B is usable only with thinking disabled.** Its raw decode is the fastest
  measured (63.8 vs 39.4 tok/s at concurrency 1) and it recorded the fewest invalid attempts
  (3/68 real decisions), but its default thinking mode spends the whole budget reasoning and then
  truncates (`legal-move rate 0.08 → 0.00` in the bench), and its per-move latency with thinking on
  (~2.0 s) is ~5× Gemma's. With `enable_thinking:false` it was both correct and the fastest
  single-stream responder (260 ms bench, TTFT p95 79 ms) — that is the configuration to use if it is
  played again.
- **The pilot is too small to say which model plays better.** The LLM-vs-LLM pairing came out
  perfectly mirrored (each model won its X game, 1–1) and **neither LLM beat Expert — both went 0–2
  from both seats (0–4 aggregate)**. That is consistent with "bounded search beats one-shot LLM move
  choice at this budget", but two games per pairing cannot rank the two LLMs. The honest reading is:
  both are *usable diversity sources*, Gemma is the cheaper/more reliable of the two out of the box,
  Nemotron is the better format-disciplined and faster generator once thinking is switched off, and
  neither is yet a strength signal.
