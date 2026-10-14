# E1 — V4 authoritative snapshot frozen and independently restored (2026-10-14)

Executed by Main under the owner's 2026-10-14 authorization. **Read-only** against V4: the backup
repository was not initialized, pruned or modified; the live database was not written.

## Frozen source

| Field | Value |
| --- | --- |
| Host | `command` (Oracle VPS), production root `/opt/mega-xo` |
| Live authority | SQLite `data/mega.sqlite` (WAL), image `71d33a1a…`, revision `f1e5577` |
| Restic repository | `s3:https://<acct>.r2.cloudflarestorage.com/mega-xo-backups/mega-xo-v4-production` (untouched) |
| Snapshots in repository | **611**, newest at `2026-10-14 00:54:59Z`, every ~15 min |
| Repository size (restore-size) | 733.470 MiB, 1833 files |
| Selected snapshot | `8d4265379eca2ec2384161e0c5f97ebbe153f0f3e82e29eef8fcb1fec2aa5a21` |
| Snapshot manifest createdAt | `1791939299047` |

## Independent off-box restore (isolated, non-serving target)

`restic restore <id> --target /work/recovery-e1` inside the backup container (the container rootfs is
read-only, so nothing in the image was altered). Restored pair:

| File | Bytes | sha256 |
| --- | --- | --- |
| `mega.sqlite` | 1,630,208 | `c77632f02cd13a49be13ec6a86332e474aa78effec611f30bc9087ad9ce72554` |
| `mega.sqlite.json` | 143 | (manifest) |

The restored file's sha256 **equals the snapshot manifest's recorded `sha256`** — the retrieval is
byte-identical, which is the property E1 requires.

## Restored-database integrity and invariants (real data)

| Check | Result |
| --- | --- |
| `PRAGMA quick_check` | `ok` |
| `PRAGMA foreign_key_check` violations | **0** |
| Tables / indexes / triggers / views | 35 / 14 / 2 / 0 |
| `v4_schema` migration rows / head | 8 / 8 |
| `state(id=1)` row present | 1 |
| `identity.accounts` | **2** |
| `match.matches` | **2** |
| `account_sessions` | 3 |
| `identities` / `email_credentials` / `profiles` / `profile_saves` | 2 / 2 / 2 / 2 |
| `snapshots` / `weeklyPaid` / receipts / journal | 8 / 0 / 0 / 4 |
| `burned` | `{coins:0, crowns:0}` |
| `leagueWeek` | `2026-10-12` |

The real principal `u_e17f44f4-8229-4230-b767-987c3a1cf807` carries `coins:157`, `crowns:0`,
`rating:600`, `casualRating:1016`, `casualGames:1`, `verified:true`, `reservedCoins:0`,
`reservedCrowns:0`, friendCode `MEGA-A889B432`, createdAt `1791403645829`. Real production economy
state (not a synthetic fixture) is therefore available to the import/reconciliation path.

The identical restored pair was copied off-box to a private 0700 location
(`~/Downloads/Mega-XO-private-evidence/v4-e1/`, sha256 re-verified after transfer) so E2 can run
without re-reading the repository.

## Real defect found and fixed during this work

`tools/v5-migration/cli.js` `verify` computed its differences-file digest from
`fs.readFileSync(...)` (a **Buffer**) while `hashText()` requires a string, so every real `verify`
run aborted with `HASH_TEXT_REQUIRED` **after** a successful load. Fixed in `3fb7dba` (digest the exact
text written). Found by running the real V4 model through load+verify, not by inspection.

## Not claimed

- No production database was written and no authority changed; `nonserving` remains `true`.
- RPO/RTO figures, the V5 R2 bucket, Neon PITR and delivered alerts are separate Stage-A items.
