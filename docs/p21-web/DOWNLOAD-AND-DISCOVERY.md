# Download routing and public discovery

Owner scope: replace the duplicate homepage browser button with **Download Now**, prepare device-specific store routing, and make the public website discoverable at **https://megaxo.online**. The future company showcase is **antimatterinnovations.com**. The GitHub repository is not a public marketing destination. The retained production service at play.antimatterinnovations.com remains an operational origin until a separately authorized hosting/authority change.

## Download availability

The homepage keeps **Play Now** inside `/game`. **Download Now** uses `/api/download`, a Node handler under `apps/web/api/` and the same handler in local preview. Android goes to Google Play; iPhone/iPad goes to the App Store when its listing exists. Browser detection also handles iPadOS desktop Safari using touch/platform evidence. Desktop opens `/download`, where users can choose a platform or browser play.

`apps/web/store-links.json` is the single public configuration. Both values are currently `null`. Set `android` to the actual HTTPS `play.google.com/store/apps/details?id=...` listing, and `ios` to the actual HTTPS `apps.apple.com/.../id...` listing after publication. Rebuild and deploy the website and API together; the build generates browser `store-links.js` from the same validated source. These are public listing URLs, not credentials or product grants.

Configured mobile links return 302; unavailable mobile links return 303 to `/download?platform=...&unavailable=1`; desktop returns 303 to `/download`. Redirects are uncached and vary on User-Agent. Explicit platform selection permits only `ios` or `android`; duplicate/unknown query parameters, arbitrary destinations, nonofficial hosts, credential-bearing URLs and redirect injection are rejected. HEAD is supported; writes return 405; invalid configuration returns 500 without a destination. No guessed store listing, purchase or reward grant is enabled.

## Public content and crawler policy

The static build prerenders all 39 website routes using the same pure views as the browser controller. Each HTTP document includes the complete header, main content and footer before JavaScript loads. Shared SEO functions emit and update unique route titles/descriptions, canonical links, Open Graph/Twitter cards and JSON-LD. Canonicals, sitemap entries, media references and brand descriptions use megaxo.online. All 22 public canonical routes appear once in `sitemap.xml`; alias routes share their destination canonical and stay out of the sitemap.

`robots.txt` allows the public site and assets, with explicit exclusions for `/game`, `/play`, `/legacy-game`, account/profile/friends/settings/challenge, utility/error paths, `/api/` and implementation copies under `/pages/`. Play and private/utility routes also carry `noindex`; unknown routes and `/404` actually return HTTP 404. Clean legal routes retain full source wording and draft notices under the website theme. Retained raw legal `.html` documents stay unchanged apart from their existing stylesheet path transformation and receive noindex and HTTP canonical Link headers.

The owner requested crawler blocking on gameplay, so both robots disallow and noindex are present there. A crawler respecting disallow cannot fetch that page's noindex, and a blocked URL can still appear as a URL-only result if externally linked; this combination is not a guarantee of removal. Public guides remain available for discovering and understanding the game.

Production configuration removes the prior global noindex header and applies selective exclusions. Local preview remains globally noindex by default. The `indexable: true` server option is only a programmatic loopback test fixture for verifying production policy. Automatic Git deployment remains disabled. Building these files does not publish the domain, submit a sitemap or establish search-engine indexing.

## Clear answers and legitimate links

`/faq` presents seven visible, factual answers about rules, browser accounts, themes, downloads and the official site. Its FAQ structured data is generated from those same answers. Other pages do not receive unrelated FAQ markup. Homepage/About/How-to-play carry factual VideoGame identity; every route carries website/publisher/page identity and applicable breadcrumbs. There are no invented ratings, reviews, release dates, prices or social profiles.

`/press` provides official facts, existing committed logo/icon downloads, a reusable description and game-guide links. Footer links make the FAQ, media kit and downloads discoverable. [company-project-card.html](company-project-card.html) is ready for the future Antimatter Innovations projects page, with ordinary direct links to megaxo.online. No external backlink has been published because the owner currently has no live company site or public profiles. Add the card when the company page exists; later use real store listing website fields for the game URL. Do not use automated link placement or public GitHub as a marketing backlink.

These changes address crawlability, useful answers, semantic identity, internal navigation, mobile rendering and share previews. They do not guarantee rankings, indexing or citations by AI services.

## Launch checks still required

- Publish the reviewed website/API on the authorized host with megaxo.online HTTPS and real same-origin session/service configuration.
- Verify deployed GET/HEAD statuses, selective headers, robots, sitemap, canonical URLs and store handler from outside the local fixture. Any new host alias should redirect to the canonical domain under an explicit domain-routing change.
- Add actual store URLs when listings are live; verify on real iPhone/iPad/Android devices.
- Publish the company showcase/card, then verify the real backlink.
- Verify domain ownership in search webmaster tools and submit the sitemap through the authenticated owner account after launch; no fabricated verification token is included.
- Complete pending human accessibility/physical-browser and legal/provider release gates.

## Primary guidance checked on 2026-10-11

Google recommends rendered public content, crawlable links, metadata and correct statuses in its [JavaScript SEO guidance](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics). Its [generative AI optimization guide](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide) builds on those fundamentals and does not require special AI files or markup. The [noindex guidance](https://developers.google.com/search/docs/crawling-indexing/block-indexing) explains the robots-disallow limitation. Its [spam policies](https://developers.google.com/search/docs/essentials/spam-policies) describe manipulative link practices to avoid. The [2026 documentation updates](https://developers.google.com/search/updates) record removal of Google FAQ rich results; the visible FAQ and matching Schema.org semantics are not presented as a rich-result promise. [Schema.org VideoGame](https://schema.org/VideoGame) supplies the game identity vocabulary. Vercel's [Node runtime documentation](https://vercel.com/docs/functions/runtimes/node-js) supports the standalone project `/api` handler.

Exact source SHA, affected-path commands, local browser/accessibility results and CI are recorded with this unit's verification evidence after the code checkpoint. Native entitlements, approved game/economy rules, live V4 authority and the original V5 production gates remain unchanged.

## Verified checkpoint

Source `8520f1ca32bdcc830bfab6830e2292732849eae8` passes all 89 affected tests,901 browser checks and 137 accessibility checks locally, with zero automated violations. Eighteen prerender isolation checks prove unchanged raw main content and zero site execution during axe tooling; actual JavaScript-disabled rendering is independently covered by browser QA. 116 views remain for human review. Bundle `6d14a99617f49bdee645abb95df51577992530200a4d41af14e45d01d6a57242` contains 120 files / 2,945,270 bytes. [Exact verification](evidence/8520f1c/verification.json) records source, commands, environment, cases, screenshots and residual work.

Website CI [38114808679](https://github.com/oculusrex14/Mega-XO/actions/runs/38114808679) and retained validation [38114808754](https://github.com/oculusrex14/Mega-XO/actions/runs/38114808754) pass on that source. The downloaded CI manifest matches the local manifest byte for byte. No provider deployment, live store listing or external backlink was activated.

## Owner review, 14 October 2026

The owner requested removal of the media-kit page. `/press`, its footer link, its generated artifact, sitemap entry and Vercel rewrite are removed. The earlier media-kit description above is historical and superseded. Existing logo assets are preserved. Settings remains because it contains offline-copy management and account/privacy navigation.
