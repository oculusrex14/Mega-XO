# B2 Play Console forms — 20 October 2026

Environment: authenticated Brave UI, existing Mega XOXO app `online.megaxo.xoxo`, developer
`4755692624714861405`, app `4972412657191136432`. Browser work was performed with the CUA
runtime. Source checkpoint: `0493d3df71a34980f1cc57fed432dc7a3e3ee643` (`origin/V6` at worktree
creation). Isolated worktree `/tmp/megaxo-b2-datasafety`, branch `codex-v6-data-safety`.
The owner's explicit task overrides the older branch names in AGENTS and the scratch playbook.

## Observed results

| Item | Result |
| --- | --- |
| Saved draft on entry | Present; Step 1 of 5 after reopening; existing collection/security answers and six selected types retained |
| Step 3 selections | Personal info `3/9`; Financial info `1/4`; App activity `1/5`; Device or other IDs `1/1` |
| Step 4 Personal info | `3 of 3 completed`: Name, Email address, User IDs |
| Step 4 Financial info | `1 of 1 completed`: Purchase history |
| Step 4 App activity | `1 of 1 completed`: App interactions |
| Step 4 Device or other IDs | `1 of 1 completed` |
| Step 5 of 5 | Expanded preview matched the supplied purposes, sharing, and optional purchase history |
| Data safety final Save | **PASS**: `Change saved. Send for review in Publishing overview.`; not merely Save draft |
| Category | **PASS**: Game → Board; category save confirmation observed |
| Contact details | **PASS**: `contact@antimatterinnovations.com`, `https://megaxo.online`; phone left blank; save confirmation observed |
| Default listing | **PASS**: completed Assets → Review → Save; listing table says `Ready to send for review`, updated Oct 20, 2026 |
| Setup dashboard | `9 of 11 complete` after Data safety; `10 of 11 complete` after category/contact; unfinished setup section absent after listing save. No literal final `11 of 11` counter was displayed. |
| Publishing overview | `Changes not yet submitted for review` includes Data safety (`Complete Data safety questionnaire`), en-US default listing (`Provided app name (Mega XOXO), and all other required information`), and category (`Board game`). `Send app for review` is disabled pending remaining dashboard requirements. |

All six modal Save actions produced their respective saved confirmations. The UI combines
Collected/Shared in the first question and requests collection and sharing purposes separately
when both are checked. The supplied Device ID purpose, Advertising or marketing, was selected
for both. No additional purpose or data type was inferred.

| Type | Collected | Ephemeral | Shared | Collection purpose | Required |
| --- | --- | --- | --- | --- | --- |
| Name | Yes | No | No | App functionality | Yes |
| Email address | Yes | No | No | Account management | Yes |
| User IDs | Yes | No | No | App functionality | Yes |
| Purchase history | Yes | No | No | App functionality | No |
| App interactions | Yes | No | No | App functionality | Yes |
| Device or other IDs | Yes | No | Yes | Advertising or marketing | Yes |

The final declaration remains saved for review, not submitted, approved, or live. This execution
records the owner-supplied answers; it does not independently certify the final native SDK
inventory or close the earlier exact-build/device acceptance requirements.

## Listing text

Language: default English (United States), en-US. App name: **Mega XOXO** (9/30).

The playbook's literal short description was 82 characters, exceeding Play's 80-character limit.
Removing the opening `The ` gives the submitted 78-character version:

> Ultimate tic-tac-toe. Nine boards, one strategy. Play free, online or offline.

Full description (1,224/4,000 characters), adapted from the live
[About](https://megaxo.online/about) and [FAQ](https://megaxo.online/faq) pages:

```text
Mega XOXO is an Ultimate Tic-tac-toe strategy game by Antimatter Innovations. Nine small 3 × 3 boards form one bigger board. Every move also decides where your opponent plays next.

THINK ONE BOARD AHEAD
Place three Xs or Os in a row to claim a small board. Claim three small boards in a row on the bigger board to win the game. The cell you choose sends the next player to the corresponding small board. If that board is complete, they can choose any open board.

CHOOSE HOW YOU PLAY
Practice against Bot or share a screen with a friend. Play online by signing in to your permanent Mega XOXO profile. Online play requires an internet connection; local practice and same-screen play can be enjoyed offline.

COMPETITION THROUGH SKILL
Elo follows rated results. Currency and purchase history never create a skill advantage. Your linked profile carries your progression and connections across supported clients.

YOUR GAME. YOUR ATMOSPHERE.
Choose from Vector Light, Midnight Club, Paper Club and After Hours. Themes change the appearance while legal moves and competitive balance stay the same.

Learn the rules and find support at https://megaxo.online.
Questions, account help or feedback: contact@antimatterinnovations.com
```

## Uploaded assets and provenance

| Slot / file | Properties | SHA-256 |
| --- | --- | --- |
| App icon: existing `assets/p21/icons/native/play-store-512.png`, uploaded as `play-icon-512.png` | 512×512 RGBA PNG; 172,967 bytes; unchanged native icon export | `f031abe7cc55b5c778bd251236a422814cc470752d5e98755c457818fbc8b8c3` |
| `play-feature-1024x500.png` | 1024×500 opaque PNG; generated brand artwork | `7a1604d6da89967603a2df8802c1c71b4f5768860d06481c1d1dac78f5a18b43` |
| `phone-01-bot-midnight.jpg` | 1080×1920 JPEG; unaltered live browser viewport, Easy Bot / Midnight Club after a real local move | `d011a795acdd514b9237526c131edef43f391fae01a986787454949612b50e5f` |
| `phone-02-same-screen-vector.jpg` | 1080×1920 JPEG; unaltered live browser viewport, same-screen / Vector Light after six legal moves | `04e2f73406cbcb3ef6a17757ce4494859caf7f790741c34700ba8f622985221e` |

Phone screenshot slot: **2 / 8**. These are the running site's browser screenshots, expressly
permitted by the task, not screenshots from an Android device or evidence of native UI parity.
No synthetic gameplay, captions, or retouching were added. Temporary viewport and browser zoom
were reset. Tablet/PC/Desktop/XR assets and video were left empty; Play accepted the listing Save.
The UI recommends four screenshots for promotion; only the required two were supplied.

Feature graphic generation used the built-in imagegen tool, with existing
`assets/p21/art/hero-wide.webp` and `assets/p21/logos/mega-xoxo-horizontal-logo.png` as references.
The generated output was inspected, then mechanically resized to the required dimensions with
`sips --resampleHeightWidth 500 1024`. `sips -g pixelWidth -g pixelHeight -g hasAlpha` verified
dimensions and no alpha. The existing icon was copied without editing.

Final generation prompt:

```text
Use case: ads-marketing. Asset type: Google Play feature graphic, final exact 1024 by 500 pixels (wide 2.048:1 aspect ratio), opaque RGB PNG. Primary request: create a polished Mega XOXO store banner using the supplied existing brand assets. Input image 1 is the approved cosmic blue-purple landscape background; image 2 is the brand logo to preserve faithfully, including spelling MEGA XOXO and its cyan-magenta metallic design. Composition: cosmic landscape fills full width; place the existing horizontal logo prominently, centrally, with generous crop-safe margins. Beneath it, add one small clean white line of text exactly: 'Nine boards. One strategy.' Maintain crisp text and legible logo. Do not add a gameplay mockup, phone, store badge, price, rating, award, call to action, or any other text. This is brand artwork, not an app screenshot. The important content should stay inside the central 80 percent of the canvas. Keep brand identity and existing background style.
```

Play Review also exposed an AI asset declaration. The new feature graphic was marked as created
or edited using AI. The existing owner-supplied icon and unaltered browser screenshots were not
new AI generation/editing in this task; their boxes remained unchecked. This distinction is
recorded for owner review of inherited artwork provenance before any review submission.
[Play's declaration guidance](https://support.google.com/googleplay/android-developer/answer/17262077?hl=en)
was read in Brave; it describes per-asset declarations, editable in the asset library.

## Verification, limitations, and recovery

CUA actions used fresh AX states after changes and semantic locators to avoid shifting numeric
indices. One existing tab could not be claimed because another automation session owned it; a
fresh tab opened the same saved server-side draft. The extension file-chooser upload failed
because file-URL access is disabled. The native macOS file picker successfully uploaded only the
four chosen assets; extension permissions were not changed.

Local proof screenshots are kept outside the committed evidence, under
`.scratch/b2-evidence/{data-safety-saved,category-contact-saved,store-listing-ready,publishing-unsubmitted}.jpg`.
No authenticated AX/DOM traces, cookies, tokens, raw player data, or credentials were committed.
No local CI/test suite was run: verification was actual browser form saves plus image-property
checks and `git diff --check`.

No AAB was uploaded. No Test and release navigation, track edit, release submission, production
write/deployment, monetization code edit, or send-for-review action was performed. Closed testing
and exact-build release approval remain outside this task.

Recovery: these are unpublished Console changes. Edit the specific saved Data safety/category/
contact/listing fields in Console before sending for review if the owner revises the supplied
answers or assets. Reverting this evidence commit alone does not undo server-side Console saves.
The prior source is retained at the checkpoint above; no existing artwork or application file
was overwritten.
