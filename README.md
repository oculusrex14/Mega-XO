# Mega-XO V3 - Tactical Board Game Design Specification

V3 is a **full visual and UX redesign** of Mega Tic-Tac-Toe, not a reskin of V1/V2.

The design direction is **Tactical Board Game**: a polished mobile strategy game with a tactile tabletop feel, crisp geometric structure, strong information hierarchy, restrained personality, and zero layout instability.

The board is the hero. Everything else supports decision-making.

---

## 1. Product Goal

Mega Tic-Tac-Toe should feel closer to a premium compact strategy game than a casual tic-tac-toe toy.

The experience should communicate:

- strategy
- clarity
- tactility
- confidence
- polish
- fairness
- fast comprehension

Avoid:

- sketch-prototype appearance
- emoji icons
- excessive handwritten typography
- random pastel styling
- layout movement when marks appear
- overloaded screens
- decorative animation that obscures gameplay

---

## 2. Core Game Rules - Non-Negotiable

The Mega Board is a 3x3 grid of Mini Boards. Each Mini Board is another 3x3 tic-tac-toe board, giving 81 playable cells.

Both Mega Board positions and Mini Board cells use the same indices:

```
0 1 2
3 4 5
6 7 8
```

A move is:

`{ boardIndex, cellIndex }`

The central rule is:

`nextBoard = cellIndex`

Example:

Player X plays in Mega Board 4, Cell 2.

The opponent must next play inside Mega Board 2.

If the destination Mini Board is already resolved - X won, O won, or draw - the opponent receives a **Free Move** and may play in any unresolved Mini Board.

A Mini Board is claimed by standard tic-tac-toe rules.

The match is won when a player claims 3 Mini Boards in a row on the Mega Board.

A resolved Mini Board is never playable again.

These rules must be implemented independently from the UI layer.

---

# 3. Visual Identity

## Design language

**Tactical Board Game**

The UI should look like a modern physical strategy game translated carefully to mobile.

Think:

- matte board-game surfaces
- clean printed cards
- precision-cut tiles
- restrained ink texture
- subtle depth
- strong grid geometry
- tactile button feedback

Do not recreate the old "hand-drawn wireframe" look.

Small imperfections may appear in decorative surfaces, but controls, icons, grids and typography must remain precise.

---

# 4. Color System

Use a small intentional palette.

### Core surfaces

- App Background: `#F2EEE5`
- Primary Surface: `#FBF9F4`
- Raised Surface: `#FFFFFF`
- Ink: `#25282D`
- Secondary Ink: `#666A70`
- Divider: `#D6D1C7`

### Player colors

**X**
- Primary: `#315FCB`
- Soft: `#DFE8FF`
- Dark: `#23469A`

**O**
- Primary: `#D34F68`
- Soft: `#FBE1E7`
- Dark: `#A6384E`

### Tactical states

- Active Board: `#F4C84A`
- Active Board Soft: `#FFF4C4`
- Victory: `#62A66A`
- Victory Soft: `#DDEFD9`
- Danger/Low Timer: `#D75252`
- Disabled Surface: `#E3E0D9`

X and O must remain distinguishable by **shape**, never color alone.

---

# 5. Typography

Use personality only where it helps branding.

### Display / Logo
Recommended:
- Bricolage Grotesque
- Baloo 2
- Fraunces Sans-style alternative
- or a custom Mega XO wordmark later

### UI
Recommended:
- Inter
- Manrope
- Nunito Sans

### Rules

- Never use a handwriting font for body copy.
- Never use decorative type for timers, scores, stats or controls.
- Title personality is allowed.
- Gameplay text must prioritize instant legibility.

Suggested hierarchy:

- App title: 32-40 px
- Screen title: 24 px
- Player names: 14-16 px
- Turn instruction: 14 px semibold
- Cell-independent labels: 12-14 px
- Supporting text: 11-13 px

---

# 6. Icon System

V3 must contain **no emoji-based UI icons**.

Use SVG icons from one consistent family.

Preferred starting library:

**Lucide**

Acceptable alternatives:

- Phosphor
- Tabler

Recommended mappings:

- Bot: Bot
- Local multiplayer: Users
- Ranked: Trophy
- Casual: Gamepad2
- Private match: LockKeyhole / Link
- Friends: UsersRound
- Leaderboard: ChartNoAxesColumnIncreasing / Trophy
- Stats: ChartColumn
- Settings: Settings
- Timer: Timer
- Restart: RotateCcw
- Rematch: RefreshCw
- Sound: Volume2
- Music: Music2
- Haptics: Vibrate
- Ad-free: BadgeMinus / Ban
- Back: ChevronLeft
- Help: CircleHelp
- Profile: CircleUserRound

All icons should use the same stroke weight.

Recommended visual size:
- navigation: 22-24 px
- cards: 24-28 px
- compact controls: 18-20 px

---

# 7. Layout System

All gameplay geometry must be independent of text or icon dimensions.

Use a spacing scale based on:

`4 / 8 / 12 / 16 / 24 / 32`

Minimum touch target:

**44x44 px**

Primary screen content should sit inside:

- 16 px phone edge padding
- 20-24 px on larger devices

The Mega Board should use nearly the full available width while preserving safe margins.

---

# 8. Critical Board Rendering Architecture

The board must never resize when X, O, a winner overlay, hint, or animation is added.

This is a hard V3 acceptance requirement.

## Mega Board

Use a fixed CSS grid:

`grid-template-columns: repeat(3, 1fr)`

Each Mini Board:

- `aspect-ratio: 1 / 1`
- `min-width: 0`
- `min-height: 0`
- fixed grid participation
- no content-driven sizing

## Mini Board

Each Mini Board is another 3x3 CSS grid.

Each Cell:

- `position: relative`
- `aspect-ratio: 1 / 1`
- `overflow: hidden`
- `min-width: 0`
- `min-height: 0`

## X/O marks

Never render X as a font character.

Never create O using layout-affecting borders on the cell itself.

Both are dedicated SVG marks placed inside an absolute layer:

```css
.cellMark {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
}

.cellMark svg {
  width: 68%;
  height: 68%;
}
```

Adding a mark must cause **zero reflow**.

## Claimed Mini Board

Do not remove the Mini Board DOM structure.

Add an absolutely positioned overlay:

```
position: absolute;
inset: 0;
z-index: ...
```

The underlying board remains geometrically identical.

No winner state may change Mini Board width, height, gap or Mega Board dimensions.

---

# 9. Mark Design

## X

Create a custom SVG using two slightly softened diagonal strokes.

Characteristics:

- cobalt blue
- rounded stroke caps
- consistent stroke width
- visually centered
- slight optical asymmetry allowed

## O

Create a custom SVG circle/path.

Characteristics:

- coral red
- rounded stroke
- identical apparent visual weight to X
- not mathematically thin

Both marks should remain clear at very small sizes.

---

# 10. Home Screen

The home screen should be calm and high hierarchy.

## Header

Left:
- optional profile/avatar

Center:
- Mega Tic-Tac-Toe logo

Right:
- Settings

Below logo:
- rank/rating chip when signed in

Example:

**Gold II - 1,428**

Do not make rating the visual focus.

## Primary modes

Use four large mode cards:

### Vs Bot
Icon: Bot  
Subtitle: Offline - 5 difficulties

### Pass & Play
Icon: Users  
Subtitle: Two players - one device

### Play Online
Icon: Trophy / Gamepad2  
Subtitle: Ranked or Casual

### Private Match
Icon: LockKeyhole  
Subtitle: Play with a friend

Cards should have:
- icon
- title
- short description
- clear selected state
- large touch surface

Do not place configuration controls inside every card.

---

# 11. Contextual Match Setup

Only show options relevant to the selected mode.

### Vs Bot
Show:
- Difficulty
- Who starts
- Timer optional

### Pass & Play
Show:
- Who starts
- Timer

### Online
Show:
- Ranked / Casual
- matchmaking status

### Private Match
Show:
- Create Room
- Join Room
- friend code / invite link

Use one strong bottom CTA:

**Start Match**

or contextually:

**Find Match**

**Create Room**

---

# 12. Game Screen

The game screen must prioritize the board.

## Top Bar

- Back/menu
- mode label
- timer if enabled
- overflow/settings

Keep it compact.

## Player Row

Two compact player cards.

Each contains:

- avatar
- display name
- X or O indicator
- Mini Boards claimed

The active player's card gets a subtle surface/elevation change.

Do not animate its dimensions.

## Turn Banner

Examples:

**Your turn - play in Top Right**

**Opponent's turn**

**Free Move - choose any open board**

This should be readable in under one second.

## Board

The board occupies the largest visual area on screen.

## Bottom Utility Row

Recommended:

- Rules/help
- Restart or Resign depending on mode
- Stats / match info

Avoid permanently visible controls that are rarely used.

---

# 13. Board Interaction States

Each unresolved Mini Board can be:

### Active
The only board currently legal.

Treatment:
- amber border
- soft amber surface
- modest elevation/glow

### Inactive
Visible but unavailable.

Treatment:
- reduced contrast
- no dramatic opacity loss; state must remain readable

### Free Move Available
Every unresolved board is legal.

Treatment:
- subtle amber edge on all available boards
- banner explicitly says "Free Move"

### Won by X
Treatment:
- soft blue surface
- large blue X overlay
- underlying cell history remains faintly visible

### Won by O
Treatment:
- soft coral surface
- large coral O overlay
- history remains faintly visible

### Draw
Treatment:
- neutral muted surface
- small neutral blocked/draw mark
- no X/O ownership implication

---

# 14. Destination Preview

This mechanic is central and deserves dedicated UX.

When the player presses or hovers a legal empty cell:

1. the candidate mark previews in that cell
2. the corresponding destination Mini Board receives a subtle outline
3. if that destination is already resolved, show a small **FREE MOVE** indicator instead

This teaches the send rule without forcing users to reread instructions.

Preview must never alter layout.

---

# 15. Move Animation

Total duration target:

**180-260 ms**

Sequence:

1. X/O draws or scales into the selected cell
2. selected cell gives a short tactile pulse
3. destination Mini Board gets a brief highlight
4. turn ownership changes

No camera zoom.

No board movement.

No layout shift.

---

# 16. Mini Board Win Animation

Target:

**350-500 ms**

Sequence:

1. winning 3-cell line flashes
2. board surface softens
3. large winner SVG fades/scales in
4. Mega Board state updates
5. destination logic continues normally

The Mini Board must not expand.

---

# 17. Mega Board Victory

This is the strongest animation in the game.

Sequence:

1. three claimed Mini Boards brighten
2. a clean victory line draws across the Mega Board
3. board receives a short success pulse
4. result sheet rises from bottom

Optional confetti may occur outside the board.

Target before result sheet:

**700-1000 ms**

Keep it satisfying, not theatrical.

---

# 18. Invalid Move Feedback

Never use an alert dialog.

If the player taps an illegal board:

- tapped board gives a tiny shake
- required board pulses once
- optional short haptic
- optional temporary text: "Play in the highlighted board"

No state change.

---

# 19. Settings

Organize settings into clear groups.

## Gameplay
- Show legal board highlight
- Show destination preview
- Move timer
- Confirm move: Off by default

## Audio
- Sound FX
- SFX volume
- Ambient music
- Music volume

## Haptics
- Haptic feedback

## Appearance
- Light / Dark / System
- Board theme
- X/O cosmetic style

## Accessibility
- High contrast
- Reduce motion
- Larger UI
- color-safe mode if additional colors are introduced

## Notifications
- Friend requests
- Match found
- Friend challenges
- Rank changes
- Marketing separately

## Privacy
- Online status
- Friend request permissions
- Challenge permissions
- Profile visibility

## Account
- Profile
- Linked login
- Cloud sync
- Sign out

## Purchases
- Remove Ads
- Restore Purchases

---

# 20. Stats

Keep offline and online stats separate.

## Overview
- games played
- W/L/D
- win rate
- current streak
- best streak
- Mini Boards claimed
- average moves
- total play time

## Bot
Break down by difficulty:
- games
- wins
- losses
- draws
- win rate

## Online
Future server-backed:
- rating
- peak rating
- rank
- Ranked W/L/D
- Casual W/L/D
- streaks
- match history

Never count bot/local games toward ranked stats.

---

# 21. Friends / Online Structure

Future production structure:

- username
- avatar
- rating/rank
- online status
- friend requests
- recent opponents
- private challenges
- block/report

Ranked games must use a server-authoritative rules engine.

The client may optimistically animate a move, but the server decides validity.

Never fake online opponents using bots.

---

# 22. Monetization

Recommended launch model:

- free game
- occasional post-match ads only
- no ads during a live game
- one-time Remove Ads purchase
- optional cosmetic board and X/O themes

Never sell competitive advantages.

No energy system.

No paid extra moves.

No stronger paid bot assistance in ranked play.

---

# 23. Responsive Requirements

V3 must be tested at minimum at:

- 320 px width
- 360 px
- 390 px
- 430 px
- tablet portrait

Hard rules:

- board remains square
- no X/O-induced resizing
- no claimed-board-induced resizing
- player cards never push board off-screen unexpectedly
- bottom controls remain reachable
- no horizontal scrolling
- modals fit within safe viewport height
- keyboard should not destroy layout in code/join-room fields

Use `clamp()` sparingly for typography and spacing.

Never use content dimensions to size gameplay cells.

---

# 24. Accessibility

- X and O differentiated by geometry, not color
- minimum 44x44 touch targets
- sufficient text/background contrast
- Reduce Motion disables nonessential animation
- screen reader labels on cells:
  - "Centre Mini Board, Top Right cell, empty"
  - "Top Left Mini Board, won by X"
- active board state must be announced
- timer warning should not rely only on color

---

# 25. Code Architecture Target

The current single-file prototype should not be the long-term architecture.

Separate:

## Rules Engine
Pure functions:
- `getLegalMoves`
- `isLegalMove`
- `applyMove`
- `resolveMiniBoard`
- `resolveMegaBoard`
- `getNextBoard`
- `isFreeMove`

## UI
Components:
- AppShell
- MainMenu
- ModeCard
- MatchSetup
- PlayerHeader
- TurnBanner
- MegaBoard
- MiniBoard
- Cell
- MarkX
- MarkO
- Settings
- Stats
- MatchResult

## AI
Separate bot module:
- Beginner
- Easy
- Medium
- Hard
- Expert

## Networking
Separate online adapter:
- auth
- room
- matchmaking
- authoritative move submission
- reconnect
- rating update

This separation is required before production online multiplayer.

---

# 26. V3 Acceptance Criteria

V3 is not complete until all of the following are true:

- [ ] No emoji icons in product UI
- [ ] Consistent SVG icon family
- [ ] Custom SVG X and O
- [ ] No board/cell resizing after any move
- [ ] No board resizing after a Mini Board is claimed
- [ ] Active-board state is unmistakable
- [ ] Free Move state is unmistakable
- [ ] Destination preview works without reflow
- [ ] Responsive at 320-430 px widths
- [ ] Rules engine is separated from visual rendering
- [ ] Offline bot modes work end-to-end
- [ ] Local pass-and-play works end-to-end
- [ ] Stats separate offline and online
- [ ] Settings do not interrupt or resize gameplay
- [ ] Reduced-motion mode works
- [ ] Online UI does not fake a real connected opponent
- [ ] Ranked implementation remains server-authoritative when backend is added

---

# 27. V3 Design Summary

**Mega Tic-Tac-Toe V3 should look like a premium pocket strategy board game.**

The visual hierarchy is:

**Board > Turn information > Players > Controls > Decoration**

The interaction hierarchy is:

**Legal move > Destination consequence > Mini Board ownership > Mega Board strategy**

Every visual decision should make one of those relationships clearer.

The unique identity comes from the combination of:

- warm matte board-game surfaces
- precise modular geometry
- cobalt X vs coral O
- amber tactical highlighting
- custom scalable marks
- restrained tactile motion
- premium SVG iconography
- a board-first interface

V3 should no longer look like a mockup of an app.

It should look like the actual game.
