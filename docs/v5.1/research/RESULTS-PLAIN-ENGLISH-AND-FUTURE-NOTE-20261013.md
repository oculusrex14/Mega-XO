# Mega XOXO AI research — plain-language results + how to build the Impossible bot (2026-10-13)

Written for a non-specialist reader. This is the straight story of what the research programme actually
found, plus a forward-looking recommendation on how to eventually build the "Impossible" level.

## 1. The goal

Build a **strong, tiny bot** for Mega XOXO — small enough to run on a phone (a few megabytes), but good
enough to be genuinely tough to beat. This is the model that the "Impossible" difficulty would use.

## 2. What we started with vs what we ended with

The bot is scored by playing many fair games against strong reference opponents and counting how many
points it wins (a win = 1 point, a draw = 0.5). "Expert" and "UCT" are the two reference bots.

| Candidate | vs Expert bot | vs UCT bot |
| --- | --- | --- |
| Before this work | ~5% | ~61% |
| After this work (best) | **~47%** | **~95%** |

That is roughly a **9–10× improvement against the Expert bot** — the best result the project has ever
produced. The model stayed small: **2.9 MB** (and 0.76 MB compressed), inside the phone budget.

## 3. Why it got better (the one big idea)

The bot learns by example: you show it thousands of positions and tell it the right move. The **quality
of those examples** turned out to matter far more than computer power, model size, or search depth.

Two concrete causes of the improvement:

1. **The old examples were bad.** They came from weak games, so the bot was learning noise.
2. **A public research project called `utttai` had 350,000 expertly-labelled positions for the exact
   same game.** Its rules are identical to ours (verified across all 16 million data rows). Converting
   and training on that data is what took the bot from 5% → 47%.

## 4. The public research project (the useful one)

- **Link:** https://github.com/arnowaczynski/utttai
- **Licence:** Apache-2.0 (permissive; reuse with attribution is allowed).
- **What it gave us:** ~8 million MCTS positions + ~8 million neural-MCTS positions, plus a working
  "learn from your own search" recipe. It is a genuinely good model of how to build a serious
  Ultimate-Tic-Tac-Toe engine, and its data is directly usable as training examples for our game.

## 5. The "language model arena" experiment (a clear negative result)

We tested four large language models as candidate players, to see if a big chatbot could out-think the
search bot.

| Model | vs our Expert bot |
| --- | --- |
| Nemotron 3.5 Lightning 30B | lost 0–4 |
| Gemma 4 26B | lost 0–4 |
| Qwen3.8-27B | lost 0–2 |
| Ornith 1.5 | could not run (needs a software image that isn't installed) |

**A bigger language model was NOT a better player.** All of them lost to a modest search engine. They
are only useful as *idea generators* (suggesting candidate moves), never as ground truth.

## 6. The self-play experiment (a real trap, and its fix)

The AlphaZero approach is: let the bot play itself, learn from its own games, repeat.

- **Naive version got worse every round:** 93% → 39% → 29%. It slowly forgot the good knowledge and
  replaced it with weak games — a "collapse".
- **Fixed version (keep the good examples in every round, only ADD self-play):** 93% → **95%** → 91%.
  Stable and slightly better.

**Lesson:** self-play alone degrades a bot unless strong examples anchor every round.

## 7. What is NOT done (honest)

- The compressed "int8" version loses too much strength — not shippable yet.
- Nothing was published. The public model list is empty; production is untouched.
- Ornith-1.5 could not be served (missing vLLM image + no internet on that machine).

## 8. FUTURE NOTE — my recommendation on how to build the Impossible bot

Based on everything measured, here is the honest playbook for the eventual Impossible level. The
programme is paused until **real player gameplay data** exists, because that is the one dataset the
whole effort was missing.

### The core principle

> **Impossible strength will come from better training examples, not from more compute or a bigger model.**

Every lever we tested that "should" help — bigger network, deeper search, more self-play — did **not**
help. The only thing that moved the needle was a stronger source of labelled positions.

### Recommended order of work (highest value first)

1. **Collect and use real player games.** This is the first and most important step. Real humans explore
   positions, tactics and mistakes that no self-play bot ever produces. Ingest those games through the
   same rules-validation we already built, label the positions with our strong search, and train on
   them. This is expected to be the biggest single jump available.
2. **Keep a fixed "anchor" of strong examples in every training round.** Never let a round train only on
   its own self-play — that is the collapse we measured. Always mix anchor data + new data.
3. **Only advance a new bot if it beats the current one in a head-to-head match** (we already built this
   gate). Never let a regressing round overwrite a stronger bot.
4. **Keep mining strong label sources.** Any trustworthy, verified source of good moves (deep search,
   solved endgames, verified tactics, and — if ever licensed — more external research data) beats more
   self-play.
5. **Do NOT invest in large language models as players.** They lose to search and are slow. Use them only
   to *generate candidate moves* for diversity, never as the answer key.
6. **Ship the small float model first.** The int8 compression currently costs too much strength; get
   the 2.9 MB float model into the game before chasing a smaller file.

### Rough roadmap to "Impossible"

```text
real player data  ->  label it with our strong search  ->  train (anchor + real data)
      ->  head-to-head vs current champion  ->  if it wins by a clear margin, promote
      ->  repeat, always keeping the anchor
```

Each step already exists as working, committed code. The missing ingredient is the **real gameplay
examples** — which is exactly why the owner deferred this until that data can be collected.

### Bottom line

- We proved the approach **works** (5% → 47% vs Expert on a phone-sized model).
- We proved the big-language-model idea **does not work** for actual play.
- We found and fixed the self-play trap.
- The path to a genuinely "Impossible" bot is: **real player data → strong labels → anchored training →
  head-to-head promotion.** Everything else is already built and waiting.
