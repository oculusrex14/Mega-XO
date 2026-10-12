# Live V4 authority - read-only inventory (2026-10-12)

Collected by the Main agent over Tailscale SSH (`command`, 100.64.128.46) with read-only
commands only. No restart, no write, no schema change, no secret printed. Sanitized: digests
and sizes are recorded, credential material is not.

## Host and writer

- Host `openclaw-host`, up 4 days at capture; load average ~0.00.
- Running containers: `mega-xo-production-edge-1` (caddy `sha256:d8542f48d34a...`),
  `mega-xo-production-app-1` (healthy), `mega-xo-production-backup-1`; plus co-hosted
  `chrome-webui` and the buildx builder. Only the three `mega-xo-production-*` belong to the product.
- Exactly one ingress owns host 80/443: the `docker-proxy` for the caddy edge container
  (pids 265287 on :80, 265301 on :443). No other listener on 80/443.
- No `mega`/`node`/`sqlite` writer process outside the containers; no product cron entries.
- App restart policy `unless-stopped`; co-hosted services are not disturbed by a production restart.

## Running image identity

- `/opt/mega-xo/current-image` = `ghcr.io/oculusrex14/mega-xo@sha256:71d33a1a9893a303c5ffcbdb090caefde22d9e7e054a8c2d6c494a44919b58e4`.
- `mega-xo-production-app-1` `Config.Image` = the same digest. Pinned by digest, not a mutable tag.
- App answers internally on the backend network: `livez` 200, `opsz` 200 (`{"ok":true}`).
  Externally, `Host: megaxo.online` over http returns `308` to `https://megaxo.online/`
  (redirect only); the authoritative loopback health reads are the app's own `200`s.
- `opsz` on the raw published port `127.0.0.1:9091` returns `404` (the public path is not exposed
  there) - recorded so it is not mistaken for an outage.

## Durable truth (SQLite, current authority)

- Single authority `/opt/mega-xo/data/mega.sqlite` (1,531,904 bytes) with live `-wal` (~4.3 MB) and
  `-shm`. A `mega.sqlite.coordinator.lock` guards single-writer coordination.
- Pre-deploy snapshot retained: `predeploy-20261007T172137Z.sqlite` (+ `.json`), the V4.1.2 deploy snapshot.
- This is the first-write boundary: the first post-import production write (auth/background/webhook)
  ends SQLite rollback eligibility. Nothing here was written by this inventory.

## Backups (independent, encrypted)

- Backup container mounts `data -> /data`, `backup-work -> /work` (Restic working dir),
  `backup-status -> /backup-status`, and secrets `backup_secret_key`, `restic_password`,
  `backup_access_key` at `/run/secrets/*`.
- `backup-status/last-success.json`: `snapshotId` `c7af4cec`, `bytes` 1,531,904,
  `sha256` `5723364433e654cf904a6661b0e018d92fc2203f81516ba2a9f7d7402d233d1d`, last completed 2026-10-12.
  The snapshot byte size equals the base `mega.sqlite` size, consistent with a captured-and-verified
  independent snapshot.

## Staging coexistence

- `/opt/mega-xo-staging` exists (its own `app.env`, `data/`, `releases/`, `secret-rotation.lock`)
  but has **no running containers**. New staging can therefore be stood up alongside production
  without stopping production or the co-hosted services; host 80/443 remain owned by the V4 edge
  until a deliberate, approved cutover.

## Boundary statement

This is read-only production inventory and a fresh integration checkpoint, not authorization to
change production. No V4 file, schema, image, DNS record or backup repository was modified. The
V5.1 branch remains a separate development branch; `main` and `V4.1` are untouched.
