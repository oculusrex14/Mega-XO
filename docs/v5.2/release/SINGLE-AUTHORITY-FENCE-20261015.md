# Single mutating authority: every V4 writer fenced (2026-10-15)

The cutover requires that the legacy SQLite writer be fenced and that exactly one mutating authority
remain. This is the evidence, gathered by direct inspection rather than by assertion.

## The five writer paths, each checked

| # | Path | State | Evidence |
| --- | --- | --- | --- |
| 1 | `mega-xo-production-app-1` (the V4 mutation owner) | **fenced** | `Running=false`, `RestartPolicy=no`, `ExitCode=0` |
| 2 | Any host process holding the database file | **none** | `lsof /opt/mega-xo/data/mega.sqlite` → empty |
| 3 | `mega-xo-production-backup-1` (V4 backup worker) | **cannot write** | `/opt/mega-xo/data` is mounted `rw=false`, and the mount itself is `ro`; a `touch /data/.fence-probe` returns `Read-only file system` and no probe file exists |
| 4 | The V4 HTTP ingress | **repointed** | `/tmp/mega-release-f1e5577/deploy/Caddyfile:27` is now `reverse_proxy 172.18.0.1:8080` (the V5 authority), not `app:8080` |
| 5 | The database file itself | **frozen** | `mega.sqlite` mtime is `2026-10-15 04:04:52.600305021 +0000` — exactly the fence instant — and there is no `-wal` file, because the writer checkpointed on its clean exit |

## The one authority

`systemctl show mega-xo-v5-production.service` → `ActiveState=active`, `SubState=running`.
The V5 authority holds the authority epoch `v5:1792037113917:153a8543d555682d` and is the only process
in the topology permitted to mutate competitive or economic state. Its pool is `api_runtime` /
`core_runtime` / `worker_runtime` with per-role grants; the API handler context is asserted to hold no
Core pool (reaching Core only over the signed ingress).

## Note on the backup container's read/write mount

The backup container does hold `rw=true` on `/opt/mega-xo/backup-work` — that is its own scratch
staging directory, not the database. The database bind is strictly read-only, which is what matters
for the fence.

## Honest limits

- The two Core processes ("two same-host Core containers prove process failover, not host HA") are a
  separate P16 concern; this record establishes the *writer* fence, not host-level HA.
- The V4 images and its `current-image` file remain on the host for audit; nothing was deleted. Only
  the writer was stopped and its restart policy disabled.
