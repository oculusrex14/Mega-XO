# DGX2 LLM serving + QSFP link probe (measured 2026-10-13)

Second NVIDIA GB10 Spark, reached **only** over the QSFP link from DGX1 (`ssh dgx2-qsfp-a` /
`10.10.10.2`). All numbers below are measured on the box; anything not exercised is marked
`[UNVERIFIED]`. Every command is quoted so it can be re-run.

Host (measured):

```
$ ssh dgx2-qsfp-a 'hostname; uname -r; free -h | head -2'
edgexpert-c555
7.0.0-1019-nvidia
               total        used        free      ...
Mem:           121Gi       4.8Gi        12Gi      ...
```

- GPU: `NVIDIA GB10`, driver `580.178.04`, CUDA `13.0`; **unified memory** (nvidia-smi reports
  Memory-Usage as `Not Supported`, so per-process GPU VRAM is not directly readable on this platform).
- State at probe start: idle — no tmux server, 0 GPU processes (`nvidia-smi`, `tmux ls`,
  `ps aux | grep -E "sglang|vllm|llama|python"`). DGX1's two SGLang servers (ports 8893/8894) were
  live and were **not** touched (both returned `HTTP 200` on /health after all work).
- Networking: **no internet default route over QSFP** — `ip route` shows
  `default via 192.168.0.1 dev wlP9s9` (Wi-Fi). QSFP is `enp1s0f1np1 10.10.10.2/30` (link speed
  200000 Mb/s) plus a second fabric `enP2p1s1np1 10.10.20.2/30`. A model must therefore be **pushed
  from DGX1 over 10.10.10.2** to be served here (done below).

## 1. Model inventory on DGX2

`~/.cache/huggingface/hub/` (DGX2) — sizes are real `du -sh`; blob sizes from `find … -printf %s`:

| Repo | Size | Architecture / format | Params / quant | Weights present? | Revision (`refs/main`) |
| --- | --- | --- | --- | --- | --- |
| `models--Mia-AiLab--GLM-5.3-Flash-EXL3-4bpw-TensorFold-Ablit` | **164 GB** | `Glm5NextForConditionalGeneration`, **EXL3 4 bpw** (`quant_method=exl3, bits=4, codebook=mcg, head_bits=16, scope=glm53_routed_experts_only`) | MoE; index `total_size`=175,622,979,576 B | **yes — 83/83** `model-000NN-of-00083.safetensors`, 0 `.incomplete` | `57edefd2f5d9b371c8345883304d5af68b52fa24` |
| `models--incoai--GLM-5.3-Flash-DFlash2` | 2.2 GB | `DFlash2DraftModel` (qwen3-family **spec-decode draft**: 5 layers, hidden 4096, 32 heads / 8 kv, vocab 154880, max_pos 1,048,576) | 1 shard `model.safetensors` (2,233.67 MB) | yes (draft only — not a full model) | `bf582e4eacc1810f76656d1811693ff6c6737d2a` |
| `models--unsloth--Qwen3.5-0.8B` | 8.5 MB | `Qwen3_5ForConditionalGeneration` | — | **no** — only tokenizer/config/added_tokens blobs; the 1.75 GB `model.safetensors-00001-of-00001.safetensors` blob is **absent** | `23c69c53358a07516b5827588b3fdb12ae78fd65` |
| `models--openai--gpt-oss-20b` | 12 KB | — | — | **no** — `refs/main` only, no `snapshots/`, no `blobs/` | `6cee5e81ee83917806bbde320786a8fb61efebee` |

Commands:

```
$ ssh dgx2-qsfp-a 'cd ~/.cache/huggingface/hub; for d in models--*; do echo "$d"; du -sh "$d"; find "$d/blobs" -type f -printf "%s\t%p\n" | sort -rn | head; cat "$d/refs/"*; echo; done'
$ ssh dgx2-qsfp-a 'cd ~/.cache/huggingface/hub/models--Mia-AiLab*/snapshots/*; ls model-*-of-*.safetensors | wc -l'   # -> 83
$ ssh dgx2-qsfp-a 'find ~/.cache/huggingface/hub -name "*.incomplete" | wc -l'                                      # -> 0
```

Notes:

- `~/models/llm/` was **empty** at probe start (populated later by the QSFP ship, §3).
- `~/models-h3/FL2VA` is a MiniMax-H3 **video/audio** model (13-shard transformer + audio_vae), not
  an LLM — out of scope, listed only to close the "any `~/models`" question.
- **gpt-oss-20b and Qwen3.5-0.8B are not usable on DGX2 as-is**: both are HF-cache stubs with the
  weight blobs missing. GLM-5.3-Flash-EXL3 is complete but 164 GB.

## 2. Serving runtime and measured serving

### Which runtimes exist

`which sglang vllm llama-cli llama-server ollama` -> none on `$PATH`; system `python3` has no ML
stack. The ML stack lives in conda envs (`~/miniforge3`):

| Env | Python | torch | sglang | vllm | transformers |
| --- | --- | --- | --- | --- | --- |
| base | 3.14.6 | — | — | — | — |
| breeze | 3.12.14 | 2.11.0+cu130 (cuda ok) | — | — | 4.57.3 |
| longcat | 3.12.14 | 2.13.0+cu130 (cuda ok) | — | — | 5.16.1 |
| **tts** | 3.12.14 | 2.11.0+cu130 (cuda ok) | **0.5.16** | — | 5.12.1 |

**The only serving runtime on DGX2 is SGLang 0.5.16 in conda env `tts`** (`python3 -m
sglang.launch_server`; benches `sglang.bench_serving` / `bench_one_batch_server` shipped).

### Runtime × model compatibility (this determines what can be served)

| Model | Serveable? | Evidence |
| --- | --- | --- |
| GLM-5.3-Flash-EXL3-4bpw | **No** | SGLang 0.5.16 has **no exl3 quantization support**: `grep -rl exl3 .../sglang/` → 0 files; `sglang/srt/layers/quantization/` has no exl3/exllama module. No internet to install one. |
| GLM-5.3-Flash-DFlash2 | **No** | Launch fails: `ValueError: Cannot find model module. 'DFlash2DraftModel' is not a registered model in the Transformers library`. It is a draft model, not servable alone. |
| Qwen3.5-0.8B (native copy) | not possible (weights missing) | but arch IS supported: `sglang/srt/models/qwen3_5.py` exists → `Qwen3_5ForConditionalGeneration` is registered. |
| gpt-oss-20b | not possible (weights missing) | — |

Commands:

```
$ ssh dgx2-qsfp-a 'grep -rl exl3 ~/miniforge3/envs/tts/lib/python3.12/site-packages/sglang/ | wc -l'   # -> 0
$ ssh dgx2-qsfp-a 'ls ~/miniforge3/envs/tts/lib/python3.12/site-packages/sglang/srt/models/ | grep qwen3_5'
qwen3_5.py
qwen3_5_mtp.py
$ ssh dgx2-qsfp-a '… conda activate tts; timeout 90 python3 -m sglang.launch_server --model-path ~/.cache/huggingface/hub/models--incoai--GLM-5.3-Flash-DFlash2/snapshots/bf582e4e… --port 30099'
… ValueError: Cannot find model module. 'DFlash2DraftModel' is not a registered model in the Transformers library
```

Because **no complete, compatible model existed locally**, the anticipated workflow was exercised:
DGX1's complete Qwen3.5-0.8B (1.75 GB) was shipped over QSFP (§3) and served on DGX2. This is the only
configuration DGX2 can currently serve.

### Measured serving — Qwen3.5-0.8B, SGLang 0.5.16

Server: `conda activate tts; python3 -m sglang.launch_server --model-path
/home/oculus-rex/models/llm/Qwen3.5-0.8B --port 30100 --host 127.0.0.1 --mem-fraction-static 0.6`
(port 30100 was free; the DGX1 servers use 8893/8894). Reached
`The server is fired up and ready to roll!` in ~75 s. Weights loaded from local disk (not HF).

Load / capacity (from the server log):

- `Load weight end. elapsed=12.29 s, type=Qwen3_5ForConditionalGeneration, avail mem=111.39 GB`
- `KV Cache is allocated. dtype: torch.bfloat16, #tokens: 3031665, K size: 17.35 GB, V size: 17.35 GB`
- `max_total_num_tokens=3031665, chunked_prefill_size=8192, max_prefill_tokens=16384, max_running_requests=343`
- avail mem after KV pool `44.29 GB`, after CUDA-graph capture `39.91 GB`
- process RSS (unified-mem proxy): scheduler 3.75 GB, detokenizer 1.47 GB, main 1.64 GB

Bench: `python3 -m sglang.bench_serving --backend sglang --host 127.0.0.1 --port 30100 --model
/home/oculus-rex/models/llm/Qwen3.5-0.8B --dataset-name random --random-input-len 600
--random-output-len 16 --num-prompts N --max-concurrency C` (≈600-token in, 16-token out — the
"short game-ish prompt" shape):

| Concurrency | Prompts | Mean TTFT (ms) | Median TTFT (ms) | Mean TPOT (ms) | Decode ≈ tok/s | Output tok/s | Peak output tok/s | Total tok/s | Req/s | Mean E2E (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 20 | 37.60 | 24.10 | 8.24 | ~121 | 90.41 | 101 | 2,294 | 8.41 | 117.97 |
| 8 | 64 | 76.31 | 57.26 | 16.26 | ~62 | 336.78 | 332 | 11,177 | 36.47 | 210.65 |
| 32 | 128 | 95.41 | 101.95 | 40.77 | ~25 | 625.96 | 641 | 23,390 | 75.87 | 394.41 |

- **Max concurrency**: `max_running_requests=343` (set by SGLang from the 3.03 M-token KV pool at
  `--mem-fraction-static 0.6`); the busiest bench run exercised **32** concurrent requests
  (`Concurrency: 29.93` achieved) without rejecting — the server was **not** saturated at 32, so 343
  is the configured ceiling and >32 is `[UNVERIFIED]` by direct load test.
- **Peak memory**: model load took unified mem to ~111 GB *available* (i.e. ~10 GB used including
  weights); KV pool is 34.7 GB (17.35 K + 17.35 V). Exact GPU-VRAM split is not readable on GB10
  (`nvidia-smi` → `Not Supported`).
- After the run the server was stopped and temp files removed (§5); DGX2 GPU returned to 0 %.

## 3. QSFP link measurements (DGX1 <-> DGX2)

Interface (DGX2): `enp1s0f1np1  UP  10.10.10.2/30`, `cat /sys/class/net/enp1s0f1np1/speed` → **200000**
Mb/s (200 GbE). DGX1 side: `enp1s0f1np1  UP  10.10.10.1/30`.

**(a) RTT**

```
$ ssh dgx2-qsfp-a 'ping -c 5 -W 2 10.10.10.1'
5 packets transmitted, 5 received, 0% packet loss
rtt min/avg/max/mdev = 0.084/0.393/0.868/0.307 ms
```

**(b) Real transfer rate**

`scp` — DGX1 creates a 3 GiB file, pushes it to DGX2 (this is DGX1 **push**, the only direction that
authenticates, see (c)):

```
$ ssh dgx-ts 'dd if=/dev/zero of=/tmp/qsfp-test.bin bs=1M count=3072 status=none; sync'
$ ssh dgx-ts '/usr/bin/time -v scp /tmp/qsfp-test.bin oculus-rex@10.10.10.2:/tmp/qsfp-test.bin'
    Elapsed (wall clock) time (h:mm:ss or m:ss): 0:05.20
```

3,221,225,472 B / 5.20 s = **~619 MB/s (~4.96 Gbit/s)**. `scp` is SSH-CPU-bound, not link-bound, so
the raw link was measured with `iperf3` (a pre-existing `iperf3 -s` on DGX2 `10.10.10.2:5201` was
reused — not disturbed):

```
$ ssh dgx-ts 'iperf3 -c 10.10.10.2 -t 10'        # single stream TCP, DGX1->DGX2
[  5]  0.00-10.00  sec  51.7 GBytes  44.4 Gbits/sec   0 retr   (sender == receiver)
$ ssh dgx-ts 'iperf3 -c 10.10.10.2 -t 10 -P 4'   # 4 parallel streams
[SUM]  0.00-10.00  sec   129 GBytes   111  Gbits/sec   4 retr
$ ssh dgx-ts 'iperf3 -c 10.10.10.2 -t 6 -R'      # single stream, DGX2->DGX1 (reverse)
[  5]  0.00-6.01   sec  31.6 GBytes  45.2 Gbits/sec   0 retr
```

- Raw TCP: **44.4 Gbit/s single-stream**, **111 Gbit/s with 4 streams** (~13.9 GB/s), 0 retransmits;
  reverse single-stream **45.2 Gbit/s** (roughly symmetric). The link ceiling is >111 Gbit/s
  `[UNVERIFIED]` — not probed higher.
- Real artifact rate: the model ship itself (§ below) measured via `rsync` at **394.7 MB/s** reported
  (`394,691,433.33 B/s`, elapsed **3.55 s**), and `scp` of a bulk zero file at **619 MB/s**.

**Artifact / dataset crossing (the model-ship workflow)**

```
$ ssh dgx-ts 'rsync -aL --info=stats2 -e ssh \
    ~/.cache/huggingface/hub/models--unsloth--Qwen3.5-0.8B/snapshots/23c69c53…/ \
    oculus-rex@10.10.10.2:~/models/llm/Qwen3.5-0.8B/'
Total transferred file size: 1,775,676,356 bytes
sent 1,776,111,127 bytes  received 323 bytes  394,691,433.33 bytes/sec
elapsed=3.55 s
```

Integrity: md5 `7d61ccb37ef5d4ad330fec4ad0e06934` on both DGX1 source blob and the DGX2 landing
`~/models/llm/Qwen3.5-0.8B/model.safetensors-00001-of-00001.safetensors` — **identical**. So a 1.75 GB
model moves DGX1→DGX2 in ~3.5 s and is directly servable (it was, §2).

**(c) Can DGX2 reach DGX1's server endpoints over QSFP?** **Yes** (L3 connectivity + ports + HTTP):

```
$ ssh dgx2-qsfp-a 'for p in 8893 8894 11001 8080 22; do timeout 4 bash -c "echo > /dev/tcp/10.10.10.1/$p" && echo "$p OPEN" || echo "$p CLOSED"; done'
8893 OPEN   8894 OPEN   11001 OPEN   8080 OPEN   22 OPEN
$ ssh dgx2-qsfp-a 'curl -s -o /dev/null -w "HTTP %{http_code} in %{time_total}s\n" http://10.10.10.1:8894/health'
HTTP 200 in 1.003502s
$ ssh dgx2-qsfp-a 'curl -s -o /dev/null -w "HTTP %{http_code} in %{time_total}s\n" http://10.10.10.1:8893/health'
HTTP 200 in 7.110921s      # first-hit cold (connection/JIT warm-up); 8894 hit 200 in 1.0 s
```

So DGX2 can **curl DGX1's SGLang servers (8893/8894) and the 8080 (caddy) front door over QSFP** —
DGX2 could act as a client of DGX1's inference endpoints.

**Directionality caveat (SSH auth is one-way):**

```
$ ssh dgx-ts 'ssh oculus-rex@10.10.10.2 hostname'          # DGX1 -> DGX2  works
edgexpert-c555
$ ssh dgx2-qsfp-a 'ssh oculus-rex@10.10.10.1 hostname'     # DGX2 -> DGX1  denied
oculus-rex@10.10.10.1: Permission denied (publickey,password).
```

DGX1→DGX2 key auth works; **DGX2→DGX1 SSH does not** (no authorized key). Over QSFP, artifacts must
be **pushed** from DGX1 (`scp`/`rsync`), or DGX2 pulls over HTTP/rsync-daemon if such a service is set
up. The 4-stream reverse `iperf3` (one attempt) returned `unable to receive control message … Connection
reset by peer` (the shared single-threaded test server); single-stream reverse succeeded.

## 4. What could not be measured, and why

- **GLM-5.3-Flash-EXL3-4bpw serving throughput** — impossible on DGX2 today: SGLang 0.5.16 has no
  `exl3` quantization path, no `vllm`, and DGX2 has **no internet** to install one. (Independently,
  164 GB of 4 bpw weights on a 121 GB-unified box would not fit without the runtime's own offload
  scheme.) Not measured.
- **Serving any *native* DGX2 model** — `gpt-oss-20b` and `Qwen3.5-0.8B` caches are weight-less stubs;
  `GLM-5.3-Flash-DFlash2` is a draft-only arch rejected by the loader. Hence the shipped-model path.
- **True GPU VRAM / peak device memory** — GB10 exposes unified memory; `nvidia-smi` reports
  `Not Supported` for Memory-Usage. Reported as unified `avail mem` and process RSS instead.
- **DGX2 max_running_requests=343 verified under load** — bench only exercised up to 32 concurrent;
  343 is the runtime-configured ceiling, load beyond 32 `[UNVERIFIED]`.
- **QSFP ceiling / full-duplex aggregate** — best measured is 111 Gbit/s (4-stream TCP); did not probe
  higher stream counts or MTU/jumbo tuning; the second fabric (`10.10.20.0/30`) was not tested.
- **DGX2→DGX1 push** — blocked by SSH auth (see caveat); workaround is DGX1-push.

## 5. Non-destructiveness / cleanup

- DGX1's live SGLang servers (8893/8894) were untouched and still returned `HTTP 200` afterwards.
- DGX2's pre-existing `iperf3 -s` (10.10.10.2:5201) was reused, not stopped.
- My DGX2 SGLang server (`:30100`) was stopped (port closed, sglang procs gone, GPU back to 0 %,
  `free` back to ~116 GiB available); temp files `/tmp/qsfp-test.bin`, `/tmp/sglang-qwen.log` removed
  on DGX2 and `/tmp/qsfp-test.bin` removed on DGX1.
- The only persistent artifact on DGX2 is the shipped model `~/models/llm/Qwen3.5-0.8B/` (1.75 GB),
  kept so the serving configuration is reproducible.
