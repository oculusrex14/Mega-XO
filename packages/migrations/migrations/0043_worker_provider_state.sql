-- runner: current-role
-- P10 (V5-10-03): the provider state machine's missing SOURCE identity plus two schema facts without which the provider finalization/notification state machine
-- cannot work at all, found by executing the P10 provider workflow against the migrated 42-chain.
--
-- 1. `monetization.store_finalize` has NO unique constraint on its identity. The V4 source DDL does
--    (`server/production/migrations.js:96`, `PRIMARY KEY(store,transaction_id)`), but migration 0015
--    omitted it while giving `store_notifications` its `PRIMARY KEY (store, notification_id)`. Every
--    V4 producer writes the finalization row with `INSERT ... ON CONFLICT(store, transaction_id) DO
--    UPDATE` (`server/google-play-billing.js:55-57`), so on the migrated schema that write is
--    REFUSED by PostgreSQL with `42P10: there is no unique or exclusion constraint matching the ON
--    CONFLICT specification`. It also means a re-verified purchase could create a DUPLICATE
--    finalization row and contact the provider twice, and that the worker's `FOR UPDATE SKIP LOCKED`
--    claim could grant two workers the same transaction. The primary key restores the source
--    contract and is the identity the upsert and the fence both depend on.
-- 2. The worker role that drives the sweep is missing the two narrow privileges the P10 workflow
--    needs, which 0022 deliberately withheld while the work lived in the game process:
--      * `monetization.receipts` SELECT: `completeFinalization` reads the receipt of the transaction
--        it is about to consume/acknowledge BEFORE contacting the provider, so "finalize only after
--        durable grant" is provable from the worker role. Read-only: the worker never mints a grant.
--      * `monetization.store_revocations` INSERT + SELECT: `handleRefundNotification` writes the same
--        permanent tombstone Core's `commerce.refund` writes (0021) so a later purchase of a refunded
--        store transaction fails `RECEIPT_REFUNDED`, and `handlePurchaseNotification` must READ that
--        tombstone before it grants - a purchase callback for a store transaction this database never
--        granted is exactly the out-of-order "refund arrived first" case, and without the read the
--        callback would mint a consumable the provider already refunded. INSERT-only on write: the
--        tombstone stays immutable once written (0021 already gives core_runtime SELECT, INSERT,
--        UPDATE), and the receipt FREEZE and account hold remain Core-owned.
--
-- Additive only: no grant is revoked, no column is added or retyped, and worker_runtime still holds no
-- write on monetization.receipts, no DELETE on a permanent table and no economic surface. The primary
-- key is added with ALTER TABLE ... ADD PRIMARY KEY, which fails if the table already violated it;
-- on the legacy-imported rows the identity is already unique because that is the row's identity.

ALTER TABLE monetization.store_finalize ADD PRIMARY KEY (store, transaction_id);

GRANT SELECT ON monetization.receipts TO worker_runtime;
GRANT SELECT, INSERT ON monetization.store_revocations TO worker_runtime;
