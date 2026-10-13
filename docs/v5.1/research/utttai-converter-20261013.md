# utttai → Mega XOXO converter: implementation, real-data run and rejection evidence

Date: 2026-10-13 · Branch: `V5.1` · Deliverable of the ticket "Build
`training/bot/utttai-converter.py` implementing the design in
`docs/v5.1/research/utttai-analysis.md` §5.2/§5.3, and run it on REAL data to prove it."

This is the executed follow-up to `docs/v5.1/research/utttai-analysis.md` §5 (which designed the
converter but, per its own instructions, did not write one). It writes **only** the converter and small
`.artifacts/` outputs. Neither `src/**` nor any shared pipeline file (`train.py`, `champion_cycle.py`,
…) was touched. `src/game.js` was not modified (sha256
`e6e14c258b4db439eedf28090ebafd0962867bab5e64709d0d4438cb145b31e0`, unchanged from the analysis doc).

## 0. Files written

| Path | Bytes | sha256 |
| --- | --- | --- |
| `training/bot/utttai-converter.py` | 16,011 | `9ce640a6b370cb5fc8d0598943a7b6f423b730e102b3f9b4add5161a84884368` |
| `.artifacts/v51/utttai-stage1-depth00.jsonl` | 2,614 | `30cda8e1227177ab482bfb4cefd790abbdb235e1c1aeb3c1dfc0ff576c5e0941` |
| `.artifacts/v51/utttai-stage1-depth04.jsonl` | 15,461,178 | `81cf4e8fbd91761a65900430e029fa1f2f6af0e939001717fef2ffb9fd36417d` |
| `.artifacts/v51/utttai-stage2-depth04.jsonl` | 32,766,073 | `ce3a6c3fc708b0b1f7950b51c70c93ff946c888b653a248c93eddde4938bb828` |
| `.artifacts/v51/utttai-stage1-depth40.jsonl.gz` | 27,919,748 | `8028deb7be6ec99ef09501893f99edea5f1965f01dd728c3a0fa8165e671e3ec` |
| `.artifacts/v51/utttai-stage2-depth40.jsonl.gz` | 25,253,702 | `3791154d6cf49ee3c03fbc79d72b049731ac30041fa0a5b90f82dbac8a981a48` |

`.artifacts/` is gitignored (`.gitignore:1`). The two `depth40` outputs were ~360 MB each as raw
JSONL; the converter emitted them raw, and they were gzipped in place **after** the sha256 of the raw
bytes was recorded (raw sha256: stage1 depth40 `f3fa69f91c9bc0a77c5c5c18049f31a72e977caae6074d0bed3675df5e60deca`,
stage2 depth40 `c5d4a514083189cb7e32943bb231669178a50c9e0f1f16767ea021c60ad8e109`).

## 1. Archives (re-downloaded; the earlier local copies were deleted mid-task)

The pre-existing `/private/tmp/stage1-mcts.7z` was deleted by an unrelated cleanup and the venv holding
`py7zr` went with it. Both archives were re-downloaded from the upstream Google-Drive file IDs named in
the analysis doc (`stage1` `1y7V1HWKdykuxD6Q8PNhydjPrHxkBr6vu`, `stage2`
`1BxsJ8BmcluRLI6WK8ElIVVwLhCtjn2kQ`) into `/Volumes/T9/utttai-dl/` and sha256-verified:

| Archive | Bytes | sha256 (expected = actual) |
| --- | --- | --- |
| `stage1-mcts.7z` | 853,537,097 | `24732f9110559d0bd9c1e70ba7b51db0351fea1fe7da494ab7b33a37de21a73a` |
| `stage2-nmcts.7z` | 504,013,587 | `533a885a0b1f5ea2433a9de73c41d839b282c2abbc5ec69ae0246119eb9eb250` |

Both hashes match the analysis doc exactly (the first stage1 download was transport-corrupted and
produced a different hash at the same byte length; a clean re-download matched — the Drive `uc?…`
endpoint returns a virus-scan interstitial whose `confirm=t&uuid=…` form must be followed, and a
straight `curl -o` of the first response silently truncates into that HTML on occasion).

`py7zr` is not importable system-wide (`ModuleNotFoundError`); a fresh venv was created at
`/Volumes/T9/utttai-dl/venv` (`python3 -m venv … && pip install py7zr` → py7zr **1.1.4**). Node v26.8.2
is used for our engine/encoder bridge. Nothing large was written to `/`: archives, extracted members
and the venv all live on `/Volumes/T9`.

## 2. Converter design (implements §5.2/§5.3)

`training/bot/utttai-converter.py` streams one `depthNN.txt` member (from a `.7z` via `py7zr` member
extraction, or a plain `--file`), parses each datapoint line and emits a **new** record shape that
reuses **none** of the complete-game schema:

```json
{"schemaVersion":1,"encodingVersion":"planes8-v1","source":"utttai",
 "valueTargetSource":"utttai-mcts-root-mean"|"utttai-nmcts-root-value",
 "planes":[648],"legalMask":[81],"visitTarget":[81],"valueTarget":0.073424,
 "externalSplit":"external",
 "utttai":{"depthFile":"stage1-mcts/depth40.txt","stateSha256":"8e56…b21f"}}
```

* **State → our state** (§5.2.1): 93 digits → `board[b][c]` from `state[b*9+c]`, `mini[b]` from
  `state[81+b]` (`1→'X' 2→'O' 3→'DRAW' 0→null`), `turn` from `state[90]`, `required` = `null` if
  `state[91]===9` else `state[91]`, `winner` from `state[92]`.
* **Encoded with OUR encoder** (§5.2.2): `planes`/`legalMask` come from `E.encode(state)` executed in
  Node against `src/bot/encoding.js` — their 4×9×9 planes are never reshaped.
* **Identity action index** (§5.2.3): `visitTarget[theirIndex] += visits/Σvisits`; their index **is**
  our `b*9+c`, no transpose.
* **Declared non-terminal value** (§5.2.4): `valueTarget` = their root mean state value
  (`(W−L)/V` for stage1, the header `STATE_VALUE_MEAN` for stage2), `valueTargetSource` names the
  dataset, and there is **no** `terminalOutcome`/`terminalValue`/`gameId`/`openingFamily`/`split`.
* **Split** (§5.2.6 option a): the whole corpus is labelled `externalSplit:"external"`; only
  `--split external` is accepted.
* **Dedup** (§5.2.7): keyed on the 93-digit canonical state; the surviving row is the one with the
  **highest root visit count**; drops are counted (`dedupDropped`).
* **Never mixes value sources** (§5.2.8): the two sources are distinct strings.

CLI: `--archive`/`--file` (mutually exclusive, required), `--member`, `--limit N`, `--kind
auto|stage1|stage2`, `--split external` (only value accepted), `--out path.jsonl`, `--tmp`, `--stats`.

## 3. Rejection guards actually implemented (§5.3) — counted by type

Each guard is counted into a named bucket; a rejected row is dropped, never repaired:

| §5.3 | Guard | Bucket |
| --- | --- | --- |
| 1 | 93-digit parse; `state[0..80] ∈ {0,1,2}` | `state_parse` |
| 2 | `state[90]∈{1,2}`, `state[91]∈{0..9}`, `state[92]∈{0..3}` | `field_range` |
| 3 | terminal row (`state[92]!=0`) | `terminal_row` |
| 4a | sub-board win/draw not reproduced by our `G.winner()` | `engine_reject:MACRO_MISMATCH` |
| 4b | mega verdict ≠ our `G.winner(mini)` | `engine_reject:MEGA_MISMATCH` |
| 4c | routing points at a resolved sub-game (their engine normalises it to `9`) | `engine_reject:RULE_CONSTRAINT` |
| 4d | X-first parity violated (mover has fewer stones) | `engine_reject:PARITY` |
| 4e | no legal moves | `engine_reject:NO_LEGAL` |
| 5 | action index set ≠ our recomputed `G.legal()` set | `legal_set_mismatch` |
| 6 | index duplicated / `<0` / `>80`, or `SYMBOL ≠ state[90]` | `bad_action_index` |
| 7 | row token grammar/length | `row_shape` |
| 8 | visits `≤0`, `Σ childVisits ≠ rootVisits−1`, root WDL `≠` visits | `visit_invariants` |
| 9 | `valueTarget` non-finite / outside `[−1,1]` | `value_range` |
| 10 | visit-weighted action values ≠ root value beyond rounding | `value_range_consistency` |

`value_range_consistency` tolerance is `1e-3`, chosen from measurement, not guesswork: the
visit-weighted mean `Σ(vᵢ·valᵢ)/Σvᵢ` reproduces the root value to `max|Δ| = 1.9999e-6` (stage1) and
`1.974e-4` (stage2) — inside the text format's 6-decimal rounding, exactly as the analysis doc's §1.3(d)
predicted (2.0e-6 / 2.0e-4). Guard §5.3-9 (4-ply opening ambiguity) is **not applicable** because no
game-level field (family/split/gameId) is ever written; that is the point of the `external` split.

## 4. Exact commands and measured counts (real bytes)

```
PY=/Volumes/T9/utttai-dl/venv/bin/python
$PY training/bot/utttai-converter.py --archive /Volumes/T9/utttai-dl/stage1-mcts.7z \
    --member stage1-mcts/depth00.txt --limit 200000 \
    --out .artifacts/v51/utttai-stage1-depth00.jsonl --stats
$PY training/bot/utttai-converter.py --archive /Volumes/T9/utttai-dl/stage1-mcts.7z \
    --member stage1-mcts/depth40.txt --limit 200000 \
    --out .artifacts/v51/utttai-stage1-depth40.jsonl --stats
$PY training/bot/utttai-converter.py --archive /Volumes/T9/utttai-dl/stage2-nmcts.7z \
    --member stage2-nmcts/depth40.txt --limit 200000 \
    --out .artifacts/v51/utttai-stage2-depth40.jsonl --stats
# plus stage1/stage2 depth04 (dedup-rich layer)
```

| Member | kind | rows in | rows out | dedup dropped | rejected | max value Δ | wall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `stage1-mcts/depth00.txt` | stage1 | 18 | 1 | 17 | **0** | 1.07e-6 | 0.25 s |
| `stage1-mcts/depth04.txt` | stage1 | 12,504 | 7,079 | 5,425 | **0** | 1.18e-6 | 0.3 s |
| `stage2-nmcts/depth04.txt` | stage2 | 15,000 | 15,000 | 0 | **0** | 6.09e-6 | 0.5 s |
| `stage1-mcts/depth40.txt` | stage1 | 167,381 | 167,381 | 0 | **0** | 2.00e-6 | 33.7 s |
| `stage2-nmcts/depth40.txt` | stage2 | 165,641 | 165,641 | 0 | **0** | 1.97e-4 | 23.8 s |

**On the genuine shipped bytes, every one of the 360,544 parsed rows passes every guard** (rejection
histogram is empty for all five runs) — and the stage1 `depth00` duplicates (18 rows → 1 state) and
`depth04` duplicates (12,504 → 7,079) are exactly the repeats the analysis doc's §2.3 predicted.

Dedup was cross-checked **independently** of the converter with `cut -c16-108 … | sort -u | wc -l`
(the 93-digit state is columns 16–108 after the `evaluatedState{` prefix):

| Member | rows | distinct states (independent) | converter `rowsOut` |
| --- | ---: | ---: | ---: |
| stage1 depth00 | 18 | 1 | 1 |
| stage1 depth04 | 12,504 | 7,079 | 7,079 |
| stage2 depth04 | 15,000 | 15,000 | 15,000 |
| stage1 depth40 | 167,381 | 167,381 | 167,381 |
| stage2 depth40 | 165,641 | 165,641 | 165,641 |

### 4.1 Guard self-test on deliberately corrupted rows (the guards are not dead code)

Because the shipped bytes never trip a guard, each guard was exercised by hand-corrupting a real
`depth04`/`depth10` row (Python driver in `/tmp`, ephemeral) and running the converter on the single
crafted line. Every corruption produced **exactly one** rejection bucket and **0** rows out:

| Crafted corruption | Expected bucket | Observed | rowsOut |
| --- | --- | --- | ---: |
| cell = `3` | `state_parse` | `state_parse` | 0 |
| state truncated to 92 digits | `state_parse` | `state_parse` | 0 |
| `state[90] = 5` | `field_range` | `field_range` | 0 |
| `state[92] = 7` | `field_range` | `field_range` | 0 |
| `state[92] = 1` (terminal) | `terminal_row` | `terminal_row` | 0 |
| duplicate action index | `bad_action_index` | `bad_action_index` | 0 |
| action index `81` | `bad_action_index` | `bad_action_index` | 0 |
| action symbol ≠ mover | `bad_action_index` | `bad_action_index` | 0 |
| one action moved onto an occupied cell | `legal_set_mismatch` | `legal_set_mismatch` | 0 |
| one action removed | `visit_invariants`¹ | `visit_invariants` | 0 |
| `rootVisits += 5` | `visit_invariants` | `visit_invariants` | 0 |
| root `W += 5` (W+D+L ≠ V) | `visit_invariants` | `visit_invariants` | 0 |
| stage2 header value `5.0` | `value_range` | `value_range` | 0 |
| stage2 root sign flipped | `value_range_consistency` | `value_range_consistency` | 0 |
| mover forced to the wrong parity | `engine_reject:PARITY` | `engine_reject:PARITY` | 0 |
| routing pointed at a resolved sub-game | `engine_reject:RULE_CONSTRAINT` | `engine_reject:RULE_CONSTRAINT` | 0 |
| macro claim corrupted | `engine_reject:MACRO_MISMATCH` | `engine_reject:MACRO_MISMATCH` | 0 |
| 3 sub-boards force an X mega-line, result left `0` | `engine_reject:MEGA_MISMATCH` | `engine_reject:MEGA_MISMATCH` | 0 |

**18/18 crafted corruptions rejected, and every row was removed by the intended guard.** (Two notes on
ordering, both expected: the `RULE_CONSTRAINT` case needs a state with a resolved sub-game, which does
not exist at `depth04`, so a `stage1-mcts/depth10.txt` row was used; and the "one action removed" row is
caught by `visit_invariants` because dropping an action also breaks `Σ childVisits = rootVisits−1`,
which is checked before the engine — the *dedicated* `legal_set_mismatch` case is the "moved onto an
occupied cell" row, where visits are untouched but the index set differs from `G.legal()`.)

**All rejection counts on shipped data are 0 and all rejection counts on crafted data are ≥1 — so the
histogram is a live guard, not decoration.**

## 5. Verification (acceptance #2) — every emitted row

Command (Node, our own `src/game.js` + `src/bot/encoding.js`, independent of the converter; it reads
the five outputs as a stream because concatenating them exceeds Node's max string length):

```
node - .artifacts/v51/utttai-stage1-depth00.jsonl .artifacts/v51/utttai-stage1-depth04.jsonl \
        .artifacts/v51/utttai-stage2-depth04.jsonl .artifacts/v51/utttai-stage1-depth40.jsonl.gz \
        .artifacts/v51/utttai-stage2-depth40.jsonl.gz
```

The checker reconstructs the state from `planes + legalMask` alone (which side is to move is derived
from the own/opponent stone counts — `co===cp ⇒ X`, `co===cp+1 ⇒ O`), calls `E.encode(state)`, and
compares the result to the row's stored `planes` (648) and `legalMask` (81), then asserts the
`visitTarget` invariants and the `valueTarget` range. Result:

```
{"rowsVerified":355102,"planeMismatch":0,"legalMaskMismatch":0,"parityUnderivable":0,
 "visitSumNotOne":0,"maxAbsSumErr":1.4e-8,"nonzeroOnIllegal":0,"valueOutOfRange":0}
VERIFY PASS
```

Verified: `planes` reproduce from our encoder exactly (648/648) and `legalMask` equals `G.legal()`
(81/81) for **all 355,102 emitted rows**; `visitTarget` sums to 1 within `1.4e-8` (the residual is only
the 9-decimal rounding used when scattering) and is non-zero **only** on legal indices; every
`valueTarget ∈ [−1,1]`.

### 5.1 Sample emitted rows (values elided for `planes`/`legalMask`/`visitTarget`)

```
{"schemaVersion":1,"encodingVersion":"planes8-v1","source":"utttai",
 "valueTargetSource":"utttai-mcts-root-mean",
 "planes":[648],"legalMask":[81],"visitTarget":[81],"valueTarget":0.073424,
 "externalSplit":"external","utttai":{"depthFile":"stage1-mcts/depth40.txt","stateSha256":"8e563c63…"}}
   visitTarget non-zero: 54→0.07809, 55→0.01918, 58→0.77239, 62→0.13034
{"schemaVersion":1,"encodingVersion":"planes8-v1","source":"utttai",
 "valueTargetSource":"utttai-nmcts-root-value", … "valueTarget":0.017652,
 "utttai":{"depthFile":"stage2-nmcts/depth40.txt","stateSha256":"5b867607…"}}
   visitTarget non-zero: 27→0.0056, 30→0.0076, 31→0.14891, 33→0.0002, 34→0.82998, 35→0.0077
```

Action indices are `b*9+c` (identity), and `stateSha256` is `sha256` of the raw 93-digit string, so a
row is reproducible from its source without storing the state twice.

## 6. Disk (`/`) before / after / peak (acceptance #4)

| Point | `/` free |
| --- | --- |
| Before the run (parent's cleanup just completed) | **14 GiB** |
| Lowest observed (during a 360 MB raw `depth40` JSONL write) | **13 GiB** |
| After gzip + raw-file removal | **14 GiB** |

`/` never dropped below **13 GiB**, far above the ~3 GiB floor. All archives, extracted members and the
`py7zr` venv were placed on `/Volumes/T9`; only the (gitignored, gzipped) `.artifacts/v51/` outputs sit
on `/`, totalling ~76 MB.

## 7. What was NOT run / not verified, and why

* **The anticipated blocker — "stage2 absent locally" — did not apply.** `stage2-nmcts.7z` was
  re-downloaded (sha256-verified, §1) and **both** `stage2 depth04` and `stage2 depth40` were run, so
  the stage-2 grammar (`SYMBOL INDEX VISIT_COUNT STATE_VALUE_MEAN`) is proven on real bytes, not just
  designed. The only datasets not converted are the depths not selected by `--member`.
* **The full corpus (all 81 depths × 2 datasets = 16,005,010 rows)** was not converted. The runs here
  are bounded (`--limit 200000`) per acceptance; the largest executed member (`depth40`) converted its
  entire 167,381 rows. A full pass is possible but out of scope for this ticket.
* **`train.py` was not modified.** The record shape deliberately declares `valueTargetSource` without
  `terminalOutcome`/`terminalValue`, which `train.py:24-40` rejects; wiring a new declared source (or a
  dedicated consumer) for `external` rows is a `train.py` change that the **parent owns**. These
  `.jsonl` files are therefore not yet consumable by `train.py` by design (analysis §5.2.4).
* **Guard §5.3-9 (4-ply opening ambiguity)** is not exercised on real data, because no game-level field
  is written. If a future variant wants a reconstructed `openingFamily`, it must additionally reject the
  9.0 % ambiguous `depth04` rows (467/1,345 cross-split) and ~everything at `depth06+`.
* **No strength/league claim.** These rows are off-policy supervision only; nothing here says utttai
  strength transfers to Mega XOXO.
* `[UNVERIFIED]` remains the dataset's own explicit licence grant (repo-level Apache-2.0 is inferred to
  cover the Drive files); the derived `.artifacts/` files are local-only and not redistributed, so no
  §4 attribution obligation is triggered yet.

## 8. Verdict

The converter implements §5.2/§5.3, runs on real bytes from both re-verified archives, and on the
shipped data trips **zero** guards while every guard demonstrably fires on crafted corruption
(18/18). All 355,102 emitted rows independently verify against our own `src/game.js`/`encoding.js`,
and dedup matches an independent distinct-state count exactly. The output is a new, honest,
external-split, non-terminal supervision corpus — no game id, opening family, split or terminal
outcome was invented.
