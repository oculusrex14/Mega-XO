# V4 encrypted off-box backup runbook

V4 uses Restic encryption over Cloudflare R2's S3-compatible API. SQLite remains authoritative on the VPS; R2 stores encrypted recovery snapshots only.

## Why R2

As of October 2026, Cloudflare R2 Standard storage includes a monthly free tier of:

- 10 GB-month storage;
- 1 million Class A operations;
- 10 million Class B operations;
- free Internet egress.

V4 deliberately sets its own repository raw-data budget to **2 GiB**, well below the storage allowance. The application refuses a new backup before its conservative budget estimate would exceed that cap. This is a safety guard, not a provider billing guarantee.

Official references:

- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/r2/get-started/s3/

## 1. Create the bucket

In Cloudflare Dashboard:

1. Open **Storage & databases → R2 → Overview**.
2. Create a **Standard** storage bucket.
3. Recommended name: `mega-xo-backups`.
4. Do not make the bucket public.
5. Record the Cloudflare Account ID. It is not a secret.

Do not enable R2 SQL, Data Catalog, public development URLs, or unrelated features for this backup bucket.

## 2. Create a least-privilege R2 token

In **R2 → Manage API Tokens**:

1. Create an account or user API token.
2. Permission: **Object Read & Write**.
3. Scope it to the `mega-xo-backups` bucket only.
4. Copy the **Access Key ID** and **Secret Access Key**.
5. Store both outside GitHub. The secret cannot be viewed again after creation.

Do not use an R2 Admin token.

## 3. Configure the VPS without putting credentials on the command line

Place each credential temporarily in an owner-only file, for example:

```text
/root/r2-access-key
/root/r2-secret-key
```

Then run:

```bash
sudo bash deploy/configure-r2-backup.sh \
  /opt/mega-xo \
  CLOUDFLARE_ACCOUNT_ID \
  mega-xo-backups \
  --access-key-file /root/r2-access-key \
  --secret-key-file /root/r2-secret-key
```

For a jurisdiction-specific R2 bucket, append `--jurisdiction eu` or `--jurisdiction us` as appropriate.

After the command succeeds, securely remove the temporary credential files. The deployment copies credentials into owner-only Docker secret files.

The generated repository format is:

```text
s3:https://<ACCOUNT_ID>.r2.cloudflarestorage.com/mega-xo-backups/mega-xo-v4
```

and `AWS_DEFAULT_REGION=auto`.

## 4. Preserve the Restic recovery password outside the failure domain

`scripts/init-vps.js` generates a random Restic password at:

```text
/opt/mega-xo/secrets/restic_password
```

Before enabling backups, copy that password to a secure location that is:

- outside the Oracle VPS;
- outside the Cloudflare account;
- accessible to Antimatter Innovations if the VPS is lost.

Do not put it in GitHub, chat, screenshots, or the R2 bucket.

Without the Restic password, the encrypted backup repository cannot be recovered.

## 5. Prove backup and restore before starting the schedule

After a validated release image has created the SQLite database and `/opt/mega-xo/current-image` exists:

```bash
sudo bash deploy/enable-backups.sh /opt/mega-xo --initialize-new-repository
```

This command deliberately performs all of these before starting the recurring worker:

1. initializes a new encrypted Restic repository;
2. makes a SQLite online snapshot;
3. uploads it to R2;
4. runs a Restic repository check;
5. retrieves the exact first snapshot;
6. verifies its SHA-256 manifest and SQLite integrity/schema;
7. only then starts the 15-minute backup worker.

If any step fails, the recurring worker is not enabled.

## 6. Ongoing behavior

The backup worker:

- wakes approximately every 15 minutes;
- obtains a WAL-consistent SQLite online snapshot;
- checks repository usage against the V4 budget;
- uploads the database plus integrity manifest;
- records the last successful snapshot locally;
- never automatically deletes/prunes data.

Retention/pruning is an explicit operator action:

```bash
docker compose ... run --rm backup node scripts/backup-run.js prune --confirm-retention
```

The configured policy keeps recent hourly/day-scale recovery points plus daily and weekly history. Always review actual repository size before pruning.

## 7. Recovery drill

A backup is not proven until recovery succeeds.

At staging, perform at least one full drill:

1. create known test account/wallet state;
2. force a backup;
3. retrieve the snapshot from R2;
4. stop the staging application;
5. restore only through `deploy/restore.sh`;
6. start the application;
7. verify the known account and wallet state;
8. verify the pre-restore local snapshot was retained.

Never test destructive restore against live production user data merely to prove the procedure.

## 8. External completion evidence

Update `docs/V4-OPEN-BLOCKERS.md` when complete:

- EXT-07: R2 bucket/token created;
- EXT-08: first backup, check, retrieve, and verification passed;
- EXT-09: Restic password stored outside both Oracle and Cloudflare.

Record only non-secret evidence.
