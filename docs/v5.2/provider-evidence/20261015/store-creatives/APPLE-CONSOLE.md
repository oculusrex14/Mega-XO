# Apple App Store Connect product-page creative checkpoint

Observed read-only in the existing App Store Connect record on 2026-10-15 from 02:33–02:37 UTC; metadata below reflects the refreshed view at 02:37 UTC. App Store Connect Apple ID `6822833387`, Mega XOXO, bundle `online.megaxo.xoxo`, iOS version `1.0.0`. No new record was created. No asset was uploaded, selected, saved, or submitted.

## Current listing state

Version status is **Prepare for Submission**. No build is attached; the Build section says to upload a build. After refresh, **Add for Review** appeared enabled, but it was not clicked and no submission was made. The inspected localization is English (U.S.). The initial page render showed an older description; the value below is from the refreshed page. No field was edited or saved by this inspection.

- Name: **Mega XOXO**
- Subtitle: **Think one board ahead**
- Category: **Games**; subcategories **Board** and **Strategy**
- Promotional text: blank (170 characters available)
- Description: populated:
  > Nine small boards. One big strategy.
  >
  > Mega XOXO brings Ultimate Tic-tac-toe to your screen. Win the small boards to win the big one. Every move also decides where your opponent plays next.
  >
  > Learn the rules with a guided tutorial, practise against Bot, or share a screen for a local two-player game. Choose from Beginner, Easy, Medium, Hard and Expert difficulty. Explore four appearances with the same rules and legal moves.
  >
  > Think one board ahead.
- Keywords: `tic tac toe,ultimate,strategy,board game,puzzle,offline,bot,`
- Copyright: `2026 Antimatter Innovations`
- Support URL and Marketing URL: blank
- Version string: `1.0.0`

The description currently mentions a guided tutorial. The owner’s release guidance still marks the tutorial unverified, so confirm that path in the exact accepted signed build before using it as a screenshot or promotional claim. Keep Bot difficulty labels at Beginner, Easy, Medium, Hard, and Expert; do not rename Expert.

## Current creative slots and upload controls

Under **Header and Search Results**, both slots are empty. Each has a drag-and-drop area, **Browse Assets** (Asset Library), **Upload**, and **Preview** controls. The header has **0 of 1 Header Asset**; Search Results has **0 of 1 Search Results Asset**. The UI says that if no Search Results asset is added, app previews and screenshots appear there instead.

Apple’s creative-asset reference lists these image specifications:

| Placement | Accepted image sizes |
| --- | --- |
| Product page header | 3840 × 1646 px (21:9, JPEG/JPG/PNG); or 5244 × 2950 px (16:9, PNG) |
| Search results | 1920 × 1280 through 3840 × 2560 px (3:2, JPEG/JPG/PNG); or 5244 × 2950 px (16:9, PNG) |

Under **App Previews and Screenshots**, each visible device group has a drag-and-drop area, **Browse Assets**, **Upload**, **Preview**, up to **3 app previews**, and up to **10 screenshots**. All inspected counts are zero.

| Device group | Screenshot sizes shown in App Store Connect | App-preview sizes shown |
| --- | --- | --- |
| iPhone with Dynamic Island (medium display), for 6.1″/6.3″ | 2556 × 1179, 1179 × 2556, 2622 × 1206, 1206 × 2622 px | 1920 × 886 or 886 × 1920 px |
| iPhone Duo | 2034 × 1398, 1398 × 2034, 2853 × 2007, 2007 × 2853 px | 1920 × 886 or 886 × 1920 px |
| iPad 13″ display, for 12.9″/13″ | 2732 × 2048, 2048 × 2732, 2752 × 2064, 2064 × 2752 px | 1600 × 1200 or 1200 × 1600 px |

Apple’s current submission rule is at least **one screenshot for iPhone with Dynamic Island (medium display)** and, **if the app supports iPadOS**, at least **one screenshot for iPad 13-inch display**. You can provide up to 10 screenshots per device size. If the UI is consistent, App Store Connect scales the highest required resolution down to smaller sizes; images cannot have transparency. Accepted screenshot formats are JPEG, JPG, and PNG. The inspected Xcode project has `TARGETED_DEVICE_FAMILY = "1,2"` in Debug and Release, so its source configuration includes iPhone and iPad. There is no uploaded build to confirm the final shipped device family.

Apple’s current screenshot specification says iPhone Duo screenshots become required starting April 2027 for apps using the iOS 27.1 SDK or later. The release build and SDK are not uploaded/known yet, so verify the SDK at build time.

## Icon and provenance

The version page has no separate app-icon upload control. Apple takes the app icon from the uploaded build. Local native-icon readiness evidence says the AppIcon resources were added and simulator/debug builds passed, but it explicitly does not establish the icon in a signed or uploaded build. The App Store Connect record still has no build, so the shipping icon cannot be verified here. See [icon readiness](../../20261014/apple/ASC-APP-ICON-READINESS-20261015.md) and [native icon build evidence](../native-icons/README.md).

For screenshot art, use real game UI and keep any framing or callouts faithful to the final build. If captures come from the shared client bundle before the signed native build is available, label that provenance and treat native recapture as a release check.

## Draft copy option (not saved)

Promotional text, 157/170 characters:

> Most moves send your opponent to a new board. Challenge the Bot, pass the screen for local two-player play, and explore four appearances with the same rules.

Possible screenshot story: (1) “Nine small boards. One big strategy.” (2) “Most moves set the next board.” (3) “Choose your Bot challenge.” (4) “Two players. One screen.” (5) “Four appearances. Same rules.” Use these only where each state is present in the accepted build.

## Apple references

- [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
- [Creative assets specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/creative-assets-specifications)
- [App Store asset best practices](https://developer.apple.com/app-store/asset-best-practices/)
