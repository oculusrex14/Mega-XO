# Mega-XO Handoff — V4.1 Live → V5 Program

**Date:** 2026-10-07
**From:** opencode harness (this session)
**To:** whoever picks this up next, on any harness
**Read this first, then `NewArchitecture.md`, then `docs/V4-OPEN-BLOCKERS.md`.**

---

## 1. One-paragraph state

Mega-XO **V4.1.1 is live in production** at `https://play.antimatterinnovations.com`
(immutable image `ghcr.io/oculusrex14/mega-xo@sha256:225b93cc…`, tag `v4.1.1`,
commit `f31618d`). All V4.1 launch blockers (EXT-01 through EXT-30) are recorded
COMPLETE in `docs/V4-OPEN-BLOCKERS.md`. Staging is intentionally **stopped** while
production owns ports 80/443. One loose end: production off-box backup activation
was failing with `BACKUP_TRANSPORT_FAILED` at last attempt (§7). Separately, the
**V5 program is fully planned** in `/NewArchitecture.md` (25 phases, Neon
Postgres as durable truth, Vercel frontend/API, Redis ephemera, distributed Game
Core) — **start only with Phases 0–3**, and V4.1 stays operational throughout.
Neon account is authenticated on this machine but has **zero projects yet** (§9).

---

## 2. What's live right now

| Surface | State |
|---|---|
| Production | `https://play.antimatterinnovations.com/` → 200; `/livez {"ok":true}`; `/opsz {"ok":false}` (false = no fresh backup snapshot yet, see §7) |
| Production privacy | `/metrics` → 404, `/server/production/main.js` → 404, no server fingerprint header |
| Staging | `https://staging.play.antimatterinnovations.com` — **containers stopped on purpose** (`--profile backup down`); re-bring only after stopping the production edge (they share 80/443) |
| UptimeRobot | `mega-xo-livez` + `mega-xo-opsz`, HTTPS, 5-min checks; DOWN alert mails verified received |
| VPS health | `host-health-monitor.sh` HEALTHY baseline; forced-outage alert + recovery mails verified |
| systemd (prod) | `mega-xo-health.timer` active, `mega-xo-db-integrity.timer` active, 15-min backup worker container up |

### Release identity (production)

- Tag: `v4.1.1` (supersedes `v4.1.0`) — tag == `package.json` version (release-gate requirement)
- Commit: `f31618d1fd3d7cb3d82b9ad90f4c689ebe36248e`
- Digest: `ghcr.io/oculusrex14/mega-xo@sha256:225b93ccf8718e9fa4484cdcd920604a1535d86f35c6dfec9eae11777bd3df4f`
- Branch head: `V4.1` @ `8a77d3f` ("record completed production release")
- Gate: `scripts/release-gate.js` returned `{"approved":true,…}` for this tag/sha

---

## 3. Infrastructure map

- **VPS:** `openclaw-host`, `129.80.67.164`, Oracle `VM.Standard.A1.Flex` 4 OCPU / 24 GB, region `iad`, `aarch64`, Ubuntu 24.04.4, Docker 29.5.0, Tailscale node `command` (`100.64.128.46`)
- **SSH: Tailscale only** — `ssh command`. Direct `ubuntu@129.80.67.164:22` times out **by design**. `sudo -n` works without a password prompt.
- **DNS (Hostinger):** `play.antimatterinnovations.com A → 129.80.67.164 TTL 300`; `staging.play.antimatterinnovations.com A → 129.80.67.164 TTL 300`; no AAAA; mail records untouched.
- **Ingress:** Oracle security list opens TCP 80+443 from `0.0.0.0/0`; host `ufw` allows `80/tcp` + `443/tcp`; SSH is Tailscale-only.
- **TLS:** Caddy terminates both names; production Caddyfile at `/opt/mega-xo` (`deploy/Caddyfile`), staging variant `deploy/Caddyfile.staging`.
- **Roots on VPS:** production `/opt/mega-xo`, staging `/opt/mega-xo-staging` (created by `scripts/init-vps.js`; secrets files are mode 600).

---

## 4. V4.1 as-built — what is implemented

Single-Node deployment: Node.js app + SQLite (per-root database files) behind Caddy.
Game Core, API, and web frontend are one unit in V4.1 — **this is exactly what V5
decomposes** (do not "fix" this piecemeal; follow the V5 phases).

Implemented and accepted (evidence rows in `docs/V4-OPEN-BLOCKERS.md`):

- Guest online stays **sign-in-only** for V4.1 launch (deliberate scope decision).
- Private lobby **closes (`CANCELLED`) when the host leaves** (`src/tournament.js leave()`, `616c946`; tests 54/54 + 20/20 green).
- Full account system: email/password, Google/Apple OAuth (nonce/state/PKCE, issuer/audience/`sub` checks), linked accounts, recovery, sessions device-scoped with revocation (`scripts/operator.js`, loopback-only proven).
- Economy: Coins/Crowns wallets, ranked entry escrow, settlement, ledger, tournaments with payouts, store purchases.
- Moderation policy draft **approved** (EXT-29); reports/moderation flows implemented.
- Privacy export: Profile → Linked accounts & recovery → Privacy → Download my data verified clean (EXT-30).
- Email: Resend live acceptance PASS to test inbox (EXT-12).
- Operator API: loopback-only proven, live `MX-…` support-ID lookup + `sessions-revoke` audited, `audit-verify` valid (EXT-28). Audit chain uses a **dedicated `MEGA_AUDIT_SECRET`/`audit_secret`** — never the session secret (EXT-27 fix; see §6).
- Static UI suite 89/89 green; `npm test` green at release commit.
- Offline/airplane, reboot recovery, restore drill (`4541468f`), capacity acceptance — all recorded in the ledger.

---

## 5. Secrets & credentials map (paths only — no values in repo or chat)

| Secret | Lives at | Notes |
|---|---|---|
| Production app secrets | `/opt/mega-xo/secrets/*` (600) | installed via `deploy/install-secrets.sh`; includes dedicated `audit_secret` (`--audit-file` flag — order matters, see script) |
| Staging app secrets | `/opt/mega-xo-staging/secrets/*` (600) | same installer |
| Staging Basic Auth | `/opt/mega-xo-staging/secrets/staging_access_password`, user `staging` | owner fetches over SSH only |
| Restic passwords (both roots) | **Operator-held offline** | saved by operator during EXT-09; rotation drill done (EXT-27) |
| Resend API key | installed in both roots (hash `4eafcb3e…` in ledger) | rotation waived by operator; temp files shredded |
| R2 backup token | bucket-scoped, `da585304…`; old `7a01af4b…` **revoked** | atomic rotation procedure: `deploy/rotate-r2-credentials.sh` |
| Neon API key | `~/.config/neon/credentials.default.json` (600), profile `default`, account `oculusrexai@gmail.com` | §9 |
| GHCR | release images pushed (package was flipped public for staging pull; flip back to private) | §7 |

**Iron rule, still in force:** never paste production secrets/keys/OTPs in chat or
the repo. Pass via file-drop/stdin; shred temp files. The ledger records hashes
and non-secret evidence only.

---

## 6. Hard-won fixes — do not regress these

1. **Audit secret isolation (EXT-27).** `server/production/*` reads audit HMAC from
   dedicated `MEGA_AUDIT_SECRET`/`audit_secret`, never the session secret.
   `scripts/image-smoke.sh` must carry the audit secret or images falsely fail.
2. **Short snapshot IDs.** `scripts/backup-run.js` and `deploy/enable-backups.sh`
   accept 8–64 hex chars (`4e72d97`), not just 64 — Restic short IDs are used
   everywhere in the runbooks.
3. **Empty Apple roots.** Empty Apple identity roots = Apple disabled, but a
   *partial* Apple config stays fail-closed (staging boot fix).
4. **Edge capabilities.** `deploy/compose.yaml` edge needs
   `cap_add: [NET_BIND_SERVICE, DAC_READ_SEARCH]` or Caddy bind fails.
5. **`deploy/db-integrity-check.sh`.** Fixed stray backslash + host-vs-node
   validation; all `deploy/*.sh` are `+x`.
6. **Release discipline.** Only immutable `…@sha256:DIGEST` ever deploys.
   `scripts/release-gate.js` requires tag == `package.json` version + all
   REQUIRED EXT rows COMPLETE. Verify with `deploy/verify-release.sh` before
   `deploy/release.sh`.
7. **Port ownership.** Production and staging share 80/443 — exactly one edge runs
   at a time. Staging re-bring = stop production edge first (reverse to hand back).

---

## 7. Loose ends / active issues (in priority order)

1. **Production off-box backup failing (only red item).**
   `deploy/enable-backups.sh /opt/mega-xo --initialize-new-repository` returned
   `{"event":"backup_failed","code":"BACKUP_TRANSPORT_FAILED"}`; after syncing the
   staging R2 pair into production it progressed to `backup_repository_checked`
   but reported *"Backup status did not contain a valid snapshot ID"* — so
   `/opt/mega-xo/backup-status/last-success.json` has no valid snapshot and
   `/opsz` stays `{"ok":false}`. Suspect `backup.env` repository/prefix or R2
   credential scope on the production root. Fix, re-run, confirm `/opsz true`,
   then record EXT-17-style evidence. Staging backup is green (snapshot
   `397312` bytes `3baabee3`, `sha256 c4750560…`, retrieve+verify PASS) — use it
   as the working reference.
2. **Flip GHCR package back to private** (was opened for staging pull).
3. **Confirm UptimeRobot green** on the production URLs (~5 min after cutover).
4. **Store/ads native track** is the only remaining program after the above:
   `native/COMMERCE-AND-ADS.md` + `docs/V4-P0-PLATFORM-READINESS.md` brief the
   external Android/iOS builder (works off `V4.1`).

---

## 8. Branch / tag / image inventory

- Repo: `https://github.com/oculusrex14/Mega-XO.git`, branch **`V4.1`** (head `8a77d3f`)
- Tags: `v4.1.1` (production, current), `v4.1.0` (superseded — images failed on missing audit secret in smoke)
- GHCR: `ghcr.io/oculusrex14/mega-xo@sha256:225b93ccf8718e9fa4484cdcd920604a1535d86f35c6dfec9eae11777bd3df4f`
- `main`/production `V4` history untouched by V5 work (V5 branches off green V4.1 — §10)
- **Untracked in workdir, must be committed or deliberately carried:**
  `NewArchitecture.md` (the V5 plan), `.agents/skills/` (`neon`, `neon-postgres`),
  `skills-lock.json` (pinned skill hashes)

---

## 9. Neon access (already wired on this machine)

- CLI: `npx neon@latest …` from the workdir.
- Auth: profile `default` holds an API key for `oculusrexai@gmail.com`
  (`~/.config/neon/credentials.default.json`, 600). No browser flow needed.
- Org: **Antimatter Innovations** (`org-wandering-sea-53820697`, Free plan).
  Org-scoped commands **must** pass `--org-id org-wandering-sea-53820697` or the
  CLI blocks on an interactive picker.
- Projects: **none exist yet** — first V5 job is to create the project
  (recommended region near IAD / US-East, per the plan).
- Skills: `neon` + `neon-postgres` installed **user-level** (all harnesses on this
  Mac: antigravity, claude-code, codex, gemini-cli, grok, opencode,
  github-copilot) **and** project-local in `.agents/skills/` + `skills-lock.json`.

---

## 10. The V5 program (what the next harness builds)

Full spec: `/NewArchitecture.md` (2455 lines — the authority; this section is an index).

- **Central rule:** one identity system, one authoritative PostgreSQL database,
  one competitive game authority. Browser, Android, iOS are clients of the same platform.
- **Target:** Vercel (`megaxo.online`, browser game, stateless APIs) → Neon
  Postgres (durable truth) → Redis/Valkey (ephemeral only — *"if wiping Redis
  would permanently harm a player, it doesn't belong in Redis"*) → Game Core on
  Oracle VPS (sole authority for wins, Elo, wallets, payouts) → realtime
  `wss://rt.megaxo.online` with revision-based durable match state → background
  worker → dual backups (Neon PITR + encrypted R2).
- **Milestones:** V5.0 Foundation → V5.1 Persistence → V5.2 Identity → V5.3
  Distributed state → V5.4 Game Core → V5.5 Hybrid cloud → V5.6 Reliability →
  V5.7 Cross-platform → V5.8 Web → V5.9 Production → V5.10 Scale.
- **Start with Phases 0–3 only:** freeze architecture/ownership (Phase 0, new
  long-lived branch `V5-platform` from latest green V4.1) → extract
  repository/domain boundaries (Phase 1, `npm test` stays green) → provision Neon
  + real migrations (Phase 2) → deterministic SQLite→Postgres migration with
  **zero unexplained reconciliation differences** (Phase 3). Do not build Redis,
  realtime, and Vercel APIs simultaneously.
- **Invariants that must survive:** every Coin/Crown accountable across migration
  (no creation/destruction), actor IDs permanent, Google/Apple `sub` never becomes
  the primary key, Game Core alone settles economy, V4.1 stays live until final cutover.

---

## 11. Next harness — first-session checklist

1. `git status -sb && git log --oneline -5` on branch `V4.1` — expect head `8a77d3f`; decide what to do with the untracked files (§8).
2. `ssh command 'docker ps --format "{{.Names}} {{.Status}}"'` — production stack up; staging down is expected.
3. `curl -s https://play.antimatterinnovations.com/livez https://play.antimatterinnovations.com/opsz` — `true` / currently `false` (§7.1).
4. `npx neon@latest projects list --org-id org-wandering-sea-53820697` — works non-interactively; empty until V5 Phase 2.
5. Read `docs/V4-OPEN-BLOCKERS.md` (ledger), `deploy/RELEASE-RUNBOOK.md` (ship procedure), `NewArchitecture.md` Phases 0–3 (next work).
6. Knock out §7.1–7.3 before starting any V5 branch.

Key file index: runbooks `deploy/VPS-RUNBOOK.md`, `deploy/STAGING-RUNBOOK.md`,
`deploy/RELEASE-RUNBOOK.md`, `deploy/INCIDENT-RUNBOOK.md`,
`deploy/MODERATION-RUNBOOK.md`; deploy scripts `deploy/*.sh`; gates
`scripts/release-gate.js`, `scripts/vps-preflight.sh`, `scripts/operator.js`,
`scripts/backup-run.js`, `scripts/image-smoke.sh`; prod server
`server/production/`; domain/game `src/` + `tests/`; program docs `docs/`;
V5 plan `/NewArchitecture.md`.
