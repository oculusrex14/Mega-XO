# Mega XOXO launch checklist (2026-10-27)

The single source of truth for what stands between the current live state
(da888ac + staged V6 work) and a full public launch. Owner gates are the
human actions only the account holder can perform; engineering items are
owned by the orchestrator.

## Owner gates (human actions, in order)

1. **Google Play closed test**: invite 12 testers to the existing internal
   test link (play.google.com/apps/internaltest/4700778741227096719), have
   all 12 opt in, and let the 14-day closed-testing clock run. Production
   submission can only be clicked after the clock completes. Play Console
   forms are COMPLETE (11/11: data safety, IARC, listing, creatives).
2. **Apple App Store**: sign in to App Store Connect, accept the latest
   agreements, and complete identity/verification if prompted. Then the
   iOS checklist (IOS-RELEASE-CHECKLIST.md) can be executed; TestFlight
   external testing is optional before the first submission.
3. **On-device rewarded-ad impression (D2)**: open the installed APK on a
   physical Android device, play one rewarded ad to a completed impression
   while the AdMob debug logging is on, and confirm the reward grants.
   This is the last monetization acceptance case.
4. **Search Console + Bing verification**: add the megaxo.online property
   (DNS TXT or the hosted verification file), verify, then submit
   https://megaxo.online/sitemap.xml in both. Bing imports the Google
   verification via its import flow.
5. **Secret rotation** (deferred by owner decision): Dodo, Resend, Neon
   and the backup encryption keys should rotate after the store
   submissions; the runbook is ROLLBACK-PLAN.md plus the ops notes.

## Engineering state (orchestrator)

| Item | State |
| --- | --- |
| Production (megaxo.online) | da888ac live, readyz verified, 12/12 routes + health endpoints 200 |
| A4 compute | Defect modes eliminated (20 skips / 1 justified dump / 0 loops in the interim window); 9.48% active time is request-driven from live traffic; final 48h verdict ~08:58Z Oct 28 (automation scheduled) |
| Payments | Dodo primary, live with region pricing and the Launch50 promo; Polar dormant by owner decision |
| Ads | Native AdMob boundary fail-closed; only the on-device impression (D2) is unproven |
| SEO/AEO | Route-table-derived sitemap/robots/llms.txt, JSON-LD (Organization, WebSite, VideoGame, FAQPage), OG + Twitter cards on every public page |
| Staged on V6 (f16d11f) | R7-F1 exported attempt-budget constant; R7-F2 injected-timer cancellation consistency - deploy in the next window |
| Staged on V6 (this run-through) | /press kit restored with current facts, footer link, sitemap entry |

## Launch-day sequence

1. A4 final verdict lands ~08:58Z Oct 28; record it in the decision log.
2. Deploy the staged V6 window (press kit + P2 follow-ups) with the
   standard runbook; the bundle rebuild must pin the new exact SHA.
3. Re-run the two web QA suites (v5-p21-seo, v5-p21-web-build) in CI and
   the browser QA on the live store page.
4. Announce: the press kit (/press), the sponsors page and the news page
   are the landing surfaces; social cards render from the route table.
5. After launch: watch readyz, the error rate in the service journal and
   the Neon usage snapshot daily for the first week.

