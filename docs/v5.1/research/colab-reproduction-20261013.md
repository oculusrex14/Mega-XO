# Colab T4 portability reproduction (2026-10-13)

Third-runtime reproduction of the compact-net training pipeline, within the existing Colab
subscription (no compute units purchased; balance stayed 0.00). Session created, used, then stopped.

## Setup

- `colab new -s repro --gpu T4` → READY; torch `2.11.0+cu130`, `cuda True`, `Tesla T4`.
- Bundle shipped via `colab upload`: `training/bot/{train.py,model.py,validate-data.cjs,generate.cjs,export.py}`,
  `src/{game.js,bot/{encoding,search,board,contracts}.js}`, plus a 22,000-position external-corpus slice
  (`colab-slice.jsonl`, train/validation split).

## Command (on the T4)

```
python3 training/bot/train.py colab-slice.jsonl --output /content/mx/cand \
  --source-commit <sha> --epochs 4 --batch 512 --device cuda --width 96 --blocks 4 --value-source all --node-bin node
```

## Result

| Metric | Value |
| --- | --- |
| device | **cuda (Tesla T4)** |
| parameters | **713,802** (identical architecture to the DGX champion) |
| best epoch | 4 / 4 |
| validation value MSE | **0.0246** |
| policy top-1 | **0.514** |
| peak CUDA | 367 MB |
| elapsed | 21.5 s |

## Reading

- The **exact same `train.py` + canonical `src/` rules/encoding** ran unchanged on a stock Colab T4 and
  produced the identical 713,802-parameter architecture with a healthy validation curve. The research
  pipeline is **portable across three independent runtimes** (DGX GB10 CUDA, this Mac's CPU, Colab T4).
- The T4 reproduces the qualitative result (the external utttai labels train a useful policy/value net);
  its value MSE (0.0246 on the 22k slice) is in the same regime as the DGX runs.
- No compute units were purchased; the T4 ran within the subscription and the session was stopped.
- This is a **portability/independence** check, not a strength claim: no league was run on the T4 model
  (its strength is measured by the DGX leagues).
