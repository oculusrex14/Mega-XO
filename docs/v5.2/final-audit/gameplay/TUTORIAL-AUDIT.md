# Guided tutorial audit

Source: `7f582b749a1128b86e53ddcbcda57b569b0953cf`. **UNVERIFIED / UNPAID** under the owner contract. Static implementation and existing automated evidence were reviewed; no novice study, physical-device narration/assistive-technology session or new local tutorial test was run.

## Implemented lesson

`src/tutorial/lesson.js:5-6` defines `guided-practice-v1` and six canonical plies. “Six moves” means three human X moves and three scripted bot O moves:

| Ply | Actor | Board/cell | Teaching purpose |
| --- | --- | --- | --- |
| 1 | Human X | top-left mini board / centre cell (`b:0,c:4`) | Cell location sends the opponent to the centre mini board |
| 2 | Bot O | centre mini board / top-left cell (`b:4,c:0`) | Bot sends the human back to the top-left board |
| 3 | Human X | top-left mini board / middle-left (`b:0,c:3`) | Build two X marks across a row |
| 4 | Bot O | middle-left mini board / top-left (`b:3,c:0`) | Follow the route back again |
| 5 | Human X | top-left mini board / middle-right (`b:0,c:5`) | Complete the middle row; win one mini board, not the Mega board |
| 6 | Bot O | middle-right mini board / top-left (`b:5,c:0`) | Destination is already closed; demonstrate free choice |

The handoff retains this position for ordinary Beginner practice. The objective remains three **won mini boards** in a Mega-board row/column/diagonal. No alternative gameplay, rewards, geography or eligibility blocker is introduced.

## State and safety review

| Area | Source behavior | Evidence / remaining acceptance |
| --- | --- | --- |
| Versioned lesson | `VERSION`, `valid`, `restore` in `src/tutorial/lesson.js` | Invalid/mismatched saves end guidance rather than inventing a new board |
| Canonical replay | `valid()` reconstructs all prior plies with `G.apply` and compares state | Shared canonical legality; source and `tests/bot/lesson.test.cjs` |
| First-run conditions | `create()` requires fresh X-to-move practice with no prior moves/winner | Source rejects incompatible start state |
| Input gate | `allows()` admits only the required guided human move | Website and app adapters must honor the lesson decision |
| Explicit Continue | `PROMPT`, `AWAIT_MOVE`, `AWAIT_CONTINUE`, `DONE` | Bot plies do not silently advance through teaching pauses |
| Skip / restart | `advance('skip')`, client restart and confirmation paths | Remains practice; restart discards only the explained practice position |
| Hidden/background | `advance(...,{hidden:true})` does not advance | Source/harness evidence; physical lifecycle remains NOT_RUN |
| Narration/captions | Lesson text/hints plus narration-enabled/volume state in client/website compat | Voice availability, timing and physical screen-reader interaction NOT_RUN |
| Beginner handoff | Final Continue changes guidance to DONE, preserving the board | Ordinary Beginner practice remains unpaid; no silent official match |
| Reward exclusion | Practice flag and local-AI exclusions in `src/domain.js:110-117` | `tests/domain.test.js` rejects practice/local farming; no Coin/Crown/Elo grant is authorized |

The app uses `src/tutorial/client.js` and the website uses `apps/web/bot-compat.js` with `apps/web/board.js`. They share lesson/rule semantics but have different renderers and lifecycle wiring. One adapter's successful test cannot certify the other on a physical device.

## Existing evidence

- `tests/bot/lesson.test.cjs`: source-level lesson/state-machine and canonical transition coverage.
- `tests/v51-bot-tutorial.test.js`, `tests/v51-p21-bot.test.js`: integration/adapter/rule and unpaid-practice boundaries.
- `tests/bot/tutorial-browser.py`, `worker-browser.py`, `pack-browser.py`: existing scripted browser harnesses.
- [GitHub Actions bot/tutorial job](https://github.com/oculusrex14/Mega-XO/actions/runs/39006747072/job/117320656188): observed SUCCESS for the PR source; `.github/workflows/v52-bot-tutorial.yml` includes Node regression, tutorial/browser, worker/pack and accessibility harness stages.
- [Canonical benchmark ledger](../../../v5.1/bot-ai/BENCHMARKS.md) explicitly records fresh-user onboarding/physical accessibility as unmeasured in its evidence scope.

The exact PR input head was `7f582b7`; GitHub pull-request jobs can execute the synthetic merge. Do not relabel this as a physical Android/iPhone study or live-user completion rate. The current P21 presentation failure also skipped that workflow's automatic accessibility stage; another harness's success does not erase the skip.

## Comprehension verdict and required evidence

**Implemented, but human comprehension acceptance is NOT_RUN.** Existing scripted success does not establish that a novice understands where the next move must be played, why a closed destination permits free choice, or that one mini-board win is not a Mega win. SAGAN-011 records the missing human acceptance evidence, not a claim that users failed a study.

The owner target remains at least 80% of genuinely new participants identifying the required next mini board without hints. A valid study should pin the app/build and platform, use a fixed neutral script and questions, avoid coaching, record participant count plus correct/incorrect numerator, completion/dropout and confusion themes, and distinguish unaided responses from those after a hint. Repeat after material copy changes with new participants.

Also NOT_RUN at this audit source: TalkBack/VoiceOver narration ordering, captions versus spoken timing, unavailable system voices, volume/mute persistence, background interruption during Continue, restart/resume after process death, large text/safe areas and physical Android/iPhone touch targeting. Report real failures independently rather than substituting a simulator or a source test for these outcomes.
