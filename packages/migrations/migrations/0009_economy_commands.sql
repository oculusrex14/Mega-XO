-- V5 P02 (V5-02-02) - idempotent command surfaces and per-account progress (design sections
-- 2.2, 3.2, 3.5; R3). The legacy relational `commands` table (DurableStore.run dispatcher)
-- becomes economy.command_outcomes; account.operations{} becomes economy.wallet_operations
-- (design 3.2 lists both families; keeping each legacy uniqueness domain intact). Fingerprints
-- are stored verbatim and NEVER recomputed in SQL.

-- Global durable-store commands: id = JSON.stringify([actor,key]) => (actor,key) uniqueness.
-- SOURCE TRUTH: the legacy commands table (server/economy-store.js:20) and the account.operations
-- map store NO commit timestamp; committed_at is nullable so the import preserves genuine absence
-- rather than fabricating now(). A runtime command that observes a clock may still set it.
CREATE TABLE IF NOT EXISTS economy.command_outcomes (
  actor_id TEXT NOT NULL,
  "key" TEXT NOT NULL CHECK ("key" ~ '^[A-Za-z0-9:_-]{1,160}$'),
  fingerprint CHAR(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  response TEXT NOT NULL CHECK (response IS JSON),
  committed_at timestamptz,
  PRIMARY KEY (actor_id, "key")
);

-- account.operations{}: conversion quotes. SOURCE TRUTH: src/domain.js:88 stores
-- fingerprint = JSON.stringify(conversion quote) - the exact quote TEXT, not a digest - and
-- compares it byte-for-byte for idempotency (domain.convert). Storing it as TEXT (not a fixed
-- hex CHAR(64)) preserves those exact bytes; rehashing would break differential replay (R3).
CREATE TABLE IF NOT EXISTS economy.wallet_operations (
  actor_id TEXT NOT NULL,
  "key" TEXT NOT NULL CHECK ("key" ~ '^[A-Za-z0-9:_-]{1,160}$'),
  fingerprint TEXT NOT NULL CHECK (fingerprint IS JSON),
  result TEXT NOT NULL CHECK (result IS JSON),
  -- SOURCE TRUTH: account.operations{} stores {fingerprint,result} with NO timestamp; NULL
  -- preserves genuine absence rather than a fabricated import now().
  committed_at timestamptz,
  PRIMARY KEY (actor_id, "key")
);

-- account.ledger[] (conversion entries) - distinct from the global journal (design 2.2/2.7).
CREATE TABLE IF NOT EXISTS economy.wallet_ledger_entries (
  actor_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  operation_id TEXT,
  currency TEXT NOT NULL CHECK (currency IN ('coins', 'crowns')),
  amount BIGINT NOT NULL CHECK (amount BETWEEN -9007199254740991 AND 9007199254740991),
  reason TEXT NOT NULL,
  at timestamptz NOT NULL,
  PRIMARY KEY (actor_id, entry_id)
);
CREATE INDEX IF NOT EXISTS wallet_ledger_entries_actor_at_idx ON economy.wallet_ledger_entries (actor_id, at DESC);

-- account.daily{date:{...}} -> one row per actor-day (design 2.2). `seconds` is fractional:
-- SOURCE TRUTH src/authority.js _settle does d.seconds += Math.min(900,(now-started)/1000), a
-- full-precision JS number that can carry binary-floating tails; a fixed NUMERIC(12,3) scale
-- would round an admitted source value (e.g. 90.0005). Bare `numeric` is unbounded scale/
-- precision and stores the JSON numeric text exactly; the >= 0 domain check is preserved.
-- claimed preserves order as TEXT[].
CREATE TABLE IF NOT EXISTS economy.daily_progress (
  actor_id TEXT NOT NULL REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  day DATE NOT NULL,
  finished INTEGER NOT NULL DEFAULT 0 CHECK (finished >= 0),
  seconds numeric NOT NULL DEFAULT 0 CHECK (seconds >= 0),
  boards INTEGER NOT NULL DEFAULT 0 CHECK (boards >= 0),
  casual INTEGER NOT NULL DEFAULT 0 CHECK (casual >= 0),
  friend INTEGER NOT NULL DEFAULT 0 CHECK (friend >= 0),
  ranked INTEGER NOT NULL DEFAULT 0 CHECK (ranked >= 0),
  ranked_bonus INTEGER NOT NULL DEFAULT 0 CHECK (ranked_bonus >= 0),
  claimed TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(claimed) <= 16),
  PRIMARY KEY (actor_id, day)
);
