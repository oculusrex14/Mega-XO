# V4 staging deployment and acceptance runbook

Staging origin: **https://staging.play.antimatterinnovations.com**

Staging is a separate deployment root, SQLite database, OTP/proxy secrets, Basic Auth credential, mail budget, and backup repository. Purchases, ads, and paid-entry competition remain disabled.

On the single-VPS launch architecture, pre-production staging temporarily owns public ports 80/443. Stop staging before starting the production edge.

## 1. DNS

In Hostinger DNS for `antimatterinnovations.com`, add:

| Type | Name | Points to | TTL |
| --- | --- | --- | --- |
| A | `staging.play` | the Oracle VPS public IPv4 | 300 |

Do not add AAAA unless IPv6 is verified end-to-end.

Confirm:

```bash
getent ahostsv4 staging.play.antimatterinnovations.com
```

## 2. Initialize an isolated staging root

From the V4 repository on the VPS:

```bash
sudo docker run --rm --platform linux/arm64 \
  -v "$PWD:/src:ro" \
  -v /opt/mega-xo-staging:/opt/mega-xo-staging \
  -w /src \
  node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 \
  node scripts/init-vps.js \
  staging.play.antimatterinnovations.com \
  /opt/mega-xo-staging \
  staging
```

Expected origin:

```text
https://staging.play.antimatterinnovations.com
```

Staging creates its own:

- database directory;
- OTP secret;
- proxy secret;
- Restic recovery password;
- Basic Auth password;
- mail/outbox state;
- backup/status directories.

## 3. Prepare staging access protection

Run:

```bash
sudo bash deploy/prepare-staging.sh /opt/mega-xo-staging
```

This uses the pinned Caddy image to hash the generated staging password. It never prints the password.

When a human needs to log in:

```bash
sudo cat /opt/mega-xo-staging/secrets/staging_access_password
```

Username:

```text
staging
```

Do not copy the password into GitHub or this blocker ledger.

## 4. Install staging mail secrets

Create a separate Resend API key for staging if practical. Restrict it to the verified Antimatter Innovations domain.

Install it through:

```bash
sudo bash deploy/install-secrets.sh /opt/mega-xo-staging
```

The prompt does not echo the key.

Google/Apple login credentials are optional for the first staging deployment. If testing them, install their secret files through the same script rather than placing private values in `app.env`.

## 5. Configure isolated encrypted backups

Staging and production use separate Restic repository prefixes even if they share one private R2 bucket:

```text
mega-xo-v4-staging
mega-xo-v4-production
```

Configure staging with:

```bash
sudo bash deploy/configure-r2-backup.sh \
  /opt/mega-xo-staging \
  CLOUDFLARE_ACCOUNT_ID \
  mega-xo-backups \
  --access-key-file /root/r2-access-key \
  --secret-key-file /root/r2-secret-key
```

Preserve the staging Restic password outside the VPS before enabling backups.

## 6. Obtain an immutable release-candidate image

Deploy only a GHCR digest that passed V4 source validation plus amd64/arm64 container acceptance.

Expected form:

```text
ghcr.io/oculusrex14/mega-xo@sha256:<64 hex chars>
```

Do not deploy a mutable `:latest`, branch tag, or unverified local image.

## 7. First staging deployment

Ensure no other process is using public 80/443, then:

```bash
sudo bash deploy/release.sh \
  /opt/mega-xo-staging \
  ghcr.io/oculusrex14/mega-xo@sha256:IMAGE_DIGEST
```

Caddy obtains a public certificate for `staging.play.antimatterinnovations.com`.

## 8. Automated live smoke

Run:

```bash
sudo bash deploy/staging-smoke.sh /opt/mega-xo-staging
```

It checks:

- staging Basic Auth is mandatory;
- public TLS responds;
- liveness/readiness are healthy;
- no-index header is present;
- private source/metrics paths return 404;
- a secure HttpOnly session cookie is issued;
- hostile-origin email requests are rejected before OTP activity.

The script never prints the staging password.

## 9. Enable and prove off-box backup

After the first database exists:

```bash
sudo bash deploy/enable-backups.sh \
  /opt/mega-xo-staging \
  --initialize-new-repository
```

The recurring backup worker starts only after first upload, repository check, retrieval, and integrity verification all succeed.

## 10. Manual real-email acceptance

Use a real test mailbox you control.

Test signup:

1. Open the staging URL.
2. Enter Basic Auth.
3. Choose **Continue with email**.
4. Use a new test email and a strong test password.
5. Confirm the OTP arrives from **Mega XO by Antimatter Innovations**.
6. Enter the OTP.
7. Confirm the profile is created only after OTP success.

Test recovery:

1. Sign out.
2. Choose **Forgot password?**
3. Enter the same email.
4. Confirm the reset OTP arrives.
5. Verify OTP.
6. Set a new password.
7. Confirm the old password no longer works.
8. Confirm the new password restores the same player tag/profile.

Do not use a production customer account for staging.

## 11. Restart and reboot acceptance

Before restart, create known non-sensitive test state.

Then:

```bash
docker restart mega-xo-staging-app-1
sudo reboot
```

Container names may differ; use `docker compose ps` rather than guessing when executing.

After each restart:

- `deploy/staging-smoke.sh` passes;
- the same account/profile returns;
- wallet/rank/save state is intact;
- no duplicate refund/ledger event appears;
- incomplete match escrow follows the restart/refund rule exactly once.

## 12. Full backup/restore drill

On staging only:

1. record known test account/wallet state;
2. force a fresh backup;
3. retrieve a specific snapshot;
4. place staging in maintenance;
5. stop staging;
6. restore via `deploy/restore.sh ... --confirm-replace`;
7. restart;
8. verify the known state;
9. verify the pre-restore local safety snapshot exists.

## 13. Stop staging before production

Because this one-VPS pre-launch layout uses the same public ports:

```bash
export MEGA_ROOT=/opt/mega-xo-staging
export MEGA_IMAGE=$(cat /opt/mega-xo-staging/current-image)
docker compose --env-file /opt/mega-xo-staging/compose.env -f deploy/compose.yaml --profile backup down
```

Verify ports 80/443 are free before starting the production edge.

## 14. Record completion

Update `docs/V4-OPEN-BLOCKERS.md` with non-secret evidence for:

- EXT-10 staging DNS;
- EXT-11 staging deployment;
- EXT-12 real email acceptance;
- EXT-13 restart/reboot acceptance;
- EXT-14 backup/restore drill.
