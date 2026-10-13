# DGX1 (Spark 1) LLM inventory + measured throughput probe — 2026-10-13

First NVIDIA GB10 Spark, reached over Tailscale (`ssh dgx-ts`, hostname `aitopatom-a531`).
**All throughput numbers below are measured on this box** with the runtime's own benchmark
(`sglang.bench_serving`); anything derived rather than printed by a tool is labelled *derived*,
and anything not exercised is `[UNVERIFIED]`. Every command is quoted verbatim so it can be re-run.

Host (measured):

```
$ ssh dgx-ts 'hostname; uname -a; nvidia-smi --query-gpu=name,driver_version --format=csv'
aitopatom-a531
Linux aitopatom-a531 7.0.0-1019-nvidia #19~24.04.2-Ubuntu SMP PREEMPT_DYNAMIC aarch64
name, NVIDIA GB10
driver_version, 580.178.04
```

- **Unified memory, ~128 GB**: `free -m` → `Mem: total 124608` MiB (121.7 GiB). `nvidia-smi
  --query-gpu=memory.used,memory.total` returns `[N/A],[N/A]` (GB10 does not expose discrete
  VRAM), so device-memory readings are taken from `nvidia-smi --query-compute-apps` and from the
  engine's own `avail mem` log lines (both quoted below).
- **Pre-existing state at probe start: two SGLang LLM servers were already live and were NOT
  touched** (see §2). `tmux ls` → no server; `docker ps` → the two LLM containers plus `sparkDash`.

---

## 1. Model inventory (DGX1)

Sizes are real `du -sh`. **Parameter counts are counted from the safetensors headers themselves**
(8-byte header length + JSON header per shard; no framework needed). `du -sh` and the
safetensors-header total differ because NVFP4 stores weights as packed `U8` (2 values/byte) plus
`F8_E4M3` scale tensors; the "stored params" figure is what the loader sees as tensor elements.

### 1a. Live / primary LLM checkpoints

| # | Path | Format / quant | Arch (config) | Stored params | Storage dtypes (elements) | On-disk | Revision (`refs/main` or `.cache` tree) | Intended runtime |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| N | `~/models/llm/nemotron-3.5-lightning-30b-nvfp4` | safetensors, **modelopt MIXED_PRECISION** (`W4A16_NVFP4` routed experts + **FP8** attention/mixer, KV `FP8`) | `NemotronHForCausalLM` / `nemotron_h` — **hybrid Mamba+attention MoE**, 52 layers, 128 routed experts (6/step), 1 shared, hidden 2688, vocab 131072, ctx 1,048,576 | **19.707 B** | U8 15.093 B (fp4 packed) · F8_E4M3 2.777 B · BF16 1.829 B · F32 7.9 M | **21 GB** | `bee7596271d1495f6992ae224aefde4410e816b8` (`nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4`) | **SGLang** (`lmsysorg/sglang:dev-nemotron3-5-lightning`) — *currently serving on :8893* |
| G | `~/models/llm/gemma-4-26b-a4b-fp8dynamic` | safetensors, **compressed-tensors FP8_DYNAMIC** (weights FP8, dynamic per-token act; lm_head/embed/router/vision excluded), KV `FP8` | `Gemma4ForConditionalGeneration` / `gemma4` — MoE, 30 layers (**25 sliding_attention + 5 full_attention**, window 1024), 128 experts (moe_int 704), hidden 2816, `global_head_dim` 512, vocab 262144, ctx 262144 | **26.561 B** | F8_E4M3 24.483 B · BF16 2.077 B | **27 GB** | `ed35d7abe5d940da41b4ff06eb482feb0be8cb44` (`RedHatAI/gemma-4-26B-A4B-it-FP8-dynamic`) | **SGLang** (`lmsysorg/sglang:latest`) — *currently serving on :8894* |
| Q | `~/models/llm/qwen3.8-27b-uncensored-fp8` | safetensors, **FP8 e4m3 dynamic** (`quant_method=fp8`, BF16 lm_head/visual), KV `FP8` (checkpoint declares `kv_cache_quant_algo: FP8`) | `Qwen3_5ForConditionalGeneration` / `qwen3_5` — **dense** hybrid GDN VLM: 64 layers (**48 linear_attention + 16 full_attention**), hidden 5120, 24 heads / 4 kv, head_dim 256 | **27.783 B** | F8_E4M3 24.699 B · BF16 3.084 B | **29 GB** | `9228df5c6c9c509e1019f83b4e085cf643118bac` (local uncensored merge) | **SGLang** (`lmsysorg/sglang:qwen38-27b`) — launcher `~/Qwen3.8-27B-Uncensored-SGLang-DGX-Spark` (**not served**, §4) |
| O | `~/models/ornith-nvfp4` | safetensors, **NVFP4A16** (`nvfp4-pack-quantized`, group 16, fp8 scales; `linear_attn`/`self_attn`/gates excluded) | `Qwen3_5MoeForConditionalGeneration` / `qwen3_5_moe` — MoE 40 layers (**30 linear + 10 full**), 256 routed experts (8/step), 1 shared, hidden 2048, moe_int 512, vocab 248320 | **20.959 B** | U8 16.169 B · BF16 2.769 B · F8_E4M3 2.021 B · F32 30.8 K | **23 GB** | `85ffd2d0629ae5fa4f860dda356ec33161806c9b` (`ornith-ai/Ornith-1.5-35B-A3B-NVFP4`) | **vLLM** (`eugr/spark-vllm-b12x:latest` on :8890; `ghcr.io/aeon-7/aeon-vllm-ultimate:latest` on :8891) — **image absent locally**, §4 |
| O+ | `~/models/ornith-dflash-drafter` | safetensors, BF16 draft model | `DFlashDraftModel` / `qwen3` — 8 layers, hidden 2048, 32 heads / 4 kv, vocab 248320 | ~0.47 B | 1 shard | **948 MB** | (drafter for O) | vLLM spec-decode (`--speculative-config dflash`) |

### 1b. Cross-Spark / large checkpoints (present but not single-box-servable)

| Path | Format / quant | Arch | On-disk | Revision | Runtime |
| --- | --- | --- | --- | --- | --- |
| `~/.cache/huggingface/hub/models--Mia-AiLab--GLM-5.3-Flash-EXL3-4bpw-TensorFold-Ablit` | safetensors, **EXL3 4 bpw** (`quant_method=exl3, bits=4, codebook=mcg, head_bits=16, scope=glm53_routed_experts_only`), BF16 elsewhere | `Glm5NextForConditionalGeneration` / `glm5_next` — 45 layers, 288 routed experts (8/step), hidden 4096, 64 heads, vocab 154880, ctx 1,048,576, 1 MTP layer | **164 GB** | `57edefd2f5d9b371c8345883304d5af68b52fa24` | **TensorFold, TP2 over 2 Sparks** (`tensorfold-glm53:v0.6.0`) — needs ~110 GiB free **per** box |
| `~/.cache/huggingface/hub/models--incoai--GLM-5.3-Flash-DFlash2` | safetensors (draft) | `DFlash2DraftModel` — 5 layers, hidden 4096 | **2.2 GB** | `bf582e4eacc1810f76656d1811693ff6c6737d2a` | GLM TensorFold drafter |
| `~/Qwen3.8-27B-SGLang-DGX-Spark/.cache/huggingface/hub/models--RadixArk--Qwen3.8-27B-NVFP4` | NVFP4 | `Qwen3_5...` dense 27B | **21 GB** | `319f741cce68d7914884900c138a1fbb70a42f30` | SGLang (`qwen38-27b` image, :8888) |
| `…/models--RadixArk--Qwen3.8-27B-NVFP4-BF16-LMHead` | NVFP4 + BF16 lm_head (default checkpoint) | dense 27B | **23 GB** | `009632fef96dd349150baa780c984e62e70e91fe` | SGLang (`qwen38-27b` image, :8888) |
| `…/models--z-lab--Qwen3.8-27B-DFlash2` | safetensors (draft) | DFlash2 drafter | **3.6 GB** | `50307d4c4cde6860d4eee73e2547cd786fe8e8a4` | SGLang DSPARK drafter |

### 1c. Stubs, toolchains, non-LLM

| Path | What it is |
| --- | --- |
| `~/.cache/huggingface/hub/models--google--gemma-4-26B-A4B-it` | **12 KB metadata-only stub** (no weights; `refs/main 4d7ae4984b7db7de8f8457170b3f1a419ee76d52`). The served Gemma is the FP8-dynamic copy in `~/models/llm/`. |
| `~/.cache/huggingface/hub/models--RedHatAI--gemma-4-26B-A4B-it-FP8-dynamic` | 12 KB stub (`ed35d7ab…`) — same, weights live in `~/models/llm/gemma-4-26b-a4b-fp8dynamic`. |
| `~/.cache/huggingface/hub/models--nvidia--NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4` | 12 KB stub (`bee75962…`). |
| `~/.cache/huggingface/hub/models--unsloth--Qwen3.5-0.8B` | 8.5 MB **shim only** (`.no_exist/…/model.safetensors`); the real 1.75 GB blob lives in `blobs/78/783867…` and the symlink `snapshots/…/model.safetensors-00001-of-00001.safetensors`. This is the copy shipped to DGX2. |
| `~/llama.cpp` | Built tree, commit **`c029602`**, `build/bin/` has `llama-cli`, `llama-server`, `llama-bench`, `llama-quantize`, … **No LLM GGUF installed** (only `models/ggml-vocab-*.gguf` test vocabs). |
| `~/sglang-omni` | 8.2 GB — SGLang-related repo (no model weights). |
| `~/models/llm/SenseNova-U1.5-8B-MoT*` | VLM: BF16 dir 47 GB + `…-Q4_0-v2.gguf` 11 GB. |
| `~/models-h3/FL2VA` | **135 GB MiniMax-H3 video/audio** model — out of LLM scope. |
| Ollama | **not installed / inactive** (`which ollama` → nothing; `systemctl is-active ollama` → `inactive`). No Ollama-served model. |
| vLLM on host | **not installed** (`import vllm` fails). vLLM exists only inside the Ornith/Flash-Next Docker images (none present locally, §4). |

### 1d. Single-model-per-GPU?

A GB10 has ~128 GB unified. **Observed**: two servers coexist only because each was started with a
low static fraction — Nemotron `--mem-fraction-static 0.45` (23.91 GB weights + 14.10 GB KV) and
Gemma `0.40` (22.53 GB weights + KV) together hold **~85 GB** of the box. Every **single large**
deployment uses 0.70–0.95 (`qwen3.8-27B .env` → `DF_FRAME mem-fraction-static 0.7`; `start.sh`
`--mem-fraction-static 0.95`; Ornith `0.85`), i.e. **70–95 % of the box per model** — so at sane
fractions a Spark serves **one large model at a time**. GLM-5.3-Flash (164 GB) does not fit one
Spark even alone → it is a **2-Spark TP2 job**. The launch scripts encode this as a *single-LLM
lane* guarded port (8888, refused if occupied).

---

## 2. Detected serving arrangement (from the launch scripts; nothing was started)

| Port | Model / container | Runtime · image | Key flags |
| --- | --- | --- | --- |
| **8893** | `nemotron-3-5-lightning` · `nemotron-3-5-lightning-sglang` | SGLang `0.0.0.dev1+gd59c1ddf7` · `lmsysorg/sglang:dev-nemotron3-5-lightning` | `--mem-fraction-static 0.45 --sleep-on-idle --mamba-ssm-dtype float16 --cuda-graph-max-bs-decode 4 --reasoning-parser nemotron_3 --tool-call-parser qwen3_coder` |
| **8894** | `gemma-4-26b` · `gemma-4-26b-sglang` | SGLang `0.5.21` · `lmsysorg/sglang:latest` | `--mem-fraction-static 0.40 --sleep-on-idle --kv-cache-dtype fp8_e4m3 --reasoning-parser gemma4 --tool-call-parser gemma4` |
| 8888 | `qwen3.8-27b-sglang` (dense, default `RadixArk/Qwen3.8-27B-NVFP4-BF16-LMHead`) — **single-LLM lane** shared with GLM-TP2 and Qwen3.8-Flash-Next | SGLang `lmsysorg/sglang:qwen38-27b` | `--mem-fraction-static 0.95 --attention-backend flashinfer --kv-cache-dtype fp8_e4m3 --mamba-full-memory-ratio 4.21 --max-running-requests 6 --context-length 1000000 --speculative-algorithm EAGLE (3/1/4)` |
| 8889 | Qwen3.8-27B-Uncensored (`~/models/llm/qwen3.8-27b-uncensored-fp8`, `QUANT=fp8`) | SGLang `qwen38-27b` | same family; `--mem-fraction-static 0.7`, `--max-running-requests 6` |
| 8890 | Ornith-1.5-35B-A3B-NVFP4 · `ornith-1.5-b12x-8890` | **vLLM** `eugr/spark-vllm-b12x:latest` | `--moe-backend b12x --spec-method mtp --spec-tokens 1 --max-num-seqs 24 --gpu-memory-utilization 0.60 --max-model-len 262144` |
| 8891 | Ornith AEON Ultimate NVFP4 + DFlash · `ornith-aeon-8891` | **vLLM** `ghcr.io/aeon-7/aeon-vllm-ultimate:latest` | `--speculative-config dflash n=6 --gpu-memory-utilization 0.60 --max-num-seqs 16` |
| 8080 / 11001 | caddy front door / `sparkDash` monitor | — | not inference |

- All LLM servers are **Docker with `--network host`**, GPU via `--gpus all` (device shared with the
  host). Model dirs are bind-mounted **read-only** at `/model`.
- Each start script **refuses to start if its port is taken** ("stop the other server first") — the
  arrangement is deliberately one LLM per port, and the ports are the "lanes".
- No inference server was started by this probe. The two live servers were used **read-only** for
  benchmarking (their own engine's bench client). `curl http://127.0.0.1:8893/health` and
  `:8894/health` both returned `HTTP 200` **after** all runs (see §6).

---

## 3. Measured throughput

### 3a. Protocol

Prompt shape = **~640-token input / 16-token output, temperature 0** (the "short game-ish prompt"
shape; structured 16-token move output). Driver = **the runtime's own benchmark**, not an ad-hoc
loop:

```
$ ssh dgx-ts 'docker exec <container> python3 -m sglang.bench_serving \
    --backend sglang --host 127.0.0.1 --port <8893|8894> --model <served-name> \
    --tokenizer /model --dataset-name random --random-input-len 640 --random-output-len 16 \
    --num-prompts 64 --max-concurrency <C> --temperature 0 --disable-tqdm \
    --disable-ignore-eos --warmup-requests 4'
```

(`--disable-ignore-eos` keeps the true 16-token decode length — without it the server can stop a
sequence at its first EOS token and distort tok/s. `--warmup-requests 4` primes the CUDA graphs;
`--sleep-on-idle` on both servers means the first warm-up request pays the mem-pool wake.)

TTFT/Tpot come straight from the tool's output; **decode tok/s is derived as `1000 / mean TPOT`**
(per-token decode rate during decode, excluding first token) and is labelled *derived*.

### 3b. Nemotron-3.5-Lightning-30B-A3B (hybrid MoE+FP8, SGLang :8893) — serving server

Command (one row per `--max-concurrency C`):

```
$ ssh dgx-ts 'docker exec nemotron-3-5-lightning-sglang python3 -m sglang.bench_serving \
  --backend sglang --host 127.0.0.1 --port 8893 --model nemotron-3-5-lightning \
  --tokenizer /model --dataset-name random --random-input-len 640 --random-output-len 16 \
  --num-prompts 64 --max-concurrency C --temperature 0 --disable-tqdm --disable-ignore-eos \
  --warmup-requests 4'
```

| Concurrency | Prompts | Mean TTFT (ms) | Median TTFT (ms) | Mean TPOT (ms) | **decode tok/s** *(derived 1000/TPOT)* | Output tok/s | Peak concurrent | Successful |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 64 | 92.54 | 89.03 | 15.29 | **65.4** | 42.19 | 8 | 64/64 |
| 4 | 64 | 159.98 | 145.61 | 45.53 | 22.0 | 68.27 | 13 | 64/64 |
| 16 | 64 | 277.97 | 266.15 | 106.01 | 9.4 | 121.01 | 31 | 64/64 |
| 64 | 64 | 858.88 | 1039.36 | 133.09 | 7.5 | **261.72** | 64 | 64/64 |

Load-beyond-capacity run (`--max-concurrency 144 --num-prompts 288`, 2.25× the runtime cap of 108):

```
$ … --num-prompts 288 --max-concurrency 144 …
Output token throughput: 148.62 tok/s · Peak output: 402 tok/s · Peak concurrent: 171
Mean TTFT: 3221.43 ms · Mean TPOT: 551.96 ms (decode 1.8 tok/s derived) · Successful: 288/288
```
→ **no OOM, no request errors**, but latency collapses (TTFT 3.2 s, TPOT 552 ms). *No hard
concurrency wall was reached.*

Single-stream repeat for cross-check (`--num-prompts 32 --max-concurrency 1`, 3 warmups):
TTFT mean 191.31 ms, TPOT mean 14.33 ms → 69.8 tok/s; per-request E2E 313.86 ms mean.

### 3c. Gemma-4-26B-A4B FP8-dynamic (MoE, SGLang :8894) — serving server

```
$ ssh dgx-ts 'docker exec gemma-4-26b-sglang python3 -m sglang.bench_serving \
  --backend sglang --host 127.0.0.1 --port 8894 --model gemma-4-26b \
  --tokenizer /model --dataset-name random --random-input-len 640 --random-output-len 16 \
  --num-prompts 64 --max-concurrency C --temperature 0 --disable-tqdm --disable-ignore-eos \
  --warmup-requests 4'
```

| Concurrency | Prompts | Mean TTFT (ms) | Median TTFT (ms) | Mean TPOT (ms) | **decode tok/s** *(derived)* | Output tok/s | Peak concurrent | Successful |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 64 | 134.02 | 137.59 | 26.22 | **38.1** | 26.30 | 6 | 64/64 |
| 4 | 64 | 212.93 | 221.47 | 67.07 | 14.9 | 46.34 | 11 | 64/64 |
| 16 | 64 | 430.20 | 415.30 | 157.05 | 6.4 | 80.80 | 26 | 64/64 |
| 64 | 64 | 2158.49 | 1879.95 | 290.56 | 3.4 | **109.47** | 64 | 64/64 |

Peak instantaneous output from the load runs: 155–170 tok/s at C=24–32. **Gemma is ~1.6× slower
than Nemotron at C=1 despite being an "A4B" MoE** — its KV budget is the binding constraint
(§3e), and it is FP8 (8-bit) not NVFP4.

### 3d. Load time, peak memory, capacity — from the engines' own logs / nvidia-smi

```
$ ssh dgx-ts 'docker logs <container> 2>&1 | grep -E "Load weight|KV Cache|max_total_num_tokens|Engine startup timings|avail mem"'
$ ssh dgx-ts 'nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv'   # sampled during benches
```

| | **Nemotron-30B-A3B-NVFP4** | **Gemma-4-26B-A4B-FP8** |
| --- | --- | --- |
| `Load weight end. elapsed` | **118.63 s** (mem usage 23.91 GB) | **174.35 s** (mem usage 22.53 GB) |
| Engine `load_weight=` (startup timings) | 118.63 s | 174.35 s |
| `scheduler_e2e` (load→ready) | 320.11 s | 228.13 s |
| KV pool | `#tokens 4,928,538`, FP8, K 7.05 GB + V 7.05 GB = **14.10 GB** | full `15,631` tok (0.07+0.07 GB) + SWA `12,504` tok (0.60+0.60 GB) = **1.34 GB** |
| `avail mem` after pool / CUDA graph | 62.00 → **61.40 GB** | 35.71 → **32.41 GB** |
| **Peak GPU memory (scheduler, nvidia-smi)** | **51,861 MiB** (~50.6 GiB) at C=64 | **32,116 MiB** (~31.4 GiB) |
| CUDA-graph capture | decode 3.65 s (0.95 GB), bs=[1,2,4] | decode 34.20 s (3.10 GB), bs=[1..256] |
| `max_running_requests` | **108** (capped by Mamba state cache: `max_mamba_cache_size=544`, 5 slots/req) | **2048** (KV-token bound; not tested to the wall) |
| Max concurrency reached in a bench | 130.2 achieved / 171 peak (no OOM, no errors) | 64 (no OOM; severe latency) |

Peak-memory method: a 0.3 s `nvidia-smi --query-compute-apps=pid,used_memory` sampler ran for the
duration of each bench; the table reports the **max** over the run (Nemotron scheduler 50,081 →
50,749 → 51,861 MiB for C=8/32/64; Gemma scheduler flat **32,116 MiB**). These are unified-memory
process readings; `nvidia-smi --query-gpu=memory.used` is `[N/A]` on GB10.

### 3e. KV cache per sequence at this context (640-in + 16-out ≈ 656–672 tokens)

Derived directly from the measured pool sizes printed by the engine:

- **Nemotron** (:8893): 14.10 GB / 4,928,538 tokens = **2.86 KB/token** → **~1.92 MB per sequence**
  at 672 tokens *(derived)*. The model is 52-layer Mamba+attention; SGLang keeps KV for its
  attention layers only. Additionally the **Mamba recurrent state is the real cap**: 5 state slots
  per request with `max_mamba_cache_size=544` → `max_running_requests=108`.
- **Gemma** (:8894): full-attention pool 0.14 GB / 15,631 tok = **8.75 KB/token**; sliding-window
  pool 1.20 GB / 12,504 tok = **96 KB/token**. A sequence's KV is dominated by the SWA pool and is
  bounded by the **sliding window of 1024**; at 672 tokens ≈ **~70 MB/seq** *(derived: 672×96 KB SWA
  + 672×8.75 KB full)*.

This **KV budget, not VRAM, is what caps Gemma**: `mem-fraction-static 0.40` gives it only ~35 GB
of pool, and its 25 sliding-window layers cost ~96 KB/token, hence `max_total_num_tokens=15631`.

### 3f. Bottom line for the simulator

- **Decode, single stream, short game prompts**: Nemotron **~65 tok/s** (TPOT 15.3 ms), Gemma
  **~38 tok/s** (TPOT 26.2 ms).
- **Aggregate output throughput** (16-token responses, so prefill-dominated): ~**110–260 tok/s** at
  64 concurrent; Nemotron saturates ~**262 tok/s** at its cap and *degrades* past it (149 tok/s at
  130 concurrent).
- **Latency knee** (before it hurts an interactive loop — TTFT < ~300 ms, TPOT < ~110 ms): both
  models at **≈16 concurrent** requests. Nemotron holds <1 s TTFT up to ~64; Gemma breaks 2 s TTFT
  at 64.

---

## 4. What could not be measured, and why

- **Dense model (Qwen3.8-27B, `~/models/llm/qwen3.8-27b-uncensored-fp8`) — not benchmarked.** Two
  blockers, both verified:
  1. **No free memory.** Its launcher is the memory-rich config: `--mem-fraction-static 0.95`,
    `--max-running-requests 6`, `--context-length 1000000`. With the two live servers holding
    ~82 GiB, `free -m` reported `used 95089 MiB / available 29519 MiB`. A dense 27B FP8 (~30 GB
    weights + 6× large-context KV) needs far more than 29 GB free. The launcher's own port guard
    (`8888`) would also refuse because that is the "single-LLM lane".
  2. **Image absent locally.** The launcher pins `IMAGE=lmsysorg/sglang:qwen38-27b`; `docker images`
    on this box lists only `lmsysorg/sglang:latest`, `lmsysorg/sglang:dev-nemotron3-5-lightning`,
    `sparkdash-sparkdash:latest`, `tensorfold-glm53:v0.6.0`. That tag can only be fetched
    (`docker manifest inspect …` → present on the Hub), which this probe was not authorised to do.
  - *Prior* measurement on this box (recorded in the launcher's own header comment, **not re-run**,
    hence `[UNVERIFIED]`): MTP 3/1/4 + NVFP4 = 16.9 tok/s (thinking) / 21.0 (non-thinking); DSpark +
    FP8 = 11.4/11.5. **No fresh dense number is claimed here.**
- **GLM-5.3-Flash-EXL3 (164 GB, EXL3 4 bpw) — not benchmarked.** It is a **2-Spark TP2 TensorFold**
  job; the launcher requires **~110 GiB free on each Spark** and a private-fabric rendezvous. It also
  needs the `incoai/GLM-5.3-Flash-DFlash2` drafter. A single-box probe cannot host it, and starting
  it would have collided with the two live servers. *The MoE "large" model measured in §3 is
  therefore Nemotron-3.5-Lightning-30B-A3B, not GLM.*
- **Ornith-1.5 / AEON (vLLM) — not benchmarked.** Both launchers use vLLM images that are **not
  present locally** (`ghcr.io/aeon-7/aeon-vllm-ultimate:latest`, `eugr/spark-vllm-b12x:latest`) and
  have no host `vllm` install; pulling them was out of scope. The GGUF path is also empty: no LLM
  GGUF is installed in `~/llama.cpp`, and Ollama is inactive.
- **True GPU VRAM / peak device memory** — GB10 unified memory; `nvidia-smi --query-gpu=memory.used`
  returns `Not Supported`/`[N/A]`. Reported as engine `avail mem` lines plus per-process
  `used_memory` from `--query-compute-apps`.
- **Hard concurrency wall (OOM point)** — none reached. Nemotron served 130 concurrent / 171 peak
  without error (its configured cap is 108); Gemma served 64 without error. Both degrade in latency
  long before failing, so the *practical* limit is latency, reported in §3f.
- **Qwen3.8-Flash-Next, MiniMax-H3, SenseNova, image/audio models** — out of scope (non-LLM or
  video/audio), not benchmarked.

---

## 5. Non-destructiveness

- **No server was started or stopped.** The two pre-existing SGLang servers (:8893, :8894) were used
  read-only through their own `bench_serving` client and their Docker logs.
- No model, container, image, or git state was changed; no file on the DGX was written (the sampler
  temp files `/tmp/mem*.log` were created and removed). No package installed, nothing downloaded.
- Memory sampling and `docker logs` were the only side effects.

## 6. Post-run state (verified)

```
$ ssh dgx-ts 'curl -s -o /dev/null -w "HTTP %{http_code} %{time_total}s\n" http://127.0.0.1:8893/health; \
              curl -s -o /dev/null -w "HTTP %{http_code} %{time_total}s\n" http://127.0.0.1:8894/health; \
              docker ps --format "{{.Names}} {{.Status}}"'
HTTP 200 1.002776s      # :8893 nemotron-3-5-lightning
HTTP 200 1.001653s      # :8894 gemma-4-26b
gemma-4-26b-sglang            Up 37 minutes
nemotron-3-5-lightning-sglang Up 2 hours
sparkDash                     Up 3 hours
```

Both serving containers were still `Up` and both endpoints answered `200` after every benchmark.
