# Mega-XO V3 — Vector Relay

V3 is a complete UI/UX redesign of Mega Tic-Tac-Toe built around the game's defining mechanic:

**every move routes the opponent to their next Mini Board.**

This version deliberately abandons the hand-drawn / paper-mockup direction used in earlier concepts. The new identity is called **Vector Relay** — a clean tactical interface built around routing, sectors, signal flow, and board control.

---

## 1. Design Thesis

Mega Tic-Tac-Toe should not look like a novelty tic-tac-toe app.

It should feel like a compact strategy game with its own visual language.

The interface is based on three ideas:

1. **Sector control** — each Mini Board behaves like a tactical sector.
2. **Routing** — the chosen cell visibly sends the opponent somewhere.
3. **Board ownership** — claimed sectors visibly become X or O territory.

The result should feel modern, precise, competitive, and immediately understandable.

No imitation of sketchpad, notebook, Muse-style, or doodle UI is part of this direction.

---

## 2. Core Rules

The game contains:

- 1 Mega Board
- 9 Mini Boards
- 81 playable cells

Both Mega Board positions and Mini Board cells use:

```
0 1 2
3 4 5
6 7 8
```

A move is represented as:

`{ boardIndex, cellIndex }`

The central rule is:

`nextBoard = cellIndex`

Example:

- Player X plays inside Mini Board 4
- X chooses Cell 2
- Player O must next play inside Mini Board 2

If Mini Board 2 is already:
- won by X
- won by O
- drawn

then O receives a **Free Move** and may play inside any unresolved Mini Board.

A Mini Board is claimed with a normal tic-tac-toe 3-in-a-row.

The match is won when a player claims 3 Mini Boards in a row on the Mega Board.

---

# 3. Visual Identity — Vector Relay

## Personality

- tactical
- compact
- intelligent
- clean
- premium
- slightly futuristic
- not sci-fi
- not playful-cartoon
- not skeuomorphic
- not hand-drawn

## Signature visual idea

Whenever a move is made, the interface briefly shows a **route vector** from the selected cell to the opponent's destination Mini Board.

That routing visualization becomes a distinctive part of the game's identity.

The game is not merely "tic-tac-toe inside tic-tac-toe."

It is a **routing strategy game**.

---

# 4. Color System

### Neutral system

- App background: `#E9ECEF`
- Main surface: `#F8F9FB`
- Raised surface: `#FFFFFF`
- Primary ink: `#15181C`
- Secondary text: `#747B84`
- Divider: `#CDD2D8`

### X

- Primary: `#246BFD`
- Soft ownership: `#DFE9FF`

### O

- Primary: `#F45669`
- Soft ownership: `#FFE1E6`

### Routing

- Signal / legal-route accent: `#C6FF42`
- Signal text: `#27310A`

### State colors

- Win: `#81C784`
- Danger: `#E84B4B`

The route color is intentionally separate from both players so that it always represents **movement / destination**, not ownership.

---

# 5. Typography

## Primary UI

**Space Grotesk**

Used for:
- navigation
- mode labels
- buttons
- player names
- screen headings
- readable gameplay UI

## Tactical metadata

**IBM Plex Mono**

Used sparingly for:
- rating
- route labels
- turn-state metadata
- timers
- friend codes
- small tactical labels

No handwriting fonts.

No decorative font is used for gameplay-critical information.

---

# 6. Iconography

V3 uses **Lucide SVG icons**.

No emojis are used as interface icons.

Core mappings include:

- Bot → Bot
- Pass & Play → Users
- Online → Swords
- Private Match → Link2
- Friends → UsersRound
- Rank → Trophy
- Stats → ChartNoAxesColumnIncreasing
- Settings → Settings2
- Match Settings → SlidersHorizontal
- Rules → CircleHelp
- Restart → RotateCcw
- Copy → Copy
- Route → Route
- Back → ChevronLeft

All icons:
- use one icon family
- share one stroke weight
- inherit foreground color
- scale independently from text

---

# 7. Home Information Architecture

The home experience uses a bottom navigation system:

- Play
- Friends
- Rank
- Stats

Settings lives in the top-right.

This makes social and competitive systems first-class areas instead of hidden modal features.

---

# 8. Play Screen

The Play screen leads with the game's strategic identity:

**Win the board. Control the route.**

The mode selector is a vertical stack rather than a 2x2 card grid.

Modes:

### Vs Bot
Five offline difficulties.

### Pass & Play
Two players on one device.

### Play Online
Ranked or Casual matchmaking.

### Private Match
Friend room / invite flow.

Only context-relevant settings appear after choosing a mode.

For Vs Bot:
- difficulty
- starting side

For Pass & Play:
- starting side

Online/private options do not fake a match in the static prototype.

---

# 9. Friends Screen

The Friends area contains:

- username search
- friend code
- copy action
- future recent opponents
- friend requests
- online/offline friend state

The current prototype intentionally uses an honest empty state rather than fabricated social data.

Future production actions:

- Add Friend
- Challenge
- View Stats
- Remove
- Block
- Report

---

# 10. Rankings Screen

Competitive identity is deliberately separated from offline play.

The screen contains:

- current tier
- rating
- progression bar
- leaderboard area

V3 does not fabricate leaderboard users.

Until the multiplayer backend exists, the screen clearly identifies online data as unavailable.

Future filters:

- Global
- Friends
- Weekly
- Seasonal
- Regional

---

# 11. Stats Screen

Offline statistics are locally persisted.

Overview includes:

- games played
- bot win rate
- best streak
- average moves
- Mini Boards claimed
- draws

Bot performance is broken down by:

- Beginner
- Easy
- Medium
- Hard
- Expert

Online statistics remain separate.

---

# 12. Game Screen Hierarchy

The gameplay hierarchy is:

1. player state
2. route instruction
3. Mega Board
4. lightweight match controls

The Mega Board remains the visual focus.

The game screen contains:

### Compact header
- back
- mode
- difficulty / context
- timer
- settings

### Player cards
- custom X / O glyph
- player name
- Mini Boards claimed

### Route HUD
Examples:

`FREE ROUTE`

or:

`YOUR TURN · TOP-RIGHT`

This is more useful than generic "your turn" messaging because the game's main constraint is destination routing.

### Mega Board
Dominates the screen.

### Bottom actions
- Rules
- Restart
- Stats

---

# 13. Board Geometry — Hard Requirement

The board must never resize when marks, claimed states, or animations appear.

The Mega Board is a fixed 3x3 CSS grid.

Each Mini Board:

- `aspect-ratio: 1 / 1`
- `min-width: 0`
- `min-height: 0`
- participates only in grid geometry

Each Mini Board contains its own fixed 3x3 grid.

Every Cell:

- `position: relative`
- `aspect-ratio: 1 / 1`
- `min-width: 0`
- `min-height: 0`
- `overflow: hidden`

Marks are absolutely positioned inside cells.

They never affect document flow.

This directly fixes the previous X/O resizing bug.

---

# 14. X and O Rendering

X and O are not text characters.

They are custom SVG marks.

## X
- cobalt blue
- two rounded diagonal strokes
- 68% of cell size

## O
- coral red
- SVG circle
- equal apparent stroke weight to X
- 68% of cell size

Both are rendered inside:

```
position: absolute;
inset: 0;
display: grid;
place-items: center;
```

Therefore adding a mark produces **zero layout reflow**.

---

# 15. Claimed Mini Boards

Claiming a Mini Board does not delete or replace its grid container.

Instead, an absolute overlay appears above the existing Mini Board.

### X claim
- pale cobalt ownership surface
- large custom X

### O claim
- pale coral ownership surface
- large custom O

### Draw
- neutral grey ownership surface
- compact DRAW label

The Mini Board's geometry never changes.

---

# 16. Board Interaction States

## Forced active board

The required Mini Board receives:

- dark border
- bright route-green outer ring

Other unresolved boards remain visible but lower in opacity.

## Free Move

All unresolved boards receive a subtle legal-state treatment.

The route HUD says:

**FREE ROUTE — CHOOSE ANY OPEN MINI BOARD**

## Destination preview

Hovering / pressing a legal cell previews its corresponding destination board.

This is a direct visual explanation of:

`nextBoard = cellIndex`

## Invalid move

Invalid input never opens an alert.

Instead:
- lightweight toast
- optional haptic
- legal state remains visually obvious

---

# 17. Signature Route Animation

After a legal move:

1. the mark appears
2. the game calculates the next target board
3. a route vector briefly draws from the selected Cell to the destination Mini Board
4. the target Mini Board pulses
5. turn ownership changes

The vector:
- uses the routing accent color
- exists in an SVG overlay above the board
- does not affect layout
- fades within roughly 650 ms

If the destination Mini Board is resolved, no line is drawn and the route HUD moves to **FREE ROUTE**.

This is the core original interaction motif of V3.

---

# 18. Match Result UX

The result appears as a bottom sheet rather than a full-screen takeover.

It shows:

- Victory / Defeat / Draw
- Mini Boards controlled
- moves played
- match duration
- Rematch
- Back to menu

Rematches swap the starting side.

---

# 19. Settings UX

Settings are presented as a bottom sheet.

## Gameplay
- Legal board highlight
- Destination preview
- Move timer

## Feedback
- Sound effects
- Ambient sound
- Haptics

## Appearance
- Light
- Dark
- Reduce motion

## Purchases
- Remove Ads

The static prototype exposes the purchase entry point but does not simulate App Store / Play Billing success.

---

# 20. Responsive Strategy

V3 must work without board distortion at:

- 320 px
- 360 px
- 390 px
- 430 px
- portrait tablet

Hard rules:

- Mega Board remains square
- Mini Boards remain square
- Cells remain square
- X/O never alter dimensions
- ownership overlays never alter dimensions
- no horizontal scroll
- route overlay remains aligned with board
- bottom navigation remains reachable
- gameplay actions remain inside safe viewport

---

# 21. Accessibility

- X and O differ by shape and color
- route state does not rely on color alone
- touch targets aim for at least 44 px where practical
- Reduce Motion disables nonessential animation
- timer danger should include a numeric countdown
- cells can receive descriptive aria labels in production
- active Mini Board should be announced to assistive technology

---

# 22. Bot Difficulty

### Beginner
Random legal play.

### Easy
Finds immediate Mini Board wins and simple blocks.

### Medium
Uses tactical heuristics:
- immediate win/block
- destination control
- centre/corner preference
- avoiding free-route gifts

### Hard
Shallow minimax / alpha-beta.

### Expert
Deeper search when branching allows it.

Bot logic remains completely offline.

No LLM is used.

---

# 23. Online Architecture

Production online play must be server-authoritative.

The server must validate:

- player turn
- active Mini Board
- target Cell
- Cell occupancy
- Mini Board resolution
- Mega Board resolution
- timers
- move sequence

Future systems:

- auth
- matchmaking
- private rooms
- reconnect
- rating
- leaderboards
- friends
- match history

The client may animate optimistically, but server state is authoritative.

---

# 24. Monetization

Recommended:

- free game
- post-match ads only
- no ads during gameplay
- one-time Remove Ads purchase
- cosmetic themes later

Never:
- sell stronger moves
- sell extra turns
- sell competitive advantage
- interrupt a live match with an ad

---

# 25. V3 Acceptance Criteria

- [x] Completely new visual identity
- [x] No notebook / sketch UI
- [x] No emoji interface icons
- [x] Lucide icon system
- [x] Custom SVG X
- [x] Custom SVG O
- [x] Fixed square cell geometry
- [x] No X/O-induced board resizing
- [x] No claim-overlay-induced resizing
- [x] Distinct forced-board state
- [x] Distinct Free Route state
- [x] Destination preview
- [x] Signature route-vector animation
- [x] Play / Friends / Rank / Stats information architecture
- [x] Offline stats
- [x] Five bot difficulties
- [x] Local two-player
- [x] Light and dark themes
- [x] Reduced-motion setting
- [x] Honest online placeholders
- [ ] Production multiplayer backend
- [ ] Real auth
- [ ] Real leaderboard
- [ ] StoreKit / Play Billing
- [ ] Push notifications
- [ ] Production match history

---

# 26. Design Summary

The final V3 identity is:

## **Vector Relay**

A clean tactical mobile game where the UI visually reinforces the game's unique strategic rule:

**the cell you choose is also the route you give your opponent.**

That idea drives:

- the route-green signal color
- the route HUD
- destination previews
- vector animations
- sector-like Mini Boards
- competitive typography
- clean geometric layout
- separated social / ranked / stats navigation

V3 should not look like a redesigned tic-tac-toe mockup.

It should look like a game that could only belong to **Mega XO**.
