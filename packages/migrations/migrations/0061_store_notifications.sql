-- runner: current-role
-- MXA-ECO-005 (2026-10-18) - the durable provider-notification dedupe for the V5 store
-- notification lanes (Google Play RTDN + Apple App Store Server Notifications v2). Handlers
-- verify the provider credential FIRST; a row here only prevents reprocessing one provider
-- event id. Writes stay Core-owned through the commerce service (core_runtime pattern), so the
-- API tier never touches this table and no grant can be minted from a notification alone.
CREATE TABLE IF NOT EXISTS monetization.store_notifications (
  store TEXT NOT NULL CHECK (store IN ('google', 'apple')),
  notification_id TEXT NOT NULL CHECK (length(notification_id) BETWEEN 1 AND 200),
  received_at timestamptz NOT NULL,
  CONSTRAINT store_notifications_pkey PRIMARY KEY (store, notification_id)
);
