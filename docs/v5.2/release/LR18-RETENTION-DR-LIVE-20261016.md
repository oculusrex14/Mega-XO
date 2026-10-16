# LR18 - retention & DR live verification (2026-10-16)

**Method:** read-only SSH inspection of the production host (systemd units, scripts, state) + the migration-chain schema. No sweep executed, no production data touched, no secrets printed.

## P0 FINDING - production retention sweeps target the STAGING database

The production host runs three V5.2 retention timers: mega-xo-v52-retention@spool / @backups / @captures (next run Mon 2026-10-19). Their service unit executes:

    ExecStart=/opt/mega-xo-v51-staging/bin/capture-job.sh retention

and that script is hardwired to staging: CAPTURE_ENV=staging, CAPTURE_TARGET_FILE=.../staging.json (the staging Neon DB), staging export/journal directories and staging key ids. Its own header says "Installed by the DC00 staging operator step."

**Consequences:**
1. Production data retention (the 730d/90d/7d windows) is NOT enforced - no production-targeted sweep exists anywhere on the host (there is no capture-job in /opt/mega-xo-v5-production/bin/).
2. The staging database receives the sweeps instead (harmless to production data, but the staging env is being mutated by units labeled as production).
3. The units depend on a staging tree that a staging redeploy could change or remove.

**Accidental safety:** because the sweeps target staging, the production BACKUPS have never been pruned by these units - the 35-day backup-prune gate the owner brief requires ("safe-prune proof first") is still intact. The corrective procedure below must NOT enable destructive backup pruning; it only retargets the sweeps correctly and keeps the backups-mode gate disabled until the independent safe-prune proof exists.

## Corrective procedure for Main (production change - Main's lane)

1. Create production capture configuration: /opt/mega-xo-v5-production/secrets/capture-job.env (mode 600) with the PRODUCTION capture target (docs/v5/environments/production.json), production CA/capture keys and CAPTURE_ENV=production; the capture role credentials come from the production capture-roles.json (create it from the deployed role identities - capture_privacy / capture_exporter / capture_runtime).
2. Install /opt/mega-xo-v5-production/bin/capture-job.sh - the same one-shot shape as the staging script but sourced from the production tree and production secrets, CAPTURE_EXPORT_DIR=/opt/mega-xo-v5-production/capture-dc00/export.
3. Repoint the three units: ExecStart=/opt/mega-xo-v5-production/bin/capture-job.sh <mode> (or regenerate from the repo unit templates), then systemctl daemon-reload.
4. Verify BEFORE the next scheduled run (Mon 2026-10-19): systemctl start mega-xo-v52-retention@spool.service and confirm the journal shows the PRODUCTION binding, then let the schedule resume.
5. **Backup prune stays DISABLED**: do not add a backups-mode destructive pass until the independent safe-prune proof (restore, prune, re-verify) is recorded. The current misconfiguration accidentally protected this; keep it that way.
6. Rollback: revert the unit ExecStart to the staging script (restores today's state, minus nothing).

## Verified healthy

| Check | Result |
| --- | --- |
| Consent routes fail closed | /api/account/research + deletion 401 anonymous (LR17 report) |
| Adult-band DB enforcement | CAPTURE_CONSENT_ADULT_ONLY in 0052; the service never softens it |
| Deletion state machine | real disable, tombstone, worker hand-off; the API never claims deleted:true |
| Capture schema deployed | 0044-0048 + 0052-0055 in the 55=55 chain (LR05) |
| Retention timers exist | spool/backups/captures scheduled; misdirected (finding above) |
| Worker retention sweep | ops.outbox terminal rows leave after the 7-day default (worker-workflows RETENTION_SQL) |
| Backup prune gate | intact - the misdirected units never touched production backups |
| No day-one training | no neural-training path exists in the capture lane (source inventory) |

## Honest limits

- The LIVE learning.policy posture (the production DB row) needs a read-only psql pass by Main - the exact SQL is in the LR17 report's delegated section.
- The 35-day backup-prune safe proof (restore, prune, re-verify) has not been performed - deliberately.
- The retention POLICY VALUES (730d capture / 90d exports / 7d spool / 35d backups) are reconciled in the source (worker-workflows 7d default; the rest live in the capture-job env/DB) - the production values are readable only after the corrective procedure runs.
