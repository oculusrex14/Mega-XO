 # Takeover record, 2026-10-18 - production deploy + LR05 host sync
 
 Companion to TAKEOVER-20261017.md (kept open for context; this file records the deploy and the monitoring fix).
 
 ## PRODUCTION DEPLOY c66626c + live verification
 
 - DEPLOYED: scripts/v51/deploy-production.cjs commit c66626ce405abc6fdb794e54498a40f7c1f04414, bundle sha256 a0fc99721d1c55af7156761925450025daf66928dc7ccb63f829e5e7f4a66ef4 (171 files) at 2026-10-18T01:37:37Z; archive /opt/mega-xo-v5-production/rollback/2026-10-18T01-35-50-937Z-31948-c66626ce405a; host receipt state/deploy-receipt.json.
 - Boot-failure cycle that preceded the successful deploy (all fixed in-tree first): cashfreeEnv hoist (02bea36), verifier-gate null acceptance (c66626c), host secrets/proxy.secret provisioned via openssl rand -hex 48 (0600, root).
 - LIVE VERIFICATION (all pass): /readyz 200, /livez 200, /opsz 200, guest POST /api/monetization/exchange 401 (route live), guest /api/monetization/status 401, /.well-known/apple-app-site-association two-team appIDs (6N6C9338NX,D5TQJ76T44), security headers CSP+HSTS+XCTO+XFO present, https://megaxo.online serves the game shell.
 - SECRET-HANDLING FLAG: during diagnosis one tool result displayed the R2 reader token (cfat_..., read-only DR-bucket scope) and an earlier session displayed runtime-roles.json contents. Recommend the owner rotate both at the next maintenance window; nothing was committed to the repo.
 
 ## LR05 HOST SYNC (infra monitoring fix)
 
 - SYMPTOM: /opsz returned 503 and mega-xo-v5-freshness.service failed every run since ~Oct 15 21:51 while mega-xo-v5-backup.service verified upload+readback every 5 minutes.
 - ROOT CAUSE: host /opt/mega-xo-v5-production/bin/v5-r2-client.js predated the repo LR05 pagination fix (2026-10-16): list() fetched a single max-keys=1000 page, key-ordered oldest-first, so once the pg16-encrypted prefix passed 1000 objects (1117 at diagnosis) the freshness checker could only ever see backups from Oct 15 - a permanent false STALE. The fix existed in repo deploy/v5/ but was never synced to the host.
 - MUTATION: synced repo deploy/v5/v5-r2-client.js to host bin/ (install -m 0700 root:root); old file kept at bin/v5-r2-client.js.pre-LR05-sync-20261018. No other deploy/v5 file had drifted (verified by full-dir diff).
 - VERIFICATION: freshness run under systemd FRESH (newest manifest 7-307s old, 1117-1118 manifest objects counted, ciphertext head re-verified), /opsz answers ok:true locally and 200 via https://megaxo.online/opsz, recovery alert delivered, unit no longer in failed state. Rollback: restore the .pre-LR05 file (would reintroduce the false-stale only).
 - OWNER DECISION PENDING (not blocking): R2 remote retention is unbounded (1117+ objects, 2 per 5-min backup, no pruning). The client now paginates to a 100-page safety cap; recommend defining a retention policy (e.g. daily+weekly tiers) before the bucket reaches 100k objects, which is the only limit that still fails closed.
 
 ## WEB ANNOTATION P21-W-011 (sponsors page spacing)
 
 - Owner comment (browser, 2026-10-18): on /sponsors the 'No mail app? Copy the address: contact@antimatterinnovations.com' caption sits too close to the 'Open email draft' button - push it down for better spacing.
 - FIX: apps/web/pages.css gained .pg-sponsor-enquiry>p.pg-small.mx-muted:last-child{margin-top:18px} directly after the existing .pg-sponsor-enquiry rule. No markup change; the caption is still the fallback copy path.
 - ROLLBACK: delete the added line; rebuild.
