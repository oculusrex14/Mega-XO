-- runner: current-role
-- SEC-V52-CASHFREE-IDEMPOTENCY-RACE fix (2026-10-16, owner-delegated decision: reserve-then-create).
--
-- Today createCashfreeOrder/createPolarCheckout call the provider BEFORE the durable
-- (actor, op_key) fence: a concurrent same-key race orphans one provider order (never
-- double-grants, but the orphan is real money-adjacent state with ambiguous recovery). This
-- table is the RESERVATION: a PENDING row is inserted under the same fence semantics BEFORE any
-- external I/O, and only the successful inserter calls the provider.
--
-- State machine: PENDING (reserved, provider call in flight or not yet attempted) -> READY
-- (provider id + successful response recorded, ledger committed) or FAILED (an explicit provider
-- rejection proving creation failed; replay returns the sanitized failure) or UNKNOWN (transport
-- timeout/disconnect/malformed success, or a PENDING row older than the reconciliation window -
-- recovered ONLY by an explicit provider read against the reserved id/metadata, never by an
-- automatic re-create; a late response finalizes only its own request_id).
--
-- request_id is application-generated (the Core commerce service owns the uuid); it travels in
-- the Polar checkout metadata and pairs with the reserved Cashfree order id for reconciliation.
-- price_snapshot is the immutable SERVER-SELECTED catalog price (Cashfree INR numeric string or
-- the Polar price id + cents) captured at reservation time - settlement compares it exactly,
-- never a client value. No DELETE anywhere: reservations are permanent evidence like the
-- ledgers they fence, and rows self-document their outcome.

CREATE TABLE IF NOT EXISTS monetization.commerce_create_requests (
  request_id UUID NOT NULL,
  actor_id TEXT NOT NULL REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  op_key TEXT NOT NULL CHECK (op_key ~ '^[A-Za-z0-9:_-]{1,160}$'),
  provider TEXT NOT NULL CHECK (provider IN ('cashfree', 'polar')),
  product_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  price_snapshot JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'READY', 'UNKNOWN', 'FAILED')),
  provider_object_id TEXT,
  response_text TEXT,
  error_code TEXT,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT commerce_create_requests_pkey PRIMARY KEY (request_id),
  CONSTRAINT commerce_create_requests_actor_op_key_key UNIQUE (actor_id, op_key),
  CONSTRAINT commerce_create_requests_provider_object_id_key UNIQUE (provider, provider_object_id),
  CONSTRAINT commerce_create_requests_ready_complete CHECK (
    state <> 'READY' OR (provider_object_id IS NOT NULL AND response_text IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS commerce_create_requests_state_updated_idx
  ON monetization.commerce_create_requests (state, updated_at);

-- Core is the SOLE economic mutation authority (0015/0021 pattern). No DELETE for any runtime
-- role: reservations are permanent evidence. api_runtime gets nothing (the API reaches commerce
-- only through the signed ingress); worker_runtime gets nothing (creation recovery is a commerce
-- service reconciliation, not a worker sweep).
GRANT SELECT, INSERT, UPDATE ON monetization.commerce_create_requests TO core_runtime;

-- The 0026 default privileges fire only for v5_owner-created tables; this migration runs as the
-- management identity, so the backup contract (0026: explicit exact SELECT only) is granted here.
GRANT SELECT ON monetization.commerce_create_requests TO backup_reader;
