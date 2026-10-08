-- runner: current-role
-- V5 P02 (V5-02-03) - migration history ledger (design section 4).
-- The runner's tool-managed bootstrap guarantees the table exists before file 0001 records
-- itself; this checksummed file is the authoritative definition and idempotently normalizes
-- whatever bootstrap created: canonical columns, ownership, named constraints, grants.
-- checksum = sha256(name || E'\n' || sql), the identical rule to server/production/migrations.js
-- checksum(), so the legacy v4_schema rows map 1:1 as P03 import provenance. The runner inserts
-- each history row in the same transaction as its migration body; runtime roles get no DML
-- here - INSERT is a migration_owner privilege (design section 7).
CREATE TABLE IF NOT EXISTS meta.migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum CHAR(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  runner TEXT NOT NULL,
  duration_ms INTEGER,
  schema_version INTEGER NOT NULL
);

DO $$
BEGIN
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'meta.migrations'::regclass) <> 'v5_owner' THEN
    ALTER TABLE meta.migrations OWNER TO v5_owner;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'migrations_checksum_hex_ck' AND conrelid = 'meta.migrations'::regclass) THEN
    ALTER TABLE meta.migrations ADD CONSTRAINT migrations_checksum_hex_ck CHECK (checksum ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'migrations_name_ck' AND conrelid = 'meta.migrations'::regclass) THEN
    ALTER TABLE meta.migrations ADD CONSTRAINT migrations_name_ck CHECK (name ~ '^[0-9]{4}_[a-z0-9_]{1,80}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'migrations_duration_ck' AND conrelid = 'meta.migrations'::regclass) THEN
    ALTER TABLE meta.migrations ADD CONSTRAINT migrations_duration_ck CHECK (duration_ms IS NULL OR duration_ms >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'migrations_schema_version_ck' AND conrelid = 'meta.migrations'::regclass) THEN
    ALTER TABLE meta.migrations ADD CONSTRAINT migrations_schema_version_ck CHECK (schema_version >= 1);
  END IF;
END
$$;

GRANT SELECT, INSERT ON meta.migrations TO migration_owner;
