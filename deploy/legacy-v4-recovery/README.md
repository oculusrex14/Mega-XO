# Legacy V4 recovery fence

The V4 to PostgreSQL authority cutover completed on 2026-10-15. The V4 SQLite
writer must never run again against current player data.

compose.yaml.fenced is the historical V4 compose project (SQLite app with
MEGA_DB=/data/mega.sqlite, restart: unless-stopped, an edge that depends_on
the app, and the V4 restic backup loop). It is kept byte-for-byte as a
recovery artifact and renamed .fenced so "docker compose -f" cannot load it.
Do not rename it back, do not "temporarily" run it, and do not copy its
services into the V5 edge file.

Every service in the fenced file carries the profile
v4-fenced-do-not-run, so a plain "docker compose up" on it selects no
service at all; running it requires passing --profile v4-fenced-do-not-run
explicitly, which is the point.

The production public edge is deploy/compose-v5-edge.yaml (Caddy only). The
game authority is the host systemd unit mega-xo-v5-production.service
(PostgreSQL/Neon + Core + API + realtime). The V4 data volume stays in place,
untouched, as the recovery asset until the owner explicitly retires it.
