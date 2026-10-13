# Committed dataset audit + deduplication (2026-10-13)

Produced by `training/bot/dataset-audit.py audit docs/v5.1/bot-ai/datasets/*.jsonl.gz`, a real pass over
the seven committed datasets. This resolves the "verify the seven committed datasets and resolve
artifact size/provenance discrepancies" audit item and feeds Phase 4's dedup/leakage discipline.

## Per-file (`rows` / unique canonical positions / duplicate rows)

| File | Rows | Unique positions | Dup rows | Splits | Value-target source |
| --- | --- | --- | --- | --- | --- |
| `search-labels-1000` | 48,396 | 48,395 | 1 | train 37,953 / val 5,229 / hold 5,214 | deep-search-root-score |
| `search-labels-dgx2` | 31,854 | 31,851 | 3 | train 24,567 / val 3,973 / hold 3,314 | deep-search-root-score |
| `search-labels-combined` | 80,250 | 80,239 | 11 | train 62,520 / val 9,202 / hold 8,528 | deep-search-root-score |
| `d16_search-labels` | 9,084 | 9,083 | 1 | train 7,309 / val 929 / hold 846 | deep-search-root-score |
| `selfplay-w96` | 10,871 | 10,870 | 1 | train 8,281 / val 1,440 / hold 1,150 | **terminal-outcome** |
| `sp-combined` | 91,121 | 91,105 | 16 | train 70,801 / val 10,642 / hold 9,678 | **mixed: 80,250 search + 10,871 terminal** |
| `decision-v2` | 960 | – | – | (LLM decision schema) | – |

## Provenance nesting (the actual discrepancy)

Position overlap between files is **exact set inclusion**, not independent sampling:

- `search-labels-1000` (48,395 positions) is **100%** contained in `search-labels-combined`.
- `search-labels-dgx2` (31,851) is **100%** contained in `search-labels-combined`.
- `search-labels-combined` = `search-labels-1000` ∪ `search-labels-dgx2` (80,239 = 48,395 + 31,851 − 7).
- `sp-combined` ⊇ `search-labels-combined` (all 80,239) **and** ⊇ `selfplay-w96` (all 10,870).

So only **three** of the seven search/self-play datasets are independent sources
(`search-labels-1000`, `search-labels-dgx2`, `selfplay-w96`); `search-labels-combined` and `sp-combined`
are derived unions. This is benign if files are used one at a time, but:

1. **Never train on a file and its superset together** — it double-counts the shared positions.
2. **`sp-combined` mixes two value-target semantics** (80,250 deep-search-root-score + 10,871
   terminal-outcome). Training on it as-is averages two non-comparable labels; `--value-source` in
   `train.py` (added `c1974d5`) is the fix.
3. The same canonical position appearing in two files carries **different labels** (search root score
   vs terminal outcome), which is exactly the label conflict the dedup/one-semantics rules prevent.

## Split hygiene (within-file)

Every one of the seven datasets has **0 positions and 0 opening families that cross splits**. The
`splitFor` family-hash grouping is doing its job; the risk was *between* datasets, which the audit above
quantifies.

## Fixes landed

- `training/bot/dataset-audit.py` — `audit` / `dedup` / `qualification` / `positions`. Real pass, no model.
- Reserved **qualification** split: `splitFor(f, reserve)` reserves the first `reserve`% of the
  family-hash space; the reserve is recorded in each manifest (`qualificationReserve`) and reproduced by
  `validate-data.cjs`, so a qualification dataset of those families is provably never trained/tuned on.
  Default `reserve=0` keeps the seven committed datasets byte-reproducible; a run that wants an untouched
  final qualification set passes an explicit reserve.
- `train.py` surfaces `qualificationRows/Games/Families` and treats `qualification` as a split that is
  never trained on.

## Recommended training inputs (no double counting)

- Supervised control: `search-labels-combined` (one semantics) — do NOT also add `search-labels-1000`
  or `-dgx2`.
- Self-play ablation: `selfplay-w96` alone, or `sp-combined` with `--value-source deep-search-root-score`
  (which drops the 10,871 terminal rows).
- Fresh qualification: regenerate with an explicit `--reserve` so final evaluation families are untouched.
