# E2 — real V4 → production PostgreSQL import and reconciliation (2026-10-14)

Executed by Main under the owner's 2026-10-14 authorization. The target is the **production** Neon
database, which is still `nonserving:true` and serves no traffic. No V4 write, no authority change.

## Pipeline (all real, exact SHAs)

| Step | Command | Result |
| --- | --- | --- |
| Capture (WAL-safe, immutable) | `node tools/v5-migration/cli.js capture --source <restored V4 copy> --snapshot … --record …` | `schemaHead 8`, 35 tables / 14 indexes / 2 triggers, 8549 rows, **0 unclassified**; source fingerprint `aa411dee744b0dc5977c653289dde5c9ca370a062fa8c5b7d9e6f07c57797d48` |
| Extract (pure reader) | `… cli.js extract --snapshot … --clock 1791939609808 --out model.json --summary …` | model sha256 `0ea9837ac72d9368331d6b8b8304e05df303e1b2d7e4a7e7e87f03d8a660e363`; 44 197 fields, 0 unclassified |
| Load (importer) | `… cli.js load --model … --run e2-prod-… --database-url <production direct> --environment production --adopt-existing` | 77 batches; counters `V:8554, O:2, E:3`; target guard created for `7696322233278462389/mega_xo_v5_production` |
| Verify (reconciler) | `… cli.js verify --model … --run e2-prod-… --database-url <production direct> --environment production` | **gate pass:true; unexplained 0; coverage unclassified 0** |

## Production database state after import (real query)

| Relation | Rows |
| --- | --- |
| `identity.actors` | 2 |
| `economy.wallets` | 2 |
| `match.matches` | 2 |
| `identity.email_credentials` | 2 |
| `identity.profiles` | 2 |

## Reconciliation result (production, real data)

`v5_migration` gate: `{pass:true, requireUnexplained:0, requireCoverageUnclassified:0}`; counts
`{differences:4, explained:4, informational:0, unexplained:0}`.

All nine conservation equations pass with zero failures:

| Equation | Assertions | Failures |
| --- | --- | --- |
| C1 available/reserved identity | 8 | 0 |
| C2 reserved closure | 8 | 0 |
| C3 burn composition | 4 | 0 |
| C4 conversion fidelity | 1 | 0 |
| C5 tournament pool algebra | 1 | 0 |
| C6 wealth identity | 2 | 0 |
| C7 occupancy single-valued | 0 | 0 |
| C8 relationship symmetry | 2 | 0 |
| C9 tombstone/principal referential classes | 25 | 0 |

A07 invariant: 2 actors compared **per actor and per currency**; global available totals
`{coins:307, crowns:0}`, matching the source exactly.

The four explained differences are the documented closed categories:
`restore-normalization/boolean-coercion` (×2, the reader's reported normalization),
`expired-session/expire` (×1) and `ephemeral-rebuild/rebuild` (×1, `community_limits`). None is an
unexplained per-actor difference.

## Real defect found and fixed

`tools/v5-migration/cli.js` `verify` hashed a **Buffer** where `hashText()` requires text, so every
real verification aborted with `HASH_TEXT_REQUIRED`. Fixed in `3fb7dba`; found by running the real V4
model, not by inspection.

## Evidence

- Restricted (outside Git, 0600): `~/MegaXO-private/v5-e2/{capture.json,v4-snapshot.sqlite,model.json,
  extract-summary.json,prod-load-summary.json,prod-differences.jsonl,prod-verify-summary.json}`.
- Public summary: this file. No actor ids, email addresses or credentials are reproduced here.

## Not claimed

- The database remains `nonserving`; no API/Core/worker is connected to it.
- No V4 writer was fenced and no authority epoch was started (E3–E5).
- This proves the import/reconciliation path on the real production principal set; it does not by
  itself authorise the cutover, which still requires E3 (roles/secrets/Core), E4 (V4 fence) and E5.
