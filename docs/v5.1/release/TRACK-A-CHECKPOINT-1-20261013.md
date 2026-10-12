# TRACK A checkpoint 1 - reconnaissance, diagnosis and infrastructure (2026-10-13)

Owner instruction: 72 h serious AI research on both DGX Sparks, plus TRACK B staging.

## Machines (verified)

| Node | SSH | GPU | Env | Internet | Notes |
| --- | --- | --- | --- | --- | --- |
| DGX1 | `dgx-ts` (`aitopatom-a531`) | NVIDIA GB10, driver 580.178.04 | `~/v51-experiment/venv` torch 2.13.0+cu129; `~/mega-xo-learning/unsloth-env` torch 2.14.1+cu130 + unsloth 2026.10.3 | yes | 20 cores, 121 GB, `/` 2.9 T free |
| DGX2 | `dgx2-qsfp-a` (`edgexpert-c555`) via DGX1 QSFP 10.10.10.2 | NVIDIA GB10, driver 580.178.04 | `~/v51-experiment/venv` torch 2.13.0+cu129; unsloth-env replicated from DGX1 over QSFP | **NO default route** | reached only over the QSFP link; no pip/HF |

DGX2's only path is the QSFP link to DGX1, so the unsloth env (6 GB) and the HF Qwen cache were shipped
DGX1 -> DGX2 over QSFP (`SHIP_DONE`). The env loads on DGX2 (torch 2.14.1+cu130, cuda True, unsloth
2026.10.3). Any HF model download must happen on DGX1 first.

## Diagnosis (the key finding this checkpoint)

DGX1 `value_diagnosis.py` on 9,235 records (7,313 train / 935 val / 987 holdout):

- material-feature value MSE: train 1.073 / val 0.794 / holdout 1.158; **predict-zero MSE 0.73-0.84**;
- value-only training: **train MSE 0.010 but validation 1.00 / holdout 1.15** - the net memorises the
  training set and generalises to nothing, worse than predicting zero;
- D4 augmentation + weight decay did **not** help (holdout 1.47).

Data analysis: within-(material,filled)-group value variance is **0.662** of the overall **0.731**
(only ~9% explained); material->outcome agreement is **0.23 early**, rising to 0.61 late. Conclusion:
**the weak self-play terminal value is near-unpredictable; the labels - not the architecture - are the
bottleneck.** This is exactly the "stronger training targets" the owner commissioned.

## Research direction implemented

`training/bot/search-labels.cjs`: POLICY = deep alpha-beta/MCTS **visit** distribution; VALUE = deep
search **root score** normalised to [-1,1] (a bounded, consistent look-ahead label), with hard-state
flags. `train.py`/`validate-data.cjs` now accept a DECLARED stronger value (`valueTargetSource`) while
keeping the strict terminal default. Family-safe split unchanged.

## In flight

- DGX1 (16 shards x 64 games) and DGX2 (14 x 48) generating strong-search-label datasets in tmux;
  combined ~13 k rows at checkpoint time.
- DGX2 unsloth env + HF Qwen cache shipping.

## Next

1. Finish label generation; train compact CNN on validation (architecture sweep width {64,96,128}).
2. Diagnose whether search-root-score value is learnable (the test the weak outcome failed).
3. Rebuild PUCT candidate; benchmark on the frozen holdout vs improvedExpert + tacticalUCT.
4. DGX2: decision-teacher fine-tuning with improved labels/task weighting; measure bestMove separately.

## Resources

No cost; no model published; no production touched. V4 production untouched; `APPROVED_CATALOG` empty.
