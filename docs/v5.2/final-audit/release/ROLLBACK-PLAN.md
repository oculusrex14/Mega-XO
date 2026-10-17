# Rollback Plan — V5.2

## Current state (BLOCKED)

The existing scripts/v51/deploy-production.cjs rollback path is NOT safe (MXA-INF-001, P0): the carry step moves host-managed launcher inventory and node_modules out of the archived tree, and the unhealthy path deletes the new tree then restores the stripped archive - the restored runtime cannot start. No deployment may proceed until this is fixed and PROVEN.

## Required fix (Main lane)

1. Archive the complete live tree unmodified (including serve.sh, node_modules, docs/v5/environments/production.json).
2. On unhealthy detection: stop services, restore the COMPLETE archive, restart, verify /livez + /opsz + one authenticated API read before declaring recovery.
3. Prove it: isolated staging rehearsal - deploy a deliberately broken build, trigger the unhealthy path, assert full recovery. Record commands + hashes in evidence/.

## Post-fix rollback sequence (authorized deploy only)

1. SSH read-only pre-check: disk, pg_isready, redis ping, current release SHA.
2. Deploy via scripts/v51/deploy-production.cjs (archives full live tree as dated rollback point).
3. Smoke: /livez, /opsz, GET /api/monetization/status guest 401, GET /api/account/session 200 set-cookie, game load on https://megaxo.online.
4. If unhealthy at ANY step: stop, restore the dated archive (complete), restart, re-run step 3 against the previous SHA.
5. Never restart a stale SQLite writer; PostgreSQL remains authority (writer-fence tests guard this).

Related: MXA-INF-002 (retention misbinding) must be fixed BEFORE any deploy so a rollback rehearsal cannot sweep the wrong authority.
