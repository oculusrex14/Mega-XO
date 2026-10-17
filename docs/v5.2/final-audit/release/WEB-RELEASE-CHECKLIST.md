# Website Release Checklist (https://megaxo.online)

| Item | Status | Notes |
|---|---|---|
| Production build | READY | candidate green in CI (validate, browser-presentation, realtime x3) |
| Domain/DNS | PASS | apex canonical; www 301; play.* 308 (verified live 2026-10-17) |
| TLS | PASS | valid to 2027-01-13 |
| Auth | PASS | Google + Apple live; MXA-SEC-001 cookie hardening in candidate |
| Gameplay | PASS | CI browser lanes + 320px reflow fix verified |
| Store/monetization | BLOCKED | live API stale (MXA-ECO-001) + commerce P1 cluster; Polar sandbox price ids pending (handoff section 8) |
| Responsive | PASS | 935-check presentation matrix green on audit head |
| Privacy/Terms | READY | live legal pages; deletion flow copy now honest (SAGAN-004) |
| Account management | PARTIAL | full flow in-app; website deep link fixed (SAGAN-003) |
| Analytics | N/A | opt-in only by design (metrics route MXA-INF-008 pending fix) |
| Error monitoring | NOT_RUN | /opsz exists; no external tracker configured (honest absence) |
| SEO/metadata | PASS | sitemap + canonical metadata in apps/web/seo.js |
| Security headers | FAIL (live) | MXA-SEC-002: candidate sets CSP/XFO/XCTO/Referrer-Policy; live serving lacks them - verify after deploy |
