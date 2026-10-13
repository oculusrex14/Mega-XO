# utttai (`arnowaczynski/utttai`) — rules, data and licence analysis for Mega XOXO V5.1

Research deliverable for Phase 2 of `docs/v5.1/research/MULTI-LLM-AND-RL-PROGRAMME.md`
("External data (`arnowaczynski/utttai`): rules/board compatibility, licence, and a validated converter
or an explicit rejection. Never change our rules to accept external records.").

Everything below is **locally-tested** against a real shallow clone and the **real downloaded archives**
unless the line carries `[UNVERIFIED]` or `provider-reported`. No production/live-V4/model-catalog/
release-gate/spend item is touched; `src/game.js` was not modified.

## 0. Scope and method (evidence trail)

| Item | Value |
| --- | --- |
| Upstream repo | `https://github.com/arnowaczynski/utttai` (Apache-2.0, default branch `main`) |
| Clone | `git clone --depth 1 https://github.com/arnowaczynski/utttai.git` → `/tmp/utttai-clone` |
| Upstream HEAD | `622dae66b18198f6f12aef0a0bccd5bd40de2d8e` (2022-04-23) — `git log -1` on the shallow clone; `pushed_at` `2022-04-23T12:55:22Z` (GitHub API) |
| Upstream repo size | 2.2 MB working tree, 488 KB `.git` (no data committed; see §2) |
| Our checkout | `c1974d5145d509c2f7fca0c84a825da30ecb5916` (`fix(learning): best-validation export…`); `src/game.js` sha256 `e6e14c258b4db439eedf28090ebafd0962867bab5e64709d0d4438cb145b31e0` |
| Our encoding | `src/bot/encoding.js` sha256 `1eea6e4fbbc0d411feba8dfca8455f39fe2fd68996a13618718b56b86a6c9511` |
| Dataset 1 | `stage1-mcts.7z` — 853,537,097 bytes, sha256 `24732f9110559d0bd9c1e70ba7b51db0351fea1fe7da494ab7b33a37de21a73a` |
| Dataset 2 | `stage2-nmcts.7z` — 504,013,587 bytes, sha256 `533a885a0b1f5ea2433a9de73c41d839b282c2abbc5ec69ae0246119eb9eb250` |
| Extraction | `py7zr` 1.1.4; both archives extracted in full (81 `depthNN.txt` members each) |
| Upstream unit tests | `python3 -m pytest tests/ -q` on the clone → **5 passed** (0.22 s) |
| Our cross-validation | Two engines run side by side: their `utttpy` (imported as a library) and our `src/game.js` via `node` |

Reuse of the external data is evaluated as a **data-provenance** question only. No converter was
written (per instruction); this document designs one and states the rejection rules.

---

## 1. Rules and board representation vs our canonical `src/game.js`

### 1.1 Where their rules live

Their engine is implemented three times, byte-compatible with each other:

- Python reference: `utttpy/game/ultimate_tic_tac_toe.py` (+ `constants.py`, `action.py`, `helpers.py`).
- C++ (dataset producer): `utttcpp/src/utttcpp/game/ultimateTicTacToe.cpp` (+ `include/.../constants.hpp`).
- Browser (deployed): `website/src/game/UltimateTicTacToe.js` (+ `constants.js`, `helpers.js`).

Their state is a **93-byte array** (`STATE_SIZE = 93`, `constants.py:3`):

- `state[0..80]` — the 81 cells, `0` empty, `1` = X, `2` = O.
- `state[81..89]` — macro cells, `0` open, `1` = X claimed, `2` = O claimed, `3` = drawn.
- `state[90]` — next symbol (`1` = X, `2` = O).
- `state[91]` — routing (`0..8` = required subgame, `9` = unconstrained).
- `state[92]` — mega-board result (`0` ongoing, `1`/`2` win, `3` draw).

Our state (`src/game.js:7`, `create()`): `board` 9×9 of `null|'X'|'O'`, `mini[9]` of
`null|'X'|'O'|'DRAW'`, `turn`, `required` (`null` = free, else `0..8`), `winner`, `line`, `moves`.

### 1.2 Rule-by-rule comparison

| Aspect | utttai | Mega XOXO (`src/game.js`) | Verdict |
| --- | --- | --- | --- |
| Shape | 9 macro boards × 3×3 = 81 cells | identical. Cell index in their array `i` is `subgame*9+cell` (`_get_empty_indexes`, `ultimate_tic_tac_toe.py:101-105`) | **match** (index space identical) |
| Move | `Action(symbol, index)`, `index 0..80`, `symbol` must equal `next_symbol` | `{b,c}` with `b=index//9`, `c=index%9`; forced to `turn` | **match** |
| Macro claim | Win a subgame by any of the 8 lines, `_is_winning_position` (`ultimate_tic_tac_toe.py:107-136`) | `LINES` = the same 8 lines (`src/game.js:4`), `winner()` (`src/game.js:8`) | **match** |
| Drawn subgame | Subgame full with no winner ⇒ macro `DRAW` (`_update_supergame_result`, `:142-149`) | `board[b].every(Boolean)` ⇒ `mini[b]='DRAW'` (`step`, `src/game.js:17`) | **match** |
| Mega win | 3 claimed subgames in a line (`_is_winning_position(symbol, subgame=9)`, `:153`) | `winner(n.mini)` (`src/game.js:18`) | **match** |
| Mega draw | All 9 macro cells non-open (`_is_full(9)` ⇒ `DRAW`, `:154-155`) | `n.mini.every(Boolean)` ⇒ `'DRAW'` (`src/game.js:18`) | **match** |
| Routing after a move | `next_subgame = index % 9`; if that subgame is already resolved ⇒ unconstrained `9`, else that subgame (`_set_next_constraint`, `:163-167`) | `required = mini[c] ? null : c` (`step`, `src/game.js:19`) | **match** |
| Forced-move override | If sent to a **finished** subgame, all unfinished subgames are legal — implemented by the `9` sentinel + `get_legal_indexes` (`:53-61`) | `legal()` treats `required===null \|\| mini[required] \|\| required===b` (`src/game.js:9`) | **match** |
| Legal set when unconstrained | every empty cell of every non-resolved subgame (`:55-60`) | same (`src/game.js:9`) | **match** |
| Terminal detection | `result` field non-zero (`is_terminated`, `:89`) | `winner !== null` | **match** |
| Scoring | win ⇒ winner; no material score; **no early stop** — play continues until a mega line or a full board | identical (`winner` + `mini.every`) | **match** |
| Move-order bookkeeping | `state[90]`, `state[91]`, `state[92]` serialised **in** the state | recomputed by `create`/`step` | **match** (representation differs, semantics same) |
| First player | always X (constructor sets `next_symbol = X`, `:21-26`); both shipped datasets are X-first (verified in §1.3b) | `create(first)` accepts `'X'` **or** `'O'` and our generator really uses both (`generate.cjs:108,141`: `G.create(seed % 2 ? 'O' : 'X')`) | **mismatch (ours is a superset)** |
| Illegal-move checking | extensive `_verify_state` (`:170-222`) incl. a `constraint`-consistency check | `apply` throws `ILLEGAL_MOVE` for out-of-set moves | equivalent for legal play |

**Rule verdict: the rules are the same game.** This is not a claim from reading alone; it was executed.

### 1.3 Executed equivalence evidence

**(a) 400 full games, two independent engines, position by position.**

Our generator played 400 complete X-first games with `src/game.js`; every position (turn, macro array,
required subgame, **and the full legal-index set**) was fed into their Python `UltimateTicTacToe`:

```
games 400  avg_len 58.69
positions_ok 23876  positions_bad 0
legalsets_ok 23876  legalsets_bad 0
terminal_mismatch 0
```

So the legal-index sets agree at **every one of 23,876 positions** (23,876/23,876), and the terminal
verdict agrees on all 400 games. (Our engine's average length 58.7 here is from **uniform-random** play,
not the ~40–50 plies the project's blog reports for strong play — different behavior policy, so this is
not a contradiction [INFERENCE].)

**(b) Whole shipped datasets, every row, against our engine.**

Both released archives were extracted in full and every one of the 16,005,010 datapoint lines was parsed
and replayed through `src/game.js`:

| Check | `stage1-mcts` (8,001,990 rows) | `stage2-nmcts` (8,023,020 rows) |
| --- | --- | --- |
| parse failures | 0 | 0 |
| their `_verify_state()` rejects | 0 | 0 |
| macro claims inconsistent with our `G.winner(mini)` | 0 | 0 |
| turn/routing/result fields out of range | 0 | 0 |
| **legal-index set ≠ our `G.legal()` set** | **0** | **0** |
| action indices outside 0..80 / duplicated | 0 | 0 |
| action symbol ≠ current mover | 0 | 0 |
| depth == count of non-zero cells (`depthNN.txt`) | 0 mismatches | 0 mismatches |
| positions with fewer X than O (X-first invariant) | 0 | 0 |

This is a full-file pass, not a sample. On the exact released bytes, the two rule sets are
**indistinguishable**.

**(c) Value-sign convention (our §-level requirement) — verified on decisive rows.**

Our convention is `E.value(winner, player) = +1` win / `0` draw / `−1` loss **for the side to move in the
recorded state** (`src/bot/encoding.js:21`). Theirs matches:

- Their NMCTS value is the **root's mean state value, sign-flipped twice** so it is side-to-move-relative:
  `backprop` alternates the sign up the path (`neuralMonteCarloTreeSearchWorker.cpp:407-411`,
  also `neural_monte_carlo_tree_search.py:136-142`), and `getEvaluatedActions` reports
  `-childNodes[i]->stateValueMean` (`neuralMonteCarloTreeSearch.cpp:111`) so the action value is from the
  parent mover's view.
- Terminal leaf for the mover is `-1.0`, draw `0.0` (`neuralMonteCarloTreeSearchWorker.cpp:380-386`) —
  i.e. the perspective is "value of the position for the player who is about to move".
- Empirically on real 1.0-magnitude rows: `mover=O, value=0.9998, best action 74 → utttai result O_WON`;
  `mover=X, value=-0.9964` on a lost position, etc. 8 decisive rows checked across stage1/stage2.

**Value convention: `+1/−1/0` side-to-move, exactly ours.** (Note the *derivation* differs — see §4.3 —
but the *convention* is the same.)

**(d) Root-value/action-value consistency.** For all 16,005,010 rows, the visit-weighted mean of the
per-action values equals the root value to `max|Δ| = 2.0e-4` (stage2) and `2.0e-6` (stage1) — the
residual is only the 6-decimal rounding in the text format. And `rootVisits − Σ childVisits = 1` for
**every** row of both datasets (16,005,010/16,005,010), i.e. the root itself consumes exactly one
simulation. Both are strong internal-consistency checks that the files are what the code says.

### 1.4 Where the two differ at all

1. **First player.** utttai is X-first only; we support X **and** O starts. Consequence: utttai data can
   only ever cover one of our two first-player cases; an O-first record cannot come from utttai.
2. **Encoding layout.** Their 4×9×9 planes vs our `planes8-v1` 8×9×9 (`src/bot/encoding.js:4-6`):
   - theirs ch0 = mover's marks, ch1 = opponent's marks, **ch2 = constant ±1 fill**, ch3 = legal cells
     (`utttpy/game/helpers.py:21-45`; the browser uses `getStateArray324` with the same layout,
     `website/src/game/helpers.js:12-45`).
   - ours: ch0 own marks, ch1 opp marks, ch2 own mini-board, ch3 opp mini-board, ch4 drawn mini-board,
     ch5 required mini-board, ch6 legal cells, ch7 free route.
   - Verified: our ch0/ch1 reproduce their ch0/ch1 semantics exactly (both are side-to-move-relative
     own/opponent marks), and our ch6 equals their ch3 (legal cells). Their ch2 is a constant ±1 fill; it
     has no counterpart in ours, but our ch5 (required mini-board) + ch7 (free route) carry the routing
     information it stands in for. Our ch2/ch3/ch4/ch5/ch7 have no utttai counterpart at all.
   - Their visual flattening `row_index/col_index` (`helpers.py:11-19`) is exactly our `spatial()`:
     `spatial(i//9, i%9) === i` for all 81 — verified.
3. **Action-space index — this is the one place a naive converter breaks.**
   Their dataset action index `i` is `subgame*9 + cell`, i.e. it **is** our canonical policy index
   `b*9+c` (`src/bot/board.js:43`, `src/bot/encoding.js` header). It is **not** the visual `spatial(b,c)`.
   Verified: `their i === our b*9+c` for all 81 (identity), while `spatial(b,c) ≠ their index` for 54 of
   the 81 indices (e.g. their `i=3` is our policy index 3 = visual cell 9; their `i=9` is our policy
   index 9 = visual cell 3). A converter that assumed visual row-major would silently transpose the
   policy for 2/3 of the actions. **Identity mapping is the correct one.**

---

## 2. Data inventory

### 2.1 Datasets

Both datasets are described in `datasets/README.md` (upstream) and on the `datasets/` folder; they are
**not** in Git — `datasets/.gitignore:1-4` ignores `stage1-mcts/`, `stage1-mcts.7z`, `stage2-nmcts/`,
`stage2-nmcts.7z`.

| | `stage1-mcts` | `stage2-nmcts` |
| --- | --- | --- |
| Generator | pure MCTS with **random playouts** (`datasets/README.md:5`) | NMCTS with the PVN first trained on stage1 (`:30`) |
| Positions (claimed) | 8,001,990 (`:5`,`:11`) | 8,023,020 (`:30`,`:36`) |
| Positions (measured, full extraction) | **8,001,990** | **8,023,020** |
| Avg simulations/position (claimed) | 1,359,479 (`:11`) | 10,000 (`:36`) |
| Distribution | 7,049,309 @1M; 952,681 @~4.0M (`:9-11`) | 8,022,643 @10k; 377 @20,610 (`:34-36`) |
| Download | `https://drive.google.com/file/d/1y7V1HWKdykuxD6Q8PNhydjPrHxkBr6vu/view` (`:26`) | `https://drive.google.com/file/d/1BxsJ8BmcluRLI6WK8ElIVVwLhCtjn2kQ/view` (`:49`) |
| Archive size | 815 MB claimed (`:26`) / **853,537,097 B measured** | 481 MB claimed (`:49`) / **504,013,587 B measured** |
| Extracted size | 2.6 GB claimed / **2,787,631,947 B (2.596 GiB) measured** | 2.1 GB claimed / **2,181,440,799 B (2.032 GiB) measured** |
| Archive member count | 81 files, `depth00.txt` … `depth80.txt` | 81, same naming |
| Layout | one file per ply; `depth00` = empty board | same |
| Empty files | `depth77..depth80` (and stage2 also `77..80`) | same |
| Real deepest ply shipped | **76** (all deeper layers empty) | **76** |
| Rows with a non-zero terminal result field | **0** | **0** |

Measured sample hashes (for a future converter to pin, do not treat as archive-wide manifests):
`stage2-nmcts/depth00.txt` `dc2ca5a1fc26ce9fed41f7a566c92222b6f4b1f0ef9cc7c9364594b16f098dcb`,
`stage2-nmcts/depth01.txt` `a26d724ac8420a60fa7a95fd4be397450fd3b4eadb9bfc13d8ed5c90b17984b1`,
`stage2-nmcts/depth60.txt` `a088a2cd0a0e98e5146bb98d33bb28f246f8a0ed0a1e9bcde1963a61f4a853ce`,
`stage1-mcts/depth00.txt` `b6ddcfa4c17fc491203b3c8ade910ab43cc1fbe6d79b1f9e8ddfc14de041472d`,
`stage1-mcts/depth60.txt` `6f8c521711e4097ad32d6b2b7dcbed2362c887a9d9a8378f9d62544b13612aca`.

All four Google Drive URLs (both file downloads and both folder pages) were reachable
(`HTTP 200`); the file endpoints returned `content-disposition: attachment; filename="stage1-mcts.7z"` /
`"stage2-nmcts.7z"`. The **full archives were downloaded and extracted**, so the "format/size/valid
UTTT play" claims below are measured, not quoted.

### 2.2 Exact row format (one datapoint per line)

`stage1-mcts` (`datasets/README.md:23`; parser `utttpy/selfplay/datatools.py:57-94`; writer C++
`utttcpp/src/utttcpp/selfplay/monteCarloTreeSearch.cpp:13-51` and Python
`utttpy/selfplay/monte_carlo_tree_search.py:315-339`):

```
evaluatedState{UTTT_STATE NUM_VISITS NUM_WINS NUM_DRAWS NUM_LOSSES} evaluatedActions{SYMBOL INDEX NUM_VISITS NUM_WINS NUM_DRAWS NUM_LOSSES, ...}
```

- `UTTT_STATE` = 93 digits concatenated, no separators.
- root `value = (NUM_WINS − NUM_LOSSES) / NUM_VISITS` (`datatools.py:67`), **side-to-move-relative**
  (`Node::getEvaluatedState` selects `numWinsX/O` by whose turn it is,
  `monteCarloTreeSearch.cpp:92-99`).
- action probability = the child's `numVisits` normalised over the actions (`datatools.py:87`).
- action value = `(win − loss)/visits` at the child (`datatools.py:83`).

`stage2-nmcts` (`datasets/README.md:46`; parser `datatools.py:96-123`; writer
`utttcpp/src/utttcpp/selfplay/neuralMonteCarloTreeSearch.cpp:14-49`):

```
evaluatedState{UTTT_STATE VISIT_COUNT STATE_VALUE_MEAN} evaluatedActions{SYMBOL INDEX VISIT_COUNT STATE_VALUE_MEAN, ...}
```

- `STATE_VALUE_MEAN` is the root's backpropagated mean value; action value is `−childMean` so it is
  parent-relative.

Neither format has: a game id, an opening family, a split, a player-to-move label (it is derived: parity
of the stone count, or `state[90]`), a terminal outcome, or any provenance string. `SYMBOL` is redundant
with `state[90]`.

### 2.3 Are these legal Ultimate Tic-Tac-Toe positions from real play?

**Yes — verified, not assumed.** All 16,005,010 rows: their own `_verify_state()` accepted every one,
our `src/game.js` reproduced the identical legal-index set for every one, macro claims match our
`winner()` for every one, depth file == real stone count for every one, and the X-first/parity invariant
holds for every one. So the rows are genuine, legal UTTT positions.

**But they are not games.** They are a ply-indexed *position* corpus:

- No row in either dataset has a non-zero terminal result field, and no file beyond ply 76 exists.
- They are incomplete sets of games. On the shipped layers, sampling 150 parents per layer: for
  ply→ply+1, **100 %** of children are present at ply 1–3, but only **28.1 %** at 3→4, **20.9 %** at 4→5,
  **13.6 %** at 5→6 and ~12 % thereafter (stage2; stage1 is similar: 64 % → 45 % → 35 % → 27 % → 21 % →
  14 % → 13 %). So the corpus is a heavily subsampled tree, not a set of complete self-play games.
- Reconstructing the 4-ply opening from a shipped ply-≥4 state works for **13,655/15,000** (91.0 %) of
  stage2 `depth04` rows, but is **ambiguous** for the remaining 1,345 (91.0 % unique / 9.0 % ambiguous,
  0 unresolved). Worse, ambiguity is not stable: at `depth06` only ~0 % are unique, at `depth10` ~0.75 %,
  and at `depth20`+ the number of distinct 4-ply openings consistent with the state explodes into the
  dozens-to-hundreds.
- Critically, among the ambiguous `depth04` rows, **467 of 1,345 (34.7 %)** have candidate openings that
  map to **different** `splitFor()` buckets — i.e. train vs validation vs holdout (`splitFor` in
  `training/bot/generate.cjs:29`). `depth10` is far worse: 293/394 ambiguous rows are cross-split.
- Positions **repeat** across rows: `depth00` has 5 rows for 1 distinct state; `depth01` 120 rows for 81
  distinct; `depth05` 75,202 rows for 74,349 distinct. Duplicates carry different visit counts and
  different value estimates (same position evaluated to different precision at different depths).

**Consequence: the shipped corpus cannot supply a legal game id, a legal opening family, a legal split,
a complete game, or a terminal outcome.** Any of those fields must be synthesised — and synthesising a
split from an ambiguous opening is exactly the leakage our split discipline forbids.

---

## 3. Licence and reuse

### 3.1 Licence

- Repository root `LICENSE` is the **Apache License, Version 2.0** (full text, 11,357 bytes). GitHub's
  API reports `"license": {"spdx_id": "Apache-2.0"}`. There is **no `NOTICE` file** in the repo
  (`find . -iname 'NOTICE*'` → nothing), so Apache-2.0 §4(d) has no upstream NOTICE to reproduce.
- `README.md:113-115`:
  > ## License
  >
  > This project is licensed under the [Apache License 2.0](LICENSE).
- The `LICENSE` file itself carries no copyright holder name (it still contains the
  `Copyright [yyyy] [name of copyright owner]` placeholder at line 189, as the unmodified template).
  Git history identifies the author/committer as `ar-nowaczynski <ar.nowaczynski@gmail.com>`
  (HEAD commit `622dae6`, 2022-04-23).
- The two Google Drive dataset folders and both dataset files carry **no licence text of their own**
  (checked the folder pages; only the *GitHub* repo declares Apache-2.0). This is the one real
  licensing gap, discussed in §3.3; if derived data is ever committed, §4(a)/(c) attribution applies.

### 3.2 The operative grant

Apache-2.0 §2 (quoted from the upstream `LICENSE`, beginning at file line 66):

> "Grant of Copyright License. Subject to the terms and conditions of this License, each Contributor
> hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable
> copyright license to reproduce, prepare Derivative Works of, publicly display, publicly perform,
> sublicense, and distribute the Work and such Derivative Works in Source or Object form."

Apache-2.0 §3 (patents) grants a patent licence for patent claims necessarily infringed by the
contributions. §4 imposes the redistribution conditions: (a) include a copy of the Licence, (b) mark
modified files, (c) retain attribution notices from the Source form, (d) reproduce any NOTICE file
(none here). §7 provides the "AS IS", no-warranty disclaimer; §8 limits liability.

### 3.3 Is reuse/derivation permitted? — assessment

- **Code**: yes. Apache-2.0 explicitly grants "prepare Derivative Works of … and distribute the Work and
  such Derivative Works … in Source or Object form" (§2, quoted above). Apache-2.0 is a standard
  permissive licence with an explicit patent grant and is compatible with our research-only, non-
  commercial, offline use.
- **Conditional obligation**: if any utttai code or data is actually redistributed (not merely used
  locally), we must ship the Apache-2.0 text and mark modified files (§4(a)(b)), and retain the
  attribution notice (§4(c)). Our `training/bot/README.md` already states
  "No pretrained weights or external datasets are included" and "The repository has no root LICENSE
  file in the inspected base, so do not invent a license grant for its code or weights" — that standing
  policy is compatible with this use, but would need to be **updated if any utttai-derived artifact is
  ever committed**, because the *base repo* (ours) has no root LICENSE.
- **Datasets**: `[INFERENCE]` — the repo-level Apache-2.0 is the author's own declared licence for "this
  project", and the datasets are published by the same author from the repository's README; there is no
  separate dataset licence or terms-of-use, and no contradictory terms on the Drive pages. The
  conservative reading is that the datasets are covered by the same Apache-2.0 grant, but a converter
  should record this as an inference and, if the derived data is ever redistributed, attribute the
  upstream author and include the Apache-2.0 text. This is a **documentation gap to flag, not a legal
  clearance**; a human/owner decision is required before any redistribution.
- **Trademarks**: Apache-2.0 §6 grants no trademark rights; "uttt.ai" / "utttai" names must not be used
  as a product mark. Not a blocker for internal research data.

**Licence verdict: reuse and derivation are permitted by Apache-2.0; redistribution of anything derived
carries the §4 attribution obligation, and the dataset's own licence status is an inference
(`[UNVERIFIED]` as an explicit dataset grant).**

---

## 4. The iterative neural-MCTS loop, and what made it improve

### 4.1 The loop (documented + code-verified)

1. **Stage 1 — bootstrap from pure MCTS.** MCTS with random playouts, single-threaded, synchronous
   (`utttcpp/src/mcts-generate.cpp`; `MonteCarloTreeSearch::simulate` in
   `utttcpp/src/utttcpp/selfplay/monteCarloTreeSearch.cpp:322-339`). Self-play games were played
   start-to-finish; at each ply the tree is **synchronised** to the played child and re-run for
   `numSimulations − rootVisits` more simulations (`run()`, `:255-260`), so each position accumulates a
   *fresh* visit distribution (`mcts-generate.cpp:98-116`). Move selection: `"sample"` (visit-
   proportional), also `argmax`/`random` (`selectAction`, `:259-298`).
2. **Stage 1 training.** `scripts/train_stage1.py` → `train_policy_value_net` (`utttpy/selfplay/training.py`):
   **100,000 iterations, batch 2048**, Adam, LR schedule 5e-5 → 3e-4 → 1e-4 → 3e-5
   (`train_stage1.py:36-55`), automatic mixed precision. Loss = masked **KL divergence** policy
   (`policy_loss_weight 1.0`) + masked MSE **action-values** (`1.0`) + MSE **state value** (`3.0`)
   (`policy_value_loss.py:44-49`).
3. **Stage 2 — NMCTS self-play with that net.** `utttcpp/src/nmcts-generate.cpp:200-241`: same loop, but
   each simulation evaluates a leaf with the PVN (`evaluate(leafNode, 1.0)`,
   `neuralMonteCarloTreeSearch.cpp:314-320`), selects by `Q = −childMean` plus a **PUCT** term
   (`U ∝ explorationStrength · policyProb · √parentVisits / (childVisits+1)`,
   `neuralMonteCarloTreeSearch.py:98-108`), and backpropagates with alternating sign (`:136-142`).
   **No Dirichlet noise and no temperature schedule** — `grep -rni "dirichlet\|noise\|temperature"` over
   `utttpy/`, `scripts/`, `utttcpp/`, `website/src/` finds only the `softmax_temperature=1.0` argument
   (`neural_monte_carlo_tree_search.py:82,110,130,178,196`). So this is *not* AlphaZero's exploration
   recipe.
4. **Stage 2 training.** `scripts/train_stage2.py`: initialised from the stage-1 checkpoint, 100,000
   iterations, batch 2048, KL-divergence policy, action-values weight lowered **1.0 → 0.5**, state-value
   weight **3.0** (`train_stage2.py:40-59`).
5. **Data augmentation.** Two mirror flips + a transpose (`random_orientation_inplace`,
   `training.py:155-172`) — an 8-fold D4 augmentation, applied at training time, not materialised.
6. **Evaluation.** Tournament between MCTS, NMCTS1 (stage1) and NMCTS2 (stage2), each in "quick" and
   "strong" versions; **100 games per match from 50 unique positions, each played twice with sides
   swapped** (`README.md:52-65`; positions in `utttpy/selfplay/evaluation_uttt_states.py`, 50 states,
   all length 93).
7. **Deployed artifact.** `NMCTS2` is the model on `uttt.ai` (`README.md:82`), exported with
   `scripts/export_policy_value_net_onnx.py` and run in-browser via `onnxruntime-web`
   (`website/src/selfplay/NeuralMonteCarloTreeSearch.js:1,222,251`).

### 4.2 Scale

| Quantity | Value | Source |
| --- | --- | --- |
| PVN size | ~5M parameters, 20 MB | `README.md:24` |
| PVN input | 4×9×9 planes, 256 planes | `policy_value_network.py:11` |
| PVN output | policy logits 81 + action values 81 + state value (tanh); ONNX export keeps logits+value | `policy_value_network.py:70,90,123-131` |
| Stage-1 label budget | avg 1,359,479 sims/position | `datasets/README.md:11` |
| Stage-2 label budget | avg 10,000 sims/position | `datasets/README.md:36` |
| Training iterations | 100,000 × 2048 = ~2.05e8 samples per stage | `train_stage1.py:36-37`, `train_stage2.py:40-41` |
| Wall clock | "about 10 weeks" on one desktop (i7-10700K + 2× RTX 2080 Ti); most time in C++ dataset generation | `website/src/blog/Blog.js:~247-248` |
| Runtime budget | 1k sims ≈ 4.4 s; 10k sims ≈ 17.8 s single-threaded server; in-browser: 75 sims/s desktop, 2.5 sims/s phone | `README.md:54-59`; `Blog.js:~251-253` |

### 4.3 What actually made it improve (and what to distrust)

- **Data quality over quantity, stated explicitly** (`README.md:26`): enormous simulation budgets per
  labelled position (1.36M avg in stage 1) instead of many cheap labels. This is the same conclusion our
  own diagnosis reached (`docs/v5.1/release/TRACK-A-72H-RESEARCH-PLAN.md`: "value MSE ~1.08, worse than
  predicting zero (0.73)"; the fix is stronger labels, `training/bot/search-labels.cjs`).
- **The value target is the root's mean state value, not the game outcome** (`README.md:30`). This is a
  *different value semantics* from our default `terminal-outcome`, and is closer to our
  `deep-search-root-score` mode. It is the labelled, look-ahead value at the position — which is exactly
  why our `train.py` must never average the two (it already refuses to; see `train.py:24-40`).
- **Two-stage bootstrapping beats random-playout-only**: NMCTS1 beat pure MCTS; NMCTS2 (retrained on
  its own self-play) improved on NMCTS1 consistently; NMCTS2 beat MCTS with **4 orders of magnitude
  fewer simulations** at inference (1k vs 10M) (`README.md:77-80`). That is the iterative-RL signal.
- **Honest limits**: the author states NMCTS3 is still needed to know whether more improvement is
  possible (`README.md:80`) — i.e. the loop was run for **two** generations, and the reported evidence is
  an internal tournament, not an external strength claim.
- **Auxiliary action-values head** (`README.md:32`) is an unusual extra head (81 per-action values next
  to the logits) with weight 1.0/0.5; our compact model has no such head, so an utttai-trained network
  is not drop-in with our ONNX contract (81 logits + 1 tanh value, `training/bot/README.md`).
- **No Dirichlet noise / no temperature schedule** means their self-play explores only via PUCT's
  policy term and visit sampling. An "AlphaZero-style" RL programme of ours should not copy this part
  uncritically.

---

## 5. Compatibility verdict and converter design

### 5.1 Verdict: **compatible-with-conversion — for supervision only, never for game-level fields**

- **Rules/board: compatible (verified, exact).** Same game; same 81-index action space with the
  *identity* mapping to our `b*9+c`; same value convention (+1/−1/0 side-to-move).
- **Data: compatible-with-conversion** as an **off-policy, policy+value supervision corpus**, provided
  the derived record is honest about what it does not contain. It can supply:
  `planes` (from their 93-byte state via our own `encode()` — not by reshaping their planes),
  `legalMask` (recomputed with `G.legal()`), `visitTarget` (normalised child visits), and a
  **`valueTarget` with a declared non-terminal source** (their root mean state value).
- **Records matching OUR schema: only partially, and the missing fields are not recoverable from the
  data.** Their corpus has no game id, no opening family, no split, no terminal outcome, no complete
  game, and (for most positions) no unambiguous 4-ply opening. A converter therefore **cannot** emit a
  row that satisfies our `generate.cjs`/`validate-data.cjs` contract (`terminalOutcome` in
  `('X','O','DRAW')`, `valueTarget == E.value(terminalOutcome, player)` when the source is
  `terminal-outcome`, `openingFamily == family(moves)`, split by `splitFor(openingFamily)`,
  `completeGameMoves` from a finished game) **because the games were never stored.**
- **Explicit rejection:** the two datasets **must not be** treated as, or silently relabelled into,
  complete-game `terminal-outcome` training data. Any converter that fabricates an outcome, a
  `gameId`, an `openingFamily` or a `split` for these rows is producing leakage and must be rejected.

### 5.2 Required transformations, if a converter is ever built

A **new, separate** record shape is required (e.g. `valueTargetSource: 'utttai-nmcts-root-value'`); it
must **not** reuse the complete-game schema. The transformations:

1. **State → our state.** Parse the 93 digits; build `board[b][c]` from `state[b*9+c]` (`1→'X'`, `2→'O'`,
   `0→null`), `mini[b]` from `state[81+b]` (`1→'X'`, `2→'O'`, `3→'DRAW'`, `0→null`),
   `turn` from `state[90]`, `required` = `null` if `state[91]===9` else `state[91]`, `winner` from
   `state[92]` (`0→null`). **`winner` here is always `null` for the shipped data** (0/16,005,010 rows).
2. **Encode with OUR encoder.** `planes` = `[...E.encode(state).planes]` (648 floats), `legalMask` =
   `E.encode(state).mask`. Do **not** reshape their 4×9×9 into our 8×9×9: two of their four channels
   (own/opp) have counterparts but their ch2 constant fill has none, and our channels 2/3/4/5/7 have no
   source. Re-encoding from the rule state is exact; reshaping planes is not.
3. **Action index: identity.** `policyIndex = theirIndex` (= our `b*9+c`; `src/bot/board.js:43` defines `action(m)=m.b*9+m.c`). Build `visitTarget` by
   scattering normalised child visits into an 81-array at `theirIndex`; every index must be
   `< 81`, unique, and inside our recomputed `legalMask`.
4. **`valueTarget`: declared, non-terminal source.** Use their root mean state value directly, with
   `valueTargetSource: 'utttai-nmcts-root-value'` (stage2) or `'utttai-mcts-root-mean'` (stage1),
   `terminalValue: null` and `terminalOutcome: null`. Our `train.py` accepts a non-terminal source
   **only if** it also records `terminalValue == expected` (`train.py:24-40`) — which is impossible
   here — so this needs a **new declared source** in `train.py`, or the rows must go through a
   dedicated consumer. That is a `train.py` change, which the parent owns.
5. **Per-action values**, if used, are **parent-relative** (already sign-flipped); record them as such
   or discard them (our schema has no action-value field).
6. **Split: must be synthesised conservatively.** Options, in order of safety:
   (a) put the whole external corpus in a **new `external` split** that is never trained against our
       frozen validation/holdout — the only option that cannot leak;
   (b) if a train/validation split is genuinely needed, group by the **reconstructed opening family**
       where the reconstruction is unambiguous (91.0 % of `depth04`, ~0 % at `depth06`+) and **reject**
       everything ambiguous. Never assign ambiguous rows to a split.
7. **Deduplicate** by canonical position before use: `depth00`–`depth05` demonstrably repeat positions
   with different visit counts and value estimates (e.g. `depth00`: 5 rows / 1 position;
   `depth05`: 75,202 / 74,349). Keep one row per position (highest visit count) and record the
   decision.
8. **Never mix value sources.** These rows must not be averaged with our `terminal-outcome` or
   `deep-search-root-score` rows (the exact failure our `dataset-audit-20261013.md` documents); the
   corpus is a single new source.

### 5.3 Rejection criteria (drop the row; do not repair it)

A converter must **reject** a datapoint when any of the following holds — each is cheaply checkable and
each was exercised over the real data (all pass for the shipped files, i.e. these are the guards that
would catch a corrupt or hostile file):

1. The 93-digit state does not parse, or `state[0..80]` contains a value other than 0/1/2.
2. `state[90] ∉ {1,2}`; `state[91] ∉ {0..8, 9}`; `state[92] ∉ {0,1,2,3}`.
3. `state[92] !== 0` — the row is terminal. (Shipped rows are never terminal, and a terminal row has no
   legal actions, so our schema's "terminal board ⇒ all-zero mask" rule would apply; mixing it into a
   non-terminal corpus is a bug.)
4. Our engine rejects the state, or `G.legal(state)` is empty, or `G.winner(mini)` disagrees with
   `state[92]`/`state[81..89]`.
5. The action list's index set ≠ our `G.legal()` index set (this is the single most important guard —
   it catches any index-transposition bug in the converter itself).
6. Any action index duplicated, `< 0`, or `> 80`; any action `SYMBOL ≠ state[90]`.
7. Visits do not sum > 0; or (stage1/stage2) `Σ childVisits ≠ rootVisits − 1`.
8. `valueTarget` outside `[−1, 1]`, non-finite, or inconsistent with the visit-weighted action values
   beyond the text format's 6-decimal rounding tolerance.
9. The reconstructed 4-ply opening is **ambiguous** (more than one distinct `family()` candidate) when a
   game-level field (family/split) is being written. 1,345/15,000 stage2 `depth04` rows are ambiguous;
   467 of those are cross-split.
10. A required game-level field (`gameId`, `openingFamily`, `split`, `terminalOutcome`,
    `completeGameMoves`) would have to be invented. **Inventing any of these is a hard reject** — that
    is the definition of fabricating evidence.

### 5.4 Recommended position for the programme

Use utttai **as an external, differently-sourced policy/value supervision pool** (a fresh
`valueTargetSource`, an `external` split, deduped) to attack exactly the bottleneck our own runs found
— a value head that learned nothing from weak self-play labels — because their value target is a
1.36M/10k-simulation look-ahead value, i.e. a genuinely stronger label of the same kind our
`search-labels.cjs` produces. Do **not** attempt to reconstruct games, and do **not** claim their
strength transfers to Mega XOXO without a measured, family-safe league against our
`improvedExpert`/champion. No promotion, catalog or spend decision follows from this document.

## 6. Open / unverified items

- `[UNVERIFIED]` Explicit data-only licence grant for the two Drive datasets (repo-level Apache-2.0 is
  inferred to cover them; no separate dataset terms found).
- `[UNVERIFIED]` Exact total wall clock, per-position cost and energy for the stage-1/2 runs (the
  "~10 weeks" figure is provider-author-reported in `Blog.js`, not measured by us).
- `[UNVERIFIED]` That stage1's claimed per-group simulation counts apply to the `depthNN.txt` files as
  shipped; the archives themselves do not carry a manifest with those aggregates (measured totals and
  per-depth counts do match the README exactly).
- `[INFERENCE]` That the 4-ply-opening ambiguity measured on `depth04` extends to all deeper layers in
  the same proportions; the stratified test (400 rows/depth) shows it worsens sharply by `depth06`, so
  the `depth04` figure is an upper bound on recoverability.
- `[UNVERIFIED]` Whether any later upstream commits/branches exist: the repo's `pushed_at` is
  2022-04-23 and no tags were returned by `git ls-remote --tags`; a shallow clone was used.
