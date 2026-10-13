# TRACK A checkpoint 7 - Phase-1 pipeline corrections complete; GPU training proven

Branch `V5.1`. All Phase-1 audit corrections landed as small verified commits. Research candidates
remain offline; `APPROVED_CATALOG` stays empty; production untouched.

## Commits (all pushed)

| Fix | Commit | Evidence |
| --- | --- | --- |
| Depth propagation through `search-labels.cjs::generate()` + real per-row diagnostics; raised search clamps | `22a236e` | `tests/bot/search-labels.test.cjs` 3/3; measured depth 12@4M nodes -> completed 9, depth 16@21M -> completed 11 |
| Best-validation export + early stopping + separated label target types (`value-target-source`) | `c1974d5` | `training/bot/test_load_records.py` 3/3; smoke chose epoch 2 (metric 3.12) over the final 4 |
| Dataset dedup audit + reserved qualification split + target-source tooling | `de92848` | `docs/v5.1/research/dataset-audit-20261013.md`; reserve=30 run -> 9 qualification families, `canonical:true` |
| Decouple research progression from the public qualification gate | `464f024` | `tests/bot/research-gate.test.cjs` 2/2; 0.62@200fam -> strict refuse, research advance |
| GPU device + multi-generation loop + reserve/value-source wiring in the operator | `2a374ef` | 2-generation CPU run completed all 5 stages for both generations, archived gen-1 |

## GPU training proof (real, DGX2)

DGX2 (`edgexpert-c555`, NVIDIA GB10, CUDA 13) ran the corrected `train.py` on the committed 80,250-record
`search-labels-combined` dataset:

```
device cuda  hardware NVIDIA GB10  epochs 2  bestEpoch 2  peakCudaBytes 106.9 MB  elapsedSeconds 9.6  parameters 128,682
```

So GPU multi-generation training is genuinely enabled (device selectable, best-validation selection
working, real CUDA peak reported), not merely argued. Dataset validation ran on the node first (hash +
canonical replay).

## Measured facts feeding the RL design

- **Deep classical search is expensive**: depth 16 needed ~21M nodes / 60 s and only completed depth 11.
  This is the quantitative reason to pursue neural-guided MCTS, not deeper alpha-beta.
- **Datasets are nested, not independent**: `search-labels-1000` and `-dgx2` are 100% inside
  `search-labels-combined`, which is 100% inside `sp-combined`; `sp-combined` also mixes 80,250
  deep-search-root-score rows with 10,871 terminal-outcome rows. Train on one semantics at a time.
- **LLM serving is ready** (measured on DGX1): Nemotron-3.5-Lightning-30B 65 tok/s single-stream,
  262 tok/s at 64 concurrent (cap 108); Gemma-4-26B-A4B 38 -> 109 tok/s; latency knee ~16 concurrent.
  DGX2 can reach both at `http://10.10.10.1:8893|8894` over QSFP (RTT 0.39 ms, rsync 394 MB/s).

## Next

- Phase 2: `arnowaczynski/utttai` compatibility assessment (delegated).
- Phase 3: multi-LLM arena build + pilot (delegated), now unblocked by the measured serving capacity.
- Phase 5: first real GPU multi-generation RL run on DGX2/DGX1 once the arena/qualification data is ready.
