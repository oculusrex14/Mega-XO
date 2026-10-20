# V6 batch-deploy runbook (one authorized update)

Status: BLOCKED until the fresh Sol 6.1 verdict on V6 tip b7530b5/21344b1 is GO and the
A4 48h Neon idle-window verdict (2026-10-21) is recorded. Sequence below follows the
independent review's deployment section (/tmp/sol-v6-review/REVIEW.md, answers D) with the
R6 forward-recovery behavior now wired into scripts/v51/deploy-production.cjs.

## Preconditions (all must be true)

1. Fresh independent GO for the exact pinned SHA (any later executable-source change re-runs
   the review; docs-only commits on top are acceptable and must be disclosed).
2. Exact-SHA GitHub CI green: run of .github/workflows/v6-batch-validation.yml on the pinned
   SHA - all four jobs (promotion-wiring, promotion-postgres, website-build,
   post-deploy-gates). Evidence: run 39378362534 on 21344b1.
3. A4 verdict recorded: TWO sanitized Neon usage snapshots (mega-v5-neon-usage-snapshot/v1)
   around the 48h idle window, evaluated with deploy/v5/v5-idle-probe.js (fail-closed).
4. Website bundle rebuilt from the pinned SHA and its web-build.manifest.json source_commit
   equals the SHA; the bundle carries downloads/android/megaxo-1.0.11.apk (store-links pin; the CI website-build job derives the pin path, so it cannot drift).
5. Native artifacts rebuilt from the same source if any native file changed after
   13086f5/2dc4718: AAB for Play (google-play), APK for the website (direct-apk), both
   targetSdk 36. Play internal track already serves release 12 (1.0.11); a changed native artifact means
   a new Play upload before the batch.
6. Operator (owner) availability for the maintenance window; rollback decision authority.

## Sequence (maintenance window)

1. Read-only inventory on the host: live source commit/bundle hash, installed bin revisions,
   migration ledger length. Record alongside the rollback archive path.
2. Fence/drain ALL application writers (auth, jobs, webhooks, realtime). Confirm quiescence.
3. Verified PostgreSQL backup/recovery checkpoint; record the old source/web identities.
4. BEFORE the first migration: install and rehearse the migration-compatible recovery path.
   Abort if the recovery cannot boot against the expanded schema. The deploy failure handler
   now refuses an unbootable archive (FORWARD_RECOVERY_REQUIRED) - that is a safety net, not
   a plan.
5. From the exact release source, with the host-managed direct migrator URL supplied securely:
   V5_TARGET=production MIGRATE_CONFIRM=<exact-database-name> node scripts/v5/migrate.js
   --execute --confirm-production --json
   then: node scripts/v5/migrate.js --verify --json
   (Expect the chain to end at 0068_reward_ticket_powers or later; never rewrite applied files.)
6. Deploy with a clean checkout HEAD equal to the pinned SHA:
   node scripts/v51/deploy-production.cjs --commit <FULL_SHA> --bundle <VERIFIED_BUNDLE_DIR>
   --host command
   Record the generated source/web archive path.
7. Refresh the host-managed backup scripts from the freshly staged tree so the
   ephemeral-table-aware change-check (V6 cd32103) takes effect:
   sudo $ROOT/src-final/deploy/v5/install-change-aware.sh $ROOT
   (stages, preflights a real probe, installs, and rolls itself back on any failure;
   no service restart is needed - the next backup timer cycle picks it up).
8. Verify: readyz ready:true; exact source/bundle/download hashes (sha256 of the served APK
   must equal the store-links pin); same-origin API/realtime/session behavior; promotion
   disclosure/accept/reserve authorization; llms.txt, robots.txt, sitemap.xml, security.txt
   served; download page functional.
9. Policy publication is a DISTINCT approved step, only after step 8 acceptance:
   scripts/v5/publish-promotion-policy.cjs --dry-run first, then the real run, then verify
   the published hash matches Disclosure.ruleHash(). Reopen traffic only after acceptance.
10. Reopen traffic; monitor readyz, provider callbacks, promotion reservations and the
   rewarded-ad lane for at least one hour.

## Post-deploy A4 soak (the gate of record)

The pre-deploy soak window is polluted by launch-day device testing and was made unwinnable
by the ambient-write amplification the batch fixes (decision log 15:05 IST 2026-10-20). The
A4 verdict that certifies the Neon free-plan budget is therefore a NEW clean 24-48h soak run
AFTER this deploy:

1. With all owner devices idle (no app foreground, no browser tabs on megaxo.online), take
   sanitized snapshot 1 via the Neon consumption API (same schema as snapshot-1-*.json; the
   consumption period label must be the API value, currently 2026-10-19T13:12:28Z).
2. Leave the system untouched for 24-48h, then take sanitized snapshot 2 and evaluate:
   ssh command "sudo -n journalctl -u mega-xo-v5-production.service -u mega-xo-v5-backup.service
   -o cat --since '<window start> UTC'" | node deploy/v5/v5-idle-probe.js --before <1> --after <2>
3. Record the verdict in the decision log. With the fix live, idle windows must skip every
   cycle (0 dumps, 0 egress); any dump observed with no tracked-table writer is a defect.

## Rollback / forward recovery

- BEFORE any post-checkpoint write: use the pre-rehearsed PostgreSQL recovery procedure.
- Once writes have resumed: NEVER restore an old snapshot over new activity and never restart
  a SQLite writer. Forward-fix on the new trees; the deploy failure handler preserves them
  and prints FORWARD_RECOVERY_REQUIRED when the archive cannot boot the migrated schema.
- An unmodified schema-64 archive is NOT a valid fallback after 0065-0068.

## Post-deploy (A5)

Update RELEASE-GATES.md and the final-audit deliverables to the exact deployed state; record
the deployed SHA, bundle hash, migration chain end and verification evidence in
AUDIT-DECISION-LOG.md.
