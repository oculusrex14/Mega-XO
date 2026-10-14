# V5 supervised production backup service (2026-10-14)

Automatic, supervised **V5 production PostgreSQL backup** running on `openclaw-host`
(10.0.0.92, us-east-1) under systemd: streaming `pg_dump` as `backup_reader` against
production Neon `blue-sun-85454968`/`mega_xo_v5_production`, sealed into the repo's own
AES-256-GCM envelope, uploaded to the V5-only R2 bucket with an independent
reader-credential readback, plus a freshness checker that alerts through the same Resend
path the V4 monitor uses.

Everything below is real command output from this host. Nothing is committed to Git.

---

## 1. Files

### Host: `/opt/mega-xo-v5-production`

| Path | Mode | sha256 |
| --- | --- | --- |
| `bin/v5-pg-backup.sh` | 700 | `255a36089c80395f36a8b143a15c97b49903fc0add2f2635c6ba6f2adeb5484c` |
| `bin/v5-r2-upload.js` | 700 | `638e6b1cacab1878404c8d43726195edaa4435c55c8bf0ce483eaadceb2f3110` |
| `bin/v5-freshness.js` | 700 | `65a23d18d4016e6761f7705ae5e5fb9933f0eecca9e3929dcc75b2c17a700c06` |
| `bin/v5-r2-client.js` | 700 | `e4f5a47592766da00833d5227a7e7aae0ef152efb1f0e0c1850d13152920f138` |
| `bin/v5-lib.js` | 700 | `f628fe647542bd5a775ec910c115f41e5836fb3546b5ec2826d70b7607e48519` |
| `bin/pg_dump` | 700 | `09c385fb542fed1b8b9a168b6634ecdd4c40912061626ff23fccb842a7913773` |
| `bin/node-24/` | 755 | Node v24.21.0, copied from `/tmp/node` (already on the host), root-owned |
| `lib/scripts/v5/p15/*.js` | 700 | deployed copies of `backup-cli.js`, `sealed-archive.js`, `archive-manifest.js`, `direct-target.js`, `r2-contract.js` |
| `lib/docs/v5/environments/{production,staging}.json` | 644 | contract inputs for the target checker |
| `lib/packages/migrations/manifest.json` | 644 | `640ed89a9a04e760d46981d1e54d888f15d407351d1b114c3084e4c1636a35d5` (the `schemaManifestSha256` every archive is bound to) |
| `state/` | 700 | secrets + state (below) |
| `archives/` | 700 | local archive pair + receipt per cycle |

Deployed library blobs (verifiable against the repo):

```
f334e37c339eff343bfe42e9679339770a4f89ceb6ac3ee054f89de0b3fb84c1  lib/scripts/v5/p15/sealed-archive.js
455f4d93f13df752ac8e3ab4d8f67c70a719c34c077e74dbeeafbd3127dcf12b  lib/scripts/v5/p15/archive-manifest.js
a124c021083408e64e938187130f5b069702b598d7f34989f5957829a2071353  lib/scripts/v5/p15/backup-cli.js
a4709569abc4afa7527d941e7f3103c53f47e2dd742af1c3e7173e4e90d96821  lib/scripts/v5/p15/direct-target.js
3bec8405b6d11be1aedf13d91fc6167a045a835b0ebadc736440dc44ad1c5bee  lib/scripts/v5/p15/r2-contract.js
```

The sealer is the **unmodified repo module**, deployed as a copy into the protected tree
(it is the same file at git blob `105f3651…` in the pinned revision and at HEAD). The
host therefore runs the repo's real envelope format, not a reimplementation: header
layout, AAD, `RSA-OAEP-SHA256` key wrap, `AES-256-GCM` stream and manifest schema are all
decided by the checked-in code.

Two P15 modules are deployed from **HEAD, not from the pinned `424923af…` revision**,
because the pinned revision cannot back up production any more:

- `backup-cli.js` HEAD adds `--exclude-schema=learning`, which production requires
  (migrations 0044/0051 make `learning` reachable-but-unreadable to `backup_reader`); the
  pinned blob would abort the dump.
- `archive-manifest.js`/`direct-target.js` HEAD are the versions that the repo's tests and
  the P15 production contract already exercise (`SOURCE_KIND_ENVIRONMENT`, `PGSSLROOTCERT`).

The archive's `sourceSha` is therefore the pinned commit `424923af1d6…` while the deployed
tooling is the newer reviewed HEAD — see §9 limitations.

### Repo (working tree, uncommitted)

`deploy/v5/`: `v5-pg-backup.sh`, `v5-r2-upload.js`, `v5-freshness.js`, `v5-r2-client.js`,
`v5-lib.js`, `pg_dump`, `systemd/mega-xo-v5-{backup,freshness}.{service,timer}` — byte-identical
to the host copies (hashes above).

---

## 2. Secrets (all absolute, mode 0600, under `/opt/mega-xo-v5-production/state`, never in Git)

| File | What it is |
| --- | --- |
| `pgpass` | `ep-mute-surf-…:5432:mega_xo_v5_production:backup_reader:<secret>` |
| `neon-ca.pem` | Neon provider CA (121 certificates), for `sslmode=verify-full` |
| `recovery-public.pem` | **NEW** RSA-3072 host recipient public key |
| `r2-credentials.json` | V5 R2 writer + independent reader tokens (bucket-scoped) |
| `prod-source.json` | the production direct-PG target (`nonserving-production-source`) |
| `r2-target.json` | the V5-only bucket/prefix contract target |
| `pg-image-ref` | `postgres:16-alpine@sha256:721873c34ceb…` (pinned, root-only-read intent) |
| `backup-policy.json` | approved `rpoSeconds: 900`, with rationale and approval stamp |

The R2 secret derivation was re-verified on this machine against the live bucket before
use: **S3 access key id = token `id`, S3 secret = `sha256(token value)`** — the writer
token `53582a59…`/`cb281038…` and reader `d2641a06…`/`d4243ef2…` pairs both listed the V5
prefix with HTTP 200.

### Key custody

A **new** RSA-3072 keypair was generated for this host:

```
Private-Key: (3072 bit, 2 primes)
public SPKI sha256 = 1792f712f94db18d88760a20f69a3d6d8095a6d05d5875580043734af3451b26
```

That SPKI hash is exactly the `recipientSpkiSha256` in every archive produced by this
service, i.e. the host encrypts to this key and nothing else.

- The **public** half is the only key material on the host
  (`state/recovery-public.pem`, mode 0600).
- The **private** half is **kept OFF-HOST by the owner**:
  `~/MegaXO-private/v5-recovery-key-host-20261014/recovery-private-20261014.pem` (macOS,
  mode 0600, outside Git and outside every deployment tree).
- Proof it is not on the host: a host-wide `find / -xdev` for recovery private keys returned
  only `state/recovery-public.pem`.

**Owner decision required:** where the private half is durably held (offline medium, sealed
escrow, second custody holder) and who can reach it. Losing it makes every host-produced
archive permanently unrecoverable — that is the design, not a defect.

---

## 3. systemd units

Installed verbatim as `/etc/systemd/system/mega-xo-v5-{backup,freshness}.{service,timer}`:

```
fcd4f113923341c27c4e5a2284fef94ad0808452fdb93767b4d15a819b6d9258  mega-xo-v5-backup.service
bd654478fc4d11215acd0fb824feac805636b4025fc46062ef3134ae1ebe8f1c  mega-xo-v5-backup.timer
5057660e529413389a74522921620ecb16ea2a27cb7afba7581911bf90daac82  mega-xo-v5-freshness.service
61b4a11949b6e7fca026dcd9ea77d641050cf4b4e0bb529abeb1d12c832fd534  mega-xo-v5-freshness.timer
```

Both services are `Type=oneshot`, `User=root` (root is required for the Resend key path the
V4 monitor already uses and for the docker socket), hardened with `ProtectSystem=strict`,
`PrivateTmp`, `NoNewPrivileges`, `ProtectHome`, `RestrictAddressFamilies` and explicit
`ReadWritePaths` limited to `archives/` and `state/`.

Verbatim unit files as installed under `/etc/systemd/system/` (identical to
`deploy/v5/systemd/` in the repo):

```ini
# ---- mega-xo-v5-backup.service
[Unit]
Description=Mega XO V5 production PostgreSQL backup (pg_dump -> sealed archive -> V5 R2)
Documentation=file:/opt/mega-xo-v5-production/bin/v5-pg-backup.sh
After=docker.service network-online.target
Wants=docker.service network-online.target

[Service]
Type=oneshot
ExecStart=/opt/mega-xo-v5-production/bin/v5-pg-backup.sh
User=root
Group=root
# Serialization is inside the script (flock on state/backup.lock): a manually
# started run and a timer run cannot overlap. Never leave a partial archive.
TimeoutStartSec=1800
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectKernelTunables=true
ProtectControlGroups=true
ProtectClock=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictRealtime=true
LockPersonality=true
SystemCallArchitectures=native
ReadWritePaths=/opt/mega-xo-v5-production/archives /opt/mega-xo-v5-production/state
```

```ini
# ---- mega-xo-v5-backup.timer
[Unit]
Description=Run the Mega XO V5 production PostgreSQL backup on the 5-minute RPO cadence

[Timer]
# Five minutes against a fifteen-minute approved RPO: the measured full cycle is
# ~36 s sealing + ~2 s upload/readback, so the duty cycle is under 15 %, two
# consecutive failures still stay inside the RPO, and the freshness checker trips
# on the third. AccuracySec keeps journal/object timestamps tight; the 20 s
# randomised delay de-synchronises this timer from the freshness timer.
OnBootSec=3min
OnUnitActiveSec=5min
AccuracySec=15s
RandomizedDelaySec=20s
Persistent=true
Unit=mega-xo-v5-backup.service

[Install]
WantedBy=timers.target
```

```ini
# ---- mega-xo-v5-freshness.service
[Unit]
Description=Mega XO V5 backup freshness check (newest V5 R2 manifest vs approved RPO)
Documentation=file:/opt/mega-xo-v5-production/bin/v5-freshness.js
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/mega-xo-v5-production/bin/node-24/bin/node /opt/mega-xo-v5-production/bin/v5-freshness.js
User=root
Group=root
TimeoutStartSec=300
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectKernelTunables=true
ProtectControlGroups=true
ProtectClock=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictRealtime=true
LockPersonality=true
SystemCallArchitectures=native
ReadWritePaths=/opt/mega-xo-v5-production/state
```

```ini
# ---- mega-xo-v5-freshness.timer
[Unit]
Description=Check that the newest uploaded Mega XO V5 backup is inside the approved RPO

[Timer]
# Same cadence as the backup timer but offset by one minute, so a breach is
# detected within one backup interval of appearing and the alert is never
# evaluated against a half-written upload.
OnBootSec=4min
OnUnitActiveSec=5min
AccuracySec=15s
RandomizedDelaySec=20s
Persistent=true
Unit=mega-xo-v5-freshness.service

[Install]
WantedBy=timers.target
```

```
$ systemctl is-enabled mega-xo-v5-backup.timer mega-xo-v5-freshness.timer
enabled
enabled
$ systemctl is-active mega-xo-v5-backup.timer mega-xo-v5-freshness.timer
active
active
```

### Schedule rationale (5 minutes against a 15-minute RPO)

The measured cycle on this host is **2–4 s wall time** (§5). A 5-minute cadence is therefore:

- **~1 % duty cycle** — no overlap risk, negligible load on the 0.25 CU production compute;
- **3× headroom against the 15-minute RPO**: with a 5-minute cadence it takes **three**
  consecutive missed cycles (≈15 min) to push the newest upload past 900 s, so a transient
  Neon or R2 outage of one or two cycles does not by itself breach the objective;
- the freshness timer runs on the **same 5-minute period offset by one minute**, so a breach
  is detected within one interval and never evaluated against a half-written upload;
- `RandomizedDelaySec=20s` de-synchronises the two timers; `AccuracySec=15s` bounds drift;
  `Persistent=true` catches up after a reboot.

The RPO itself (900 s) lives in `state/backup-policy.json` as an owner-approved value, so
changing it is a deliberate, reviewable act rather than an edit to the unit.

### Overlap safety

`v5-pg-backup.sh` takes `flock -n` on `state/backup.lock` before doing anything else. Proved
live by holding the lock and starting the unit:

```
V5_BACKUP_FAILED: another backup run holds the lock (overlap refused)
mega-xo-v5-backup.service: Main process exited, code=exited, status=2/INVALIDARGUMENT
```

---

## 4. What one cycle does, and how it fails closed

1. `flock -n` → refuse if another run holds the lock.
2. Verify the run is root, every protected file exists as a regular 0600 file, `state/` and
   `archives/` are 0700, the tree-local Node exists, the library is present and the image
   reference is a pinned `postgres:16-alpine@sha256:…`.
3. Set `PATH` so `pg_dump` resolves to `bin/pg_dump`, which runs the **pinned image** on the
   host network, forwarding only the libpq connection environment and bind-mounting
   `pgpass` + the provider CA read-only at identical absolute paths. stdout is byte-exact and
   the container exit status is propagated, so a failed dump cannot be sealed as a success.
4. Run the repo's `backup-cli.js`, which spawns that `pg_dump`
   (`--format=custom --no-owner --no-acl --compress=6 --lock-wait-timeout=10s
   --exclude-schema=learning`) and streams stdout straight into the AES-256-GCM sealer. **No
   plaintext dump file is ever created** (`plaintextTemporaryFileCreated: false`).
5. Validate the pair through the checked-in contract, then `PUT` ciphertext and manifest with
   `If-None-Match: *` (write-once), and **independently re-fetch both objects with the reader
   credential**, re-hashing them against the local bytes.
6. Prune local archives beyond the newest 12 (remote retention untouched — deleting DR
   objects is an owner decision this service does not take).

   The predicate was exercised in a scratch tree with `LOCAL_KEEP=3` over five synthetic
   archive triples: the two oldest triples (`.manifest.json` + `.mxb` + `.r2-receipt.json`)
   were selected for removal and the newest three kept, each of the three files moving
   together so a receipt is never orphaned from the archive it describes.

Failure behaviour: any step that fails aborts the whole run, removes its own partial archive,
and leaves **no** published state. A failed upload never rolls back a possibly-written remote
object — an orphaned encrypted object is recoverable, and deleting the only copy is not.

Proved live with a deliberately wrong password file (mode 0600, valid target, so only the
dump itself fails):

```
$ … pg_dump --format=custom --no-owner --no-acl   # wrong password
pg_dump: error: connection to server at "ep-mute-surf-…neon.tech" (3.228.184.198), port 5432
  failed: ERROR:  password authentication failed for user 'backup_reader'
password retrieved from file "/tmp/v5-fc/pgpass-bad"
wrapper rc=1

$ … backup-cli.js --source <production target> --recipient <host public key> \
    --out <private empty dir> --confirm-nonserving-production-backup
CAUSE P15_SEAL_REFUSED: sealed archive missing, accessible or empty
P15_BACKUP_REFUSED: backup aborted; no completed archive is published
SEALER rc=2

$ ls -la <private dir>          # nothing published, nothing partial
total 8
drwx------ 2 root root 4096 .
drwx------ 3 root root 4096 ..
```

---

## 5. Real runs and measured timings

### 5.1 Supervised run, started by hand exactly as the unit runs it

```
2026-10-14T02:18:15Z backup start sourceSha=424923af1d60060e456eb2fb777c44a1ada92913 image=postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
2026-10-14T02:18:17Z sealed backupId=v5-p15-2026-10-14T02-18-15-854Z-e99afe3f8368223e bytes=224351 seal_ms=1286
2026-10-14T02:18:18Z r2 upload+readback verified receipt=/opt/mega-xo-v5-production/archives/v5-p15-2026-10-14T02-18-15-854Z-e99afe3f8368223e.r2-receipt.json ms=1132
2026-10-14T02:18:18Z backup complete backupId=v5-p15-2026-10-14T02-18-15-854Z-e99afe3f8368223e elapsed_s=3
```

### 5.2 Manifest produced on the host

```json
{
  "format": "mega-v5-p15-backup-manifest/v1",
  "backupId": "v5-p15-2026-10-14T02-18-15-854Z-e99afe3f8368223e",
  "createdAtUtc": "2026-10-14T02:18:15.854Z",
  "sourceId": "neon-v5-production",
  "sourceKind": "nonserving-production-source",
  "sourceEnvironment": "production",
  "sourceFingerprint": "134e5210beaabb9a50b3217c2793ee5c76672930cfa24d994d25698f9aaca7c4",
  "sourceSha": "424923af1d60060e456eb2fb777c44a1ada92913",
  "migrationManifestSha256": "640ed89a9a04e760d46981d1e54d888f15d407351d1b114c3084e4c1636a35d5",
  "pgMajor": 16,
  "ciphertextFile": "v5-p15-2026-10-14T02-18-15-854Z-e99afe3f8368223e.mxb",
  "ciphertextBytes": 224351,
  "ciphertextSha256": "4a90cc47c3f4cc5e4d3414b8416b6304fdd58bd1fbb1dbb0e26a63d115652c5f",
  "cryptoFormat": "mega-v5-p15-sealed-archive/v1",
  "recipientSpkiSha256": "1792f712f94db18d88760a20f69a3d6d8095a6d05d5875580043734af3451b26",
  "plaintextTemporaryFileCreated": false,
  "includesClusterGlobalRolesOrSecrets": false,
  "remoteStorageVerified": false,
  "independentRestoreVerified": false,
  "backupRunClass": "REAL_DIRECT_PG16_DUMP",
  "g15Accepted": false
}
```

### 5.3 Independent retrieval — upload receipt

Uploaded with the **writer** credential, re-fetched with the **reader** credential:

```json
{
  "format": "mega-v5-p15-r2-upload-readback/v1",
  "backupId": "v5-p15-2026-10-14T02-18-15-854Z-e99afe3f8368223e",
  "sourceSha": "424923af1d60060e456eb2fb777c44a1ada92913",
  "backupCreatedAtUtc": "2026-10-14T02:18:15.854Z",
  "readbackCheckedAtUtc": "2026-10-14T02:18:18.261Z",
  "r2Bucket": "mega-xo-v5-dr-archives",
  "r2AccountId": "2f05f9d1ae66c7ebbd02349ba5b5c0ec",
  "objectKey": "megaxo/v5/pg16-encrypted/v1/v5-p15-2026-10-14T02-18-15-854Z-e99afe3f8368223e.mxb",
  "manifestObjectKey": "megaxo/v5/pg16-encrypted/v1/v5-p15-2026-10-14T02-18-15-854Z-e99afe3f8368223e.manifest.json",
  "ciphertextSha256": "4a90cc47c3f4cc5e4d3414b8416b6304fdd58bd1fbb1dbb0e26a63d115652c5f",
  "ciphertextBytes": 224351,
  "manifestSha256": "bdf354d882b2f1ecbe78b1662c3dddd5ba0390249454e0ff040a422522a33b56",
  "retrievedCiphertextSha256": "4a90cc47c3f4cc5e4d3414b8416b6304fdd58bd1fbb1dbb0e26a63d115652c5f",
  "uploadUsedWriteOncePrecondition": true,
  "separateWriterReaderProfilesUsed": true,
  "ciphertextAndManifestReadbackMatching": true,
  "transport": "curl-aws-sigv4",
  "realProviderUploadAndIndependentReadbackObserved": true,
  "mockedCallsOnly": false,
  "decryptionAndRestoreFromR2Completed": false,
  "providerIamIndependentlyAudited": false,
  "productionRetentionApproved": false,
  "g15Accepted": false
}
```

`ciphertextSha256` equals `retrievedCiphertextSha256`: the bytes the V5 bucket returns to the
**reader** credential are the bytes the writer uploaded, and are the bytes sealed on the host.

Both security properties of the pair were then probed directly against the live bucket, from
this Mac, on an object that already exists:

```
reader  PUT If-None-Match:* on the EXISTING object -> HTTP 403
        <Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>
writer  PUT If-None-Match:* on the EXISTING object -> HTTP 412
        <Error><Code>PreconditionFailed</Code><Message>At least one of the pre-conditions you specified did not hold.</Message></Error>
```

So the reader credential genuinely **cannot write** (the "independent reader" is a real
separation, not a label), and the writer's write-once precondition genuinely **cannot
overwrite** an immutable archive. Neither probe changed any object: the reader was refused,
and the writer was refused by its own precondition.

### 5.4 A third, fully independent retrieve — from a different machine and credential path

Re-fetched from this Mac with curl/AWS SigV4 using the reader token, no host involvement. The
object fetched here was the 02:14:38 cycle, whose receipt recorded
`95f96261c6aef35e9748655d341bbac0f95ead65b39fdf40484823f73c5a4e7d`:

```
MAC-SIDE INDEPENDENT RETRIEVE: HTTP 200 bytes=224351
sha256: 95f96261c6aef35e9748655d341bbac0f95ead65b39fdf40484823f73c5a4e7d
matches receipt: True
```

Both objects of the 02:18 cycle were then re-fetched the same way, each checked against the
hash recorded in the host-side receipt:

```
.manifest.json   HTTP 200 bytes=1117    sha256=bdf354d882b2f1ec…  matches_receipt=True
.mxb             HTTP 200 bytes=224351  sha256=4a90cc47c3f4cc5e…  matches_receipt=True
```

### 5.5 Measured timings

| Measure | Value |
| --- | --- |
| Container `pg_dump` start (`docker run … pg_dump --version`) | 0.33 s |
| Dump + AES-256-GCM seal on the host (`seal_ms`) | **1100–2367 ms** (n=7: 1189, 1207, 1161, 1100, 1286, 1178, 2367) |
| R2 upload + independent readback (`ms`) | **1132 ms** (single instrumented sample, 02:18 cycle) |
| **Full cycle, `systemctl start` to complete** | **2–4 s** (`elapsed_s` = 2, 2, 3, 3, 3, 4 over six successful cycles) |
| Archive size | 224 351 B ciphertext (223 320–223 309 B plaintext equivalent) |
| Duty cycle at 5-minute cadence | < 1.5 % |

The 2367 ms seal outlier is the 02:41 cycle, which ran while a freshness check was also
running; it is still two orders of magnitude inside the 5-minute period. The full sample of
real cycles is:

```
2026-10-14T02:12:49Z backup complete v5-p15-2026-10-14T02-12-47-242Z-ae11d682316360aa elapsed_s=2
2026-10-14T02:13:35Z backup complete v5-p15-2026-10-14T02-13-33-264Z-b17b9c11e4e53aee elapsed_s=2
2026-10-14T02:14:41Z backup complete v5-p15-2026-10-14T02-14-38-789Z-fcb38f9bb287c357 elapsed_s=3
2026-10-14T02:18:18Z backup complete v5-p15-2026-10-14T02-18-15-854Z-e99afe3f8368223e elapsed_s=3
2026-10-14T02:20:57Z backup complete v5-p15-2026-10-14T02-20-55-028Z-a93f8b30b26cae5a elapsed_s=3
2026-10-14T02:41:06Z backup complete v5-p15-2026-10-14T02-41-02-670Z-cc90d824cbb4b3f0 elapsed_s=4
```

Every local archive pair was audited against the bucket from the host to confirm nothing was
published by accident:

```
NOT-UPLOAD no-receipt v5-p15-2026-10-14T02-12-23-847Z-5c5100a10daf710a.manifest.json
uploaded   no-receipt v5-p15-2026-10-14T02-12-47-242Z-ae11d682316360aa.manifest.json
uploaded   receipt    v5-p15-2026-10-14T02-13-33-264Z-b17b9c11e4e53aee.manifest.json
uploaded   receipt    v5-p15-2026-10-14T02-14-38-789Z-fcb38f9bb287c357.manifest.json
uploaded   receipt    v5-p15-2026-10-14T02-18-15-854Z-e99afe3f8368223e.manifest.json
uploaded   receipt    v5-p15-2026-10-14T02-20-55-028Z-a93f8b30b26cae5a.manifest.json
uploaded   receipt    v5-p15-2026-10-14T02-41-02-670Z-cc90d824cbb4b3f0.manifest.json
```

The `NOT-UPLOAD` row is the run whose receipt path was rejected **before** any network call:
pair validation happens ahead of every PUT, so a refused cycle cannot leave a remote object
behind. The `uploaded no-receipt` row is the 02:12:47 upload whose readback had matched but
whose receipt writer was still missing at the time.

Sanity check of the plaintext this path produces (dump taken through the exact wrapper argv,
then listed with `pg_restore` inside the same pinned image):

```
416        # pg_restore --list lines
78         # TABLE DATA entries
```

The **36.1 s** figure recorded in `P15-V5-BACKUP-RETRIEVE-MEASURED-20261014.md` was measured
from the Mac over the WAN. Running from the host, which sits in us-east-1 next to the Neon
endpoint, the same work takes ~1.2 s of dump+seal. The 5-minute cadence is chosen against the
host figure but is conservative under either number.

### 5.6 Timer-triggered cycles

Nothing below was started by hand: the timers did it.

```
2026-10-14T02:14:38Z backup start sourceSha=424923af1d60060e456eb2fb777c44a1ada92913 …
2026-10-14T02:14:39Z sealed backupId=v5-p15-2026-10-14T02-14-38-789Z-fcb38f9bb287c357 bytes=224351 seal_ms=1100
2026-10-14T02:14:41Z r2 upload+readback verified receipt=…02-14-38-789Z-fcb38f9bb287c357.r2-receipt.json
2026-10-14T02:14:41Z backup complete backupId=v5-p15-2026-10-14T02-14-38-789Z-fcb38f9bb287c357 elapsed_s=3
```

```
2026-10-14T02:46:22Z backup start sourceSha=424923af1d60060e456eb2fb777c44a1ada92913 image=postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
2026-10-14T02:46:23Z sealed backupId=v5-p15-2026-10-14T02-46-22-262Z-5a0661af6d5030d0 bytes=224574 seal_ms=1108
2026-10-14T02:46:24Z r2 upload+readback verified receipt=/opt/mega-xo-v5-production/archives/v5-p15-2026-10-14T02-46-22-262Z-5a0661af6d5030d0.r2-receipt.json ms=1104
2026-10-14T02:46:24Z backup complete backupId=v5-p15-2026-10-14T02-46-22-262Z-5a0661af6d5030d0 elapsed_s=2
mega-xo-v5-backup.service: Deactivated successfully.
```

```
$ systemctl list-timers mega-xo-v5-backup.timer mega-xo-v5-freshness.timer --no-pager
NEXT                        LEFT     LAST                        PASSED  UNIT
Wed 2026-10-14 02:51:28 UTC  3min 54s Wed 2026-10-14 02:46:22 UTC  1min 11s ago  mega-xo-v5-backup.timer
Wed 2026-10-14 02:51:32 UTC  3min 58s Wed 2026-10-14 02:46:22 UTC  1min 11s ago  mega-xo-v5-freshness.timer
```

The 02:46 cycle is the important one: it ran **unattended, on the timer**, five minutes after
the previous one, and the freshness check fired alongside it and passed. Together with the
scheduled 02:40:23 breach detection in §6.2(c), this is the service operating exactly as
deployed — no operator in the loop.

The first successful cycle of the service was `v5-p15-2026-10-14T02-12-47-242Z-ae11d682316360aa`
(`elapsed_s=2`); its readback had already been verified, but its receipt file was not written
until the runner was corrected, which is why the receipt quoted above comes from the 02:18
cycle. Every cycle since writes the receipt.

```
2026-10-14T02:14:38Z backup start sourceSha=424923af1d60060e456eb2fb777c44a1ada92913 …
2026-10-14T02:14:39Z sealed backupId=v5-p15-2026-10-14T02-14-38-789Z-fcb38f9bb287c357 bytes=224351 seal_ms=1100
2026-10-14T02:14:41Z r2 upload+readback verified receipt=…02-14-38-789Z-fcb38f9bb287c357.r2-receipt.json
2026-10-14T02:14:41Z backup complete backupId=v5-p15-2026-10-14T02-14-38-789Z-fcb38f9bb287c357 elapsed_s=3
```

```
$ systemctl list-timers mega-xo-v5-backup.timer mega-xo-v5-freshness.timer --no-pager
NEXT                        LEFT     LAST                        PASSED  UNIT
Wed 2026-10-14 02:19:39 UTC  4min 51s Wed 2026-10-14 02:14:38 UTC  9s ago  mega-xo-v5-backup.timer
Wed 2026-10-14 02:19:43 UTC  4min 55s Wed 2026-10-14 02:14:38 UTC  9s ago  mega-xo-v5-freshness.timer
```

---

## 6. Freshness checker: passes when fresh, alerts when stale

`bin/v5-freshness.js` lists the V5 prefix with the **reader** credential, validates the
newest manifest through the checked-in P15 contract, confirms the matching ciphertext object
still exists with the manifest's byte length and sha256 metadata, compares the provider
`LastModified` against the approved RPO, and on failure attempts the V4 Resend path
(`/opt/mega-xo/secrets/resend_api_key` → `contact@antimatterinnovations.com`). Exits 0 when
fresh, 2 when stale.

The alert transport itself was proved independently of a breach (so the delivery path is
known-good rather than inferred from a silent failure), using the same `curl --config` +
Resend call the checker makes, with the key read straight from the V4 secrets file:

```
$ sudo bash -c '… curl --config "$cfg" --data-binary "$payload" …'
{"id":"01a13836-ded8-7601-ab82-a99465aca790"}
HTTP 200
```

The scheduled checker's own alert attempts below all report `V5_BACKUP_ALERT_ATTEMPTED:
delivered`, i.e. the same endpoint accepted the real alert mail.

### 6.1 Fresh — passes

```
$ sudo /opt/mega-xo-v5-production/bin/node-24/bin/node /opt/mega-xo-v5-production/bin/v5-freshness.js
{"format":"mega-v5-backup-freshness/v1","evaluatedAtUtc":"2026-10-14T02:14:14.442Z","rpoSeconds":900,
 "rpoSource":"/opt/mega-xo-v5-production/state/backup-policy.json","manifestObjectsUnderPrefix":3,
 "newestManifestKey":"megaxo/v5/pg16-encrypted/v1/v5-p15-2026-10-14T02-13-33-264Z-b17b9c11e4e53aee.manifest.json",
 "newestManifestLastModifiedUtc":"2026-10-14T02:13:34Z","newestManifestAgeSeconds":38,
 "newestIntegrity":{"backupId":"v5-p15-2026-10-14T02-13-33-264Z-b17b9c11e4e53aee",
  "sourceSha":"424923af1d60060e456eb2fb777c44a1ada92913",
  "ciphertextKey":"megaxo/v5/pg16-encrypted/v1/v5-p15-2026-10-14T02-13-33-264Z-b17b9c11e4e53aee.mxb",
  "ciphertextBytes":224351,"ciphertextSha256":"100809f3d02fe13bb1a3f7ab8e075601d73a2ee2b0a3d6cae963bcf1953eae02",
  "createdAtUtc":"2026-10-14T02:13:33.264Z","manifestValidatedByContract":true,"ciphertextHeadVerified":true},
 "state":"fresh","problems":[],"result":"FRESH"}
$ echo $?
0
```

As the unit itself runs it (`systemctl start mega-xo-v5-freshness.service`) the same cycle
ended with `Deactivated successfully.` — exit 0.

### 6.2 Stale — fails with exit 2 and attempts the alert

**(a) Audit instant** — evaluate the newest real upload as of a later instant, so the same
live object is genuinely older than the live RPO:

```
$ sudo …/node v5-freshness.js --at 2026-10-14T03:10:00Z
{ "format":"mega-v5-backup-freshness/v1",
  "evaluatedAtUtc":"2026-10-14T03:10:00.000Z","rpoSeconds":900,
  "rpoSource":"/opt/mega-xo-v5-production/state/backup-policy.json",
  "manifestObjectsUnderPrefix":8,
  "newestManifestKey":"megaxo/v5/pg16-encrypted/v1/v5-p15-2026-10-14T02-46-22-262Z-5a0661af6d5030d0.manifest.json",
  "newestManifestLastModifiedUtc":"2026-10-14T02:46:23Z","newestManifestAgeSeconds":1416,
  "newestIntegrity":{"backupId":"v5-p15-2026-10-14T02-46-22-262Z-5a0661af6d5030d0",
   "sourceSha":"424923af1d60060e456eb2fb777c44a1ada92913",
   "ciphertextKey":"…5a0661af6d5030d0.mxb","ciphertextBytes":224574,
   "ciphertextSha256":"1a9e7ad4d5d39f90956bd4bb76a08949d449fda7a204783b5f12a9949d670039",
   "createdAtUtc":"2026-10-14T02:46:22.262Z","manifestValidatedByContract":true,"ciphertextHeadVerified":true},
  "state":"stale","previousState":"fresh",
  "problems":["newest uploaded backup is 1416 s old, beyond the 900 s RPO (limit source: /opt/mega-xo-v5-production/state/backup-policy.json)"],
  "alert":{"attempted":true,"sent":true,"kind":"stale"},"statePersisted":false,"result":"STALE"}
V5_BACKUP_ALERT_ATTEMPTED: delivered
V5_BACKUP_STALE: newest uploaded backup is 1416 s old, beyond the 900 s RPO …
$ echo $?
2
```

**(b) Tightened limit, real now** — the newest real upload is under two minutes old, against a
deliberately impossible 5-second limit, with no invented timestamp anywhere:

```
$ sudo …/node v5-freshness.js --rpo-seconds 5
V5_BACKUP_STALE: newest uploaded backup is 92 s old, beyond the 5 s RPO (limit source: --rpo-seconds)
$ echo $?
2
```

Both audit modes are read-only with respect to **state**: a hypothetical instant or a tightened
limit can never move the live suppression clock (`statePersisted: false`), which is why the
live state file still read `"state": "fresh"` immediately after these two runs.

**(c) Live scheduled breach — the real thing, no simulation.**

The backup timer was stopped at 02:15 UTC so no new object could refresh the newest manifest,
while the freshness timer stayed enabled. The next scheduled runs at 02:19:36, 02:24:50,
02:30:02 and 02:35:16 correctly reported `FRESH` (the newest upload was then 02:20:55, still
inside 900 s). The 02:40:23 run then evaluated the same object past the RPO and fired:

```
$ date -u                                  # backup timer: stopped on purpose
Wed Oct 14 02:40:48 UTC 2026
$ systemctl is-active mega-xo-v5-backup.timer
inactive

$ journalctl -u mega-xo-v5-freshness.service --since 02:40:00
Starting mega-xo-v5-freshness.service - Mega XO V5 backup freshness check …
V5_BACKUP_ALERT_ATTEMPTED: delivered
{ … "rpoSeconds":900,"manifestObjectsUnderPrefix":6,
  "newestManifestKey":"megaxo/v5/pg16-encrypted/v1/v5-p15-2026-10-14T02-20-55-028Z-a93f8b30b26cae5a.manifest.json",
  "newestManifestLastModifiedUtc":"2026-10-14T02:20:57Z","newestManifestAgeSeconds":1166,
  "newestIntegrity":{"backupId":"v5-p15-2026-10-14T02-20-55-028Z-a93f8b30b26cae5a","sourceSha":"424923af1d6…",
   "ciphertextKey":"…a93f8b30b26cae5a.mxb","ciphertextBytes":224351,
   "ciphertextSha256":"16724794304a305a09430eb0a1ca53a458c9ad955e5ebc1900a8414691da6e4b",
   "createdAtUtc":"2026-10-14T02:20:55.028Z","manifestValidatedByContract":true,"ciphertextHeadVerified":true},
  "state":"stale","previousState":"fresh",
  "problems":["newest uploaded backup is 1166 s old, beyond the 900 s RPO (limit source: /opt/mega-xo-v5-production/state/backup-policy.json)"],
  "alert":{"attempted":true,"sent":true,"kind":"stale"},"result":"STALE"}
V5_BACKUP_STALE: newest uploaded backup is 1166 s old, beyond the 900 s RPO …
mega-xo-v5-freshness.service: Main process exited, code=exited, status=2/INVALIDARGUMENT
mega-xo-v5-freshness.service: Failed with result 'exit-code'.

$ cat /opt/mega-xo-v5-production/state/freshness-state.json
{ "state": "stale", "checkedAtUtc": "2026-10-14T02:40:23.078Z",
  "lastAlertAtUtc": "2026-10-14T02:40:23.078Z", "consecutiveUnhealthy": 1 }
```

The stale state was reached through the **scheduled timer**, on a real object, with the real
RPO, and the mail was reported delivered.

### 6.3 Recovery — the checker returns to `FRESH` and says so

The backup timer was re-enabled, one cycle ran (02:41:02, `elapsed_s=4`), and the next check
sent the recovery mail and cleared the state:

```
$ systemctl is-active mega-xo-v5-backup.timer
active
$ … backup complete backupId=v5-p15-2026-10-14T02-41-02-670Z-cc90d824cbb4b3f0 elapsed_s=4
$ … v5-freshness.js    # rc=0
V5_BACKUP_ALERT_ATTEMPTED: delivered
{ … "state":"fresh","alert":{"attempted":true,"sent":true,"kind":"recovered"},"result":"FRESH"}
$ cat /opt/mega-xo-v5-production/state/freshness-state.json
{ "state": "fresh", "checkedAtUtc": "2026-10-14T02:41:06.203Z",
  "lastAlertAtUtc": "2026-10-14T02:41:06.203Z", "consecutiveUnhealthy": 0 }
```

---

## 7. Verifying the deployed state

```
$ systemctl is-enabled mega-xo-v5-backup.timer mega-xo-v5-freshness.timer
enabled
enabled
$ systemctl is-active mega-xo-v5-backup.timer mega-xo-v5-freshness.timer
active
active
```

```
$ sha256sum /opt/mega-xo-v5-production/bin/*
09c385fb542fed1b8b9a168b6634ecdd4c40912061626ff23fccb842a7913773  /opt/mega-xo-v5-production/bin/pg_dump
65a23d18d4016e6761f7705ae5e5fb9933f0eecca9e3929dcc75b2c17a700c06  /opt/mega-xo-v5-production/bin/v5-freshness.js
f628fe647542bd5a775ec910c115f41e5836fb3546b5ec2826d70b7607e48519  /opt/mega-xo-v5-production/bin/v5-lib.js
255a36089c80395f36a8b143a15c97b49903fc0add2f2635c6ba6f2adeb5484c  /opt/mega-xo-v5-production/bin/v5-pg-backup.sh
e4f5a47592766da00833d5227a7e7aae0ef152efb1f0e0c1850d13152920f138  /opt/mega-xo-v5-production/bin/v5-r2-client.js
638e6b1cacab1878404c8d43726195edaa4435c55c8bf0ce483eaadceb2f3110  /opt/mega-xo-v5-production/bin/v5-r2-upload.js
```

```
$ sudo find / -xdev \( -name "recovery-private*" -o -name "*.pem" -path "*recovery*" \) -not -path "/opt/mega-xo-v5-production/lib/*"
/opt/mega-xo-v5-production/state/recovery-public.pem
(search complete)
$ sudo openssl pkey -pubin -in /opt/mega-xo-v5-production/state/recovery-public.pem -pubout -outform DER | sha256sum
1792f712f94db18d88760a20f69a3d6d8095a6d05d5875580043734af3451b26  -
Public-Key: (3072 bit)
```

V4 was inspected read-only only: `/opt/mega-xo/secrets/resend_api_key` (mode 0600, `opc:opc`,
37 B) is the alert credential reused by §6; no V4 file, unit, container or repository was
modified.

---

## 8. Restoring one of these archives (unchanged from P15)

The archives are the same sealed format the P15 drill already proved end to end:

1. Fetch `…mxb` + `…manifest.json` with the reader credential.
2. `archive-manifest.js:inspectPair` → manifest ↔ ciphertext binding.
3. `sealed-archive.js:authenticateArchive` with the **off-host private key** → full AES-GCM
   pass before any restore work.
4. `decryptToWritable` piped into `pg_restore` into a quarantined, non-serving PG16 database.

The private key is required for every decrypt; the host never has it.

---

## 9. Honest limitations

1. **The deployed tooling is HEAD, not the pinned `424923af…` revision.** The manifests'
   `sourceSha` is the pinned commit, but the `backup-cli.js`/`archive-manifest.js`/
   `direct-target.js` running on the host are newer files from the same working tree (HEAD),
   because the pinned `backup-cli.js` cannot back up production any more (it lacks
   `--exclude-schema=learning`, which migrations 0044/0051 make mandatory). **Owner decision:
   pin a reviewed commit that contains these fixes and re-deploy so tooling and `sourceSha`
   agree exactly.**
2. **Node is a copied runtime, not a package.** `bin/node-24/` is a straight copy of the
   host's existing `/tmp/node` (v24.21.0) into the protected tree so the units do not depend on
   `/tmp` surviving a reboot/`tmpfiles` sweep. It is not signature-verified against the
   official Node release, and there is no automatic update path for it.
3. **No AWS CLI.** The reviewed P15 `r2-transfer.js` refuses to run without aws-cli v2, which
   this host does not have; the V5 runner therefore uses `curl --aws-sigv4`. The contract
   layer (bucket/prefix/object naming, manifest binding, write-once PUT) is shared with P15,
   but the transport is a **different implementation than the one the P15 tests exercise**.
4. **`remoteStorageVerified`/`independentRestoreVerified` stay `false` in the manifest.** Those
   fields are written by the sealer before upload and are not rewritten afterwards; the upload
   and readback evidence lives in the adjacent `.r2-receipt.json`, by design (the manifest is
   immutable and its bytes are the checksum the bucket stores).
5. **Not yet verified from this service: a decrypt + restore of a *host-produced* archive.**
   The P15 drill proved the format end to end with the older key; this service's archives are
   encrypted to the **new** key, and restoring one requires the off-host private half. The
   first recovery drill against a host-produced archive is still owed.
6. **Alerting is a single channel.** The Resend sender address is
   `contact@antimatterinnovations.com` and the recipient is the same address — one mailbox,
   no paging, no escalation. A mail failure is logged as `V5_BACKUP_ALERT_ATTEMPTED: FAILED …`
   and retried (transition, then hourly), but nothing else notifies.
7. **Alert suppression is by transition plus an hourly repeat.** If a stale state persists
   across the repeat window, at most one mail per hour is sent; a silent hour-long gap in
   freshness is therefore not separately signalled.
8. **Local retention is 12 archives (~2.7 MB) and remote retention is unbounded.** The bucket
   grows at roughly 65 MB/day; **owner decision: an approved remote retention/expiry policy.**
   This service deliberately never deletes a remote object. One local pair on the host
   (`v5-p15-2026-10-14T02-12-23-847Z-5c5100a10daf710a`) is an orphan from the first, refused
   cycle: it holds a valid sealed archive that was never uploaded and has no receipt. It will
   age out through the local retention rule; no remote copy exists to remove.
9. **The timer cadence is not load-tested against a large production dataset.** Today's
   database is small (416 TOC entries, 78 `TABLE DATA` sections, 224 KB ciphertext). If the
   dataset grows, re-measure and re-justify the 5-minute cadence; the RPO value in
   `state/backup-policy.json` is the single place that would need the owner's decision.
10. **`flock` and `Freshness` state live on the same host** as the backups. A host loss loses
    the local archives and the state file (the alert then fires because the *remote* newest
    manifest goes stale, which is the intended behaviour, but recovery is from the bucket only).
11. **`/opt/mega-xo-v5-production` is owned by `ubuntu`** (mode 700), while the units run as
    root. The service therefore depends on root-only-readable secrets inside a tree whose
    owner can replace the scripts. Tightening ownership is an owner decision because the
    deployment path currently relies on `ubuntu` write access.
