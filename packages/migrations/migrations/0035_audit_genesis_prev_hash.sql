-- 0035: audit.operator_audit.prev_hash accepts the source audit GENESIS literal.
-- PROVEN (parent bg203/2023): the first append records prev_hash 'GENESIS' (sourceAudit genesis
-- actual case), subsequent entries chain the lowercase 64-hex entry_hash; native rejected the
-- genesis row 23514 operator_audit_prev_hash_check because 0017 declared prev_hash CHAR(64) with
-- a bare hex CHECK — CHAR would also SPACE-PAD the literal, so a widened hex-only check cannot
-- represent genesis at all.
-- [D] parent ruling: widen to TEXT + CHECK (prev_hash = 'GENESIS' OR 64-hex). Do NOT pad,
-- re-hash, or repair anything: the genesis string and hashes are stored exactly as appended.
-- detail stays raw TEXT (the HMAC side-channel payload is correct as-is) and entry_hash keeps
-- its CHAR(64) + hex CHECK + UNIQUE — entry hashes never carry the genesis literal, so no
-- change there. This is representation-only; the append-only immutability triggers (0017) and
-- the INSERT+SELECT-only audit_runtime posture (0023/0024) are untouched.
ALTER TABLE audit.operator_audit ALTER COLUMN prev_hash TYPE TEXT;
ALTER TABLE audit.operator_audit DROP CONSTRAINT IF EXISTS operator_audit_prev_hash_check;
ALTER TABLE audit.operator_audit ADD CONSTRAINT operator_audit_prev_hash_check
  CHECK (prev_hash = 'GENESIS' OR prev_hash ~ '^[0-9a-f]{64}$');
