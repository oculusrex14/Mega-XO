-- runner: current-role
-- MXA-ECO-005 (2026-10-18) - the durable provider-notification dedupe for the V5 store
-- notification lanes (Google Play RTDN + Apple App Store Server Notifications v2). Named
-- provider_notifications: monetization.store_notifications is ALREADY the 0015 worker
-- state-machine table and must not be reused. Handlers verify the provider credential FIRST; a
-- row here only prevents reprocessing one provider event id. Writes stay Core-owned through the
-- commerce service (core_runtime pattern), so the API tier never touches this table.
CREATE TABLE IF NOT EXISTS monetization.provider_notifications (
  store TEXT NOT NULL CHECK (store IN ('google', 'apple')),
  notification_id TEXT NOT NULL CHECK (length(notification_id) BETWEEN 1 AND 200),
  received_at timestamptz NOT NULL,
  CONSTRAINT provider_notifications_pkey PRIMARY KEY (store, notification_id)
);
GRANT SELECT, INSERT ON monetization.provider_notifications TO core_runtime;
GRANT SELECT ON monetization.provider_notifications TO backup_reader;
