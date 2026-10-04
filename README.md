# Mega-XO V3

V3 is the consolidated hand-drawn mobile prototype for **Mega Tic-Tac-Toe**.

## What V3 adds
- Dedicated home/menu flow inspired by the supplied mockups
- Vs Bot, local pass-and-play, Ranked/Casual/Private online shells
- Five bot levels: Beginner, Easy, Medium, Hard, Expert
- Correct send-rule: `nextBoard = cellIndex`
- Free Move when the destination Mini Board is already won or drawn
- Mini Board claim overlays and Mega Board win detection
- Active-board dimming/highlighting plus destination preview
- X/O start selection and rematch side swap
- Optional move timer
- Sound FX, ambient audio, haptics, confetti, reduced motion
- Paper and dark-notebook themes
- Offline stats persisted in localStorage and separated from future online stats
- Paid Remove Ads entry point without faking a store transaction

## Rules
1. The Mega Board is a 3x3 grid of Mini Boards; every Mini Board is another 3x3 tic-tac-toe board.
2. Win a Mini Board normally to claim that square of the Mega Board.
3. The cell you choose determines the Mini Board your opponent must play next.
4. If that destination Mini Board is already resolved, the opponent receives a Free Move in any unresolved Mini Board.
5. Claim three Mini Boards in a row to win the match.

## Online status
V3 intentionally does **not** fake online matchmaking. Ranked, Casual, and Private Friend modes have production-facing client flows, but need a server-authoritative realtime backend, auth, persistence, rating, and reconnect handling before they become playable across devices.

Open `index.html` directly in a browser to run the current prototype.
