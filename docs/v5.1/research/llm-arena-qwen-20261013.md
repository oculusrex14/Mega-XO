# Third LLM in the arena — Qwen3.8-27B (DGX2, 2026-10-13)

Extends the multi-LLM pilot (which played Nemotron-3.5-Lightning-30B and Gemma-4-26B-A4B) with the
third owner-named model, **Qwen3.8-27B** (dense hybrid GDN VLM, FP8-dynamic), served on the second DGX
Spark. The fourth named model, Ornith-1.5, could not be served (vLLM images absent locally and no
internet on DGX2) — recorded honestly below.

## Serving (DGX2 `edgexpert-c555`, port 8895)

- Shipped DGX1 → DGX2 over QSFP: 30.9 GB in 61 s (**502 MB/s**) — `rsync -aL`.
- SGLang 0.5.16 (`qwen3_5` architecture is supported). Launch needed three fixes, each a real
  environment gap, not a model problem:
  1. `ninja` was on disk in the env but **not on `PATH`** → flashinfer CUDA-graph JIT failed
     (`FileNotFoundError: ninja`); fixed with `PATH=…/envs/tts/bin:$PATH`.
  2. `--disable-cuda-graph` to avoid the prefill CUDA-graph capture path.
  3. `--attention-backend triton` (fallback from flashinfer).
- Command:
  ```
  PATH=$HOME/miniforge3/envs/tts/bin:$PATH python -m sglang.launch_server \
    --model-path ~/models/llm/qwen3.8-27b-uncensored-fp8 --port 8895 --host 127.0.0.1 \
    --mem-fraction-static 0.7 --disable-cuda-graph --disable-radix-cache --attention-backend triton
  ```
- Ready in ~270 s; `/health` 200; `/v1/models` reports `max_model_len 262144`. Thinking disabled via
  `chat_template_kwargs:{enable_thinking:false}`.

## Arena result (real games, canonical rules, side alternation)

`node training/bot/llm-arena.cjs --a llm --a-endpoint <tunnel> --a-model qwen3.8 --b expert --games 2 …`

| Metric | Value |
| --- | --- |
| Games | 2 (Qwen held X in one, O in the other) |
| Result | **0-2 to Expert** (Expert won from both seats) |
| Decisions | 23 |
| Invalid responses | 1 (well-formed-but-illegal, like the others) |
| Rule violations | **0** |
| Mean latency | **2126 ms/move** (p50 2062, p95 2164); TTFT mean 509 ms |

## Reading

- **Consistent with the pilot**: a one-shot 27B LLM does **not** beat bounded search. All three played
  LLMs (Nemotron, Gemma, Qwen) lose to Expert; none is a strength signal, only a candidate-move /
  diversity source.
- Qwen3.8-27B is the **slowest** move source (~2.1 s/move vs Gemma ~0.5 s, Nemotron ~0.26 s with
  thinking off), so for arena throughput it is the least practical generator, though it stayed
  rules-legal with a low invalid rate.
- **Ornith-1.5 was not played**: `~/models/ornith-nvfp4` is present on DGX1 but its runtime (vLLM) is
  absent locally and DGX2 has no internet to install one; DGX1's free memory is occupied by the two
  live SGLang servers. Recorded as an environment blocker, not a fabricated result.

## Non-destructiveness

- DGX1's live servers (8893/8894) and the DGX2 RL runs were untouched.
- The Qwen SGLang server on DGX2 (`:8895`) is left running for further arena work; it can be stopped
  with `pkill -f 'sglang.launch_server.*8895'`. No production/spend impact.
