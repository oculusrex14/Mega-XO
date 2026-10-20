-- Prerequisite for anti-hoarding spending coverage. Do not rewrite the immutable 0010.
-- Confiscations use the existing 'spend' source; 'power' is the account-wallet lane.
ALTER TABLE economy.ledger DROP CONSTRAINT ledger_source_check;
ALTER TABLE economy.ledger ADD CONSTRAINT ledger_source_check CHECK
  (source IN ('game', 'provisioning', 'mint', 'conversion', 'verified-store', 'spend',
              'tournament', 'migration-baseline', 'power'));
