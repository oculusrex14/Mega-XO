# V3.2.1 final theme contracts

These four appearances are ported from the user's Figma export in `Design Game Themes.zip`. The V3.2 component tree, board geometry, game rules, social/rank/quest pages and interaction behavior remain unchanged.

## Vector Light

The clean default:

- canvas `#E9ECEF`
- app surface `#F8F9FB`
- raised cards `#FFFFFF`
- ink `#15181C`
- X `#246BFD`
- O `#F45669`
- route/accent `#C6FF42`
- Space Grotesk + IBM Plex Mono

The intent is bright, neutral and familiar.

## Midnight Club

A deliberately authored dark theme rather than an inversion:

- canvas `#080B10`
- app surface `#101720`
- raised cards `#18212C`
- text `#D4DCE5`
- X `#6F9DFF`
- O `#FF7A98`
- route/accent `#B9F03C`
- subtle inset highlights on cards and controls
- lime selection outlines and active-board glow
- Space Grotesk + IBM Plex Mono

## Paper Club

The notebook theme from the supplied Figma pack:

- canvas `#B9AB8F`
- paper surface `#F6EFDC`
- card paper `#fffbee`
- ink `#27221B`
- X `#2A4F9B`
- O `#C23A2E`
- route/accent `#FFD23F`
- ruled-paper + grain texture
- red notebook margin line
- irregular card radii and offset ink shadows
- SVG wobble filter on X/O and the brand mark
- Caveat + Patrick Hand

## After Hours

The retro arcade pack:

- canvas `#07030F`
- app surface `#0F0722`
- raised cards `#190D38`
- text `#F1EAFF`
- X `#2CF2FF`
- O `#FF4FB6`
- route/accent `#FFD83D`
- purple grid/gradient background
- square-edged controls
- cyan/pink mark glow
- yellow active-state glow
- subtle scanlines
- Orbitron + Chakra Petch + Share Tech Mono

No flashing or strobe effects are introduced.

## Shared guarantees

Theme switching is presentation-only. It does not:

- rebuild or resize the 81-cell board,
- reset a match,
- restart the turn timer,
- change bot strength,
- alter rank/coins/quests,
- change legal-move logic.

Saved legacy appearance IDs migrate automatically:

- `dark` -> `midnight`
- `paper` -> `paperclub`
- `neon` -> `afterhours`
- `light` -> `vector`

The settings UI keeps the V3.2 theme-card picker; only the four final appearance contracts changed.
