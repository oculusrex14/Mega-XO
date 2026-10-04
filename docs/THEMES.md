# V3.2 authored theme contracts

Vector Light preserves the familiar clean hierarchy. Midnight Club uses layered slate surfaces and lime control faces. Paper Club uses printed cream stock, warm ink, serif display text, ruled texture and restrained offset shadows. After Hours uses deep violet, cyan/rose marks, arcade-like edges and controlled glow without flicker.

All themes share interaction and board geometry, not colors. The cell DOM is created once, with explicit 3x3 rows/columns and absolute SVG mark/claim layers. A theme change cannot insert text into a sizing track, reset a game or restart the turn timer.

Required pairs: `surface/ink`, `raised/ink`, `soft/muted`, `cta/on-cta`, `accent/on-accent`, `x-soft/x`, `o-soft/o`. Never assume white is the correct foreground on a colored control. SVG icons inherit the foreground of the paired control, not the global text token. Badge backgrounds and strokes have a separate light/dark palette for each league.

| Theme | Primary text/surface | Muted text/soft | CTA text/fill | Accent text/fill |
|---|---:|---:|---:|---:|
| Vector Light | 15.43 | 5.23 | 16.27 | 10.03 |
| Midnight Club | 15.96 | 7.10 | 11.60 | 11.60 |
| Paper Club | 11.45 | 4.93 | 11.64 | 8.09 |
| After Hours | 16.53 | 7.35 | 10.38 | 10.38 |

Ratios are measured contrast checks, not a claim of full WCAG certification. The automated suite checks 44 semantic foreground/background pairs across all themes; normal text targets 4.5:1 and marks target 3:1. Small borders/decorative textures are not used as the only state indicator.

Native dialogs retain focus and block background taps. Controls generally target 44px or more. The 81-cell board necessarily has smaller cells on phones; a future magnified-board input mode is an accessibility improvement still worth shipping. Screen readers receive board/cell names and the live turn instruction. Reduce motion never changes bot strength, delays or rules.

Test widths: 320, 360, 390, 430 and portrait tablet 768. Small-height screens scale the board within a constrained height budget and keep the controls reachable. Native iOS/Android and assistive-technology audits are still required.
