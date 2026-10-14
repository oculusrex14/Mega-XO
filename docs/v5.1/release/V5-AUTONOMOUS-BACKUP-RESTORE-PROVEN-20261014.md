# Automatic backup service: autonomous archive decrypts and restores (2026-10-14)

Closes the last open item from the backup-service report ("a decrypt+restore of a host-produced
archive with the new key is still owed").

## The archive

| Field | Value |
| --- | --- |
| Object | `megaxo/v5/pg16-encrypted/v1/v5-p15-2026-10-14T04-08-36-947Z-efa2e139960ca9c5.mxb` |
| Produced by | the host's `mega-xo-v5-backup.timer` — **no operator involved** |
| Retrieved with | the **independent reader** credential (separate from the writer) |
| Ciphertext | 224 574 B, GET 200 |
| Authenticated | `AUTH_OK`, `sourceSha=07c9fbab…`, `createdAtUtc=2026-10-14T04:08:36.947Z` |
| Decrypted | 223 532 B, a valid PostgreSQL 16 custom archive |
| Private key | the **off-host** RSA-3072 half only (`~/MegaXO-private/v5-recovery-key-host-20261014/`) |

This is a *second, later* timer cycle than the one in the service report, which demonstrates the
schedule is genuinely recurring rather than a one-shot.

## Restored and compared

Restored into an isolated PostgreSQL 16 cluster (schema from the immutable migration chain → 51/51,
then `--data-only --disable-triggers --single-transaction`). **Measured 0.06 s.**

| Relation | Production | Restored from the autonomous archive |
| --- | --- | --- |
| `identity.actors` | 2 | 2 |
| `economy.wallets` | 2 | 2 |
| `match.matches` | 2 | 2 |
| `identity.profiles` | 2 | 2 |
| wallet coins | 307 | 307 |
| `meta.migrations` | 51 | 51 |
| **`learning` capture table data** | — | **0** (excluded by design) |

Every reconciled quantity is identical, and the private capture schema is absent from the archive
while its trigger dependencies still resolve — the intended privacy property.

## What is now end-to-end proven

`systemd timer` → real production `pg_dump` as `backup_reader` → streaming AES-256-GCM seal for the
off-host public key → upload to the V5-only R2 bucket → independent reader retrieve → authenticated
decrypt with the off-host private key → schema from the immutable chain → data-only restore →
**byte-for-byte-equal durable data**. No operator step, no plaintext dump file, no production write.
