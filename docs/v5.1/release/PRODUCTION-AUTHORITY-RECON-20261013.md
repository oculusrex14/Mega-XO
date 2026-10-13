# P8 production authority recon — read-only (2026-10-13)

Read-only inspection of the live Oracle production host (`command`, tailnet `100.64.128.46`,
Ashburn us-east-1) to reconfirm the sole production writer before any cutover work. **No writes, no
restarts, no cutover.**

## Current authority (verified facts, not historical claims)

| Fact | Value |
| --- | --- |
| Running app container | `mega-xo-production-app-1`, image `ghcr.io/oculusrex14/mega-xo@sha256:71d33a1a9893a303c5ffcbdb090caefde22d9e7e054a8c2d6c494a44919b58e4` |
| Installed image pointer | `/opt/mega-xo/current-image` = the **same** digest `71d33a1a…` (matches the release receipt) |
| Edge/ingress | `mega-xo-production-edge-1` (caddy) — the **only** process binding host `0.0.0.0:80` and `0.0.0.0:443` |
| Backup | `mega-xo-production-backup-1` (image `225b93cc…`) |
| Product containers | exactly three (`edge`, `app`, `backup`) |
| Authority store | V4.1.2 SQLite inside the app container (single writer; no external mega/sqlite writer process found) |
| Staging isolation | `/opt/mega-xo-v51-staging` runs a **separate** loopback-only Node process on `127.0.0.1:8085` (no Docker, no host 80/443, no V4 contact) |
| Co-hosted | `chrome-webui` (linuxserver/chrome) and a buildx builder — unrelated to the product |

## Cutover-relevant reading

- Live authority is still **V4.1.2 / SQLite**; V5 has **not** become production authority. The
  V5.1 staging origin is isolated and non-serving.
- Exactly one ingress owns host 80/443, so the "new staging must coexist without stopping production"
  invariant holds: the V5.1 origin is on a private loopback+tailnet port only.
- No production restart or write occurred this session; the app container has been up 5 days.

## Still required before a real cutover (unchanged)

Final source freeze, consistent snapshot + import + per-actor reconciliation, authority-epoch/first-write
fence, worker/callback readiness, and a single owner go/no-go. These are **not** done; this recon only
reconfirmed the current writer state.
