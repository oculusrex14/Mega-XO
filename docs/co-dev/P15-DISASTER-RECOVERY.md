# P15 independent recovery engineering — NOT G15

This is an additive co-development branch: no live V4 backup configuration,
production restic repository, Neon/Vercel/R2 provider, DNS, new PostgreSQL
roles or current V5 migration schema was touched.

**Upstream:** P15 requires accepted P14, and the source program requires
independent encrypted data-plane backup, Neon PITR and a separate PostgreSQL
restore. These are distinct recovery mechanisms; a new SQL archive alone
does not satisfy G15.

## V5-15-01 — policy and targets

- scripts/v5/p15/recovery-policy.js retains source-spec *candidate* backup
  age <=15min and measured restore <=60min. These are NOT accepted targets.
- A production Neon history window and actual plan, R2 capacity/pricing,
  deletion/privacy retention, off-host key custody, alerts and RPO/RTO
  remain pending owner/provider proof.
- Existing staging metadata reports a six-hour declared history window;
  that is not independently observed PITR and does not certify production.
- V4 encrypted Restic repository and its original recovery password stay
  untouched. V5 uses a distinct namespace and key material.
- No automatic deletion, blanket retention enforcement, production
  schedule activation or broad live restore permissions.

## V5-15-02/03 — implementation boundary

- sealed-archive.js is a stream-only AES-256-GCM/RSA-OAEP-SHA256 envelope:
  pg_dump bytes feed directly to encryption; no raw dump file exists.
  The recipient public key is RSA-3072+, while the private identity stays
  with the off-host recovery custodian.
- The envelope authenticates metadata, ciphertext and recipient binding.
  Corrupted/tag-mismatched archives are refused before restore work.
- direct-target.js permits only owned disposable PostgreSQL16 source
  and a **separate** quarantined restore instance in normal CI. A
  declared nonserving staging source requires explicit owner approval,
  exact checked-in environment IDs and private PG passfile.
- Existing approved game/economy/Crown behavior is not modified.
- Tests with simulated private data must never publish source rows or
  private recovery identities in GitHub artifacts.

## Integration owner handoff remains open

1. Resolve P14 and approve real recovery/retention/backup-size/cost targets.
2. Record and verify current production Neon PITR plan and actually restore
   an isolated recovery point, not just inspect a provider setting.
3. Provision a genuinely distinct V5 R2 prefix, scoped upload/read roles
   and off-host-held private key, then verify retrieval and decryption.
4. Execute separate PG restoration, privacy/deletion revocation and per-actor
   wallet/escrow/purchase/audit invariants on real restricted evidence.
5. Schedule operator-approved backup and recurring quarantined restore
   with real freshness/incident notification and cleanup evidence.
6. Mark G15 only after actual provider/source/target proof; co-dev retains
   docs/v5/progress.json untouched.


## V5-15-03 executed disposable two-cluster restore test

- The dedicated P15 CI job runs two independent PostgreSQL16 service
  containers. A real migration-built source DB holds three synthetic actors,
  actual Core conversion and accepted match, a synthetic tournament escrow,
  a store receipt/revocation, completed privacy deletion and an audit entry.
- The real pg_dump custom archive streams directly through authenticated
  encryption into a private ciphertext file; it emits no plaintext dump.
  The ephemeral RSA private recovery key never enters committed files or
  uploaded CI artifacts.
- restore-cli.js verifies source hashes and the entire AES-GCM tag before
  attempting a second PostgreSQL instance, then decrypts straight into one
  pg_restore transaction in a newly created, previously empty database.
  It never uses clean, create, destructive migrations or auth bypass flags.
- data-integrity.js hashes every application table in a repeatable-read
  cursor, compares actual source/restored per-row content and counts,
  checks migration digests, wallet bounds and immutable audit triggers.
  The test drops only its exact temporary target database after measuring.
- This is actual two-PostgreSQL-cluster *synthetic* encrypted restoration,
  not an observed R2 retrieval, Neon PITR, role/key reconstruction or
  production RPO/RTO. G15 remains OPEN.

## V5-15-02 operator-only R2 transfer (not executed on provider)

- r2-contract.js requires a V5-only R2 bucket and immutable namespace
  megaxo/v5/pg16-encrypted/v1/. Existing V4 Restic is not modified.
- r2-transfer.js accepts real encrypted nonserving staging backups,
  uses a write-once If-None-Match precondition and a different reader
  identity to retrieve encrypted ciphertext and manifest for SHA checks.
  Partial failures do not automatically delete uploaded recovery objects.
- Ciphertext readback hashes are streamed instead of buffering an entire
  multi-gigabyte archive in memory. Private scratch files are removed.
- The fake AWS CLI unit runner is always labeled MOCK_NOT_PROVIDER_PROOF;
  actual R2 IAM, account, retention, backup retrieval and restore have
  not been externally verified. No live secrets are present in PR CI.

## V5-15-04 repeated complete disposable restore drill and freshness controls

CI now runs two separately created, sealed and decrypted real PG16 archive
roundtrips against an isolated second PostgreSQL16 instance, in sequence.
Each invocation creates distinct random archive identities and keys,
verifies all durable application tables, migrations, wallets, privacy
tombstones, refunds and audit triggers, and drops only its owned target.
The ordered evidence is checked by drill-readiness.js; any missing
second receipt, repeated ciphertext, incomplete cleanup, skipped test or
unverified restored digest fails closed. Both executions happen in ONE
CI run: they are not evidence of actual weekly scheduled provider drills.

The same module evaluates freshness against the V5 specification's
15-minute proposed age and 60-minute proposed restore objectives without
approving either production threshold. A missing/stale independent backup
requires an alert. Its report NEVER claims that alert delivery occurred.
Production scheduling, real incident alert delivery, R2 readback restore,
Neon PITR, external key custody and approved owner retention remain open.

## P15 operator backup-age watch (read-only, no alerts sent)

backup-watch.js can read a real first-party encrypted R2 upload/readback
receipt from an operator-held 0600 file under a 0700 directory. With
an explicit owner scope confirmation, it reports a measured local age
against the spec's PROPOSED fifteen-minute target; it exits nonzero for
stale, future-dated, missing, mock, unowned or unauthenticated receipts.
Output has no actor IDs, encrypted private key, personal data or AWS
credential. `realAlertDeliveryObserved` and `g15Accepted` always remain
false. Its green candidate age is not provider IAM, PITR, independent
restore or a verified production monitoring/notification system.

Example once an owner has actually provisioned R2 + the backup pipeline:

    P15_OWNER_CONFIRMS_R2_RECEIPT_SCOPE=1 node scripts/v5/p15/backup-watch.js --receipt /owner/private/v5-last.r2-receipt.json --sha SOURCE_COMMIT --now YYYY-MM-DDTHH:MM:SSZ

The actual recurring systemd/cron job, off-host alert delivery, retention
and operational runbooks must be activated only by the authorized operator
after P14, actual R2/Neon proof, private key custody and policy approval.
No timer, webhook or production alert destination is installed in this PR.
