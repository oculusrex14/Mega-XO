# Guided practice: novice study and browser acceptance

Prepared 12 October 2026 for R21 / B03.14 / B07.08, with R17 / R20 support. **Procedure implemented; no participants tested and no comprehension result claimed.** Human owns recruitment, observation, final visual/narration decisions and acceptance. Main supplies the exact candidate and physical builds. Codex implements resulting website changes and validates browsers.

## Freeze the session

Record the candidate SHA, website bundle hash, URL, date, OS/browser version, physical device, viewport, selected theme, text scale, narration/captions setting and connection. Keep the same candidate within a cohort. The local preview remains noindex and isolated from accounts/economic APIs. A simulator or resized desktop browser is not a phone.

Use genuinely new Mega XOXO players. Familiarity with ordinary tic-tac-toe is allowed; prior Mega XOXO/ultimate tic-tac-toe experience makes someone ineligible for the novice cohort. Record that decision before the task. Twenty participants is an initial recruitment target, not a claim of statistical certainty or a reason to discard smaller cohorts. Use only anonymous codes P001–P999. Do not collect names, email, accounts, payment data, IP addresses or voice recordings. Obtain permission before any optional recording; do not commit recordings or participant-level raw observations to Git.

## Moderator script

Say: “Please try the guided practice. Use the website as you normally would. I will observe, then ask three questions. You can stop whenever you want.” Open `/game`, choose **Start guided practice**, and let the participant proceed. Do not explain routing, point at a cell, activate Hint for them or coach an answer. The participant may use the tutorial's own controls; record Hint/Replay/Skip use separately. Assistance from the moderator makes the session coached, even when the answer later becomes correct.

Observe first-move discoverability, wrong taps, Continue/acknowledgment, caption/narration comprehension, focus, first claimed Mini Board and the free-route transition. Record completion, elapsed time and confusion themes locally without personal identifiers. The lesson must execute exactly six canonical half-moves:

`X(0,4), O(4,0), X(0,3), O(3,0), X(0,5), O(5,0)`.

At handoff, Mini Board 0 belongs to X, X moves next, required board is null and the game has no overall winner. Beginner continues that same position. The study creates no official Coins, Crowns, Elo or statistics.

Ask each question before giving feedback:

1. “What do you need to do to win the whole game?” Accept three claimed Mini Boards in a line; three marks in one Mini Board alone is insufficient.
2. “Point to the small board where the next player must move, and explain how you chose it.” Use the fixed routing probe A for odd participant codes and B for even codes. Do not point out highlights or explain the last cell. Accept the required Mini Board without moderator hints. Record explanation errors separately from the board-choice score.
3. “When can a player choose among the open small boards?” Accept a destination that is already won/drawn/complete, or the initial free choice. Use the closed-destination fixture when needed, without naming the rule in the question.

The probe generator replays every position through `src/game.js`; its answers are moderator material. Do not show the answer JSON to participants or add a production debug/injection endpoint. Main/Codex must prepare neutral screenshots or local isolated board cards for the pinned build before the human session. Question 2 is not established by replaying the guided lesson successfully.

## Anonymous results and interpretation

Generate a blank template and canonical probes:

```sh
node scripts/p21/novice-study.cjs --template > .artifacts/novice-responses.csv
node scripts/p21/novice-study.cjs --fixtures > .artifacts/novice-probes.json
node scripts/p21/novice-study.cjs --score .artifacts/novice-responses.csv > .artifacts/novice-summary.json
```

Every row uses fixed values only. `eligible`, `withdrawn`, `completed`, `coached` are `true`/`false`; the three answers are `correct`, `incorrect`, `no_answer`. Keep raw rows private in the owned artifact directory. The scorer refuses missing/duplicate codes, extra columns, unknown values and empty results. It never labels a study PASS.

The primary denominator is **all eligible, non-withdrawn participants**, including unfinished lessons, coached sessions and unanswered questions. Coached answers never count as unaided correct. Report exclusions and withdrawals separately. Required-board unaided correctness must reach the owner's observed 80% target; also report numerator/denominator, completion, macro-goal/free-route results and the Wilson 95% interval. A cohort reaching 80% does not prove universal success. Keep failures and confusion themes, revise approved wording when needed, then test fresh users rather than reusing a coached cohort.

Publish only the aggregate summary, candidate identifiers, sanitized device matrix and human disposition. A generated template, developer walkthrough or canonical fixture test leaves R21 / B03.14 / B07.08 open.

## Browser and physical matrix

| Environment | Required checks | Evidence limit |
|---|---|---|
| Desktop Chromium, Firefox, macOS Safari | Five website themes, keyboard-only, focus return, 200% zoom, reduced motion, menu, lesson resume | Each actual browser/version recorded; engine automation is separate from Safari application acceptance |
| Tablet portrait/landscape | 768/1024 widths, orientation, no overlap, square board, touch controls | Resized desktop verifies layout only |
| Low/mid/high Android Chrome and native WebView | 320/360/390/430 where applicable, TalkBack, text scaling, background/process loss, slow/offline network | Physical hardware, app build/signing and OS recorded |
| Current iPhone Safari and native WKWebView | Safe areas, landscape, VoiceOver, keyboard, background eviction, captions/available voices | Physical device result cannot be inferred from WebKit CI |

At each guided step test reload/resume, hide/show, wrong move, keyboard focus, Hint, Replay, Skip and explicit Restart; confirm no repeated committed move. Recheck the same-state Beginner handoff and zero reward/stat effects. Use account-free local sessions for novice testing. Real shared-account/commerce/provider acceptance belongs to the separately approved staging matrix.
