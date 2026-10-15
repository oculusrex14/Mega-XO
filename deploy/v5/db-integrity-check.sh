#!/usr/bin/env bash
set -euo pipefail
umask 077
# deploy/v5/db-integrity-check.sh - V5 production PostgreSQL integrity check.
#
# The V5 successor to deploy/db-integrity-check.sh. The V4 check ran SQLite `PRAGMA quick_check`
# and a foreign-key sweep INSIDE the `app` compose container; after the V5 cutover that container
# is deliberately retired (fenced, restart disabled), and PostgreSQL - not SQLite - is the durable
# authority, so the V4 check can only ever report a false failure.
#
# This check runs the READ-ONLY PostgreSQL verifier (scripts/v5/pg-integrity-check.js) over the
# DIRECT endpoint: ledger contiguity, per-migration checksum agreement with the checked-in chain,
# required-table presence, the runtime-role no-DDL posture and validated foreign keys. It never
# writes, applies or drops anything, and it needs no privileged runner role.
#
# The connection material is read from the deployment's own state (the direct-target identity plus
# the mode-0600 pgpass file) and is never printed. Only the sanitized verdict reaches stdout and the
# monitoring JSON.
#
# Usage: db-integrity-check.sh [absolute deployment root]

root=${1:-/opt/mega-xo-v5-production}
[[ "$root" = /* && "$root" != / ]] || { echo 'Invalid deployment root.' >&2; exit 64; }

STATE="$root/state"
TREE="$root/src-final"
NODE=${V5_NODE:-/opt/mega-xo-v5-production/bin/node-24/bin/node}
SOURCE="$STATE/prod-source.json"
PGPASS="$STATE/pgpass"
CA="$STATE/neon-ca.pem"

[[ -x "$NODE" ]] || { echo 'V5 node runtime is missing.' >&2; exit 69; }
[[ -s "$SOURCE" && -s "$PGPASS" && -s "$CA" ]] || { echo 'V5 database identity/credential/CA state is incomplete.' >&2; exit 65; }
[[ -f "$TREE/scripts/v5/pg-integrity-check.js" ]] || { echo 'V5 integrity verifier is missing.' >&2; exit 69; }

mkdir -p "$root/monitoring"
chmod 700 "$root/monitoring"
tmp="$root/monitoring/.db-integrity.$$.json"
trap 'rm -f "$tmp"' EXIT

# Build the direct connection URL WITHOUT echoing it: the password comes from the mode-0600 pgpass
# line, the identity from the checked-in direct-target state. The URL lives only in the child
# environment and is never written to disk or to stdout.
cd "$TREE"
V5_PG_TARGET="$SOURCE" V5_PG_PASSFILE="$PGPASS" V5_PG_CA="$CA" "$NODE" -e '
const fs = require("node:fs");
const d = JSON.parse(fs.readFileSync(process.env.V5_PG_TARGET, "utf8"));
const line = fs.readFileSync(process.env.V5_PG_PASSFILE, "utf8").replace(/[\r\n]+$/, "");
const field = line.split(":");
if (field.length < 5) { process.stderr.write("pgpass is malformed\n"); process.exit(65); }
const pass = field.slice(4).join(":");
const url = "postgresql://" + encodeURIComponent(d.user) + ":" + encodeURIComponent(pass) +
  "@" + d.host + ":" + String(d.port) + "/" + encodeURIComponent(d.database) +
  "?sslmode=verify-full&sslrootcert=" + encodeURIComponent(process.env.V5_PG_CA) + "&connect_timeout=10";
const { spawnSync } = require("node:child_process");
const res = spawnSync(process.execPath, ["scripts/v5/pg-integrity-check.js", "--json", "--database-url", url],
  { encoding: "utf8", env: process.env, maxBuffer: 16 * 1024 * 1024 });
// Sanitize: the verifier JSON carries the database NAME only, never the URL or credentials.
process.stdout.write(res.stdout || "");
process.stderr.write(res.stderr || "");
process.exit(res.status === null ? 70 : res.status);
' > "$tmp" || status=$?
status=${status:-0}
trap - EXIT

# The monitoring contract is a small, stable JSON: ok, the check name and the checked count.
"$NODE" -e '
const fs = require("node:fs");
let doc = {};
try { doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
const ok = doc.ok === true;
const out = {
  ok,
  check: doc.check || "postgres-integrity",
  checked: Number.isSafeInteger(doc.migrationsChecked) ? doc.migrationsChecked : 0,
  failures: Array.isArray(doc.failures) ? doc.failures.length : null,
  serverMajor: Number.isSafeInteger(doc.serverMajor) ? doc.serverMajor : null,
};
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
process.exit(ok ? 0 : 2);
' "$tmp" "$root/monitoring/db-integrity-last.json" || { echo 'MEGA_XO_DATABASE_INTEGRITY_FAILED: PostgreSQL verification did not pass.' >&2; exit 2; }
chmod 600 "$root/monitoring/db-integrity-last.json"

[[ $status -eq 0 ]] || { echo "MEGA_XO_DATABASE_INTEGRITY_FAILED: verifier exit $status." >&2; exit 2; }
echo 'MEGA_XO_DATABASE_INTEGRITY_OK'
