# TRACK A training datasets (committed, gzipped)

These are the exact datasets used for the 2026-10-13 DGX research runs. Each `.jsonl.gz` decompresses to
the dataset; the paired `.jsonl.manifest.json.gz` is the manifest whose `sha256` matches the decompressed
file (verified: `search-labels-1000` -> 48,396 records, SHA matches). Datasets are gzipped to stay
repository-friendly; decompress with `gunzip -k <file>.jsonl.gz`.

Generate/verify exactly as the runs did:

```sh
gunzip -k docs/v5.1/bot-ai/datasets/search-labels-1000.jsonl.gz
node training/bot/validate-data.cjs <the-decompressed>.jsonl   # canonical + hash + split checks
```

## Inventory

| File | Records | train/val/holdout | Producer | Purpose |
| --- | --- | --- | --- | --- |
| `search-labels-1000.jsonl.gz` | 48,396 | 37,953 / 5,229 / 5,214 | `search-labels.cjs` depth-12, 16x64 games | strong-search labels (DGX1) |
| `d16_search-labels.jsonl.gz` | 9,084 | 7,309 / 929 / 846 | `search-labels.cjs` depth-16 | deeper-label experiment |
| `search-labels-dgx2.jsonl.gz` | 31,854 | 24,567 / 3,973 / 3,314 | `search-labels.cjs` depth-12, 14x48 | strong-search labels (DGX2) |
| `search-labels-combined.jsonl.gz` | 80,250 | 62,520 / 9,202 / 8,528 | combined (DGX1+DGX2) | best candidate `big-w96b4` |
| `selfplay-w96.jsonl.gz` | 10,871 | 182 / 32 / 26 | `selfplay.cjs` (producer `big-w96b4`) | PUCT self-play |
| `sp-combined.jsonl.gz` | 91,121 | 70,801 / 10,642 / 9,678 | self-play + search labels | self-play ablation |
| `decision-v2.jsonl.gz` | 960 | - | `decision-dataset.cjs` (budget 320 ms) | Unsloth teacher rows |

## Methodology (see the checkpoints for full results)

`docs/v5.1/release/TRACK-A-72H-RESEARCH-PLAN.md` and `TRACK-A-CHECKPOINT-1..6-20261013.md`:

- **VALUE target = deep search root score** (not the weak-game terminal outcome), normalised to [-1,1]
  (`valueFromScore`, scale 400). **POLICY target = deep search visit counts.**
- **Split**: whole games grouped by D4-normalised 4-ply opening family (`splitFor`); no family crosses
  train/validation/holdout. Family-safe and frozen; the holdout is never trained or tuned on.
- **Reproduce a dataset** (example):
  ```sh
  node training/bot/search-labels.cjs out.jsonl <games> <seed> <simulations> <budgetMs> [depth]
  # parallel:  .artifacts generator was run as 16 shards then merged (see the checkpoint docs)
  ```
- **Train**: `python training/bot/train.py <dataset>.jsonl --output <dir> --source-commit <sha> --epochs N --batch B --device cuda --width W --blocks K`
- **Export**: `python training/bot/export.py <candidate-dir> <dataset>.jsonl --output <dir> [--league <report>]`
- **Benchmark**: `node training/bot/neural_league.cjs --model <export> --pairs <n> --budget-ms <ms> --simulations <n> --workers 8`

Raw (uncompressed) copies remain on the DGX nodes at `~/v51-experiment/data/`. No player data, secrets or
providers are present; these are synthetic self-play/search records only.
